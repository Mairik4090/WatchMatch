(function () {
    'use strict';

    const state = {
        currentGroupId: null,
        streamAbort: null,
        reconnectTimer: null,
        retryDelay: 1200,
        lastEventId: null,
        preferences: { hideSeenHint: false }
    };

    const adapter = {
        getApiClient() {
            if (window.ApiClient) return window.ApiClient;
            if (window.ServerConnections?.currentApiClient) return window.ServerConnections.currentApiClient();
            throw new Error('No Jellyfin ApiClient available.');
        },
        getCurrentUserId() {
            return this.getApiClient().getCurrentUserId();
        },
        getCurrentGroupId() {
            const manager = window.SyncPlay?.Manager || window.__watchMatchSyncPlayManager;
            return manager?.getGroupInfo?.()?.GroupId || null;
        },
        async setSyncPlayQueue(movieId) {
            const apiClient = this.getApiClient();
            return apiClient.requestSyncPlaySetNewQueue({
                PlayingQueue: [movieId],
                PlayingItemPosition: 0,
                StartPositionTicks: 0
            });
        },
        url(path) {
            return this.getApiClient().getUrl(path);
        },
        token() {
            return this.getApiClient().accessToken();
        },
        ajax(path, method, body) {
            const apiClient = this.getApiClient();
            return apiClient.ajax({
                url: apiClient.getUrl(path),
                type: method,
                contentType: 'application/json',
                dataType: 'json',
                data: body ? JSON.stringify(body) : undefined
            });
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

        if (!document.querySelector('.watchmatch-launch')) {
            const button = document.createElement('button');
            button.className = 'watchmatch-launch';
            button.type = 'button';
            button.textContent = 'WatchMatch starten';
            button.addEventListener('click', openWatchMatch);
            document.body.appendChild(button);
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

    async function refreshButton() {
        ensureUi();
        const button = document.querySelector('.watchmatch-launch');
        const groupId = adapter.getCurrentGroupId();
        state.currentGroupId = groupId;
        if (!groupId) {
            button.classList.remove('is-visible');
            return;
        }

        button.classList.add('is-visible');
        try {
            const session = await adapter.ajax(`WatchMatch/Session/${groupId}`, 'GET');
            if (session.uiState === 'session_already_running_locked') {
                button.textContent = 'WatchMatch laeuft';
                button.disabled = true;
            } else {
                button.textContent = 'WatchMatch starten';
                button.disabled = false;
            }
        } catch {
            button.textContent = 'WatchMatch starten';
            button.disabled = false;
        }
    }

    async function openWatchMatch() {
        state.currentGroupId = adapter.getCurrentGroupId();
        if (!state.currentGroupId) return;
        ensureUi();
        document.querySelector('.watchmatch-modal').classList.add('is-open');
        await loadPreferences();
        await renderState(await adapter.ajax(`WatchMatch/Session/${state.currentGroupId}/ready`, 'POST'));
        connectStream();
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
        const result = await adapter.ajax(`WatchMatch/Session/${state.currentGroupId}/vote`, 'POST', {
            movieId,
            vote: voteValue
        });
        await renderState(result);
    }

    async function continueMatch() {
        const result = await adapter.ajax(`WatchMatch/Session/${state.currentGroupId}/continue`, 'POST');
        await renderState(result);
    }

    async function playMatch() {
        const result = await adapter.ajax(`WatchMatch/Session/${state.currentGroupId}/play`, 'POST');
        if (!result.startPlayback || !result.movieId) return;
        await adapter.setSyncPlayQueue(result.movieId);
        await adapter.ajax(`WatchMatch/Session/${state.currentGroupId}/play-complete`, 'POST');
        closeWatchMatch();
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
            body.innerHTML = '<div class="watchmatch-status">Playback wird in SyncPlay gestartet.</div>';
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
        const evt = JSON.parse(data.join('\n'));
        renderState(evt.state);
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

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    window.addEventListener('hashchange', refreshButton);
    window.addEventListener('focus', refreshButton);
    window.setInterval(refreshButton, 5000);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', refreshButton);
    } else {
        refreshButton();
    }
}());
