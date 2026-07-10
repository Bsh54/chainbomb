// CHAINBOMB host service — EVERYTHING on-chain.
// The funded wallet sets up a match (create/join/init/delegate), then the game
// runs entirely in the Ephemeral Rollup: a tick crank advances the simulation
// and every BOT plays with its own session keypair via gasless moves. Human
// players send their own gasless moves from the browser. On victory the state
// is committed + undelegated back to Solana (settle).
//
// Run:  node host.mjs   (from ~/dev/chainbomb-program)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { decideBot } from './smart-bot.mjs';

const PORT = 7070;
const BASE_RPC = process.env.BASE_RPC || 'https://api.devnet.solana.com';
const ER_RPC = process.env.ER_RPC || 'https://devnet-eu.magicblock.app/';
const ER_WS = process.env.ER_WS || 'wss://devnet-eu.magicblock.app/';
// EU Ephemeral Rollup validator (matches the devnet-eu endpoint → low latency
// reads AND writes for our European/African users).
const VALIDATOR = new PublicKey(
  process.env.VALIDATOR || 'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e'
);
const TICK_MS = 100;
const MAX_MATCH_MS = 180000; // abandoned/stalemate matches auto-settle after 3 min
const BOT_MS = 200;

const idl = JSON.parse(fs.readFileSync('./target/idl/chainbomb.json', 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const walletKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir() + '/.config/solana/id.json', 'utf8')))
);
const wallet = new anchor.Wallet(walletKp);

const baseConn = new Connection(BASE_RPC, { commitment: 'confirmed' });
const erConn = new Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: 'confirmed' });
const baseProvider = new anchor.AnchorProvider(baseConn, wallet, { commitment: 'confirmed' });
const erProvider = new anchor.AnchorProvider(erConn, wallet, { commitment: 'confirmed' });
const program = new anchor.Program(idl, baseProvider);
const programER = new anchor.Program(idl, erProvider);
const erCoder = programER.coder.accounts;

// The host must NEVER die from a stray RPC error (a 429 in one match must not
// crash every other match). Keep the process alive; the loops are all guarded.
process.on('uncaughtException', (e) => console.error('uncaught:', String(e).slice(0, 160)));
process.on('unhandledRejection', (e) => console.error('unhandled:', String(e).slice(0, 160)));
// Per-match PDA: a fresh account for every match → a corrupted/stuck account
// is simply abandoned, the next match uses a new id. No more reseeds/redeploys.
const GAME_PREFIX = Buffer.from('game');
function deriveGamePDA(mid) {
  return PublicKey.findProgramAddressSync(
    [GAME_PREFIX, mid.toArrayLike(Buffer, 'le', 8)],
    PROGRAM_ID
  )[0];
}
// Solo (YOU VS BOTS) matches — each runs concurrently with its own crank + bots,
// exactly like rooms. So two browsers can each play their own solo game at once.
const soloMatches = new Set();

function nextColor(used) { for (let c = 0; c < 4; c++) if (!used.has(c)) return c; return -1; }

// --- multiplayer: 3 rooms, REAL players only (no bots), 2..4 per match -------
// Each room runs its own concurrent match (own matchId / PDA / crank).
const rooms = [0, 1, 2].map((id) => ({
  id, humans: [], phase: 'open', matchId: null, gamePDA: null,
  crankTimer: null, latestGame: null, startedAt: 0,
}));
function roomReset(r) {
  r.humans = []; r.phase = 'open'; r.matchId = null; r.gamePDA = null;
  r.latestGame = null; r.startedAt = 0;
}
function roomView(r) {
  return {
    id: r.id, count: r.humans.length, phase: r.phase,
    // Public view: color + name only (keep session pubkeys internal).
    humans: r.humans.map((h) => ({ color: h.color, name: h.name || `P${h.color + 1}` })),
    matchId: r.matchId ? r.matchId.toString() : null,
    gamePDA: r.gamePDA ? r.gamePDA.toBase58() : null,
  };
}
function stopRoomCrank(r) {
  if (r.crankTimer) clearInterval(r.crankTimer);
  if (r.subId != null) { try { erConn.removeAccountChangeListener(r.subId); } catch {} r.subId = null; }
  r.crankTimer = null;
}

