import './onchain/polyfills';
import { OnchainClient, DIR } from './onchain/onchain';
import type { RoomView } from './onchain/onchain';
import { OnchainGame } from './game/onchain-game';
import { Title } from './menus/title';
import { Keyboard } from './utils/keyboard';
import { Options } from './menus/options';
import { Lobby } from './menus/lobby';
import { Game } from './game/game';
import { MultiplayerGame, setCurrentMultiplayerGame } from './game/multiplayer-game';
import { Action } from './state/actions';
import { GAMESTATUS } from './game/game-status';
import { GamePad } from './utils/gamepad';
import { GameUtils } from './utils/game-utils';
import { Character } from './game/character';
import { DIRECTION } from './game/direction';
import { networkClient } from './utils/network';
import { BackgroundMusicManager } from './utils/music';
import { initTitleOverlay } from './menus/title-overlay';
import { initEndgameOverlay } from './menus/endgame-overlay';
import { initLobbyOverlay } from './menus/lobby-overlay';
import { dispatch, getState, subscribe } from './state/redux';
import type { CanvasContext } from './types';
import type { Menu } from './menus/menu';

const screenWidth = 960;
const screenHeight = 640;

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
canvas.width = screenWidth;
canvas.height = screenHeight;
const ctx = canvas.getContext('2d')!;

const canvasContext: CanvasContext = {
  screenWidth,
  screenHeight,
  ctx,
};

const controller = new Keyboard();
controller.bind();
const gamepads = new GamePad();

let currentScreen: Menu | Game | MultiplayerGame | OnchainGame = new Title();

// ---- On-chain mode ------------------------------------------------------
const chain = new OnchainClient();
(window as any).chain = chain;

const banner = document.createElement('div');
banner.id = 'onchain-banner';
banner.style.display = 'none';
document.body.appendChild(banner);
const hideBanner = () => (banner.style.display = 'none');

// Centered "setting up" overlay with blurred backdrop, shown until the match
// goes live in the rollup.
const setupEl = document.createElement('div');
setupEl.id = 'setup-overlay';
setupEl.innerHTML = `
  <div class="su-inner">
    <div class="su-spinner"></div>
    <div class="su-title">SETTING UP ON-CHAIN MATCH</div>
    <div class="su-sub" id="su-sub">Creating the arena on Solana…</div>
  </div>`;
setupEl.style.display = 'none';
document.body.appendChild(setupEl);
const showSetup = (sub?: string) => {
  if (sub) setupEl.querySelector<HTMLDivElement>('#su-sub')!.textContent = sub;
  setupEl.style.display = 'flex';
};
const hideSetup = () => (setupEl.style.display = 'none');
// ---- On-chain VERIFY panel (makes it verifiable from the platform) -------
const EXPLORER = 'https://explorer.solana.com';
const ER_CUSTOM = 'https://devnet-eu.magicblock.app/';
const addrUrl = (a: string) => `${EXPLORER}/address/${a}?cluster=devnet`;
const erTxUrl = (s: string) =>
  `${EXPLORER}/tx/${s}?cluster=custom&customUrl=${encodeURIComponent(ER_CUSTOM)}`;

