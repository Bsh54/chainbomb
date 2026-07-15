// Smart on-chain bot brain — ports the game's A* bot AI (bot-ai.ts + pathfinder)
// to run in the host over the raw on-chain Game account. Returns an action
// { move: dir } or { bomb: true } or null, per bot color.
//
// Coords: x = col (0..14), y = row (0..12). Directions: 0=UP 1=DOWN 2=LEFT 3=RIGHT.

const W = 15, H = 13;
const DXY = { 0: [0, -1], 1: [0, 1], 2: [-1, 0], 3: [1, 0] };

const solid = (x, y) =>
  x === 0 || y === 0 || x === W - 1 || y === H - 1 || (x % 2 === 0 && y % 2 === 0);
const bit = (arr, i) => ((arr[i >> 3] >> (i & 7)) & 1) === 1;
const wallAt = (g, x, y) => bit(g.walls, y * W + x);
const bonusAt = (g, x, y) => (g.bonus ? bit(g.bonus, y * W + x) : false);
const bombAt = (g, x, y) => g.bombs.some((b) => b.active === 1 && b.x === x && b.y === y);

function canMove(g, x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  if (solid(x, y)) return false;
  if (wallAt(g, x, y)) return false;
  if (bombAt(g, x, y)) return false;
  return true;
}

// Danger map: index [y*W+x] → 0..100 (higher = more dangerous / sooner blast).
function dangerMap(g) {
  const dm = new Array(W * H).fill(0);
  const set = (x, y, v) => {
    const i = y * W + x;
    if (v > dm[i]) dm[i] = v;
  };
  for (const b of g.bombs) {
    if (b.active !== 1) continue;
    const urgency = Math.max(30, 100 - b.timer); // sooner = higher
    set(b.x, b.y, 100);
    for (const [dx, dy] of Object.values(DXY)) {
      for (let r = 1; r < b.radius; r++) {
        const nx = b.x + dx * r, ny = b.y + dy * r;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || solid(nx, ny)) break;
        set(nx, ny, urgency);
        if (wallAt(g, nx, ny)) break;
      }
    }
  }
  for (const bl of g.blasts) {
    if (bl.life > 0) set(bl.x, bl.y, 100);
  }
  return dm;
}

// A* to (tx,ty). Returns array of direction steps, or [].
function findPath(g, sx, sy, tx, ty, dm) {
  const open = [{ x: sx, y: sy, gc: 0, f: 0, parent: null }];
  const closed = new Set();
  const h = (x, y) => Math.abs(x - tx) + Math.abs(y - ty);
  // Cross-product tie-breaker: nudges A* toward the straight line to the goal so
  // equal-cost paths resolve consistently → the first step is stable across
  // adjacent cells → no zig-zag / back-and-forth "floating".
  const tie = (x, y) => Math.abs((x - tx) * (sy - ty) - (sx - tx) * (y - ty)) * 0.001;
  const score = (x, y, gc) => gc + h(x, y) + tie(x, y);
  open[0].f = score(sx, sy, 0);
  while (open.length) {
    let ci = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[ci].f) ci = i;
    const cur = open[ci];
    if (cur.x === tx && cur.y === ty) {
      const path = [];
      let n = cur;
      while (n.parent) {
        const dx = n.x - n.parent.x, dy = n.y - n.parent.y;
        path.unshift(dx === 1 ? 3 : dx === -1 ? 2 : dy === 1 ? 1 : 0);
        n = n.parent;
      }
      return path;
    }
    open.splice(ci, 1);
    closed.add(cur.x + ',' + cur.y);
    for (const [dx, dy] of Object.values(DXY)) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!canMove(g, nx, ny)) continue;
      const key = nx + ',' + ny;
      if (closed.has(key)) continue;
      const dang = dm[ny * W + nx] || 0;
      if (dang > 60) continue; // avoid deadly cells
      const gc = cur.gc + 1 + dang / 20;
      const ex = open.find((o) => o.x === nx && o.y === ny);
      if (!ex) open.push({ x: nx, y: ny, gc, f: score(nx, ny, gc), parent: cur });
      else if (gc < ex.gc) { ex.gc = gc; ex.f = score(nx, ny, gc); ex.parent = cur; }
    }
  }
  return [];
}