async function settleRoom(r) {
  if (!r.matchId) return { ok: false };
  try {
    await programER.methods.settle(r.matchId).accounts({ payer: wallet.publicKey }).rpc();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

function roomCrankLoop(r) {
  stopRoomCrank(r);
  // Read the state via WS PUSH (one subscription) instead of fetching every
  // tick — this is what kept the RPC from rate-limiting (429) under load.
  try {
    r.subId = erConn.onAccountChange(r.gamePDA, (acc) => {
      try { r.latestGame = erCoder.decode('game', acc.data); } catch {}
    }, { commitment: 'processed' });
  } catch {}
  let n = 0;
  r.crankTimer = setInterval(async () => {
    try {
      await programER.methods.tick(r.matchId).accounts({ game: r.gamePDA, signer: wallet.publicKey }).rpc();
    } catch {}
    // Light fallback fetch (once/sec) in case the WS hiccups.
    if (++n % 10 === 0) {
      try { r.latestGame = await programER.account.game.fetch(r.gamePDA, 'processed'); } catch {}
    }
    const g = r.latestGame;
    if (g && (g.status === 2 || (g.status === 1 && Date.now() - r.startedAt > MAX_MATCH_MS))) {
      stopRoomCrank(r);
      await settleRoom(r);
      roomReset(r); // reopen the room for a new match
    }
  }, TICK_MS);
}

// Set up + delegate a room's match (humans only, no bots) and start its crank.
async function startRoomMatch(r) {
  const mid = new BN(Date.now());
  r.matchId = mid;
  r.gamePDA = deriveGamePDA(mid);
  await withSetupLock(async () => {
    await sendBase(await program.methods.createGame(mid).accounts({ user: wallet.publicKey }).transaction());
    const humansMask = r.humans.reduce((m, h) => m | (1 << h.color), 0);
    for (const h of r.humans) {
      await sendBase(await program.methods.join(mid, h.color, new PublicKey(h.sessionPubkey)).accounts({ signer: wallet.publicKey }).transaction());
    }
    const seed = new BN(Date.now());
    await sendBase(await program.methods.initArena(mid, seed, 0, humansMask).accounts({ signer: wallet.publicKey }).transaction());
    const delegate = program.methods.delegate(mid).accounts({ payer: wallet.publicKey, pda: r.gamePDA });
    if (VALIDATOR) delegate.remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]);
    await sendBase(await delegate.transaction());
  });
  await new Promise((res) => setTimeout(res, 1200));
  r.phase = 'live';
  r.startedAt = Date.now();
  roomCrankLoop(r);
  return { gamePDA: r.gamePDA.toBase58(), matchId: mid.toString() };
}

// Base-layer send with retry/backoff — the public devnet RPC rate-limits (429)
// under load; retry a few times before giving up.
async function sendBase(tx, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await baseProvider.sendAndConfirm(tx, [walletKp], { skipPreflight: true, commitment: 'processed' });
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

// Serialize each match's base-layer setup (create/join/init/delegate) so two
// matches starting at once don't hammer the base RPC in parallel → no 429.
let setupChain = Promise.resolve();
function withSetupLock(fn) {
  const run = setupChain.then(fn, fn);
  setupChain = run.then(() => {}, () => {});
  return run;
}

// Delegation program id (owns a delegated account until it's undelegated).
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

async function startMatch(humans, botCount, mode = 0) {
  // Each solo game is its own independent instance (fresh PDA + own loops), so
  // multiple browsers can run their own solo game at the same time.
  const m = {
    matchId: new BN(Date.now() + Math.floor(Math.random() * 4096)),
    gamePDA: null, bots: [], crankTimer: null, botTimer: null,
    latestGame: null, startedAt: 0, settling: false,
  };
  m.gamePDA = deriveGamePDA(m.matchId);

  await withSetupLock(async () => {
    await sendBase(await program.methods.createGame(m.matchId).accounts({ user: wallet.publicKey }).transaction());
    const used = new Set();
    for (const h of humans) {
      if (h == null || h.sessionPubkey == null) continue;
      used.add(h.color);
      await sendBase(await program.methods.join(m.matchId, h.color, new PublicKey(h.sessionPubkey)).accounts({ signer: wallet.publicKey }).transaction());
    }
    for (let color = 0; color < 4 && m.bots.length < botCount; color++) {
      if (used.has(color)) continue;
      const kp = Keypair.generate();
      m.bots.push({ color, kp });
      used.add(color);
      await sendBase(await program.methods.join(m.matchId, color, kp.publicKey).accounts({ signer: wallet.publicKey }).transaction());
    }
    const seed = new BN(Date.now());
    const humansMask = humans.reduce((mask, h) => (h && h.sessionPubkey ? mask | (1 << h.color) : mask), 0);
    await sendBase(await program.methods.initArena(m.matchId, seed, mode, humansMask).accounts({ signer: wallet.publicKey }).transaction());
    const delegate = program.methods.delegate(m.matchId).accounts({ payer: wallet.publicKey, pda: m.gamePDA });
    if (VALIDATOR) delegate.remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]);
    await sendBase(await delegate.transaction());
  });

  await new Promise((r) => setTimeout(r, 1200));
  startSoloLoops(m);
  soloMatches.add(m);
  return {
    gamePDA: m.gamePDA.toBase58(),
    matchId: m.matchId.toString(),
    programId: PROGRAM_ID.toBase58(),
    bots: m.bots.map((b) => b.color),
  };
}