const verifyEl = document.createElement('div');
verifyEl.id = 'verify-panel';
verifyEl.style.display = 'none';
verifyEl.innerHTML = `
  <div class="vp-modal">
    <button class="vp-close" id="vp-close" aria-label="Close">✕</button>
    <div class="vp-title">ON-CHAIN VERIFICATION</div>
    <div class="vp-head"><span class="vp-dot"></span> <b id="vp-count">0</b> transactions signed this session</div>
    <a class="vp-btn" id="vp-program" target="_blank" rel="noopener"><span class="vp-btn-txt">View the game program on Solana</span><span class="vp-arrow">↗</span></a>
    <a class="vp-btn" id="vp-account" target="_blank" rel="noopener"><span class="vp-btn-txt">View the game account on Solana</span><span class="vp-arrow">↗</span></a>
    <div class="vp-facts">
      <div class="vp-fact"><span>Network</span><b>Solana Devnet</b></div>
      <div class="vp-fact"><span>Execution</span><b>MagicBlock Ephemeral Rollup (EU)</b></div>
      <a class="vp-btn vp-btn-sm" href="https://devnet-eu.magicblock.app/" target="_blank" rel="noopener"><span class="vp-btn-txt">Rollup RPC endpoint</span><span class="vp-arrow">↗</span></a>
    </div>
    <div class="vp-note">Every move and bomb is a signed transaction, and all game rules run inside the program — nothing is trusted to a server.</div>
  </div>
`;
document.body.appendChild(verifyEl);
verifyEl.addEventListener('click', (e) => {
  if (e.target === verifyEl || (e.target as HTMLElement).id === 'vp-close') {
    verifyEl.style.display = 'none';
  }
});
(window as any).__toggleVerify = () => {
  const opening = verifyEl.style.display !== 'flex';
  verifyEl.style.display = opening ? 'flex' : 'none';
  if (opening) {
    // Refresh the account link + session count to the CURRENT match.
    (verifyEl.querySelector('#vp-account') as HTMLAnchorElement).href = addrUrl(chain.gamePDA.toBase58());
    verifyEl.querySelector('#vp-count')!.textContent = String(chain.transactionCount);
  }
};

// Small live TX feed shown DURING the match (count + recent moves/bombs,
// clickable). The program/account addresses stay on the dashboard modal.
const liveFeed = document.createElement('div');
liveFeed.id = 'live-tx';
liveFeed.style.display = 'none';
// Collapsed by default = a tiny pill (dot + count) that never blocks the arena
// corner; click it to expand the recent-tx feed, click again to collapse.
liveFeed.classList.add('collapsed');
liveFeed.innerHTML = `
  <button class="lt-head" id="lt-head" type="button" aria-label="On-chain activity">
    <span class="lt-dot"></span> <b id="lt-count">0</b><span class="lt-txt"> on-chain txs</span>
    <span class="lt-caret">▸</span>
  </button>
  <div class="lt-feed" id="lt-feed"></div>
`;
document.body.appendChild(liveFeed);
liveFeed.querySelector('#lt-head')!.addEventListener('click', () => {
  liveFeed.classList.toggle('collapsed');
});
const ltCount = liveFeed.querySelector('#lt-count')!;
const ltFeed = liveFeed.querySelector('#lt-feed')!;
chain.onTx((sig, kind) => {
  ltCount.textContent = String(chain.transactionCount);
  const a = document.createElement('a');
  a.className = 'lt-tx';
  a.target = '_blank';
  a.rel = 'noopener';
  a.href = erTxUrl(sig);
  a.textContent = `${kind} · ${sig.slice(0, 4)}… ↗`;
  ltFeed.prepend(a);
  while (ltFeed.childElementCount > 4) ltFeed.lastElementChild!.remove();
});

function setupVerifyPanel(): void {
  (verifyEl.querySelector('#vp-program') as HTMLAnchorElement).href = addrUrl(chain.programId);
  (verifyEl.querySelector('#vp-account') as HTMLAnchorElement).href = addrUrl(chain.gamePDA.toBase58());
  const countEl = verifyEl.querySelector('#vp-count')!;
  chain.onTx(() => {
    countEl.textContent = String(chain.transactionCount);
  });
}
setupVerifyPanel();

let onchainScreen: OnchainGame | null = null;
const MOVE_KEYS: Record<string, number> = {
  ArrowUp: DIR.UP, KeyW: DIR.UP, KeyZ: DIR.UP,
  ArrowDown: DIR.DOWN, KeyS: DIR.DOWN,
  ArrowLeft: DIR.LEFT, KeyA: DIR.LEFT, KeyQ: DIR.LEFT,
  ArrowRight: DIR.RIGHT, KeyD: DIR.RIGHT,
};
const onchainKeyHandler = (e: KeyboardEvent) => {
  // Only intercept while actually in the on-chain match — otherwise this global
  // capture handler would eat keys on the title/menus (and block scrolling).
  if (!onchainScreen || currentScreen !== onchainScreen) return;
  const color = onchainScreen.localColor;
  if (e.code === 'Space') {
    e.preventDefault();
    e.stopImmediatePropagation();
    chain.dropBomb(color).catch(() => {});
    return;
  }
  const dir = MOVE_KEYS[e.code];
  if (dir === undefined) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  // Predict locally first (instant); only fire the gasless tx if the move is
  // valid. The chain remains authoritative and reconciles the position.
  if (onchainScreen.predictMove(dir)) {
    chain.move(color, dir).catch(() => {});
  }
};
// Capture phase + registered ONCE: our handler runs BEFORE the base keyboard
// controller (which preventDefaults Space to stop page scroll and was eating
// bomb presses). Inert unless a match is live (guards on onchainScreen).
window.addEventListener('keydown', onchainKeyHandler, true);

