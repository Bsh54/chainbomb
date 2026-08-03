import type { CanvasContext } from '../types';

export class Ground {
  private canvasContext: CanvasContext;

  constructor(canvasContext: CanvasContext) {
    this.canvasContext = canvasContext;
  }

  render(x: number, y: number): void {
    const ctx = this.canvasContext.ctx;
    const px = 32 * y;
    const py = 32 * x;

    // Subtle two-tone checker floor
    ctx.fillStyle = (x + y) % 2 === 0 ? '#0d0d15' : '#0f1019';
    ctx.fillRect(px, py, 32, 32);

    // Faint neon grid line
    ctx.strokeStyle = 'rgba(64, 140, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, 31, 31);
  }
}
