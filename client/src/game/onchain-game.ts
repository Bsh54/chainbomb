import { BaseGame } from './base-game';
import { Character } from './character';
import { Bomb } from './bomb';
import { Wall } from './wall';
import { Flame } from './flame';
import { DIRECTION, type Direction } from './direction';
import { CARDINAL, type Cardinal } from './cardinal';
import { ARENAS } from './arenas';
import type { CanvasContext } from '../types';
import type { ChainState } from '../onchain/onchain';

const DIR_MAP: Direction[] = [DIRECTION.TOP, DIRECTION.DOWN, DIRECTION.LEFT, DIRECTION.RIGHT];

/**
 * Renders the authoritative on-chain game state (read from the Ephemeral
 * Rollup) using the existing sprite renderers. No local simulation — the chain
 * is the source of truth; we just draw the latest ChainState each frame.
 */
const W = 15;
const H = 13;
const isSolid = (x: number, y: number) =>
  x === 0 || y === 0 || x === W - 1 || y === H - 1 || (x % 2 === 0 && y % 2 === 0);

export class OnchainGame extends BaseGame {
  localColor: number;
  private state: ChainState | null = null;
  private chars = new Map<number, Character>();
  private bombInstances = new Map<string, Bomb>();
  // Smoothed on-screen positions for REMOTE players — the chain reports whole
  // cells ~10×/s, so we lerp toward the target each frame → their moves slide
  // instead of teleporting. Every action is still fully on-chain; this is
  // render-only smoothing of the authoritative position.
  private remotePos = new Map<number, { x: number; y: number }>();

  // Client-side prediction for the local player (instant feel; chain stays
  // authoritative and reconciles). Standard MagicBlock/Supersize pattern.
  private predX = -1;
  private predY = -1;
  private predInit = false;
  private moveCd = 0; // frames until next predicted move allowed
  private lastInputAt = 0;

  constructor(localColor: number) {
    super(ARENAS[0].map, [], [], []);
    this.code = 'ONCHAIN_GAME';
    this.localColor = localColor;
  }

  setState(s: ChainState): void {
    this.state = s;
    const me = s.players[this.localColor];
    if (!me || !me.active) return;
    if (!this.predInit) {
      this.predX = me.x;
      this.predY = me.y;
      this.predInit = true;
      return;
    }
    // NEVER snap the living local player back to chain — with high ER latency
    // (moves take ~1s to land) any backward reconcile is a visible rubber-band.
    // Prediction owns the on-screen position; the chain catches up behind it.
    // Only hard-reset on death, or after a very long idle (3s, well beyond the
    // slowest move) if the chain still genuinely differs.
    const longIdle = Date.now() - this.lastInputAt > 3000;
    if (!me.alive || (longIdle && (me.x !== this.predX || me.y !== this.predY))) {
      this.predX = me.x;
      this.predY = me.y;
    }
  }

  /** Predicted move: returns true if the local player moved (so caller fires tx). */
  predictMove(dir: number): boolean {
    const s = this.state;
    if (!s || !this.predInit || this.moveCd > 0) return false;
    const me = s.players[this.localColor];
    if (!me || !me.active || !me.alive) return false;
    let nx = this.predX;
    let ny = this.predY;
    if (dir === 0) ny--;
    else if (dir === 1) ny++;
    else if (dir === 2) nx--;
    else if (dir === 3) nx++;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return false;
    if (isSolid(nx, ny)) return false;
    const i = ny * W + nx;
    if (s.walls[i]) return false;
    if (s.bombs.some((b) => b.x === nx && b.y === ny)) return false;
    this.predX = nx;
    this.predY = ny;
    // Match the on-chain rate (MOVE_COOLDOWN 2 ticks × ~100ms crank ≈ 200ms) so
    // every predicted move is accepted on-chain — otherwise the extra predicted
    // moves get rejected and the player snaps back.
    this.moveCd = 15; // ~250ms at 60fps
    this.lastInputAt = Date.now();
    return true;
  }

  update(canvasContext: CanvasContext): void {
    this.render(canvasContext);
  }