const W = 15, H = 13;
const solid = (x, y) => x === 0 || y === 0 || x === W - 1 || y === H - 1 || (x % 2 === 0 && y % 2 === 0);
const bit = (arr, i) => ((arr[i >> 3] >> (i & 7)) & 1) === 1;
function cellBlocked(g, x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return true;
  if (solid(x, y)) return true;
  if (bit(g.walls, y * W + x)) return true;
  if (g.bombs.some((b) => b.active === 1 && b.x === x && b.y === y)) return true;
  return false;
}
function inBlast(g, x, y) {
  // treat cells in line with an active bomb (within radius) as dangerous
  for (const b of g.bombs) {
    if (b.active !== 1) continue;
    if (b.x === x && b.y === y) return true;
    for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
      for (let r = 1; r < b.radius; r++) {
        const nx = b.x + dx * r, ny = b.y + dy * r;
        if (solid(nx, ny) || bit(g.walls, ny * W + nx)) break;
        if (nx === x && ny === y) return true;
      }
    }
  }
  return false;
}
const DXY = { 0: [0,-1], 1: [0,1], 2: [-1,0], 3: [1,0] };

function stopSoloLoops(m) {
  if (m.crankTimer) clearInterval(m.crankTimer);
  if (m.botTimer) clearInterval(m.botTimer);
  if (m.subId != null) { try { erConn.removeAccountChangeListener(m.subId); } catch {} m.subId = null; }
  m.crankTimer = m.botTimer = null;
}

async function settleSolo(m) {
  if (m.settling) return;
  m.settling = true;
  try {
    await programER.methods.settle(m.matchId).accounts({ payer: wallet.publicKey }).rpc();
  } catch {
    /* ignore */
  } finally {
    m.settling = false;
  }
}

function startSoloLoops(m) {
  m.startedAt = Date.now();
  // Read via WS PUSH (one subscription) instead of fetching every tick.
  try {
    m.subId = erConn.onAccountChange(m.gamePDA, (acc) => {
      try { m.latestGame = erCoder.decode('game', acc.data); } catch {}
    }, { commitment: 'processed' });
  } catch {}
  let n = 0;
  m.crankTimer = setInterval(async () => {
    try {
      await programER.methods.tick(m.matchId).accounts({ game: m.gamePDA, signer: wallet.publicKey }).rpc();
    } catch {}
    if (++n % 10 === 0) {
      try { m.latestGame = await programER.account.game.fetch(m.gamePDA, 'processed'); } catch {}
    }
    const g = m.latestGame;
    if (g && (g.status === 2 || (g.status === 1 && Date.now() - m.startedAt > MAX_MATCH_MS))) {
      stopSoloLoops(m);
      await settleSolo(m);
      soloMatches.delete(m);
    }
  }, TICK_MS);

  // Smart bot AI (A* hunt + danger avoidance + safe bombing), driving on-chain
  // bots via their own session keys.
  m.botTimer = setInterval(async () => {
    const g = m.latestGame;
    if (!g || g.status !== 1) return;
    for (const b of m.bots) {
      // Hysteresis: keep the same target for a few ticks before re-picking, so
      // the bot heads somewhere instead of re-deciding (oscillating) each tick.
      const committed = b.targetAge !== undefined && b.targetAge < 8 ? b.target : null;
      const decision = decideBot(g, b.color, committed);
      if (!decision) { b.target = null; continue; }
      const p = new anchor.Program(
        idl,
        new anchor.AnchorProvider(erConn, new anchor.Wallet(b.kp), { commitment: 'processed' })
      );
      try {
        if (decision.bomb) {
          b.target = null; b.targetAge = 0;
          await p.methods.dropBomb(m.matchId, b.color)
            .accounts({ game: m.gamePDA, signer: b.kp.publicKey })
            .rpc({ skipPreflight: true, commitment: 'processed' });
        } else if (decision.move !== undefined) {
          // Commit / refresh the target (the move itself is always re-pathed
          // from the ACTUAL current cell inside decideBot → never desyncs).
          if (decision.flee || !decision.target) {
            b.target = null; b.targetAge = 0;
          } else if (b.target && b.target.x === decision.target.x && b.target.y === decision.target.y) {
            b.targetAge = (b.targetAge || 0) + 1;
          } else {
            b.target = decision.target; b.targetAge = 0;
          }
          await p.methods.movePlayer(m.matchId, b.color, decision.move)
            .accounts({ game: m.gamePDA, signer: b.kp.publicKey })
            .rpc({ skipPreflight: true, commitment: 'processed' });
        }
      } catch {}
    }
  }, BOT_MS);
}

