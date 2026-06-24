import type { CanvasContext } from '../types';
import { drawBlock } from './render-utils';

export class Block {
  private canvasContext: CanvasContext;

  constructor(canvasContext: CanvasContext) {
    this.canvasContext = canvasContext;
  }

  render(x: number, y: number): void {
    // Indestructible pillar — solid steel-blue neon block
    drawBlock(this.canvasContext.ctx, 32 * y, 32 * x, {
      fill: '#182142',
      bevel: '#2b3a66',
      edge: 'rgba(0, 200, 255, 0.35)',
    });
  }
}