  render(canvasContext: CanvasContext): void {
    if (this.moveCd > 0) this.moveCd--;
    if (!this.setupCanvas(canvasContext)) return;
    const s = this.state;
    if (!s) {
      this.applyRetroEffects(canvasContext);
      return;
    }

    // Breakable walls
    for (let i = 0; i < s.walls.length; i++) {
      if (s.walls[i]) {
        const x = i % 15;
        const y = Math.floor(i / 15);
        new Wall(x, y).render(canvasContext);
      }
    }

    // Bombs (persistent instances keep the pulse animation)
    const liveKeys = new Set<string>();
    for (const b of s.bombs) {
      const key = `${b.x},${b.y}`;
      liveKeys.add(key);
      let bomb = this.bombInstances.get(key);
      if (!bomb) {
        const owner = this.getChar(b.owner);
        bomb = new Bomb(owner);
        bomb.x = b.x;
        bomb.y = b.y;
        bomb.accelerator = 999999; // never self-explode; chain drives it
        this.bombInstances.set(key, bomb);
      }
      bomb.animationDuration = b.timer < 12 ? 2 : b.timer < 24 ? 4 : 8;
      bomb.render(canvasContext);
    }
    for (const key of [...this.bombInstances.keys()]) {
      if (!liveKeys.has(key)) this.bombInstances.delete(key);
    }

    // Blasts (flames) with cardinal detection
    this.renderBlasts(canvasContext, s);

    // Players (local one is drawn at its predicted position for instant feel)
    for (const p of s.players) {
      if (!p.active) continue;
      const c = this.getChar(p.color);
      if (p.color === this.localColor && p.alive) {
        c.x = this.predX;
        c.y = this.predY;
      } else {
        // Remote player: ease toward the authoritative chain cell for fluid
        // motion (snap on big jumps like respawn).
        let rp = this.remotePos.get(p.color);
        if (!rp) {
          rp = { x: p.x, y: p.y };
          this.remotePos.set(p.color, rp);
        }
        const dx = p.x - rp.x;
        const dy = p.y - rp.y;
        if (Math.abs(dx) > 1.6 || Math.abs(dy) > 1.6) {
          rp.x = p.x;
          rp.y = p.y;
        } else {
          rp.x += dx * 0.35; // ease-out toward target each frame
          rp.y += dy * 0.35;
          if (Math.abs(p.x - rp.x) < 0.02) rp.x = p.x;
          if (Math.abs(p.y - rp.y) < 0.02) rp.y = p.y;
        }
        c.x = rp.x;
        c.y = rp.y;
      }
      c.direction = DIR_MAP[p.dir] ?? DIRECTION.DOWN;
      if (!p.alive) {
        c.status = 'DEAD' as any;
      }
      c.render(canvasContext);
    }

    this.applyRetroEffects(canvasContext);
  }

  private getChar(color: number): Character {
    let c = this.chars.get(color);
    if (!c) {
      c = new Character(color as 0 | 1 | 2 | 3, 1, 1, DIRECTION.DOWN);
      this.chars.set(color, c);
    }
    return c;
  }

  private renderBlasts(canvasContext: CanvasContext, s: ChainState): void {
    const set = new Set(s.blasts.map((b) => `${b.x},${b.y}`));
    for (const bl of s.blasts) {
      const n = set.has(`${bl.x},${bl.y - 1}`);
      const so = set.has(`${bl.x},${bl.y + 1}`);
      const e = set.has(`${bl.x + 1},${bl.y}`);
      const w = set.has(`${bl.x - 1},${bl.y}`);
      const cnt = (n ? 1 : 0) + (so ? 1 : 0) + (e ? 1 : 0) + (w ? 1 : 0);
      let card: Cardinal = CARDINAL.MIDDLE;
      if (cnt >= 3 || (n && so && (e || w)) || (e && w && (n || so))) card = CARDINAL.MIDDLE;
      else if (n && so) card = CARDINAL.NORTH_MIDDLE;
      else if (e && w) card = CARDINAL.EAST_MIDDLE;
      else if (n) card = CARDINAL.SOUTH_END;
      else if (so) card = CARDINAL.NORTH_END;
      else if (e) card = CARDINAL.WEST_END;
      else if (w) card = CARDINAL.EAST_END;
      new Flame(bl.x, bl.y, 0, card).render(canvasContext);
    }
  }
}
