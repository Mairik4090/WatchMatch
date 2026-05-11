namespace Jellyfin.Plugin.WatchMatch.Models;

/// <summary>
/// In-memory state for one SyncPlay group.
/// </summary>
internal sealed class WatchMatchSession
{
    public WatchMatchSession(Guid groupId, IReadOnlyCollection<Guid> participantUserIds)
    {
        GroupId = groupId;
        ParticipantUserIds = participantUserIds.ToHashSet();
        ActiveUserIds = participantUserIds.ToHashSet();
        foreach (var userId in participantUserIds)
        {
            UserPositions[userId] = 0;
            ShownByUser[userId] = [];
        }
    }

    public Guid GroupId { get; }

    public WatchMatchStatus Status { get; set; } = WatchMatchStatus.Waiting;

    public HashSet<Guid> ParticipantUserIds { get; }

    public HashSet<Guid> ActiveUserIds { get; set; }

    public HashSet<Guid> DepartedUserIds { get; } = [];

    public HashSet<Guid> ReadyUserIds { get; } = [];

    public List<Guid> MovieQueue { get; } = [];

    public Dictionary<Guid, int> UserPositions { get; } = [];

    public Dictionary<Guid, HashSet<Guid>> ShownByUser { get; } = [];

    public Dictionary<Guid, MovieVotes> VotesByMovie { get; } = [];

    public Dictionary<Guid, Dictionary<Guid, WatchMatchVote>> VotesByUser { get; } = [];

    public HashSet<Guid> GloballyRejectedMovieIds { get; } = [];

    public Guid? MatchMovieId { get; set; }

    public Guid? PlayWinnerUserId { get; set; }

    public string? EndReason { get; set; }
}

/// <summary>
/// Per-movie vote buckets.
/// </summary>
internal sealed class MovieVotes
{
    public HashSet<Guid> Approved { get; } = [];

    public HashSet<Guid> Rejected { get; } = [];
}
