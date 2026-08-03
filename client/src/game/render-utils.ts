// Shared canvas helpers for the modern neon-arcade rendering.

export interface BlockStyle {
  fill: string;
  bevel: string;
  edge: string;
  pad?: number;
  radius?: number;
  alpha?: number;
}

/** Draws a chunky neon block (used for walls, breakable blocks, arena border). */
export function drawBlock(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  style: BlockStyle
): void {
  const { fill, bevel, edge, pad = 2, radius = 5, alpha = 1 } = style;
  const s = 32 - pad * 2;
  const x = px + pad;
  const y = py + pad;

  ctx.save();
  ctx.globalAlpha = alpha;

  // body
  ctx.beginPath();
  ctx.roundRect(x, y, s, s, radius);
  ctx.fillStyle = fill;
  ctx.fill();

  // top highlight / bevel
  ctx.beginPath();
  ctx.roundRect(x, y, s, s * 0.44, radius);
  ctx.fillStyle = bevel;
  ctx.globalAlpha = alpha * 0.55;
  ctx.fill();
  ctx.globalAlpha = alpha;

  // neon edge
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, s - 1, s - 1, radius);
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

export interface PlayerOpts {
  alpha?: number;
  scale?: number;
  dim?: boolean;
  glow?: boolean;
}

/**
 * Draws a neon "bot" avatar centered at (cx, cy). A visor faces the movement
 * direction (fx, fy). Used for all player states (alive / dead / victory).
 */
export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string,
  fx: number,
  fy: number,
  opts: PlayerOpts = {}
): void {
  const { alpha = 1, scale = 1, dim = false, glow = false } = opts;
  const r = 11 * scale;
  const neon = dim ? '#5b6172' : color;

  ctx.save();
  ctx.globalAlpha = alpha;

  // body
  ctx.shadowColor = neon;
  ctx.shadowBlur = glow ? 18 : dim ? 4 : 11;
  ctx.beginPath();
  ctx.roundRect(cx - r, cy - r, r * 2, r * 2, 6 * scale);
  ctx.fillStyle = dim ? '#1a1d27' : '#10131c';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = neon;
  ctx.stroke();

  // visor (faces movement direction)
  ctx.shadowBlur = glow ? 12 : dim ? 2 : 7;
  const vx = cx + fx * 3;
  const vy = cy + fy * 3 - 1;
  ctx.beginPath();
  ctx.roundRect(vx - 5 * scale, vy - 2.5 * scale, 10 * scale, 5 * scale, 2.5 * scale);
  ctx.fillStyle = neon;
  ctx.fill();

  ctx.restore();
}

/** A hot explosion cell (source-over, cheap — explosions cover many tiles). */
export function drawFlame(ctx: CanvasRenderingContext2D, px: number, py: number): void {
  ctx.beginPath();
  ctx.roundRect(px + 1, py + 1, 30, 30, 8);
  ctx.fillStyle = 'rgba(255, 80, 26, 0.82)';
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(px + 6, py + 6, 20, 20, 7);
  ctx.fillStyle = 'rgba(255, 190, 70, 0.95)';
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(px + 11, py + 11, 10, 10, 5);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

/** A dark bomb orb with a neon ring and a blinking fuse spark. */
export function drawBomb(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  ring: string,
  blink: boolean
): void {
  ctx.save();
  // body
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#0c0f18';
  ctx.fill();
  // neon ring
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = ring;
  ctx.shadowColor = ring;
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;
  // highlight
  ctx.beginPath();
  ctx.arc(cx - r * 0.32, cy - r * 0.32, r * 0.26, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.fill();
  // fuse spark
  if (blink) {
    ctx.beginPath();
    ctx.arc(cx, cy - r - 2, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd23c';
    ctx.shadowColor = '#ffae00';
    ctx.shadowBlur = 8;
    ctx.fill();
  }
  ctx.restore();
}

/** A glowing power-up tile with a symbol. */
export function drawBonusTile(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  symbol: string,
  t: number
): void {
  const rr = r * (1 + Math.sin(t * 0.12) * 0.06);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(cx - rr, cy - rr, rr * 2, rr * 2, 5);
  ctx.fillStyle = '#10131c';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = `bold ${Math.round(rr * 1.05)}px "Orbitron", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(symbol, cx, cy + 1);
  ctx.restore();
}
