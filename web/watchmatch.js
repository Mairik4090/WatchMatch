(function () {
    'use strict';

    const state = {
        currentGroupId: null,
        streamAbort: null,
        reconnectTimer: null,
        retryDelay: 1200,
        lastEventId: null,
        preferences: { hideSeenHint: false },
        actionInFlight: false,
        cachedGroupId: undefined,
        cacheExpiry: 0
    };

    const GROUP_CACHE_MS = 1000;
    const API_READY_TIMEOUT_MS = 20000;
    const API_READY_INTERVAL_MS = 250;
    const injectedMenus = new WeakSet();
    let globalClickHandlerRegistered = false;

    const adapter = {
        getApiClient() {
            if (window.ApiClient) return window.ApiClient;
            if (window.ServerConnections?.currentApiClient) return window.ServerConnections.currentApiClient();
            throw new Error('No Jellyfin ApiClient available.');
        },
        getCurrentUserId() {
            return this.getApiClient().getCurrentUserId();
        },
        deviceId() {
            return this.getApiClient().deviceId();
        },
        async getCurrentGroupId(forceRefresh) {
            if (!forceRefresh && state.cachedGroupId !== undefined && Date.now() < state.cacheExpiry) {
                return state.cachedGroupId;
            }

            try {
                const [groups, sessions] = await Promise.all([
                    this.ajax('SyncPlay/List', 'GET'),
                    this.ajax('Sessions?ControllableByUserId=' + this.getCurrentUserId(), 'GET')
                ]);

                if (!groups?.length) {
                    return rememberGroupId(null);
                }

                const me = sessions?.find(session => session.DeviceId === this.deviceId());
                if (!me) {
                    return rememberGroupId(null);
                }

                const myGroup = groups.find(group => group.Participants?.includes(me.UserName));
                return rememberGroupId(myGroup?.GroupId || null);
            } catch (err) {
                console.warn('WatchMatch: failed to resolve SyncPlay group.', err);
                return state.cachedGroupId ?? null;
            }
        },
        url(path) {
            return this.getApiClient().getUrl(path);
        },
        token() {
            return this.getApiClient().accessToken();
        },
        authHeader() {
            const apiClient = this.getApiClient();
            const deviceId = apiClient.deviceId();
            return `MediaBrowser Client="Jellyfin Web", Device="Jellyfin Web", DeviceId="${deviceId}", Version="10.11.0", Token="${this.token()}"`;
        },
        async ajax(path, method, body) {
            const apiClient = this.getApiClient();
            const response = await apiClient.ajax({
                url: apiClient.getUrl(path),
                type: method,
                contentType: 'application/json',
                dataType: 'json',
                data: body ? JSON.stringify(body) : undefined
            });

            if (response && typeof response.json === 'function') {
                return normalizeApiPayload(await response.json());
            }

            return normalizeApiPayload(response);
        }
    };

    window.watchmatchJellyfinAdapter = adapter;

    function rememberGroupId(groupId) {
        state.cachedGroupId = groupId;
        state.cacheExpiry = Date.now() + GROUP_CACHE_MS;
        return groupId;
    }

    function ensureUi() {
        if (!document.querySelector('#watchmatch-style')) {
            const link = document.createElement('link');
            link.id = 'watchmatch-style';
            link.rel = 'stylesheet';
            link.href = adapter.url('WatchMatch/Assets/watchmatch.css');
            document.head.appendChild(link);
        }

        if (!document.querySelector('.watchmatch-modal')) {
            const modal = document.createElement('div');
            modal.className = 'watchmatch-modal';
            modal.innerHTML = [
                '<div class="watchmatch-shell" role="dialog" aria-modal="true" aria-label="WatchMatch">',
                '<div class="watchmatch-topbar">',
                '<div class="watchmatch-title">WatchMatch</div>',
                '<label class="watchmatch-toggle"><input type="checkbox" class="watchmatch-hide-seen"> Gesehen-Hinweis ausblenden</label>',
                '<button type="button" class="watchmatch-close" aria-label="Schliessen">x</button>',
                '</div>',
                '<div class="watchmatch-body"></div>',
                '</div>'
            ].join('');
            modal.querySelector('.watchmatch-close').addEventListener('click', closeWatchMatch);
            modal.querySelector('.watchmatch-hide-seen').addEventListener('change', onSeenToggle);
            document.body.appendChild(modal);
        }
    }

    async function injectWatchMatchMenu(menu) {
        if (!menu || injectedMenus.has(menu)) return;
        injectedMenus.add(menu);

        try {
            let scroller = null;
            for (let i = 0; i < 20; i++) {
                scroller = menu.querySelector('.actionSheetScroller') || menu.closest('.actionSheetScroller');
                if (scroller) break;
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            if (!scroller || scroller.querySelector('.watchmatch-launch-menu')) return;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'listItem listItem-button actionSheetMenuItem listItem-border emby-button watchmatch-launch-menu';
            btn.innerHTML = menuButtonHtml('Pruefe Gruppe...');
            scroller.insertBefore(btn, scroller.firstChild);

            let groupId = null;
            let isRunning = false;
            try {
                groupId = await adapter.getCurrentGroupId(true);
                state.currentGroupId = groupId;
                if (groupId) {
                    const session = await adapter.ajax(`WatchMatch/Session/${groupId}`, 'GET');
                    isRunning = session.uiState === 'session_already_running_locked';
                }
            } catch (err) {
                console.warn('WatchMatch: could not resolve SyncPlay group state.', err);
            }

            if (!groupId) {
                btn.disabled = true;
                btn.innerHTML = menuButtonHtml('Erst Gruppe beitreten');
                return;
            }

            btn.innerHTML = menuButtonHtml(isRunning ? 'Laeuft bereits...' : 'Starten');
            btn.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                closeSyncPlayMenu(menu);
                openWatchMatch();
            });
        } catch (err) {
            injectedMenus.delete(menu);
            console.warn('WatchMatch: failed to inject SyncPlay menu button.', err);
        }
    }

    function menuButtonHtml(secondaryText) {
        return [
            '<span class="actionsheetMenuItemIcon md-icon material-icons">local_play</span>',
            '<div class="listItemBody">',
            '<div class="listItemBodyText actionSheetItemText" style="color: #00a4dc; font-weight: bold;">WatchMatch</div>',
            `<div class="listItemBodyText secondary">${escapeHtml(secondaryText)}</div>`,
            '</div>'
        ].join('');
    }

    function closeSyncPlayMenu(menu) {
        const containers = [
            menu.closest('.dialogContainer'),
            menu.closest('.actionSheet')
        ].filter(Boolean);
        const container = containers[0];
        const closeBtn = container?.querySelector('.btnCancel') ||
            container?.querySelector('button[data-action="close"]');
        if (closeBtn) {
            closeBtn.click();
        }

        window.setTimeout(() => {
            document.querySelectorAll('.dialogBackdrop').forEach(backdrop => backdrop.remove());
            containers.forEach(dialog => dialog.remove());
        }, 80);
    }

    function setActionButtons(disabled) {
        document.querySelectorAll('.watchmatch-action').forEach(btn => {
            btn.disabled = disabled;
            if (disabled) btn.classList.add('is-loading');
            else btn.classList.remove('is-loading');
        });
    }

    async function openWatchMatch() {
        if (state.actionInFlight) return;
        state.actionInFlight = true;
        try {
            state.currentGroupId = await adapter.getCurrentGroupId(true);
            ensureUi();
            document.querySelector('.watchmatch-modal').classList.add('is-open');
            const body = document.querySelector('.watchmatch-body');
            body.innerHTML = '<div class="watchmatch-status">Lade...</div>';

            if (!state.currentGroupId) {
                body.innerHTML = '<div class="watchmatch-status">Tritt zuerst einer SyncPlay-Gruppe bei.</div>';
                return;
            }

            await loadPreferences();
            await renderState(await adapter.ajax(`WatchMatch/Session/${state.currentGroupId}/ready`, 'POST'));
            connectStream();
        } catch (err) {
            const body = document.querySelector('.watchmatch-body');
            if (body) body.innerHTML = `<div class="watchmatch-status">Fehler: ${escapeHtml(err.message || 'Unbekannter Fehler')}</div>`;
        } finally {
            state.actionInFlight = false;
        }
    }

    function closeWatchMatch() {
        disconnectStream();
        document.querySelector('.watchmatch-modal')?.classList.remove('is-open');
    }

    async function loadPreferences() {
        try {
            state.preferences = normalizePreferences(await adapter.ajax('WatchMatch/Preferences', 'GET'));
            document.querySelector('.watchmatch-hide-seen').checked = !!state.preferences.hideSeenHint;
        } catch {
            state.preferences = { hideSeenHint: false };
        }
    }

    async function onSeenToggle(event) {
        state.preferences.hideSeenHint = event.currentTarget.checked;
        await adapter.ajax('WatchMatch/Preferences', 'POST', { hideSeenHint: state.preferences.hideSeenHint });
    }

    async function vote(movieId, voteValue) {
        if (state.actionInFlight) return;
        state.actionInFlight = true;
        setActionButtons(true);
        try {
            const result = await adapter.ajax(`WatchMatch/Session/${state.currentGroupId}/vote`, 'POST', {
                movieId,
                vote: voteValue
            });
            await renderState(result);
        } catch (err) {
            console.error('WatchMatch vote error:', err);
        } finally {
            state.actionInFlight = false;
        }
    }

    async function continueMatch() {
        if (state.actionInFlight) return;
        state.actionInFlight = true;
        setActionButtons(true);
        try {
            const result = await adapter.ajax(`WatchMatch/Session/${state.currentGroupId}/continue`, 'POST');
            await renderState(result);
        } catch (err) {
            console.error('WatchMatch continue error:', err);
        } finally {
            state.actionInFlight = false;
        }
    }

    async function playMatch() {
        if (state.actionInFlight) return;
        state.actionInFlight = true;
        setActionButtons(true);
        try {
            const result = await adapter.ajax(`WatchMatch/Session/${state.currentGroupId}/play`, 'POST');
            const play = normalizePlayResponse(result);
            if (play.startPlayback && play.movieId) {
                navigateAndAutoPlay(play.movieId);
            }
        } catch (err) {
            console.error('WatchMatch play error:', err);
        } finally {
            state.actionInFlight = false;
        }
    }

    async function renderState(model) {
        model = normalizeState(model);
        const body = document.querySelector('.watchmatch-body');
        if (!body) return;

        if (model.uiState === 'session_already_running_locked') {
            body.innerHTML = '<div class="watchmatch-status">Diese WatchMatch-Runde laeuft bereits. Starte nach dem aktuellen Match eine neue Runde.</div>';
            return;
        }

        if (model.uiState === 'not_enough_participants') {
            body.innerHTML = '<div class="watchmatch-status">WatchMatch braucht mindestens zwei aktive SyncPlay-Teilnehmer.</div>';
            return;
        }

        if (!model.status || model.reason === 'session_not_found') {
            body.innerHTML = '<div class="watchmatch-status">Session nicht mehr vorhanden.</div>';
            return;
        }

        if (model.status === 'Waiting') {
            body.innerHTML = `<div class="watchmatch-status">Bereit. Warte auf ${model.readyUserIds.length}/${model.memberCount} Mitglieder.</div>`;
            return;
        }

        if (model.status === 'Aborted') {
            body.innerHTML = '<div class="watchmatch-status">WatchMatch wurde beendet, weil weniger als zwei Teilnehmer aktiv sind.</div>';
            return;
        }

        if (model.status === 'SessionExhausted') {
            body.innerHTML = '<div class="watchmatch-status">Keine weiteren gemeinsamen Filmvorschlaege in dieser Runde.</div>';
            return;
        }

        if (model.status === 'MatchFound' && model.matchMovie) {
            body.innerHTML = cardHtml(model.matchMovie, true);
            body.querySelector('.watchmatch-action.neutral').addEventListener('click', continueMatch);
            body.querySelector('.watchmatch-action.play').addEventListener('click', playMatch);
            return;
        }

        if (model.status === 'PlayStarting' || model.status === 'Completed') {
            body.innerHTML = '<div class="watchmatch-status">Playback wird gestartet...</div>';
            return;
        }

        if (!model.currentMovie) {
            body.innerHTML = '<div class="watchmatch-status">Du hast alle verfuegbaren Karten dieser Runde gesehen.</div>';
            return;
        }

        body.innerHTML = cardHtml(model.currentMovie, false);
        body.querySelector('.watchmatch-action.reject').addEventListener('click', () => vote(model.currentMovie.id, 'Reject'));
        body.querySelector('.watchmatch-action.approve').addEventListener('click', () => vote(model.currentMovie.id, 'Approve'));
    }

    function cardHtml(movie, isMatch) {
        const poster = movie.hasPrimaryImage
            ? adapter.url(`Items/${movie.id}/Images/Primary?fillHeight=720&fillWidth=480&quality=90`)
            : '';
        const year = movie.productionYear ? String(movie.productionYear) : '';
        const runtime = movie.runTimeTicks ? `${Math.round(movie.runTimeTicks / 600000000)} min` : '';
        const genres = movie.genres?.length ? movie.genres.join(', ') : '';
        const seen = movie.played && !state.preferences.hideSeenHint
            ? '<div class="watchmatch-seen">Du hast das schon gesehen</div>'
            : '';
        const actions = isMatch
            ? '<div class="watchmatch-actions"><button type="button" class="watchmatch-action neutral">Weiter</button><button type="button" class="watchmatch-action play">Play</button></div>'
            : '<div class="watchmatch-actions"><button type="button" class="watchmatch-action reject">Links</button><button type="button" class="watchmatch-action approve">Rechts</button></div>';

        return [
            '<div>',
            '<article class="watchmatch-card">',
            `<div class="watchmatch-poster" style="background-image:url('${poster}')"></div>`,
            '<div class="watchmatch-card-body">',
            `<h2 class="watchmatch-movie-title">${escapeHtml(movie.name)}</h2>`,
            `<div class="watchmatch-meta">${escapeHtml([year, runtime, genres].filter(Boolean).join(' / '))}</div>`,
            seen,
            '</div>',
            '</article>',
            actions,
            '</div>'
        ].join('');
    }

    function connectStream() {
        disconnectStream();
        if (!state.currentGroupId) return;
        const abort = new AbortController();
        state.streamAbort = abort;
        streamLoop(abort.signal);
    }

    async function streamLoop(signal) {
        try {
            const headers = {
                Accept: 'text/event-stream',
                Authorization: adapter.authHeader(),
                'X-Emby-Authorization': adapter.authHeader(),
                'X-Emby-Token': adapter.token()
            };
            if (state.lastEventId) headers['Last-Event-ID'] = String(state.lastEventId);

            const response = await fetch(adapter.url(`WatchMatch/Session/${state.currentGroupId}/events`), {
                headers,
                signal
            });

            if (!response.ok) throw new Error(`WatchMatch stream failed: ${response.status}`);
            await readSse(response.body, signal);
            state.retryDelay = 1200;
            if (!signal.aborted) throw new Error('WatchMatch stream ended.');
        } catch (err) {
            if (!signal.aborted) {
                console.warn('WatchMatch stream disconnected; reloading state and reconnecting.', err);
                await reloadAfterReconnect();
                state.reconnectTimer = window.setTimeout(connectStream, state.retryDelay);
                state.retryDelay = Math.min(state.retryDelay * 1.7, 10000);
            }
        }
    }

    async function readSse(body, signal) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!signal.aborted) {
            const result = await reader.read();
            if (result.done) break;
            buffer += decoder.decode(result.value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop();
            for (const part of parts) handleSseBlock(part);
        }
    }

    function handleSseBlock(block) {
        block = block.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (!block || block.startsWith(':')) return;

        const lines = block.split('\n');
        const data = [];
        for (const line of lines) {
            if (line.startsWith('id:')) state.lastEventId = line.slice(3).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }

        if (!data.length) return;
        try {
            const evt = JSON.parse(data.join('\n'));
            renderState(evt.state || evt.State);
        } catch (err) {
            console.error('WatchMatch: failed to parse SSE event:', err);
        }
    }

    async function reloadAfterReconnect() {
        if (!state.currentGroupId) return;
        try {
            await renderState(await adapter.ajax(`WatchMatch/Session/${state.currentGroupId}`, 'GET'));
        } catch {
            const body = document.querySelector('.watchmatch-body');
            if (body) body.innerHTML = '<div class="watchmatch-status">Session nicht mehr vorhanden.</div>';
        }
    }

    function disconnectStream() {
        if (state.streamAbort) {
            state.streamAbort.abort();
            state.streamAbort = null;
        }
        if (state.reconnectTimer) {
            clearTimeout(state.reconnectTimer);
            state.reconnectTimer = null;
        }
    }

    function navigateAndAutoPlay(movieId) {
        closeWatchMatch();
        window.location.hash = `#/details?id=${movieId}`;

        let banner = document.querySelector('.watchmatch-autoplay-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.className = 'watchmatch-autoplay-banner';
            document.body.appendChild(banner);
        }

        let remaining = 5;
        banner.textContent = `WatchMatch: Film wird in ${remaining}s gestartet...`;
        banner.style.display = 'block';

        const countdown = setInterval(() => {
            remaining--;
            if (remaining > 0) {
                banner.textContent = `WatchMatch: Film wird in ${remaining}s gestartet...`;
                return;
            }
            clearInterval(countdown);

            const btn = document.querySelector('.btnPlay, [data-action="resume"], [data-action="play"]');
            if (btn) {
                banner.textContent = 'WatchMatch: Starte Wiedergabe...';
                btn.click();
                setTimeout(() => { banner.style.display = 'none'; }, 2000);
            } else {
                banner.textContent = 'WatchMatch: Klicke auf Play um zu starten';
                setTimeout(() => { banner.style.display = 'none'; }, 5000);
            }
        }, 1000);
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function normalizeApiPayload(payload) {
        if (!payload || typeof payload !== 'object') return payload;
        if ('UiState' in payload || 'uiState' in payload) return normalizeState(payload);
        if ('HideSeenHint' in payload || 'hideSeenHint' in payload) return normalizePreferences(payload);
        if ('StartPlayback' in payload || 'startPlayback' in payload) return normalizePlayResponse(payload);
        return payload;
    }

    function normalizePreferences(payload) {
        return {
            hideSeenHint: !!readProp(payload, 'hideSeenHint', 'HideSeenHint')
        };
    }

    function normalizePlayResponse(payload) {
        return {
            startPlayback: !!readProp(payload, 'startPlayback', 'StartPlayback'),
            movieId: readProp(payload, 'movieId', 'MovieId') || null
        };
    }

    function normalizeState(payload) {
        if (!payload || typeof payload !== 'object') {
            return {};
        }

        return {
            uiState: readProp(payload, 'uiState', 'UiState'),
            groupId: readProp(payload, 'groupId', 'GroupId'),
            status: readProp(payload, 'status', 'Status'),
            participantUserIds: readProp(payload, 'participantUserIds', 'ParticipantUserIds') || [],
            activeUserIds: readProp(payload, 'activeUserIds', 'ActiveUserIds') || [],
            readyUserIds: readProp(payload, 'readyUserIds', 'ReadyUserIds') || [],
            memberCount: readProp(payload, 'memberCount', 'MemberCount') || 0,
            currentMovie: normalizeMovie(readProp(payload, 'currentMovie', 'CurrentMovie')),
            matchMovie: normalizeMovie(readProp(payload, 'matchMovie', 'MatchMovie')),
            isUserReady: !!readProp(payload, 'isUserReady', 'IsUserReady'),
            isUserExhausted: !!readProp(payload, 'isUserExhausted', 'IsUserExhausted'),
            reason: readProp(payload, 'reason', 'Reason')
        };
    }

    function normalizeMovie(movie) {
        if (!movie || typeof movie !== 'object') return null;
        return {
            id: readProp(movie, 'id', 'Id'),
            name: readProp(movie, 'name', 'Name'),
            productionYear: readProp(movie, 'productionYear', 'ProductionYear'),
            genres: readProp(movie, 'genres', 'Genres') || [],
            runTimeTicks: readProp(movie, 'runTimeTicks', 'RunTimeTicks'),
            hasPrimaryImage: !!readProp(movie, 'hasPrimaryImage', 'HasPrimaryImage'),
            played: !!readProp(movie, 'played', 'Played')
        };
    }

    function readProp(source, camelName, pascalName) {
        if (!source || typeof source !== 'object') return undefined;
        return source[camelName] !== undefined ? source[camelName] : source[pascalName];
    }

    function scanForSyncPlayMenus() {
        document.querySelectorAll('.syncPlayGroupMenu').forEach(menu => {
            injectWatchMatchMenu(menu);
        });
    }

    async function waitForApiClient() {
        const started = Date.now();
        while (Date.now() - started < API_READY_TIMEOUT_MS) {
            try {
                adapter.getApiClient();
                return true;
            } catch {
                await new Promise(resolve => setTimeout(resolve, API_READY_INTERVAL_MS));
            }
        }

        return false;
    }

    async function startWatchMatchIntegration() {
        if (!await waitForApiClient()) {
            console.warn('WatchMatch: Jellyfin ApiClient was not ready; web integration disabled.');
            return;
        }

        const observerTarget = document.body || document.documentElement;
        if (!observerTarget) return;

        registerGlobalClickHandler();
        dialogObserver.observe(observerTarget, { childList: true, subtree: true });
        scanForSyncPlayMenus();
    }

    function registerGlobalClickHandler() {
        if (globalClickHandlerRegistered) return;
        globalClickHandlerRegistered = true;
        document.addEventListener('click', event => {
            if (event.target?.closest?.('.watchmatch-close')) {
                event.preventDefault();
                event.stopPropagation();
                closeWatchMatch();
            }
        }, true);
    }

    const dialogObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.classList.contains('syncPlayGroupMenu')) {
                    injectWatchMatchMenu(node);
                } else if (node.classList.contains('actionSheetScroller')) {
                    const menu = node.closest('.syncPlayGroupMenu');
                    if (menu) injectWatchMatchMenu(menu);
                } else if (node.querySelector) {
                    const menu = node.querySelector('.syncPlayGroupMenu');
                    if (menu) injectWatchMatchMenu(menu);
                }
            }
        }

        scanForSyncPlayMenus();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startWatchMatchIntegration);
    } else {
        startWatchMatchIntegration();
    }
}());
