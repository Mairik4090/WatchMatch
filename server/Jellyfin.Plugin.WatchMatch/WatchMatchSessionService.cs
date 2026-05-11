using System.Collections.Concurrent;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.WatchMatch.Models;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using MediaBrowser.Controller.SyncPlay;
using MediaBrowser.Model.Library;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.WatchMatch;

/// <summary>
/// Coordinates WatchMatch sessions and bridges them to Jellyfin SyncPlay/library APIs.
/// </summary>
public sealed class WatchMatchSessionService
{
    private readonly ConcurrentDictionary<Guid, WatchMatchSession> _sessions = [];
    private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _locks = [];
    private readonly ConcurrentDictionary<Guid, WatchMatchPreferencesDto> _preferences = [];
    private readonly ILibraryManager _libraryManager;
    private readonly ISessionManager _sessionManager;
    private readonly ISyncPlayManager _syncPlayManager;
    private readonly IUserDataManager _userDataManager;
    private readonly IUserManager _userManager;
    private readonly IAuthorizationContext _authorizationContext;
    private readonly WatchMatchEventHub _eventHub;
    private readonly ILogger<WatchMatchSessionService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="WatchMatchSessionService"/> class.
    /// </summary>
    public WatchMatchSessionService(
        ILibraryManager libraryManager,
        ISessionManager sessionManager,
        ISyncPlayManager syncPlayManager,
        IUserDataManager userDataManager,
        IUserManager userManager,
        IAuthorizationContext authorizationContext,
        WatchMatchEventHub eventHub,
        ILogger<WatchMatchSessionService> logger)
    {
        _libraryManager = libraryManager;
        _sessionManager = sessionManager;
        _syncPlayManager = syncPlayManager;
        _userDataManager = userDataManager;
        _userManager = userManager;
        _authorizationContext = authorizationContext;
        _eventHub = eventHub;
        _logger = logger;
    }

    /// <summary>
    /// Gets the Jellyfin session for the current HTTP request.
    /// </summary>
    public Task<SessionInfo> GetCurrentSessionAsync(HttpContext httpContext)
    {
        return GetCurrentSessionInternalAsync(httpContext);
    }

    private async Task<SessionInfo> GetCurrentSessionInternalAsync(HttpContext httpContext)
    {
        var auth = await _authorizationContext.GetAuthorizationInfo(httpContext).ConfigureAwait(false);
        if (!auth.IsAuthenticated || auth.User is null)
        {
            throw new UnauthorizedAccessException("WatchMatch requires an authenticated Jellyfin user.");
        }

        var session = System.Linq.Enumerable.FirstOrDefault(_sessionManager.Sessions, s => s.DeviceId == auth.DeviceId);

        return session ?? throw new KeyNotFoundException("Session not found.");
    }

    /// <summary>
    /// Gets a user-scoped state snapshot.
    /// </summary>
    public async Task<WatchMatchStateDto> GetStateAsync(Guid groupId, SessionInfo currentSession, CancellationToken cancellationToken)
    {
        await using var guard = await LockGroupAsync(groupId, cancellationToken).ConfigureAwait(false);
        var group = _syncPlayManager.GetGroup(currentSession, groupId);
        if (group is null)
        {
            return EmptyState("not_in_syncplay_group", groupId, WatchMatchEndReasons.SessionNotFound);
        }

        if (!_sessions.TryGetValue(groupId, out var session))
        {
            return EmptyState("can_start_watchmatch", groupId, null);
        }

        if (!session.ParticipantUserIds.Contains(currentSession.UserId) || session.DepartedUserIds.Contains(currentSession.UserId))
        {
            return EmptyState("session_already_running_locked", groupId, null);
        }

        WatchMatchStateMachine.ReconcileActiveUsers(session, ResolveActiveParticipants(group));
        var state = BuildState(session, currentSession.UserId);
        PublishState(session, "session_changed");
        return state;
    }