// BFS nearest cell with danger 0.
function nearestSafe(g, sx, sy, dm) {
  const seen = new Set([sx + ',' + sy]);
  const q = [{ x: sx, y: sy }];
  while (q.length) {
    const c = q.shift();
    if ((dm[c.y * W + c.x] || 0) === 0 && (c.x !== sx || c.y !== sy)) return c;
    for (const [dx, dy] of Object.values(DXY)) {
      const nx = c.x + dx, ny = c.y + dy, k = nx + ',' + ny;
      if (canMove(g, nx, ny) && !seen.has(k)) { seen.add(k); q.push({ x: nx, y: ny }); }
    }
  }
  return null;
}

function blastBlocked(g, ax, ay, bx, by) {
  if (ax === bx) {
    for (let y = Math.min(ay, by) + 1; y < Math.max(ay, by); y++)
      if (solid(ax, y) || wallAt(g, ax, y)) return true;
  } else if (ay === by) {
    for (let x = Math.min(ax, bx) + 1; x < Math.max(ax, bx); x++)
      if (solid(x, ay) || wallAt(g, x, ay)) return true;
  }
  return false;
}

function enemyInRange(g, me) {
  for (const e of g.players) {
    if (e.color === me.color || e.active !== 1 || e.alive !== 1) continue;
    const inX = e.x === me.x && Math.abs(e.y - me.y) < me.radius;
    const inY = e.y === me.y && Math.abs(e.x - me.x) < me.radius;
    if ((inX || inY) && !blastBlocked(g, me.x, me.y, e.x, e.y)) return true;
  }
  return false;
}

function wallsNearby(g, x, y) {
  let n = 0;
  for (const [dx, dy] of Object.values(DXY)) if (wallAt(g, x + dx, y + dy)) n++;
  return n;
}

// After placing a bomb at (me), is there a reachable safe cell (not in the bomb
// cross) within a few steps? Prevents suicide.
function canEscapeBomb(g, me) {
  const blast = new Set([me.x + ',' + me.y]);
  for (const [dx, dy] of Object.values(DXY)) {
    for (let r = 1; r < me.radius; r++) {
      const nx = me.x + dx * r, ny = me.y + dy * r;
      if (solid(nx, ny)) break;
      blast.add(nx + ',' + ny);
      if (wallAt(g, nx, ny)) break;
    }
  }
  const seen = new Set([me.x + ',' + me.y]);
  const q = [{ x: me.x, y: me.y, d: 0 }];
  while (q.length) {
    const c = q.shift();
    if (c.d > 0 && c.d <= 6 && !blast.has(c.x + ',' + c.y)) return true;
    if (c.d >= 6) continue;
    for (const [dx, dy] of Object.values(DXY)) {
      const nx = c.x + dx, ny = c.y + dy, k = nx + ',' + ny;
      if (canMove(g, nx, ny) && !seen.has(k)) { seen.add(k); q.push({ x: nx, y: ny, d: c.d + 1 }); }
    }
  }
  return false;
}

// --- TARGET selection (returns a destination cell {x,y}, or null) ---------
// A reachable cell within bomb range of the nearest enemy (else the enemy cell).
function enemyTarget(g, me, dm) {
  let best = null, bestD = Infinity;
  for (const e of g.players) {
    if (e.color === me.color || e.active !== 1 || e.alive !== 1) continue;
    const d = Math.abs(e.x - me.x) + Math.abs(e.y - me.y);
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) return null;
  for (let i = 1; i <= me.radius; i++) {
    for (const [dx, dy] of Object.values(DXY)) {
      const tx = best.x + dx * i, ty = best.y + dy * i;
      if (canMove(g, tx, ty) && findPath(g, me.x, me.y, tx, ty, dm).length) return { x: tx, y: ty };
    }
  }
  if (findPath(g, me.x, me.y, best.x, best.y, dm).length) return { x: best.x, y: best.y };
  return null;
}