let onchainPoll: number | null = null;

// Attach the renderer to the (soon-to-be) live game account WITHOUT starting a
// match. Reused by single-player (host starts the match here) and multiplayer
// (the shared lobby's host already started it before we attach).
function attachToLiveGame(color: number): void {
  onchainScreen = new OnchainGame(color);
  currentScreen = onchainScreen;
  // Hide the title overlay so the on-chain arena canvas is visible.
  dispatch({ type: 'SET_SCREEN', payload: { screen: 'ONCHAIN_GAME' } });
  backgroundMusic.stop();
  let liveShown = false;
  let endShown = false;
  let diedShown = false;
  const endgame = (window as any).__endgame;

  const applyState = (s: any) => {
    onchainScreen?.setState(s);
    const me = s.players[color];
    if (s.status === 1 && !liveShown) {
      liveShown = true;
      hideSetup(); // arena visible → the game clearly starts
      hideBanner();
      liveFeed.style.display = 'block';
      // Capture the roster (authorities) while live so SEE DATA labels stay
      // correct after the account is undelegated at match end.
      chain.snapshotRoster();
    }
    if (s.status === 2) {
      hideSetup();
      liveFeed.style.display = 'none';
      if (!endShown) {
        endShown = true;
        // Co-op: a player wins if the winning slot is on their team (same side
        // of the humans bitmask). Free-for-all: only the exact winner wins.
        const sameTeam = (a: number, b: number) =>
          a >= 0 && ((s.humans >> a) & 1) === ((s.humans >> b) & 1);
        const iWon = s.mode === 1 ? sameTeam(s.winner, color) : s.winner === color;
        endgame?.show(iWon, s.winner);
      }
    } else if (s.status === 1 && me && me.active && !me.alive && !diedShown) {
      diedShown = true;
      endgame?.died();
    }
  };

  // Primary render source: WebSocket push (onAccountChange).
  chain.subscribe(applyState);
  // Lightweight safety poll ONLY until the match is live, then stop (WS drives).
  if (onchainPoll) clearInterval(onchainPoll);
  onchainPoll = window.setInterval(async () => {
    const s = await chain.fetchState();
    if (s) applyState(s);
    if (liveShown || (s && s.status === 2)) {
      clearInterval(onchainPoll!);
      onchainPoll = null;
    }
  }, 500);
}

async function startOnchain(): Promise<void> {
  showSetup('Creating the arena on Solana…');
  hideBanner();
  try {
    const botCount = (window as any).__botCount ?? 3;
    await chain.ensureRealtime(); // start the blockhash pump for instant moves
    // startHostedMatch sets the per-match PDA; attach AFTER so we subscribe to
    // the right account.
    await chain.startHostedMatch(0, botCount);
    showSetup('Delegating to the Ephemeral Rollup…');
    attachToLiveGame(0);
  } catch (err) {
    showSetup('Setup failed: ' + String(err));
  }
}
(window as any).__startOnchain = () => {
  startOnchain();
};

