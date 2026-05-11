using Jellyfin.Plugin.WatchMatch;
using Jellyfin.Plugin.WatchMatch.Models;
using Xunit;

namespace Jellyfin.Plugin.WatchMatch.Tests;

public sealed class WatchMatchStateMachineTests
{
    [Fact]
    public void PerUserPositionsResumeAfterContinue()
    {
        var users = Users(3);
        var movies = Movies(8);
        var session = SwipingSession(users, movies);
        session.UserPositions[users[0]] = 5;
        session.UserPositions[users[1]] = 2;
        session.UserPositions[users[2]] = 7;

        WatchMatchStateMachine.ApplyVote(session, users[0], movies[5], WatchMatchVote.Approve);
        WatchMatchStateMachine.ApplyVote(session, users[1], movies[2], WatchMatchVote.Approve);
        WatchMatchStateMachine.ApplyVote(session, users[2], movies[7], WatchMatchVote.Approve);
        session.MatchMovieId = movies[2];
        session.Status = WatchMatchStatus.MatchFound;

        WatchMatchStateMachine.ContinueAfterMatch(session);

        Assert.Equal(6, session.UserPositions[users[0]]);
        Assert.Equal(3, session.UserPositions[users[1]]);
        Assert.Equal(8, session.UserPositions[users[2]]);
    }

    [Fact]
    public void ShownByUserPreventsDuplicateSuggestions()
    {
        var users = Users(2);
        var movies = Movies(2);
        var session = SwipingSession(users, movies);

        WatchMatchStateMachine.ApplyVote(session, users[0], movies[0], WatchMatchVote.Reject);
        WatchMatchStateMachine.ApplyVote(session, users[0], movies[1], WatchMatchVote.Reject);

        Assert.Null(WatchMatchStateMachine.GetCurrentMovieId(session, users[0]));
        Assert.Equal(movies[0], WatchMatchStateMachine.GetCurrentMovieId(session, users[1]));
    }

    [Fact]
    public void NormalRejectIsPerUserOnly()
    {
        var users = Users(2);
        var movies = Movies(1);
        var session = SwipingSession(users, movies);

        WatchMatchStateMachine.ApplyVote(session, users[0], movies[0], WatchMatchVote.Reject);

        Assert.Contains(users[0], session.VotesByMovie[movies[0]].Rejected);
        Assert.Empty(session.GloballyRejectedMovieIds);
        Assert.Equal(movies[0], WatchMatchStateMachine.GetCurrentMovieId(session, users[1]));
    }

    [Fact]
    public void ContinueRejectsMatchGloballyAndCleansVotes()
    {
        var users = Users(2);
        var movies = Movies(2);
        var session = SwipingSession(users, movies);

        WatchMatchStateMachine.ApplyVote(session, users[0], movies[0], WatchMatchVote.Approve);
        WatchMatchStateMachine.ApplyVote(session, users[1], movies[0], WatchMatchVote.Approve);
        WatchMatchStateMachine.ContinueAfterMatch(session);

        Assert.Contains(movies[0], session.GloballyRejectedMovieIds);
        Assert.False(session.VotesByMovie.ContainsKey(movies[0]));
        Assert.All(session.VotesByUser.Values, votes => Assert.False(votes.ContainsKey(movies[0])));
    }

    [Fact]
    public void PlayRequestIsFirstWinnerOnly()
    {
        var users = Users(2);
        var movies = Movies(1);
        var session = SwipingSession(users, movies);
        session.Status = WatchMatchStatus.MatchFound;
        session.MatchMovieId = movies[0];

        var first = WatchMatchStateMachine.TryStartPlay(session, users[0], out var movieId);
        var second = WatchMatchStateMachine.TryStartPlay(session, users[1], out _);

        Assert.True(first);
        Assert.Equal(movies[0], movieId);
        Assert.False(second);
        Assert.Equal(users[0], session.PlayWinnerUserId);
    }

    [Fact]
    public void ExhaustedWhenAllActiveUsersHaveNoCards()
    {
        var users = Users(2);
        var movies = Movies(1);
        var session = SwipingSession(users, movies);

        WatchMatchStateMachine.ApplyVote(session, users[0], movies[0], WatchMatchVote.Reject);
        Assert.Equal(WatchMatchStatus.Swiping, session.Status);

        WatchMatchStateMachine.ApplyVote(session, users[1], movies[0], WatchMatchVote.Reject);
        Assert.Equal(WatchMatchStatus.SessionExhausted, session.Status);
    }

    [Fact]
    public void LeaveBelowTwoActiveParticipantsAborts()
    {
        var users = Users(3);
        var session = SwipingSession(users, Movies(3));

        WatchMatchStateMachine.ReconcileActiveUsers(session, [users[0]]);

        Assert.Equal(WatchMatchStatus.Aborted, session.Status);
        Assert.Equal(WatchMatchEndReasons.NotEnoughActiveParticipants, session.EndReason);
    }

    private static WatchMatchSession SwipingSession(IReadOnlyList<Guid> users, IReadOnlyList<Guid> movies)
    {
        var session = new WatchMatchSession(Guid.NewGuid(), users)
        {
            Status = WatchMatchStatus.Swiping
        };
        session.MovieQueue.AddRange(movies);
        return session;
    }

    private static Guid[] Users(int count)
        => Enumerable.Range(0, count).Select(_ => Guid.NewGuid()).ToArray();

    private static Guid[] Movies(int count)
        => Enumerable.Range(0, count).Select(_ => Guid.NewGuid()).ToArray();
}
