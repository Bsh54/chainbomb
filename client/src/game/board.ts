import type { CanvasContext } from '../types';
import { drawBlock } from './render-utils';

type BoardType = 'UP_LEFT' | 'UP_RIGHT' | 'BOTTOM_LEFT' | 'UP' | 'BOTTOM_RIGHT' | 'BOTTOM' | 'LEFT' | 'RIGHT';

export class Board {
  private canvasContext: CanvasContext;

  constructor(_type: BoardType, canvasContext: CanvasContext) {
    this.canvasContext = canvasContext;
  }

  render(x: number, y: number): void {
    const ctx = this.canvasContext.ctx;
    const px = 32 * y;
    const py = 32 * x;

    // Solid arena border — darker steel with a cyan neon edge
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(px, py, 32, 32);
    drawBlock(ctx, px, py, {
      fill: '#141c38',
      bevel: '#26346b',
      edge: 'rgba(0, 200, 255, 0.28)',
      pad: 0,
      radius: 0,
    });
  }
}