// ---- Shared-room MULTIPLAYER lobby --------------------------------------
// Everyone who opens it joins the SAME match. Two modes: Allies (humans team
// up vs bots) and Enemies (free-for-all). The mode is passed to the host.
const PLAYER_NEON = ['#00e5ff', '#c084fc', '#3b82f6', '#ff3d6e'];
// Inline Lucide-style SVGs (no emoji — crisp, themeable via currentColor).
const svg = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const IC = {
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  allies: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  enemies: svg('<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" x2="9" y1="14" y2="18"/><line x1="7" x2="4" y1="17" y2="20"/><line x1="3" x2="5" y1="19" y2="21"/>'),
  play: svg('<polygon points="6 3 20 12 6 21 6 3"/>'),
  user: svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  bot: svg('<rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" x2="8" y1="16" y2="16"/><line x1="16" x2="16" y1="16" y2="16"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
};

// ---- MULTIPLAYER: 3 rooms, real players only (2..4 per match) ----------
// Networked game: no bots. Click MULTIPLAYER → enter a pseudo → pick a room
// (shows real player count) → lobby → START (needs 2+ real players).
const MP_MAX = 4;
let mpRoomId = -1;
let mpColor = -1;
let mpName = localStorage.getItem('chainbomb-pseudo') || '';
let mpHumans: { color: number; name: string }[] = [];

// PAGE 0 — enter a pseudo (synced to everyone via the host).
const mpNameEl = document.createElement('div');
mpNameEl.id = 'mpn-overlay';
mpNameEl.style.display = 'none';
mpNameEl.innerHTML = `
  <div class="to-scanlines"></div>
  <div class="to-vignette"></div>
  <button class="sp-back" id="mpn-back" type="button">${IC.back}<span>BACK</span></button>
  <div class="sp-inner">
    <h2 class="sp-title">MULTIPLAYER</h2>
    <div class="mpr-sub">ENTER YOUR NAME</div>
    <input id="mpn-input" class="mpn-input" maxlength="16" autocomplete="off"
           placeholder="Your pseudo" spellcheck="false" />
    <button class="to-btn to-b-mp sp-go" id="mpn-go" type="button">CONTINUE</button>
  </div>`;
document.body.appendChild(mpNameEl);
const mpnInput = mpNameEl.querySelector('#mpn-input') as HTMLInputElement;

function openNameEntry(): void {
  mpnInput.value = mpName;
  mpNameEl.style.display = 'flex';
  dispatch({ type: 'SET_SCREEN', payload: { screen: 'MP_NAME' } });
  setTimeout(() => mpnInput.focus(), 50);
}
function confirmName(): void {
  const v = mpnInput.value.trim().slice(0, 16);
  if (!v) {
    mpnInput.focus();
    return;
  }
  mpName = v;
  localStorage.setItem('chainbomb-pseudo', v);
  mpNameEl.style.display = 'none';
  openRooms();
}
mpNameEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('#mpn-go')) confirmName();
  else if (t.closest('#mpn-back')) {
    mpNameEl.style.display = 'none';
    dispatch({ type: 'SET_SCREEN', payload: { screen: 'TITLE' } });
  }
});
mpnInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmName();
  e.stopPropagation(); // don't let game key handlers see typing
});
let mpPoll: number | null = null;
let mpListPoll: number | null = null;
let mpAttached = false;
let mpCanStart = false;

// PAGE 1 — the 3 rooms as vertical buttons with their live player counts.
const mpRoomsEl = document.createElement('div');
mpRoomsEl.id = 'mpr-overlay';
mpRoomsEl.style.display = 'none';
mpRoomsEl.innerHTML = `
  <div class="to-scanlines"></div>
  <div class="to-vignette"></div>
  <button class="sp-back" id="mpr-back" type="button">${IC.back}<span>BACK</span></button>
  <div class="sp-inner">
    <h2 class="sp-title">MULTIPLAYER</h2>
    <div class="mpr-sub">JOIN A ROOM</div>
    <div class="mpr-list" id="mpr-list"></div>
  </div>`;
document.body.appendChild(mpRoomsEl);
const mprListEl = mpRoomsEl.querySelector('#mpr-list')!;

function renderRoomList(rooms: RoomView[]): void {
  mprListEl.innerHTML = rooms
    .map((r) => {
      const live = r.phase !== 'open';
      const full = r.count >= MP_MAX;
      const status = live ? 'IN GAME' : full ? 'FULL' : `${r.count}/${MP_MAX} players`;
      const dis = live || full ? 'is-off' : '';
      return `<button class="mpr-room ${dis}" data-room="${r.id}" type="button" ${dis ? 'disabled' : ''}>
          <span class="mpr-room-name">ROOM ${r.id + 1}</span>
          <span class="mpr-room-meta"><span class="mpr-dot ${live ? 'busy' : ''}"></span>${status}</span>
        </button>`;
    })
    .join('');
}

