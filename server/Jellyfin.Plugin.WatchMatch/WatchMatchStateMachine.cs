using Jellyfin.Plugin.WatchMatch.Models;

namespace Jellyfin.Plugin.WatchMatch;

/// <summary>
/// Pure WatchMatch mutation logic. All callers must serialize access per group.
/// </summary>
internal static class WatchMatchStateMachine
{
    public static bool MarkReady(WatchMatchSession session, Guid userId)
    {
        if (!session.ActiveUserIds.Contains(userId) || session.Status != WatchMatchStatus.Waiting)
        {
            return false;
        }

        session.ReadyUserIds.Add(userId);
        return session.ActiveUserIds.All(session.ReadyUserIds.Contains);
    }

    public static Guid? ApplyVote(WatchMatchSession session, Guid userId, Guid movieId, WatchMatchVote vote)
    {
        if (session.Status != WatchMatchStatus.Swiping)
        {
            throw new InvalidOperationException("Session is not swiping.");
        }

        if (!session.ActiveUserIds.Contains(userId))
        {
            throw new UnauthorizedAccessException("User is not an active WatchMatch participant.");
        }

        var current = GetCurrentMovieId(session, userId);
        if (current != movieId)
        {
            throw new InvalidOperationException("Vote does not match the user's current card.");
        }

        session.ShownByUser[userId].Add(movieId);
        var movieVotes = GetMovieVotes(session, movieId);
        movieVotes.Approved.Remove(userId);
        movieVotes.Rejected.Remove(userId);

        if (vote == WatchMatchVote.Approve)
        {
            movieVotes.Approved.Add(userId);
        }
        else
        {
            movieVotes.Rejected.Add(userId);
        }

        if (!session.VotesByUser.TryGetValue(userId, out var votesByUser))
        {
            votesByUser = [];
            session.VotesByUser[userId] = votesByUser;
        }

        votesByUser[movieId] = vote;
        AdvanceUserToNextAvailable(session, userId);

        if (movieVotes.Approved.Count >= session.ActiveUserIds.Count)
        {
            session.MatchMovieId = movieId;
            session.Status = WatchMatchStatus.MatchFound;
            return movieId;
        }

        MarkExhaustedIfNeeded(session);
        return null;
    }

    public static void ContinueAfterMatch(WatchMatchSession session)
    {
        if (session.Status != WatchMatchStatus.MatchFound || session.MatchMovieId is null)
        {
            throw new InvalidOperationException("Session has no active match.");
        }

        var movieId = session.MatchMovieId.Value;
        session.GloballyRejectedMovieIds.Add(movieId);
        session.VotesByMovie.Remove(movieId);
        foreach (var userVotes in session.VotesByUser.Values)
        {
            userVotes.Remove(movieId);
        }

        session.MatchMovieId = null;
        session.Status = WatchMatchStatus.Swiping;
        foreach (var userId in session.ActiveUserIds)
        {
            AdvanceUserToNextAvailable(session, userId);
        }

        MarkExhaustedIfNeeded(session);
    }

    public static bool TryStartPlay(WatchMatchSession session, Guid userId, out Guid movieId)
    {
        movieId = Guid.Empty;
        if (session.Status == WatchMatchStatus.PlayStarting || session.Status == WatchMatchStatus.Completed)
        {
            return false;
        }

        if (session.Status != WatchMatchStatus.MatchFound || session.MatchMovieId is null)
        {
            throw new InvalidOperationException("Session is not ready for playback.");
        }

        if (!session.ActiveUserIds.Contains(userId))
        {
            throw new UnauthorizedAccessException("User is not an active WatchMatch participant.");
        }

        session.PlayWinnerUserId = userId;
        session.Status = WatchMatchStatus.PlayStarting;
        movieId = session.MatchMovieId.Value;
        return true;
    }

    public static void ReconcileActiveUsers(WatchMatchSession session, IReadOnlyCollection<Guid> activeUserIds)
    {
        var currentlyInGroup = activeUserIds
            .Where(session.ParticipantUserIds.Contains)
            .ToHashSet();

        foreach (var userId in session.ActiveUserIds.Where(id => !currentlyInGroup.Contains(id)))
        {
            session.DepartedUserIds.Add(userId);
        }

        session.ActiveUserIds = currentlyInGroup
            .Where(id => !session.DepartedUserIds.Contains(id))
            .ToHashSet();

        if (session.Status is WatchMatchStatus.Completed or WatchMatchStatus.Aborted)
        {
            return;
        }

        if (session.ActiveUserIds.Count < 2)
        {
            session.Status = WatchMatchStatus.Aborted;
            session.EndReason = WatchMatchEndReasons.NotEnoughActiveParticipants;
            return;
        }

        session.ReadyUserIds.RemoveWhere(id => !session.ActiveUserIds.Contains(id));
        if (session.Status == WatchMatchStatus.Waiting && session.ActiveUserIds.All(session.ReadyUserIds.Contains))
        {
            session.Status = WatchMatchStatus.Swiping;
        }

        if (session.Status == WatchMatchStatus.Swiping)
        {
            MarkExhaustedIfNeeded(session);
        }
    }

    public static Guid? GetCurrentMovieId(WatchMatchSession session, Guid userId)
    {
        if (!session.ActiveUserIds.Contains(userId))
        {
            return null;
        }

        AdvanceUserToNextAvailable(session, userId);
        var position = session.UserPositions[userId];
        return position >= session.MovieQueue.Count ? null : session.MovieQueue[position];
    }

    public static bool IsUserExhausted(WatchMatchSession session, Guid userId)
    {
        return GetCurrentMovieId(session, userId) is null;
    }

    public static void AdvanceUserToNextAvailable(WatchMatchSession session, Guid userId)
    {
        if (!session.UserPositions.TryGetValue(userId, out var position))
        {
            position = 0;
        }

        while (position < session.MovieQueue.Count)
        {
            var movieId = session.MovieQueue[position];
            if (!session.GloballyRejectedMovieIds.Contains(movieId)
                && !session.ShownByUser[userId].Contains(movieId))
            {
                break;
            }

            position++;
        }

        session.UserPositions[userId] = position;
    }

    private static MovieVotes GetMovieVotes(WatchMatchSession session, Guid movieId)
    {
        if (!session.VotesByMovie.TryGetValue(movieId, out var votes))
        {
            votes = new MovieVotes();
            session.VotesByMovie[movieId] = votes;
        }

        return votes;
    }

    private static void MarkExhaustedIfNeeded(WatchMatchSession session)
    {
        if (session.Status != WatchMatchStatus.Swiping || session.ActiveUserIds.Count == 0)
        {
            return;
        }

        if (session.ActiveUserIds.All(userId => GetCurrentMovieId(session, userId) is null))
        {
            session.Status = WatchMatchStatus.SessionExhausted;
            session.EndReason = WatchMatchEndReasons.QueueEmpty;
        }
    }
}