    /// <summary>
    /// Marks the current user as ready and starts the queue when all active frozen participants are ready.
    /// </summary>
    public async Task<WatchMatchStateDto> ReadyAsync(Guid groupId, SessionInfo currentSession, CancellationToken cancellationToken)
    {
        await using var guard = await LockGroupAsync(groupId, cancellationToken).ConfigureAwait(false);
        var group = _syncPlayManager.GetGroup(currentSession, groupId)
            ?? throw new InvalidOperationException("Current session is not in the SyncPlay group.");

        var session = _sessions.GetOrAdd(groupId, _ => CreateSession(group));
        if (!session.ParticipantUserIds.Contains(currentSession.UserId) || session.DepartedUserIds.Contains(currentSession.UserId))
        {
            throw new UnauthorizedAccessException("Late joiners cannot participate in this WatchMatch session.");
        }

        WatchMatchStateMachine.ReconcileActiveUsers(session, ResolveActiveParticipants(group));
        var shouldStart = WatchMatchStateMachine.MarkReady(session, currentSession.UserId);
        if (shouldStart && session.MovieQueue.Count == 0)
        {
            BuildMovieQueue(session);
            session.Status = session.MovieQueue.Count == 0
                ? WatchMatchStatus.SessionExhausted
                : WatchMatchStatus.Swiping;
            session.EndReason = session.MovieQueue.Count == 0 ? WatchMatchEndReasons.QueueEmpty : null;
        }

        var state = BuildState(session, currentSession.UserId);
        PublishState(session, shouldStart ? "session_started" : "session_changed");
        return state;
    }

    /// <summary>
    /// Applies a swipe vote.
    /// </summary>
    public async Task<WatchMatchStateDto> VoteAsync(Guid groupId, SessionInfo currentSession, Guid movieId, WatchMatchVote vote, CancellationToken cancellationToken)
    {
        await using var guard = await LockGroupAsync(groupId, cancellationToken).ConfigureAwait(false);
        var session = GetRequiredSession(groupId);
        var group = _syncPlayManager.GetGroup(currentSession, groupId)
            ?? throw new InvalidOperationException("Current session is not in the SyncPlay group.");

        WatchMatchStateMachine.ReconcileActiveUsers(session, ResolveActiveParticipants(group));
        if (session.Status == WatchMatchStatus.Aborted)
        {
            var abortedState = BuildState(session, currentSession.UserId);
            PublishState(session, "aborted");
            return abortedState;
        }

        var matchedMovieId = WatchMatchStateMachine.ApplyVote(session, currentSession.UserId, movieId, vote);
        var state = BuildState(session, currentSession.UserId);
        PublishState(session, matchedMovieId.HasValue ? "match_found" : "session_changed");
        return state;
    }

    /// <summary>
    /// Rejects the matched movie globally and resumes every participant at their own position.
    /// </summary>
    public async Task<WatchMatchStateDto> ContinueAsync(Guid groupId, SessionInfo currentSession, CancellationToken cancellationToken)
    {
        await using var guard = await LockGroupAsync(groupId, cancellationToken).ConfigureAwait(false);
        var session = GetRequiredSession(groupId);
        var group = _syncPlayManager.GetGroup(currentSession, groupId)
            ?? throw new InvalidOperationException("Current session is not in the SyncPlay group.");
        WatchMatchStateMachine.ReconcileActiveUsers(session, ResolveActiveParticipants(group));
        if (session.Status == WatchMatchStatus.Aborted)
        {
            var abortedState = BuildState(session, currentSession.UserId);
            PublishState(session, "aborted");
            return abortedState;
        }

        EnsureActiveParticipant(session, currentSession.UserId);
        WatchMatchStateMachine.ContinueAfterMatch(session);
        var state = BuildState(session, currentSession.UserId);
        PublishState(session, "session_changed");
        return state;
    }