async function refreshRoomList(): Promise<void> {
  try {
    const { rooms } = await chain.listRooms();
    renderRoomList(rooms);
  } catch {
    mprListEl.innerHTML = '<div class="mpl-hint">Could not reach the server.</div>';
  }
}

function stopMpListPoll(): void {
  if (mpListPoll) clearInterval(mpListPoll);
  mpListPoll = null;
}

async function openRooms(): Promise<void> {
  mpRoomsEl.style.display = 'flex';
  dispatch({ type: 'SET_SCREEN', payload: { screen: 'MP_ROOMS' } });
  await refreshRoomList();
  stopMpListPoll();
  mpListPoll = window.setInterval(refreshRoomList, 1500);
}

// PAGE 2 — a room's lobby (real players only). Min 2 to start, max 4.
const mpLobbyEl = document.createElement('div');
mpLobbyEl.id = 'mpl-overlay';
mpLobbyEl.style.display = 'none';
mpLobbyEl.innerHTML = `
  <div class="to-scanlines"></div>
  <div class="to-vignette"></div>
  <button class="sp-back" id="mpl-back" type="button">${IC.back}<span>BACK</span></button>
  <div class="sp-inner">
    <h2 class="sp-title" id="mpl-title">ROOM</h2>
    <div class="mpl-room"><span class="mp2-live"></span> <b id="mpl-count">0</b>/${MP_MAX} players</div>
    <div class="to-slots" id="mpl-slots"></div>
    <button class="to-btn to-b-start sp-go" id="mpl-start" type="button">START MATCH</button>
    <div class="mpl-hint" id="mpl-hint">Joining the room…</div>
  </div>`;
document.body.appendChild(mpLobbyEl);

const mplTitle = mpLobbyEl.querySelector('#mpl-title')!;
const mplCount = mpLobbyEl.querySelector('#mpl-count')!;
const mplSlots = mpLobbyEl.querySelector('#mpl-slots')!;
const mplHint = mpLobbyEl.querySelector('#mpl-hint')!;
const mplStart = mpLobbyEl.querySelector('#mpl-start') as HTMLButtonElement;

function renderLobby(): void {
  const humans = mpHumans.length;
  mplCount.textContent = String(humans);
  mpCanStart = humans >= 2;
  mplStart.classList.toggle('is-off', !mpCanStart);
  // Show only the real players that joined — their pseudos, no bots/filler.
  mplSlots.innerHTML = mpHumans
    .slice()
    .sort((a, b) => a.color - b.color)
    .map((h) => {
      const you = h.color === mpColor;
      const name = (h.name || `P${h.color + 1}`).replace(/[<>&]/g, '');
      return `<div class="to-slot filled ${you ? 'is-you' : ''}" style="--accent:${PLAYER_NEON[h.color]}">
          <div class="to-slot-label">${name}</div>
          <div class="to-slot-type human">${you ? 'YOU' : 'PLAYER'}</div>
        </div>`;
    })
    .join('');
  mplHint.textContent = mpCanStart
    ? 'Ready — press START. Or wait for more players.'
    : 'Waiting for at least 2 real players to start…';
}

function stopMpPoll(): void {
  if (mpPoll) clearInterval(mpPoll);
  mpPoll = null;
}

