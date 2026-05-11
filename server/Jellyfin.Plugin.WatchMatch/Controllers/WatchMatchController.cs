using System.Text.Json;
using System.Reflection;
using Jellyfin.Plugin.WatchMatch.Models;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.WatchMatch.Controllers;

/// <summary>
/// WatchMatch REST and fetch-stream API.
/// </summary>
[Authorize]
[ApiController]
[Route("WatchMatch")]
public sealed class WatchMatchController : ControllerBase
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly WatchMatchEventHub _eventHub;
    private readonly WatchMatchSessionService _service;

    /// <summary>
    /// Initializes a new instance of the <see cref="WatchMatchController"/> class.
    /// </summary>
    public WatchMatchController(WatchMatchEventHub eventHub, WatchMatchSessionService service)
    {
        _eventHub = eventHub;
        _service = service;
    }

    /// <summary>
    /// Serves the lightweight Jellyfin Web injection assets embedded in this plugin.
    /// </summary>
    [HttpGet("Assets/{assetName}")]
    [AllowAnonymous]
    public ActionResult Asset([FromRoute] string assetName)
    {
        var contentType = assetName.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
            ? "text/css"
            : "application/javascript";
        var resourceName = $"Jellyfin.Plugin.WatchMatch.Assets.{assetName}";
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName);
        return stream is null ? NotFound() : File(stream, contentType);
    }

    /// <summary>
    /// Gets current session state for the caller.
    /// </summary>
    [HttpGet("Session/{groupId:guid}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<WatchMatchStateDto>> GetState([FromRoute] Guid groupId, CancellationToken cancellationToken)
    {
        var session = await _service.GetCurrentSessionAsync(HttpContext).ConfigureAwait(false);
        return Ok(await _service.GetStateAsync(groupId, session, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Marks the caller as ready.
    /// </summary>
    [HttpPost("Session/{groupId:guid}/ready")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<WatchMatchStateDto>> Ready([FromRoute] Guid groupId, CancellationToken cancellationToken)
    {
        var session = await _service.GetCurrentSessionAsync(HttpContext).ConfigureAwait(false);
        return Ok(await _service.ReadyAsync(groupId, session, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Records one swipe vote.
    /// </summary>
    [HttpPost("Session/{groupId:guid}/vote")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<WatchMatchStateDto>> Vote(
        [FromRoute] Guid groupId,
        [FromBody] VoteRequestDto request,
        CancellationToken cancellationToken)
    {
        var session = await _service.GetCurrentSessionAsync(HttpContext).ConfigureAwait(false);
        return Ok(await _service.VoteAsync(groupId, session, request.MovieId, request.Vote, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Rejects the current match globally and resumes swiping.
    /// </summary>
    [HttpPost("Session/{groupId:guid}/continue")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<WatchMatchStateDto>> Continue([FromRoute] Guid groupId, CancellationToken cancellationToken)
    {
        var session = await _service.GetCurrentSessionAsync(HttpContext).ConfigureAwait(false);
        return Ok(await _service.ContinueAsync(groupId, session, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Starts the first-wins play handoff.
    /// </summary>
    [HttpPost("Session/{groupId:guid}/play")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<PlayResponseDto>> Play([FromRoute] Guid groupId, CancellationToken cancellationToken)
    {
        var session = await _service.GetCurrentSessionAsync(HttpContext).ConfigureAwait(false);
        return Ok(await _service.PlayAsync(groupId, session, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Confirms that the winning client has invoked Jellyfin's SyncPlay queue endpoint.
    /// </summary>
    [HttpPost("Session/{groupId:guid}/play-complete")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<ActionResult> PlayComplete([FromRoute] Guid groupId, CancellationToken cancellationToken)
    {
        var session = await _service.GetCurrentSessionAsync(HttpContext).ConfigureAwait(false);
        await _service.CompletePlaybackHandoffAsync(groupId, session, cancellationToken).ConfigureAwait(false);
        return NoContent();
    }

    /// <summary>
    /// Gets current user preferences.
    /// </summary>
    [HttpGet("Preferences")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<WatchMatchPreferencesDto>> GetPreferences()
    {
        var session = await _service.GetCurrentSessionAsync(HttpContext).ConfigureAwait(false);
        return Ok(_service.GetPreferences(session.UserId));
    }

    /// <summary>
    /// Updates current user preferences.
    /// </summary>
    [HttpPost("Preferences")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<WatchMatchPreferencesDto>> SetPreferences([FromBody] PreferencesRequestDto request)
    {
        var session = await _service.GetCurrentSessionAsync(HttpContext).ConfigureAwait(false);
        return Ok(_service.SetPreferences(session.UserId, new WatchMatchPreferencesDto(request.HideSeenHint)));
    }

    /// <summary>
    /// Streams WatchMatch events with authenticated fetch().
    /// Last-Event-ID is accepted for diagnostics only; v1 does not replay buffered events.
    /// </summary>
    [HttpGet("Session/{groupId:guid}/events")]
    [Produces("text/event-stream")]
    public async Task Events([FromRoute] Guid groupId)
    {
        var currentSession = await _service.GetCurrentSessionAsync(HttpContext).ConfigureAwait(false);
        if (!_service.CanStream(groupId, currentSession.UserId))
        {
            Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        Response.Headers.CacheControl = "no-store";
        Response.Headers.ContentType = "text/event-stream";

        var (subscriptionId, reader) = _eventHub.Subscribe(groupId, currentSession.UserId);
        try
        {
            await WriteCommentAsync("connected", HttpContext.RequestAborted).ConfigureAwait(false);
            while (!HttpContext.RequestAborted.IsCancellationRequested)
            {
                var readTask = reader.WaitToReadAsync(HttpContext.RequestAborted).AsTask();
                var heartbeatTask = Task.Delay(TimeSpan.FromSeconds(20), HttpContext.RequestAborted);
                var completed = await Task.WhenAny(readTask, heartbeatTask).ConfigureAwait(false);
                if (completed == heartbeatTask)
                {
                    await WriteCommentAsync("heartbeat", HttpContext.RequestAborted).ConfigureAwait(false);
                    continue;
                }

                if (!await readTask.ConfigureAwait(false))
                {
                    break;
                }

                while (reader.TryRead(out var evt))
                {
                    await WriteEventAsync(evt, HttpContext.RequestAborted).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            _eventHub.Unsubscribe(groupId, currentSession.UserId, subscriptionId);
        }
    }

    private async Task WriteEventAsync(WatchMatchEventDto evt, CancellationToken cancellationToken)
    {
        await Response.WriteAsync($"id: {evt.Id}\n", cancellationToken).ConfigureAwait(false);
        await Response.WriteAsync($"event: {evt.Type}\n", cancellationToken).ConfigureAwait(false);
        await Response.WriteAsync("data: ", cancellationToken).ConfigureAwait(false);
        await JsonSerializer.SerializeAsync(Response.Body, evt, JsonOptions, cancellationToken).ConfigureAwait(false);
        await Response.WriteAsync("\n\n", cancellationToken).ConfigureAwait(false);
        await Response.Body.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task WriteCommentAsync(string comment, CancellationToken cancellationToken)
    {
        await Response.WriteAsync($": {comment}\n\n", cancellationToken).ConfigureAwait(false);
        await Response.Body.FlushAsync(cancellationToken).ConfigureAwait(false);
    }
}
