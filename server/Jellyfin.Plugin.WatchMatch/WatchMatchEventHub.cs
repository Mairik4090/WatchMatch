using System.Collections.Concurrent;
using System.Threading.Channels;
using Jellyfin.Plugin.WatchMatch.Models;

namespace Jellyfin.Plugin.WatchMatch;

/// <summary>
/// Lightweight in-memory fan-out for WatchMatch fetch-stream clients.
/// </summary>
public sealed class WatchMatchEventHub
{
    private readonly ConcurrentDictionary<(Guid GroupId, Guid UserId), ConcurrentDictionary<Guid, Channel<WatchMatchEventDto>>> _subscribers = [];
    private long _nextEventId;

    /// <summary>
    /// Subscribes to a group's event stream.
    /// </summary>
    public (Guid SubscriptionId, ChannelReader<WatchMatchEventDto> Reader) Subscribe(Guid groupId, Guid userId)
    {
        var channel = Channel.CreateUnbounded<WatchMatchEventDto>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });

        var id = Guid.NewGuid();
        _subscribers.GetOrAdd((groupId, userId), _ => [])[id] = channel;
        return (id, channel.Reader);
    }

    /// <summary>
    /// Removes a subscriber.
    /// </summary>
    public void Unsubscribe(Guid groupId, Guid userId, Guid subscriptionId)
    {
        var key = (groupId, userId);
        if (!_subscribers.TryGetValue(key, out var groupSubscribers))
        {
            return;
        }

        if (groupSubscribers.TryRemove(subscriptionId, out var channel))
        {
            channel.Writer.TryComplete();
        }

        if (groupSubscribers.IsEmpty)
        {
            _subscribers.TryRemove(key, out _);
        }
    }

    /// <summary>
    /// Publishes the current state. Events are not buffered or replayed in v1.
    /// </summary>
    public void Publish(Guid groupId, Guid userId, string type, WatchMatchStateDto state)
    {
        if (!_subscribers.TryGetValue((groupId, userId), out var groupSubscribers))
        {
            return;
        }

        var evt = new WatchMatchEventDto(Interlocked.Increment(ref _nextEventId), type, state);
        foreach (var subscriber in groupSubscribers)
        {
            subscriber.Value.Writer.TryWrite(evt);
        }
    }
}
