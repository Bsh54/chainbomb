import { Action } from '../state/actions';
import { dispatch, getState, subscribe } from '../state/redux';
import { TILE } from '../../shared/constants/maps';
import { Ground } from './ground';
import { Board } from './board';
import { Block } from './block';
import { CharacterStatus } from './character-status';
import type { CanvasContext, GameMap, WallGrid, Unsubscribe } from '../types';
import type { Character } from './character';
import type { Bonus } from './bonus';
import type { Bomb } from './bomb';

export abstract class BaseGame {
  map: GameMap;
  characters: Character[];
  walls: WallGrid;
  bonus: Bonus[];
  bombs: Bomb[];
  code: string;

  // Reusable rendering objects (created once, not every frame)
  protected ground: Ground | null = null;
  protected frameUpLeft: Board | null = null;
  protected frameUpRight: Board | null = null;
  protected frameUp: Board | null = null;
  protected frameBottomLeft: Board | null = null;
  protected frameBottomRight: Board | null = null;
  protected frameBottom: Board | null = null;
  protected frameLeft: Board | null = null;
  protected frameRight: Board | null = null;
  protected block: Block | null = null;
  protected unsubscribe: Unsubscribe | null = null;

  // Pre-rendered layers (built once, blitted each frame for performance)
  protected staticLayer: HTMLCanvasElement | null = null;
  protected overlayLayer: HTMLCanvasElement | null = null;

  constructor(map: GameMap, walls: WallGrid, characters: Character[], bonus: Bonus[]) {
    this.map = map;
    this.characters = characters;
    this.walls = walls;
    this.bonus = bonus;
    this.bombs = [];
    this.code = '';

    this.unsubscribe = subscribe(() => {
      this.walls = getState().walls;
      this.characters = getState().characters;
      this.bonus = getState().bonus;
      this.bombs = getState().bombs;
      this.map = getState().map;
    });
  }

  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.ground = null;
    this.frameUpLeft = null;
    this.frameUpRight = null;
    this.frameUp = null;
    this.frameBottomLeft = null;
    this.frameBottomRight = null;
    this.frameBottom = null;
    this.frameLeft = null;
    this.frameRight = null;
    this.block = null;
    this.staticLayer = null;
    this.overlayLayer = null;
  }

  protected initRenderObjects(canvasContext: CanvasContext): void {
    if (!this.ground) {
      this.ground = new Ground(canvasContext);
      this.frameUpLeft = new Board('UP_LEFT', canvasContext);
      this.frameUpRight = new Board('UP_RIGHT', canvasContext);
      this.frameUp = new Board('UP', canvasContext);
      this.frameBottomLeft = new Board('BOTTOM_LEFT', canvasContext);
      this.frameBottomRight = new Board('BOTTOM_RIGHT', canvasContext);
      this.frameBottom = new Board('BOTTOM', canvasContext);
      this.frameLeft = new Board('LEFT', canvasContext);
      this.frameRight = new Board('RIGHT', canvasContext);
      this.block = new Block(canvasContext);
    }
  }

  protected setupCanvas(canvasContext: CanvasContext): HTMLCanvasElement | null {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    if (!canvas) return null;

    const w = (this.map[0] ? this.map[0].length : 0) * 32;
    const h = this.map.length * 32;

    // Only resize the canvas when dimensions actually change (resizing resets
    // the whole backing store — doing it every frame kills performance).
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      this.staticLayer = null;
      this.overlayLayer = null;
    }

    canvasContext.screenWidth = canvas.width;
    canvasContext.screenHeight = canvas.height;

    if (!this.staticLayer) this.buildStaticLayer(canvasContext);

    // One opaque blit paints the whole arena AND clears the previous frame.
    canvasContext.ctx.drawImage(this.staticLayer!, 0, 0);

    return canvas;
  }

  // Renders the static arena (floor + fixed blocks + border) once into an
  // offscreen canvas. The tile renderers draw to canvasContext.ctx, so we
  // temporarily point it at the offscreen context.
  protected buildStaticLayer(canvasContext: CanvasContext): void {
    this.initRenderObjects(canvasContext);
    const w = canvasContext.screenWidth;
    const h = canvasContext.screenHeight;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const offCtx = off.getContext('2d');
    if (!offCtx) return;

    offCtx.fillStyle = '#0a0a0a';
    offCtx.fillRect(0, 0, w, h);

    const realCtx = canvasContext.ctx;
    canvasContext.ctx = offCtx;
    this.renderMap(canvasContext);
    canvasContext.ctx = realCtx;

    this.staticLayer = off;
  }

  protected renderMap(canvasContext: CanvasContext): void {
    this.initRenderObjects(canvasContext);

    for (let x = 0, l = this.map.length; x < l; x++) {
      for (let y = 0, k = this.map[x].length; y < k; y++) {
        switch (this.map[x][y]) {
          case TILE.GROUND:
            this.ground!.render(x, y);
            break;
          case TILE.FRAME_UP_LEFT:
            this.frameUpLeft!.render(x, y);
            break;
          case TILE.FRAME_UP:
            this.frameUp!.render(x, y);
            break;
          case TILE.FRAME_UP_RIGHT:
            this.frameUpRight!.render(x, y);
            break;
          case TILE.FRAME_BOTTOM_LEFT:
            this.frameBottomLeft!.render(x, y);
            break;
          case TILE.FRAME_BOTTOM_RIGHT:
            this.frameBottomRight!.render(x, y);
            break;
          case TILE.FRAME_BOTTOM:
            this.frameBottom!.render(x, y);
            break;
          case TILE.FRAME_LEFT:
            this.frameLeft!.render(x, y);
            break;
          case TILE.FRAME_RIGHT:
            this.frameRight!.render(x, y);
            break;
          case TILE.BLOCK:
            this.block!.render(x, y);
            break;
        }
      }
    }
  }

  protected applyRetroEffects(canvasContext: CanvasContext): void {
    if (!this.overlayLayer) this.buildOverlayLayer(canvasContext);
    // Scanlines + vignette are pre-rendered once; one blit per frame.
    canvasContext.ctx.drawImage(this.overlayLayer!, 0, 0);
  }

  protected buildOverlayLayer(canvasContext: CanvasContext): void {
    const w = canvasContext.screenWidth;
    const h = canvasContext.screenHeight;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return;

    // Scanlines
    ctx.fillStyle = 'rgba(0, 0, 0, 0.10)';
    for (let y = 0; y < h; y += 3) {
      ctx.fillRect(0, y, w, 1);
    }

    // Vignette
    const g = ctx.createRadialGradient(w / 2, h / 2, h / 3, w / 2, h / 2, h);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0.4)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    this.overlayLayer = off;
  }

  protected computeVictory(): void {
    const aliveCharacters = this.characters.filter(
      (character) => character.status === CharacterStatus.ALIVE
    );
    if (aliveCharacters.length === 1 && aliveCharacters[0].status !== CharacterStatus.VICTORY) {
      dispatch({
        type: Action.VICTORY,
        payload: {
          character: aliveCharacters[0],
        },
      });
    }
  }

  abstract update(canvasContext: CanvasContext): void;
  abstract render(canvasContext: CanvasContext): void;
}
