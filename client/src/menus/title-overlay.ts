import { getState, subscribe } from '../state/redux';

/**
 * Cyberpunk-arcade title screen, rendered as a DOM overlay on top of the
 * canvas. Minimal: the CHAINBOMB logo + three primary actions. Shown only
 * while the current screen is TITLE; hidden otherwise so the canvas is visible.
 */
export function initTitleOverlay(): void {
  const root = document.createElement('div');
  root.id = 'title-overlay';
  root.innerHTML = `
    <div class="to-scanlines"></div>
    <div class="to-vignette"></div>
    <div class="to-inner">
      <div class="to-logo">
        <h1 class="to-title" data-text="CHAINBOMB">CHAINBOMB</h1>
      </div>

      <div class="to-actions">
        <button class="to-btn to-b-start" data-act="start" id="to-start">YOU VS BOTS</button>
        <button class="to-btn to-b-mp" data-act="multiplayer">MULTIPLAYER</button>
        <button class="to-btn to-b-verify" data-act="verify">VERIFY ON-CHAIN</button>
      </div>

      <div class="to-hint">Move: ZQSD / Arrows&nbsp;&nbsp;·&nbsp;&nbsp;Bomb: SPACE</div>
    </div>
  `;
  document.body.appendChild(root);

  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!btn) return;
    const w = window as unknown as {
      __openSolo?: () => void;
      __startMultiplayer?: () => void;
      __toggleVerify?: () => void;
    };
    switch (btn.dataset.act) {
      case 'start':
        w.__openSolo?.();
        break;
      case 'multiplayer':
        w.__startMultiplayer?.();
        break;
      case 'verify':
        w.__toggleVerify?.();
        break;
    }
  });

  let shown = false;
  const render = () => {
    const isTitle = getState().currentScreenCode === 'TITLE';
    // Only touch the DOM when visibility actually changes (the store dispatches
    // many actions per frame during gameplay).
    if (isTitle !== shown) {
      root.style.display = isTitle ? 'flex' : 'none';
      shown = isTitle;
    }
  };

  subscribe(render);
  render();
}
