(function () {
    'use strict';

    const state = {
        currentGroupId: null,
        streamAbort: null,
        reconnectTimer: null,
        retryDelay: 1200,
        lastEventId: null,
        preferences: { hideSeenHint: false },
        refreshInFlight: false,
        actionInFlight: false,
        cachedGroupId: undefined,
        cacheExpiry: 0
    };

    const GROUP_CACHE_MS = 8000;
    const POLL_INTERVAL_MS = 15000;

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
            // Return cached result if still valid
            if (!forceRefresh && state.cachedGroupId !== undefined && Date.now() < state.cacheExpiry) {
                return state.cachedGroupId;
            }
            try {
                const [groups, sessions] = await Promise.all([
                    this.ajax('SyncPlay/List', 'GET'),
                    this.ajax('Sessions?ControllableByUserId=' + this.getCurrentUserId(), 'GET')
                ]);
                if (!groups?.length) {
                    state.cachedGroupId = null;
                    state.cacheExpiry = Date.now() + GROUP_CACHE_MS;
                    return null;
                }
                const me = sessions?.find(s => s.DeviceId === this.deviceId());
                if (!me) {
                    state.cachedGroupId = null;
                    state.cacheExpiry = Date.now() + GROUP_CACHE_MS;
                    return null;
                }
                const myGroup = groups.find(g => g.Participants?.includes(me.UserName));
                const result = myGroup?.GroupId || null;
                state.cachedGroupId = result;
                state.cacheExpiry = Date.now() + GROUP_CACHE_MS;
                return result;
            } catch {
                return state.cachedGroupId ?? null;
            }
        },
        // No playMovie method needed — playback is handled by navigateAndAutoPlay
        url(path) {
            return this.getApiClient().getUrl(path);
        },
        token() {
            return this.getApiClient().accessToken();
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
            // Jellyfin 10.9+ returns a fetch Response, older versions return the parsed JSON directly
            if (response && typeof response.json === 'function') {
                return response.json();
            }
            return response;
        }
    };

    window.watchmatchJellyfinAdapter = adapter;

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

    let isInjecting = false;
    async function injectWatchMatchMenu(menu) {
        if (isInjecting) return;
        isInjecting = true;
        try {
            // Wait for the scroller to be added by Jellyfin
            let scroller = null;
            for (let i = 0; i < 20; i++) {
                scroller = menu.querySelector('.actionSheetScroller');
                if (scroller) break;
                await new Promise(r => setTimeout(r, 50));
            }
            if (!scroller) return;

            // Ensure we have the latest group state
            const groupId = await adapter.getCurrentGroupId(true);
            state.currentGroupId = groupId;
            if (!groupId) return;

            // Prevent duplicate injection
            if (scroller.querySelector('.watchmatch-launch-menu')) return;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'listItem listItem-button actionSheetMenuItem listItem-border emby-button watchmatch-launch-menu';
        
        let isRunning = false;
        try {
            const session = await adapter.ajax(`WatchMatch/Session/${groupId}`, 'GET');
            if (session.uiState === 'session_already_running_locked') {
                isRunning = true;
            }
        } catch {}

        btn.innerHTML = `
            <span class="actionsheetMenuItemIcon md-icon material-icons">local_play</span>
            <div class="listItemBody">
                <div class="listItemBodyText actionSheetItemText" style="color: #00a4dc; font-weight: bold;">WatchMatch</div>
                <div class="listItemBodyText secondary">${isRunning ? 'Läuft bereits...' : 'Starten'}</div>
            </div>
        `;

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // Close the Jellyfin SyncPlay dialog
            const closeBtn = menu.closest('.dialogContainer, .actionSheet')?.querySelector('.btnCancel') || 
                             menu.closest('.dialogContainer, .actionSheet')?.querySelector('button[data-action="close"]');
            if (closeBtn) closeBtn.click();
            else {
                document.querySelector('.dialogBackdrop')?.remove();
                menu.closest('.dialogContainer, .actionSheet')?.remove();
            }

            if (!isRunning) openWatchMatch();
        });

        // Insert near the top
        scroller.insertBefore(btn, scroller.firstChild);
        } finally {
            isInjecting = false;
        }
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
            // Force-refresh the group ID when opening
            state.currentGroupId = await adapter.getCurrentGroupId(true);
            if (!state.currentGroupId) return;
            ensureUi();
            document.querySelector('.watchmatch-modal').classList.add('is-open');
            const body = document.querySelector('.watchmatch-body');
            body.innerHTML = '<div class="watchmatch-status">Lade...</div>';
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
            state.preferences = await adapter.ajax('WatchMatch/Preferences', 'GET');
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
            if (!result.startPlayback || !result.movieId) return;
            // The server broadcasts PlayStarting to all clients via SSE.
            // renderState will pick it up and call navigateAndAutoPlay for everyone.
            // For the clicking client, renderState runs synchronously below:
            await renderState(result);
        } catch (err) {
            console.error('WatchMatch play error:', err);
        } finally {
            state.actionInFlight = false;
        }
    }

    async function renderState(model) {
        const body = document.querySelector('.watchmatch-body');
        if (!body) return;

        if (model.uiState === 'session_already_running_locked') {
            body.innerHTML = '<div class="watchmatch-status">Diese WatchMatch-Runde laeuft bereits. Starte nach dem aktuellen Match eine neue Runde.</div>';
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
            // Navigate ALL clients to the movie detail page and auto-click Play.
            const movieId = model.matchMovie?.id;
            if (movieId) {
                closeWatchMatch();
                navigateAndAutoPlay(movieId);
            } else {
                body.innerHTML = '<div class="watchmatch-status">Playback wird gestartet...</div>';
            }
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
            `<div class="watchmatch-meta">${escapeHtml([year, runtime, genres].filter(Boolean).join(' · '))}</div>`,
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
        } catch {
            if (!signal.aborted) {
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
            renderState(evt.state);
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
        // Navigate to the movie detail page
        window.location.hash = `#/details?id=${movieId}`;

        // Show a countdown overlay
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

            // Try to find and click the Play button
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
        return String(value || '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    // Watch for Jellyfin dialogs opening (specifically SyncPlay menu)
    const dialogObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) {
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
        }
    });
    
    // Also inject CSS immediately
    ensureUi();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => dialogObserver.observe(document.body, { childList: true, subtree: true }));
    } else {
        dialogObserver.observe(document.body, { childList: true, subtree: true });
    }
}());