// --- tiny HTTP server -----------------------------------------------------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  try {
    if (req.url === '/health') return json(res, 200, { ok: true, program: PROGRAM_ID.toBase58() });
    if (req.url === '/start' && req.method === 'POST') {
      const b = await readBody(req);
      const out = await startMatch(b.humans || b.players || [], b.botCount ?? 3);
      return json(res, 200, out);
    }
    if (req.url === '/settle' && req.method === 'POST') {
      // Settle every running solo match (rarely needed — cranks auto-settle).
      for (const m of [...soloMatches]) { stopSoloLoops(m); await settleSolo(m); soloMatches.delete(m); }
      return json(res, 200, { ok: true });
    }
    // Multiplayer: 3 rooms, REAL players only, 2..4 per match.
    if (req.url === '/rooms' && req.method === 'GET') {
      return json(res, 200, { rooms: rooms.map(roomView) });
    }
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/rooms/state' && req.method === 'GET') {
      const r = rooms[Number(u.searchParams.get('id'))];
      if (!r) return json(res, 404, { error: 'no room' });
      return json(res, 200, roomView(r));
    }
    if (u.pathname === '/rooms/join' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.sessionPubkey) return json(res, 400, { error: 'no sessionPubkey' });
      const r = rooms[b.roomId];
      if (!r) return json(res, 404, { error: 'no room' });
      // A finished/live room reopens fresh on the first new join.
      if (r.phase !== 'open') roomReset(r);
      const name = (b.name || '').toString().trim().slice(0, 16);
      let me = r.humans.find((h) => h.sessionPubkey === b.sessionPubkey);
      if (!me) {
        if (r.humans.length >= 4) return json(res, 400, { error: 'room full' });
        const color = nextColor(new Set(r.humans.map((h) => h.color)));
        me = { color, sessionPubkey: b.sessionPubkey, name };
        r.humans.push(me);
      } else if (name) {
        me.name = name; // allow updating the pseudo
      }
      return json(res, 200, { ...roomView(r), color: me.color });
    }
    if (u.pathname === '/rooms/leave' && req.method === 'POST') {
      const b = await readBody(req);
      const r = rooms[b.roomId];
      if (r && r.phase === 'open') r.humans = r.humans.filter((h) => h.sessionPubkey !== b.sessionPubkey);
      return json(res, 200, r ? roomView(r) : { ok: true });
    }
    if (u.pathname === '/rooms/start' && req.method === 'POST') {
      const b = await readBody(req);
      const r = rooms[b.roomId];
      if (!r) return json(res, 404, { error: 'no room' });
      if (r.phase !== 'open') return json(res, 200, roomView(r)); // already starting/live
      if (r.humans.length < 2) return json(res, 400, { error: 'need 2 players' });
      r.phase = 'starting';
      try {
        const out = await startRoomMatch(r);
        return json(res, 200, { ...out, ...roomView(r) });
      } catch (e) {
        r.phase = 'open';
        return json(res, 500, { error: String(e) });
      }
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('ERROR:', e);
    return json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CHAINBOMB host on http://127.0.0.1:${PORT}  program=${PROGRAM_ID.toBase58()}`);
});