    /// <summary>
    /// Starts the idempotent play handshake. The winning client must call Jellyfin SyncPlay SetNewQueue.
    /// </summary>
    public async Task<PlayResponseDto> PlayAsync(Guid groupId, SessionInfo currentSession, CancellationToken cancellationToken)
    {
        await using var guard = await LockGroupAsync(groupId, cancellationToken).ConfigureAwait(false);
        var session = GetRequiredSession(groupId);
        var group = _syncPlayManager.GetGroup(currentSession, groupId)
            ?? throw new InvalidOperationException("Current session is not in the SyncPlay group.");
        WatchMatchStateMachine.ReconcileActiveUsers(session, ResolveActiveParticipants(group));
        if (session.Status == WatchMatchStatus.Aborted)
        {
            PublishState(session, "aborted");
            return new PlayResponseDto(false, null);
        }

        var winner = WatchMatchStateMachine.TryStartPlay(session, currentSession.UserId, out var movieId);
        PublishState(session, winner ? "play_starting" : "session_changed");
        return new PlayResponseDto(winner, winner ? movieId : null);
    }

    /// <summary>
    /// Marks a play handoff as completed after the web client invokes Jellyfin's SyncPlay queue API.
    /// </summary>
    public async Task CompletePlaybackHandoffAsync(Guid groupId, SessionInfo currentSession, CancellationToken cancellationToken)
    {
        await using var guard = await LockGroupAsync(groupId, cancellationToken).ConfigureAwait(false);
        var session = GetRequiredSession(groupId);
        if (session.PlayWinnerUserId != currentSession.UserId)
        {
            throw new UnauthorizedAccessException("Only the winning play client can complete playback handoff.");
        }

        session.Status = WatchMatchStatus.Completed;
        PublishState(session, "completed");
        _sessions.TryRemove(groupId, out _);
    }

    /// <summary>
    /// Gets the current user's preferences.
    /// </summary>
    public WatchMatchPreferencesDto GetPreferences(Guid userId)
        => _preferences.GetOrAdd(userId, _ => new WatchMatchPreferencesDto(false));

    /// <summary>
    /// Updates the current user's preferences.
    /// </summary>
    public WatchMatchPreferencesDto SetPreferences(Guid userId, WatchMatchPreferencesDto preferences)
    {
        _preferences[userId] = preferences;
        return preferences;
    }

    /// <summary>
    /// Returns true when the user is allowed to subscribe to this group's stream.
    /// </summary>
    public bool CanStream(Guid groupId, Guid userId)
        => _sessions.TryGetValue(groupId, out var session)
            && session.ParticipantUserIds.Contains(userId)
            && !session.DepartedUserIds.Contains(userId);

    private WatchMatchSession CreateSession(MediaBrowser.Model.SyncPlay.GroupInfoDto group)
    {
        var participantUserIds = group.Participants
            .Select(name => _userManager.GetUserByName(name)?.Id ?? Guid.Empty)
            .Where(id => id != Guid.Empty)
            .Distinct()
            .ToArray();

        if (participantUserIds.Length < 2)
        {
            throw new InvalidOperationException("WatchMatch requires at least two SyncPlay users.");
        }

        return new WatchMatchSession(group.GroupId, participantUserIds);
    }

    private void BuildMovieQueue(WatchMatchSession session)
    {
        var firstUser = _userManager.GetUserById(session.ParticipantUserIds.First())
            ?? throw new InvalidOperationException("Participant user not found.");

        var maxQueueSize = Plugin.Instance?.Configuration.MaxQueueSize ?? 500;
        var query = new InternalItemsQuery(firstUser)
        {
            Recursive = true,
            IncludeItemTypes = [BaseItemKind.Movie],
            IsVirtualItem = false,
            OrderBy = [(ItemSortBy.Random, SortOrder.Ascending)],
            Limit = maxQueueSize
        };

        foreach (var movie in _libraryManager.GetItemList(query).OfType<Movie>())
        {
            if (CanAllParticipantsAccess(movie, session.ParticipantUserIds))
            {
                session.MovieQueue.Add(movie.Id);
            }
        }
    }

