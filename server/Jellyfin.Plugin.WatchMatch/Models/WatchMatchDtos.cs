using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.WatchMatch.Models;

/// <summary>
/// WatchMatch session status values exposed to the web plugin.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WatchMatchStatus
{
    Waiting,
    Swiping,
    MatchFound,
    PlayStarting,
    Completed,
    Aborted,
    SessionExhausted
}

/// <summary>
/// Reason a session was aborted or ended without playback.
/// </summary>
public static class WatchMatchEndReasons
{
    public const string NotEnoughActiveParticipants = "not_enough_active_participants";
    public const string QueueEmpty = "queue_empty";
    public const string SessionNotFound = "session_not_found";
}

/// <summary>
/// Vote values accepted by the WatchMatch API.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WatchMatchVote
{
    Approve,
    Reject
}

/// <summary>
/// Preference payload for the current user.
/// </summary>
public sealed record WatchMatchPreferencesDto(bool HideSeenHint);

/// <summary>
/// Request body for a swipe vote.
/// </summary>
public sealed record VoteRequestDto(Guid MovieId, WatchMatchVote Vote);

/// <summary>
/// Request body for preference updates.
/// </summary>
public sealed record PreferencesRequestDto(bool HideSeenHint);

/// <summary>
/// Response body for a play request.
/// </summary>
public sealed record PlayResponseDto(bool StartPlayback, Guid? MovieId);

/// <summary>
/// Current WatchMatch state for one user.
/// </summary>
public sealed record WatchMatchStateDto(
    string UiState,
    Guid GroupId,
    WatchMatchStatus? Status,
    IReadOnlyList<Guid> ParticipantUserIds,
    IReadOnlyList<Guid> ActiveUserIds,
    IReadOnlyList<Guid> ReadyUserIds,
    int MemberCount,
    MovieCardDto? CurrentMovie,
    MovieCardDto? MatchMovie,
    bool IsUserReady,
    bool IsUserExhausted,
    string? Reason);

/// <summary>
/// Data needed to render one movie card.
/// </summary>
public sealed record MovieCardDto(
    Guid Id,
    string Name,
    int? ProductionYear,
    IReadOnlyList<string> Genres,
    long? RunTimeTicks,
    bool HasPrimaryImage,
    bool Played);

/// <summary>
/// Server-sent event payload wrapper.
/// </summary>
public sealed record WatchMatchEventDto(long Id, string Type, WatchMatchStateDto State);
