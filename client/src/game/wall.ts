import type { CanvasContext } from '../types';
import { drawBlock } from './render-utils';

export class Wall {
  x: number;
  y: number;
  animationState: number;
  animationDuration: number;
  destroyed: boolean;

  constructor(x: number, y: number, destroyed: boolean = false) {
    this.x = x;
    this.y = y;
    this.animationState = 0;
    this.animationDuration = 6;
    this.destroyed = destroyed;
  }

  render(canvasContext: CanvasContext): void {
    let alpha = 1;
    let pad = 2;

    if (this.destroyed) {
      // Fade + shrink out over ~24 frames
      const progress = Math.min(1, this.animationState / (this.animationDuration * 4));
      alpha = 1 - progress;
      pad = 2 + progress * 10;
      this.animationState++;
    }

    // Breakable wall — warm magenta crate, clearly distinct from the fixed blocks
    drawBlock(canvasContext.ctx, this.x * 32, this.y * 32, {
      fill: '#2a1836',
      bevel: '#4a2a5e',
      edge: 'rgba(255, 60, 140, 0.42)',
      pad,
      alpha,
    });
  }
}
