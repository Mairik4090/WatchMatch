using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.WatchMatch;

/// <summary>
/// WatchMatch server configuration.
/// </summary>
public sealed class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets the maximum number of movies to load into a session queue.
    /// </summary>
    public int MaxQueueSize { get; set; } = 500;
}
