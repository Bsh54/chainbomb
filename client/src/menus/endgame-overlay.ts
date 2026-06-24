import { getState, dispatch, subscribe } from '../state/redux';
import { Action } from '../state/actions';
import { GAMESTATUS } from '../game/game-status';
import { CharacterStatus } from '../game/character-status';
import { getCurrentMultiplayerGame } from '../game/multiplayer-game';


/**
 * End-of-game overlay (VICTORY / GAME OVER). Shown when the game reaches
 * gameStatus === END. Uses a change-guard so it never touches the DOM while a
 * match is running (avoids the perf issue).
 */
export function initEndgameOverlay(): void {
  const root = document.createElement('div');
  root.id = 'endgame-overlay';
  root.innerHTML = `
    <div class="eg-scanlines"></div>
    <div class="eg-inner">
      <div class="eg-title" id="eg-title">VICTORY</div>
      <div class="eg-winner" id="eg-winner"></div>
      <button class="eg-btn" id="eg-again" type="button">PLAY AGAIN</button>
      <button class="eg-data" id="eg-data" type="button">SEE DATA <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
    </div>
  `;
  document.body.appendChild(root);

  const titleEl = root.querySelector<HTMLDivElement>('#eg-title')!;
  const winnerEl = root.querySelector<HTMLDivElement>('#eg-winner')!;
  root
    .querySelector<HTMLButtonElement>('#eg-again')!
    .addEventListener('click', () => dispatch({ type: Action.RESET }));
  root
    .querySelector<HTMLButtonElement>('#eg-data')!
    .addEventListener('click', () =>
      (window as unknown as { __showData?: () => void }).__showData?.()
    );

  // Shared renderer for both the redux (local/multiplayer) path and the
  // on-chain path (exposed as window.__endgame).
  const showResult = (mode: 'none' | 'died' | 'win' | 'lose', winnerColor: number) => {
    root.dataset.mode = mode === 'win' || mode === 'lose' ? 'end' : mode;
    root.style.display = mode === 'none' ? 'none' : 'flex';
    if (mode === 'none') return;
    if (mode === 'died') {
      titleEl.textContent = 'YOU DIED';
      titleEl.className = 'eg-title lose';
      winnerEl.textContent = 'Spectating…';
      return;
    }
    const iWon = mode === 'win';
    titleEl.textContent = iWon ? 'VICTORY' : 'GAME OVER';
    titleEl.className = `eg-title ${iWon ? 'win' : 'lose'}`;
    // Always from the local player's point of view — never "P1 wins".
    winnerEl.textContent = iWon ? 'YOU WIN THE GAME' : winnerColor >= 0 ? 'YOU LOST' : 'Draw';
  };
  (window as unknown as { __endgame?: unknown }).__endgame = {
    show: (won: boolean, winnerColor: number) => showResult(won ? 'win' : 'lose', winnerColor),
    died: () => showResult('died', -1),
    hide: () => showResult('none', -1),
  };

  let lastMode = 'none';
  subscribe(() => {
    const s = getState();
    const mp = getCurrentMultiplayerGame();
    // In multiplayer nobody is a bot, so "me" is the local player's colour.
    const myColor = mp ? mp.localPlayerColor : s.characters.find((c) => !c.isBot)?.color;

    // Determine the current end-state mode
    let mode: 'none' | 'died' | 'end' = 'none';
    if (s.gameStatus === GAMESTATUS.END) {
      mode = 'end';
    } else if (s.gameStatus === GAMESTATUS.IN_PROGRESS) {
      const me = s.characters.find((c) => c.color === myColor);
      if (me && me.status === CharacterStatus.DEAD) mode = 'died';
    }

    if (mode === lastMode) return; // only touch DOM on change
    lastMode = mode;

    root.dataset.mode = mode;
    root.style.display = mode === 'none' ? 'none' : 'flex';
    if (mode === 'none') return;

    if (mode === 'end') {
      const winner = s.characters.find((c) => c.status === CharacterStatus.VICTORY);
      // Win = the local player is the winner. (Solo: the only human.)
      const iWon = !!winner && winner.color === myColor;
      titleEl.textContent = iWon ? 'VICTORY' : 'GAME OVER';
      titleEl.className = `eg-title ${iWon ? 'win' : 'lose'}`;
      winnerEl.textContent = winner ? (iWon ? 'YOU WIN THE GAME' : 'YOU LOST') : 'Draw';
    } else {
      // Local player died but the match is still going
      titleEl.textContent = 'YOU DIED';
      titleEl.className = 'eg-title lose';
      winnerEl.textContent = 'Spectating…';
    }
  });
}