async function openLobby(roomId: number): Promise<void> {
  mpAttached = false;
  mpColor = -1;
  mpRoomId = roomId;
  mpHumans = [];
  mpRoomsEl.style.display = 'none';
  stopMpListPoll();
  mpLobbyEl.style.display = 'flex';
  mplTitle.textContent = `ROOM ${roomId + 1}`;
  dispatch({ type: 'SET_SCREEN', payload: { screen: 'MP_LOBBY' } });
  renderLobby();
  try {
    const r = await chain.joinRoom(roomId, mpName);
    if ((r as any).error) throw new Error((r as any).error);
    mpColor = r.color;
    mpHumans = r.humans;
    renderLobby();
  } catch {
    mplHint.textContent = 'Could not join the room — it may be full or in game.';
  }
  stopMpPoll();
  mpPoll = window.setInterval(async () => {
    const st = await chain.roomState(roomId);
    if (!st) return;
    if (st.phase === 'open') {
      mpHumans = st.humans;
      renderLobby();
    }
    // The room's match started → attach to that match's PDA.
    if (st.phase === 'live' && !mpAttached && mpColor >= 0 && st.matchId) {
      mpAttached = true;
      stopMpPoll();
      mpLobbyEl.style.display = 'none';
      showSetup('Joining the on-chain match…');
      chain.setMatch(st.matchId);
      chain.setPlayerNames(st.humans); // keep pseudos for SEE DATA / labels
      attachToLiveGame(mpColor);
    }
  }, 800);
}

// Room list — pick a room, or BACK → title.
mpRoomsEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const room = t.closest('[data-room]') as HTMLElement | null;
  if (room && !room.classList.contains('is-off')) {
    openLobby(Number(room.dataset.room));
    return;
  }
  if (t.closest('#mpr-back')) {
    stopMpListPoll();
    mpRoomsEl.style.display = 'none';
    dispatch({ type: 'SET_SCREEN', payload: { screen: 'TITLE' } });
  }
});

// Lobby — START; or BACK → room list (leaving frees my slot).
mpLobbyEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('#mpl-back')) {
    stopMpPoll();
    if (mpRoomId >= 0) chain.leaveRoom(mpRoomId);
    mpLobbyEl.style.display = 'none';
    openRooms();
    return;
  }
  const startBtn = t.closest('#mpl-start') as HTMLButtonElement | null;
  if (startBtn) {
    if (!mpCanStart) {
      mplHint.textContent = 'Need at least 2 real players to start.';
      return;
    }
    startBtn.disabled = true;
    startBtn.textContent = 'STARTING…';
    mplHint.textContent = 'Launching the match on-chain…';
    chain.startRoom(mpRoomId).catch(() => {
      startBtn.disabled = false;
      startBtn.textContent = 'START MATCH';
      mplHint.textContent = 'Start failed — try again.';
    });
  }
});

(window as any).__startMultiplayer = () => {
  openNameEntry();
};

// ---- Solo setup (YOU VS BOTS) ------------------------------------------
// Opened from the title's "YOU VS BOTS" button: pick how many bots, see the
// lineup, then START GAME launches the single-player on-chain match.
const spEl = document.createElement('div');
spEl.id = 'sp-overlay';
spEl.style.display = 'none';
spEl.innerHTML = `
  <div class="to-scanlines"></div>
  <div class="to-vignette"></div>
  <button class="sp-back" id="sp-back" type="button">${IC.back}<span>BACK</span></button>
  <div class="sp-inner">
    <h2 class="sp-title">YOU VS BOTS</h2>
    <div class="to-slots" id="sp-slots"></div>
    <div class="to-arena">
      <button class="to-arrow" id="sp-minus" type="button" aria-label="Fewer bots">‹</button>
      <div class="to-arena-box">
        <span class="to-arena-label">BOTS</span>
        <span class="to-arena-name" id="sp-val">3</span>
      </div>
      <button class="to-arrow" id="sp-plus" type="button" aria-label="More bots">›</button>
    </div>
    <button class="to-btn to-b-start sp-go" id="sp-start" type="button">START GAME</button>
  </div>`;
document.body.appendChild(spEl);

let spBots = 3; // 1..3 bots filling P2..P4 (P1 is always YOU)
const spValEl = spEl.querySelector('#sp-val')!;
const spSlotsEl = spEl.querySelector('#sp-slots')!;

