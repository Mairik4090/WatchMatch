using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.WatchMatch;

/// <summary>
/// Jellyfin server plugin entry point for WatchMatch.
/// </summary>
public sealed class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <summary>
    /// Gets the active plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("2ec90ca2-b8ab-40e8-9ddf-7502c27e9a44");

    /// <inheritdoc />
    public override string Name => "WatchMatch";

    /// <inheritdoc />
    public override string Description => "Small-group movie matching for Jellyfin SyncPlay.";

    /// <inheritdoc />
    public override string ConfigurationFileName => "Jellyfin.Plugin.WatchMatch.xml";

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = Name,
            EmbeddedResourcePath = GetType().Namespace + ".Configuration.config.html"
        };
    }
}
