import { getState, dispatch, subscribe } from '../state/redux';
import { networkClient, type RoomInfo, type NetworkPlayer } from '../utils/network';

const PLAYER_LABEL = ['P1', 'P2', 'P3', 'P4'];
const PLAYER_NEON = ['#00e5ff', '#c084fc', '#3b82f6', '#ff3d6e'];

/**
 * Modern multiplayer lobby, rendered as a DOM overlay (matches the title
 * screen). The existing Lobby class still owns the socket connection; this
 * overlay only reads networkClient's public state and drives its methods.
 */
export function initLobbyOverlay(): void {
  const root = document.createElement('div');
  root.id = 'lobby-overlay';
  root.innerHTML = `
    <div class="lo-scanlines"></div>
    <div class="lo-inner">
      <div class="lo-head">
        <button class="lo-back" data-act="back" aria-label="Back">‹ BACK</button>
        <h2 class="lo-title">MULTIPLAYER</h2>
        <div class="lo-status" id="lo-status">Connecting…</div>
      </div>
      <div class="lo-body" id="lo-body"></div>
    </div>
  `;
  document.body.appendChild(root);

  const statusEl = root.querySelector<HTMLDivElement>('#lo-status')!;
  const bodyEl = root.querySelector<HTMLDivElement>('#lo-body')!;
  const playerName = 'Player-' + Math.floor(Math.random() * 1000);

  const render = () => {
    const inLobby = getState().currentScreenCode === 'LOBBY';
    root.style.display = inLobby ? 'flex' : 'none';
    if (!inLobby) return;

    const connected = networkClient.isConnected;
    statusEl.textContent = connected ? 'ONLINE' : 'CONNECTING…';
    statusEl.className = `lo-status ${connected ? 'ok' : 'warn'}`;

    if (!connected) {
      bodyEl.innerHTML = `<div class="lo-empty">Connecting to server…</div>`;
      return;
    }

    const inRoom = !!networkClient.currentRoomId;
    if (inRoom) renderRoom();
    else renderRoomList();
  };

  const renderRoomList = () => {
    const rooms = networkClient.roomList;
    const cards = rooms
      .map((r: RoomInfo, i: number) => {
        const full = r.playerCount >= r.maxPlayers;
        const playing = r.status === 'IN_PROGRESS';
        const disabled = full || playing;
        const accent = PLAYER_NEON[i % PLAYER_NEON.length];
        // player-slot dots
        const dots = [0, 1, 2, 3]
          .map((s) => `<span class="lo-dot ${s < r.playerCount ? 'on' : ''}"></span>`)
          .join('');
        return `
        <button class="lo-room ${disabled ? 'disabled' : ''}" data-act="join" data-room="${r.id}"
                style="--accent:${accent}" ${disabled ? 'disabled' : ''}>
          <span class="lo-room-accent"></span>
          <span class="lo-room-left">
            <span class="lo-room-name">${escapeHtml(r.name)}</span>
            <span class="lo-dots">${dots}</span>
          </span>
          <span class="lo-room-meta">
            <span class="lo-count">${r.playerCount}<span class="lo-count-max">/${r.maxPlayers}</span></span>
            <span class="lo-badge ${playing ? 'live' : 'open'}">${playing ? 'IN GAME' : 'OPEN'}</span>
            <span class="lo-enter">ENTER ›</span>
          </span>
        </button>`;
      })
      .join('');

    bodyEl.innerHTML = `
      <div class="lo-subhead">
        <span>SELECT A ROOM</span>
        <button class="lo-ghost" data-act="refresh">↻ Refresh</button>
      </div>
      <div class="lo-rooms">${cards || '<div class="lo-empty">No rooms available. Refresh to check again.</div>'}</div>
    `;
  };

  const renderRoom = () => {
    const players = networkClient.lobbyState?.players ?? [];
    const slots = [0, 1, 2, 3]
      .map((i) => {
        const p = players.find((pl: NetworkPlayer) => pl.color === i);
        const filled = !!p;
        return `
        <div class="lo-slot ${filled ? 'filled' : ''}" style="--accent:${PLAYER_NEON[i]}">
          <div class="lo-slot-label">${PLAYER_LABEL[i]}</div>
          <div class="lo-slot-name">${filled ? escapeHtml(p!.name).slice(0, 12) : '—'}</div>
        </div>`;
      })
      .join('');

    const count = players.length;
    const canStart = count >= 2;
    bodyEl.innerHTML = `
      <section class="lo-room-panel">
        <div class="lo-panel-head">
          <span class="lo-panel-title">WAITING ROOM</span>
          <span class="lo-panel-count ${canStart ? 'ok' : 'warn'}">
            <b>${count}</b><span>/4</span>
            <em>${canStart ? 'READY' : 'WAITING FOR PLAYERS'}</em>
          </span>
        </div>
        <div class="lo-slots">${slots}</div>
      </section>

      <div class="lo-room-actions">
        <button class="lo-btn primary ${canStart ? '' : 'is-disabled'}" data-act="start">START GAME</button>
        <button class="lo-btn ghost" data-act="leave">LEAVE ROOM</button>
      </div>
      ${canStart ? '' : '<div class="lo-hint-line">At least 2 players are required to start.</div>'}
    `;
  };

  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'back':
        if (networkClient.currentRoomId) networkClient.leaveRoom();
        networkClient.disconnect();
        dispatch({ type: 'SET_SCREEN', payload: { screen: 'TITLE' } });
        break;
      case 'refresh':
        networkClient.getRoomList();
        break;
      case 'join':
        if (btn.dataset.room) networkClient.joinRoom(btn.dataset.room, playerName);
        break;
      case 'start':
        if ((networkClient.lobbyState?.players.length ?? 0) >= 2) networkClient.startGame();
        break;
      case 'leave':
        networkClient.leaveRoom();
        break;
    }
  });

  // Re-render on any network event + on screen change
  const events = [
    'connected', 'disconnected', 'connection-error', 'room-list',
    'room-update', 'join-success', 'join-error', 'leave-success',
    'game-started', 'game-ended', 'server-shutdown',
  ];
  for (const ev of events) networkClient.on(ev, () => render());
  subscribe(render);
  render();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );
}