function renderSp(): void {
  spValEl.textContent = String(spBots);
  spSlotsEl.innerHTML = [0, 1, 2, 3]
    .map((i) => {
      const you = i === 0;
      const bot = !you && i <= spBots;
      const filled = you || bot;
      const type = you ? 'YOU' : bot ? 'BOT' : '---';
      const cls = you ? 'human' : bot ? 'cpu' : '';
      return `<div class="to-slot ${filled ? 'filled' : ''}" style="--accent:${PLAYER_NEON[i]}">
          <div class="to-slot-label">P${i + 1}</div>
          <div class="to-slot-type ${cls}">${type}</div>
        </div>`;
    })
    .join('');
}

spEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('#sp-minus')) {
    spBots = Math.max(1, spBots - 1);
    renderSp();
    return;
  }
  if (t.closest('#sp-plus')) {
    spBots = Math.min(3, spBots + 1);
    renderSp();
    return;
  }
  if (t.closest('#sp-back')) {
    spEl.style.display = 'none';
    dispatch({ type: 'SET_SCREEN', payload: { screen: 'TITLE' } });
    return;
  }
  if (t.closest('#sp-start')) {
    (window as any).__botCount = spBots;
    spEl.style.display = 'none';
    startOnchain();
  }
});
(window as any).__openSolo = () => {
  spBots = (window as any).__botCount ?? 3;
  renderSp();
  spEl.style.display = 'flex';
  dispatch({ type: 'SET_SCREEN', payload: { screen: 'SOLO_SETUP' } });
};

// ---- SEE DATA — per-player on-chain transaction table -------------------
// Opened from the endgame screen. One column per player (YOU / BOT 1 / …),
// each listing that player's own MOVE/BOMB transactions, straight from chain.
const dataEl = document.createElement('div');
dataEl.id = 'data-overlay';
dataEl.style.display = 'none';
dataEl.innerHTML = `
  <div class="dt-card">
    <button class="dt-close" id="dt-close" type="button">${IC.back}<span>CLOSE</span></button>
    <div class="dt-head">
      <h3 class="dt-title">MATCH DATA</h3>
      <div class="dt-meta" id="dt-meta"></div>
    </div>
    <div class="dt-cols" id="dt-cols"></div>
  </div>`;
document.body.appendChild(dataEl);
dataEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t === dataEl || t.closest('#dt-close')) dataEl.style.display = 'none';
});

async function showData(): Promise<void> {
  dataEl.style.display = 'flex';
  const colsEl = dataEl.querySelector('#dt-cols')!;
  const metaEl = dataEl.querySelector('#dt-meta')!;
  colsEl.innerHTML = `
    <div class="dt-loading">
      <div class="dt-spin"></div>
      <div class="dt-loading-t">Please wait — reading the full match history on-chain</div>
      <div class="dt-loading-sub" id="dt-loading-sub">Fetching transactions…</div>
    </div>`;
  metaEl.textContent = '';
  const roster = await chain.matchRoster();
  const subEl = dataEl.querySelector('#dt-loading-sub');
  // Full, precise per-player history (every MOVE/BOMB of the match).
  const actions = await chain.matchActions((done, total) => {
    if (subEl) subEl.textContent = `Reading ${done}/${total} transactions…`;
  });
  const active = roster.filter((r) => r.active);
  const byColor: Record<number, typeof actions> = {};
  active.forEach((r) => (byColor[r.color] = []));
  let total = 0;
  for (const a of actions) {
    if ((a.kind === 'MOVE' || a.kind === 'BOMB') && byColor[a.color]) {
      byColor[a.color].push(a);
      total++;
    }
  }
  metaEl.textContent = `${active.length} players · ${total} player actions on-chain (complete match history)`;
  let botN = 0;
  colsEl.innerHTML = active
    .map((r) => {
      // Prefer the player's pseudo; fall back to the slot (P1/P2/…). A YOU badge
      // marks your own column. Bots labelled BOT N.
      const label = r.isHuman
        ? (chain.nameFor(r.color) || `P${r.color + 1}`).replace(/[<>&]/g, '')
        : `BOT ${++botN}`;
      const you = r.isYou ? '<span class="dt-you">YOU</span>' : '';
      const rows = byColor[r.color] || [];
      const cells = rows.length
        ? rows
            .map(
              (a) =>
                `<a class="dt-cell ${a.failed ? 'fail' : ''}" href="${erTxUrl(a.sig)}" target="_blank" rel="noopener"><b>${a.kind}</b><span>${a.sig.slice(0, 6)}… ↗</span></a>`
            )
            .join('')
        : '<div class="dt-empty">— no actions —</div>';
      return `<div class="dt-col ${r.isYou ? 'is-you' : ''}" style="--c:${PLAYER_NEON[r.color]}">
          <div class="dt-colh"><span class="dt-dot"></span>${label}${you} <em>${rows.length}</em></div>
          <div class="dt-cells">${cells}</div>
        </div>`;
    })
    .join('');
}
(window as any).__showData = () => {
  showData();
};