// Nearest reachable power-up cell (BFS).
function bonusTarget(g, me, dm) {
  const seen = new Set([me.x + ',' + me.y]);
  const q = [{ x: me.x, y: me.y, d: 0 }];
  while (q.length) {
    const c = q.shift();
    if (c.d > 10) continue;
    if ((c.x !== me.x || c.y !== me.y) && bonusAt(g, c.x, c.y)) return { x: c.x, y: c.y };
    for (const dd of [0, 1, 2, 3]) {
      const [dx, dy] = DXY[dd];
      const nx = c.x + dx, ny = c.y + dy, k = nx + ',' + ny;
      if (!seen.has(k) && canMove(g, nx, ny) && (dm[ny * W + nx] || 0) <= 30) { seen.add(k); q.push({ x: nx, y: ny, d: c.d + 1 }); }
    }
  }
  return null;
}

// Approach cell of the nearest breakable wall.
function wallTarget(g, me, dm) {
  let best = null, bestD = Infinity;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (!wallAt(g, x, y)) continue;
      for (const [dx, dy] of Object.values(DXY)) {
        const ax = x + dx, ay = y + dy;
        if (canMove(g, ax, ay)) { const d = Math.abs(ax - me.x) + Math.abs(ay - me.y); if (d < bestD) { bestD = d; best = { x: ax, y: ay }; } }
      }
    }
  }
  if (best && findPath(g, me.x, me.y, best.x, best.y, dm).length) return best;
  return null;
}

function pickTarget(g, me, dm) {
  return enemyTarget(g, me, dm) || bonusTarget(g, me, dm) || wallTarget(g, me, dm);
}

// Main decision. `committed` = the destination cell the bot is already heading
// to (kept by the host for a few ticks = hysteresis) so we don't re-pick a new
// target every tick (that was the oscillation). We ALWAYS re-path from the
// bot's ACTUAL current cell → the plan can never desync from reality.
// Returns {bomb:true} | {move,flee:true} | {move,target:{x,y}} | null.
export function decideBot(g, color, committed) {
  // Decoded players carry no `color` field (color = array index) — stamp it.
  g.players.forEach((p, i) => { p.color = i; });
  const me = g.players[color];
  if (!me || me.active !== 1 || me.alive !== 1) return null;
  const dm = dangerMap(g);
  const here = dm[me.y * W + me.x] || 0;

  // 1) Flee danger (reactive — no target commitment).
  if (here > 30) {
    const safe = nearestSafe(g, me.x, me.y, dm);
    if (safe) { const p = findPath(g, me.x, me.y, safe.x, safe.y, dm); if (p.length) return { move: p[0], flee: true }; }
    for (const d of [0, 1, 2, 3]) {
      const [dx, dy] = DXY[d];
      const nx = me.x + dx, ny = me.y + dy;
      if (canMove(g, nx, ny) && (dm[ny * W + nx] || 0) < here) return { move: d, flee: true };
    }
    return null;
  }

  // 2) Strategic bomb (reactive).
  if (me.bombUsed < me.bombMax && !bombAt(g, me.x, me.y)) {
    const enemy = enemyInRange(g, me);
    const walls = wallsNearby(g, me.x, me.y);
    if ((enemy || walls > 0) && canEscapeBomb(g, me)) { if (enemy || Math.random() < 0.3) return { bomb: true }; }
  }

  // 3) Move toward the committed target if still valid+reachable+not-reached;
  //    otherwise pick a fresh one. Always re-path from the current cell.
  // Reached the committed target → HOLD this tick (host clears it) before
  // choosing a new one — prevents the reach→turn-around bounce.
  if (committed && committed.x === me.x && committed.y === me.y) return null;
  let target = null;
  if (committed) {
    const p = findPath(g, me.x, me.y, committed.x, committed.y, dm);
    if (p.length) target = { cell: committed, path: p };
  }
  if (!target) {
    const t = pickTarget(g, me, dm);
    if (t) { const p = findPath(g, me.x, me.y, t.x, t.y, dm); if (p.length) target = { cell: t, path: p }; }
  }
  if (target) return { move: target.path[0], target: target.cell };

  // 4) nothing to do — a single safe step (rare).
  for (const d of [0, 1, 2, 3]) {
    const [dx, dy] = DXY[d];
    if (canMove(g, me.x + dx, me.y + dy) && (dm[(me.y + dy) * W + (me.x + dx)] || 0) === 0) return { move: d };
  }
  return null;
}
