# WatchMatch for Jellyfin 10.11.x

WatchMatch adds a small-group movie matching flow to Jellyfin SyncPlay. It is built for 2-3 people who want to agree on a movie without manually browsing a large library.

This repository contains two pieces:

- `server/Jellyfin.Plugin.WatchMatch`: Jellyfin server plugin with REST endpoints, in-memory session state, votes, movie queue construction and authenticated `fetch()` streaming.
- `web`: Jellyfin Web injection assets for the WatchMatch button, swipe UI and match screen.

## Hard Requirements

- Jellyfin `10.11.x`.
- Jellyfin Web. Other clients are not supported in v1.
- The File Transformation plugin is required to inject `web/watchmatch.js` and `web/watchmatch.css` into Jellyfin Web.
- Working Jellyfin SyncPlay and WebSockets are required for the final Play action.
- WatchMatch state is in-memory only. Sessions do not survive Jellyfin/plugin restarts.

## Install Through Jellyfin Plugin Repositories

Add this repository URL in Jellyfin Admin Dashboard -> Plugins -> Repositories:

```text
https://raw.githubusercontent.com/Mairik4090/WatchMatch/refs/heads/main/manifest.json
```

Then open the plugin catalog and install WatchMatch like any other Jellyfin plugin.

## What WatchMatch Does

1. A WatchMatch button appears inside the SyncPlay group menu while the user is in a SyncPlay group.
2. Participants press ready.
3. When all currently active frozen participants are ready, WatchMatch builds a randomized queue of Jellyfin `Movie` items.
4. Each participant swipes independently. Faster users can be far ahead of slower users.
5. Normal rejects apply only to the rejecting user.
6. A match happens when the current active participant count equals the approval count for one movie.
7. All clients move to the match screen.
8. `Weiter` rejects that movie globally and returns every user to their own queue position.
9. `Play` calls `POST /WatchMatch/Session/{groupId}/play`; the first valid caller wins and then invokes Jellyfin's existing SyncPlay `SetNewQueue` flow.

## Design Notes

- SyncPlay is used as group/playback anchor only. WatchMatch does not add custom SyncPlay websocket messages.
- Realtime updates use authenticated `fetch()` streaming with `text/event-stream`. Native `EventSource` is intentionally avoided because it cannot send Jellyfin auth headers.
- `Last-Event-ID` is accepted only as reconnect/debug context. v1 does not buffer or replay events.
- All mutations for one `groupId` are serialized through a per-group `SemaphoreSlim`.
- Movies are filtered centrally through `CanAllParticipantsAccess(movie, participantUserIds)`.
- Watched status from Jellyfin `UserData.Played` is informational only and never filters the queue in v1.

## Membership Rules

- `participantUserIds` are frozen when the WatchMatch session starts.
- `activeUserIds` are frozen participants still present in the SyncPlay group.
- Late joiners see a locked state and cannot vote or subscribe to the stream.
- If a participant disconnects and rejoins, v1 treats that user as a late joiner.
- If fewer than two frozen participants remain active, the session aborts.

## Known v1 Limitation

If the winning client receives `{ "startPlayback": true }` from `/play` but crashes before calling Jellyfin SyncPlay `SetNewQueue`, the server can remain in `play_starting`. This is documented for v1 instead of adding heavier server-side playback orchestration.

## File Transformation

Install the server plugin first, then inject the web assets. The descriptor in `web/file-transformation/watchmatch.transform.json` shows the intended transformation:

```html
<link rel="stylesheet" href="/WatchMatch/Assets/watchmatch.css">
<script src="/WatchMatch/Assets/watchmatch.js"></script>
```

File Transformation plugin versions may use slightly different descriptor schemas, so adapt the provided JSON to the installed plugin version.

The web script intentionally keeps Jellyfin Web internals behind `window.watchmatchJellyfinAdapter` so future Jellyfin Web changes are isolated to one small compatibility layer.

## Build

The project targets `net9.0` and pins Jellyfin package references to `10.11.0`.

```powershell
dotnet restore WatchMatch.sln
dotnet test WatchMatch.sln
dotnet publish server/Jellyfin.Plugin.WatchMatch/Jellyfin.Plugin.WatchMatch.csproj -c Release
```

## API

- `GET /WatchMatch/Session/{groupId}`
- `POST /WatchMatch/Session/{groupId}/ready`
- `POST /WatchMatch/Session/{groupId}/vote`
- `POST /WatchMatch/Session/{groupId}/continue`
- `POST /WatchMatch/Session/{groupId}/play`
- `POST /WatchMatch/Session/{groupId}/play-complete`
- `GET /WatchMatch/Session/{groupId}/events`
- `GET /WatchMatch/Preferences`
- `POST /WatchMatch/Preferences`

## Repository Status

This is a v1 implementation with server/session/web logic and unit tests for the pure state machine. Browser integration testing must be run against a real Jellyfin `10.11.x` development server.