// Modern cyberpunk-arcade DOM overlays on top of the canvas
initTitleOverlay();
initEndgameOverlay();
initLobbyOverlay();

// Initialize background music manager
const backgroundMusic = BackgroundMusicManager.getInstance();
// Try to start music immediately (may be blocked by browser autoplay policy)
backgroundMusic.start();
// Also start music on first user interaction (click/keypress) as fallback
canvas.addEventListener('click', () => {
  backgroundMusic.start();
}, { once: true });
document.addEventListener('keydown', () => {
  backgroundMusic.start();
}, { once: true });

subscribe(() => {
  const newScreenCode = getState().currentScreenCode;
  if (currentScreen.code === newScreenCode) {
    return;
  }

  switch (newScreenCode) {
    case 'TITLE':
      currentScreen = new Title();
      backgroundMusic.start();
      break;
    case 'OPTIONS':
      currentScreen = new Options();
      backgroundMusic.start();
      break;
    case 'LOBBY':
      currentScreen = new Lobby();
      backgroundMusic.start();
      break;
    case 'NEW_GAME': {
      const walls = GameUtils.initWalls(getState().map, getState().characters);
      const bonus = GameUtils.initBonus(getState().map, getState().characters);

      currentScreen = new Game(getState().map, walls, getState().characters, bonus);
      setCurrentMultiplayerGame(null);
      backgroundMusic.stop();

      dispatch({
        type: Action.INIT_GAME,
        payload: {
          status: GAMESTATUS.IN_PROGRESS,
          walls,
          bonus,
        },
      });
      break;
    }
    case 'MULTIPLAYER_GAME': {
      const lobbyState = networkClient.lobbyState;
      if (!lobbyState) {
        dispatch({ type: Action.ESCAPE });
        break;
      }

      const characters: Character[] = [];
      lobbyState.players.forEach(player => {
        const char = new Character(player.color as 0 | 1 | 2 | 3, player.x, player.y, DIRECTION.DOWN);
        char.isBot = false;
        characters.push(char);
      });

      const walls = GameUtils.initWalls(getState().map, characters);
      const bonus = GameUtils.initBonus(getState().map, characters);

      const localPlayer = lobbyState.players.find(p => p.id === networkClient.localPlayerId);
      const localColor = localPlayer ? localPlayer.color : 0;

      const mpGame = new MultiplayerGame(getState().map, walls, characters, bonus, localColor);
      currentScreen = mpGame;
      setCurrentMultiplayerGame(mpGame);
      backgroundMusic.stop();

      dispatch({
        type: Action.INIT_GAME,
        payload: {
          status: GAMESTATUS.IN_PROGRESS,
          walls,
          bonus,
          characters,
        },
      });
      break;
    }
  }
});

const step = (): void => {
  currentScreen.update(canvasContext);
  controller.listen();
  gamepads.listen();
  requestAnimationFrame(step);
};

requestAnimationFrame(step);

interface Metrics {
  width: number;
  height: number;
  computedWidth: () => number;
  computedHeight: () => number;
}

const metrics: Metrics = {
  width: 0,
  height: 0,
  computedWidth() {
    return metrics.width;
  },
  computedHeight() {
    return metrics.height;
  },
};

const stretch = (): void => {
  metrics.width = document.body.offsetWidth;
  metrics.height = document.body.offsetHeight;
  canvas.style.width = `${metrics.computedWidth()}px`;
  canvas.style.height = `${metrics.computedHeight()}px`;
};

stretch();
window.addEventListener('resize', stretch, false);