    private bool CanAllParticipantsAccess(BaseItem movie, IReadOnlySet<Guid> participantUserIds)
    {
        foreach (var userId in participantUserIds)
        {
            var user = _userManager.GetUserById(userId);
            if (user is null || !movie.IsVisibleStandalone(user) || movie.GetPlayAccess(user) != PlayAccess.Full)
            {
                return false;
            }

            if (movie is Movie playableMovie && playableMovie.MediaSourceCount <= 0)
            {
                return false;
            }
        }

        return true;
    }

    private HashSet<Guid> ResolveActiveParticipants(MediaBrowser.Model.SyncPlay.GroupInfoDto group)
    {
        return group.Participants
            .Select(name => _userManager.GetUserByName(name)?.Id ?? Guid.Empty)
            .Where(id => id != Guid.Empty)
            .ToHashSet();
    }

    private WatchMatchStateDto BuildState(WatchMatchSession session, Guid userId)
    {
        var currentMovieId = session.Status == WatchMatchStatus.Swiping
            ? WatchMatchStateMachine.GetCurrentMovieId(session, userId)
            : null;

        return new WatchMatchStateDto(
            "watchmatch_session",
            session.GroupId,
            session.Status,
            session.ParticipantUserIds.ToArray(),
            session.ActiveUserIds.ToArray(),
            session.ReadyUserIds.ToArray(),
            session.ActiveUserIds.Count,
            currentMovieId.HasValue ? BuildMovieCard(currentMovieId.Value, userId) : null,
            session.MatchMovieId.HasValue ? BuildMovieCard(session.MatchMovieId.Value, userId) : null,
            session.ReadyUserIds.Contains(userId),
            WatchMatchStateMachine.IsUserExhausted(session, userId),
            session.EndReason);
    }

    private MovieCardDto? BuildMovieCard(Guid movieId, Guid userId)
    {
        if (_libraryManager.GetItemById(movieId) is not Movie movie)
        {
            return null;
        }

        var user = _userManager.GetUserById(userId);
        var played = user is not null && (_userDataManager.GetUserDataDto(movie, user)?.Played ?? false);
        return new MovieCardDto(
            movie.Id,
            movie.Name,
            movie.ProductionYear,
            movie.Genres,
            movie.RunTimeTicks,
            movie.HasImage(MediaBrowser.Model.Entities.ImageType.Primary, 0),
            played);
    }

    private WatchMatchSession GetRequiredSession(Guid groupId)
        => _sessions.TryGetValue(groupId, out var session)
            ? session
            : throw new KeyNotFoundException("WatchMatch session not found.");

    private void EnsureActiveParticipant(WatchMatchSession session, Guid userId)
    {
        if (!session.ActiveUserIds.Contains(userId))
        {
            throw new UnauthorizedAccessException("User is not an active WatchMatch participant.");
        }
    }

    private void PublishState(WatchMatchSession session, string eventType)
    {
        foreach (var participantId in session.ParticipantUserIds)
        {
            _eventHub.Publish(session.GroupId, participantId, eventType, BuildState(session, participantId));
        }
    }

    private async ValueTask<GroupLock> LockGroupAsync(Guid groupId, CancellationToken cancellationToken)
    {
        var semaphore = _locks.GetOrAdd(groupId, _ => new SemaphoreSlim(1, 1));
        await semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
        return new GroupLock(semaphore);
    }

    private static WatchMatchStateDto EmptyState(string uiState, Guid groupId, string? reason)
        => new(uiState, groupId, null, [], [], [], 0, null, null, false, false, reason);

    private sealed class GroupLock : IAsyncDisposable
    {
        private readonly SemaphoreSlim _semaphore;

        public GroupLock(SemaphoreSlim semaphore)
        {
            _semaphore = semaphore;
        }

        public ValueTask DisposeAsync()
        {
            _semaphore.Release();
            return ValueTask.CompletedTask;
        }
    }
}
