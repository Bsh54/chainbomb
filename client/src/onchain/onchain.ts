import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';
import idl from './chainbomb.json';

/** Minimal browser wallet backed by a Keypair (anchor's Wallet isn't browser-safe). */
class KeypairWallet {
  constructor(readonly payer: Keypair) {}
  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }
  async signTransaction<T extends Transaction>(tx: T): Promise<T> {
    (tx as Transaction).partialSign(this.payer);
    return tx;
  }
  async signAllTransactions<T extends Transaction>(txs: T[]): Promise<T[]> {
    txs.forEach((t) => (t as Transaction).partialSign(this.payer));
    return txs;
  }
}

/**
 * CHAINBOMB on-chain client.
 *
 * Reads the shared Game account from the Ephemeral Rollup in real time and
 * (later) sends gasless moves. Host setup (create/join/init/delegate/settle)
 * is done by a funded wallet via the server; the browser only needs a session
 * keypair to sign gasless ER transactions — no SOL required.
 */

export const BASE_RPC = 'https://api.devnet.solana.com';
// EU region — measured ~10-50x lower latency than Asia for our users.
export const ER_RPC = 'https://devnet-eu.magicblock.app/';
export const ER_WS = 'wss://devnet-eu.magicblock.app/';

const PROGRAM_ID = new PublicKey((idl as any).address);
const GAME_PREFIX = 'game'; // per-match PDA prefix: [ "game", matchId(u64 le) ]

// Directions (match the on-chain program)
export const DIR = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3 } as const;

// A multiplayer room's public snapshot (real players only).
export interface RoomView {
  id: number;
  count: number;
  phase: string; // 'open' | 'starting' | 'live'
  humans: { color: number; name: string }[];
  matchId: string | null;
  gamePDA: string | null;
}

// Normalized state the renderer/adapter can consume
export interface ChainPlayer {
  color: number;
  x: number;
  y: number;
  dir: number;
  alive: boolean;
  active: boolean;
  bombMax: number;
  radius: number;
}
export interface ChainBomb {
  x: number;
  y: number;
  owner: number;
  radius: number;
  timer: number;
}
export interface ChainState {
  status: number; // 0 lobby, 1 live, 2 ended
  tick: number;
  winner: number; // -1 none
  mode: number; // 0 = free-for-all, 1 = co-op (humans vs bots)
  humans: number; // bitmask: bit c set => color c is a human
  playerCount: number;
  players: ChainPlayer[];
  bombs: ChainBomb[];
  blasts: { x: number; y: number }[];
  walls: boolean[]; // 195
  bonus: boolean[]; // 195
}

const W = 15;
const H = 13;
const CELLS = W * H;

function bit(arr: number[], i: number): boolean {
  return ((arr[i >> 3] >> (i & 7)) & 1) === 1;
}

export class OnchainClient {
  readonly session: Keypair;
  gamePDA: PublicKey; // per-match — set via setMatch()
  private matchId: BN = new BN(0);
  private readonly erConn: Connection;
  private readonly baseConn: Connection;
  private readonly program: Program; // ER-bound (gasless actions + live reads)
  private readonly baseProgram: Program; // base-layer reads
  private subId: number | null = null;
  private listeners: ((s: ChainState) => void)[] = [];

  constructor() {
    this.session = loadSession();
    this.erConn = new Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: 'confirmed' });
    this.baseConn = new Connection(BASE_RPC, { commitment: 'confirmed' });
    const wallet = new KeypairWallet(this.session) as unknown as AnchorProvider['wallet'];
    this.program = new Program(
      idl as any,
      new AnchorProvider(this.erConn, wallet, { commitment: 'confirmed' })
    );
    this.baseProgram = new Program(
      idl as any,
      new AnchorProvider(this.baseConn, wallet, { commitment: 'confirmed' })
    );
    this.gamePDA = this.deriveGamePDA(this.matchId);
  }

  private deriveGamePDA(mid: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(GAME_PREFIX), mid.toArrayLike(Buffer, 'le', 8)],
      PROGRAM_ID
    )[0];
  }

  /** Point the client at a specific match's account (fresh PDA per match). */
  setMatch(matchId: string | number): void {
    this.unsubscribe(); // drop any subscription to the previous match's PDA
    this.roster = [];
    this.matchId = new BN(matchId);
    this.gamePDA = this.deriveGamePDA(this.matchId);
  }

  get sessionPubkey(): string {
    return this.session.publicKey.toBase58();
  }

  /** Normalize a decoded anchor account into ChainState. */
  private normalize(g: any): ChainState {
    const players: ChainPlayer[] = g.players.map((p: any, i: number) => ({
      color: i,
      x: p.x,
      y: p.y,
      dir: p.dir,
      alive: p.alive === 1,
      active: p.active === 1,
      bombMax: p.bombMax,
      radius: p.radius,
    }));
    const bombs: ChainBomb[] = g.bombs
      .filter((b: any) => b.active === 1)
      .map((b: any) => ({ x: b.x, y: b.y, owner: b.owner, radius: b.radius, timer: b.timer }));
    const blasts = g.blasts
      .filter((bl: any) => bl.life > 0)
      .map((bl: any) => ({ x: bl.x, y: bl.y }));
    const walls: boolean[] = [];
    const bonus: boolean[] = [];
    const wallsArr = Array.from(g.walls as number[]);
    const bonusArr = Array.from(g.bonus as number[]);
    for (let i = 0; i < CELLS; i++) {
      walls.push(bit(wallsArr, i));
      bonus.push(bit(bonusArr, i));
    }
    return {
      status: g.status,
      tick: typeof g.tick === 'number' ? g.tick : (g.tick as BN).toNumber(),
      winner: g.winner,
      mode: g.mode ?? 0,
      humans: g.humans ?? 0,
      playerCount: g.playerCount,
      players,
      bombs,
      blasts,
      walls,
      bonus,
    };
  }

  /** Fetch the current on-chain state once (ER first, base layer fallback). */
  async fetchState(): Promise<ChainState | null> {
    try {
      const g = await (this.program.account as any).game.fetch(this.gamePDA);
      return this.normalize(g);
    } catch {
      /* not delegated / not in ER — fall through to base layer */
    }
    try {
      const g = await (this.baseProgram.account as any).game.fetch(this.gamePDA);
      return this.normalize(g);
    } catch {
      return null;
    }
  }

  /** Subscribe to live updates from the ER. */
  subscribe(cb: (s: ChainState) => void): void {
    this.listeners.push(cb);
    if (this.subId !== null) return;
    const coder = (this.program as any).coder.accounts;
    this.subId = this.erConn.onAccountChange(
      this.gamePDA,
      (acc) => {
        try {
          const g = coder.decode('game', acc.data);
          const s = this.normalize(g);
          for (const l of this.listeners) l(s);
        } catch {
          /* ignore decode errors */
        }
      },
      { commitment: 'processed' }
    );
  }

  unsubscribe(): void {
    if (this.subId !== null) {
      this.erConn.removeAccountChangeListener(this.subId);
      this.subId = null;
    }
    this.listeners = [];
  }

  /** Ask the host service to set up + delegate a match with this session. */
  async startHostedMatch(color: number, botCount = 3): Promise<{ gamePDA: string; matchId: string }> {
    const humans = [{ color, sessionPubkey: this.sessionPubkey }];
    const res = await fetch('/host/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ humans, botCount }),
    });
    const out = await res.json();
    if (out.matchId != null) this.setMatch(out.matchId);
    return out;
  }

  // --- multiplayer rooms (real players only, 2..4 per match) -------------
  /** List the rooms with their live real-player counts. */
  async listRooms(): Promise<{ rooms: RoomView[] }> {
    const res = await fetch('/host/rooms');
    return res.json();
  }

  /** Join a specific room with a pseudo; returns my color + the room snapshot. */
  async joinRoom(roomId: number, name: string): Promise<RoomView & { color: number }> {
    const res = await fetch('/host/rooms/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, sessionPubkey: this.sessionPubkey, name }),
    });
    return res.json();
  }

  // color → pseudo, captured from the room when the match starts, so SEE DATA
  // and in-game labels can show real names.
  private playerNames = new Map<number, string>();
  setPlayerNames(humans: { color: number; name: string }[]): void {
    this.playerNames.clear();
    for (const h of humans) this.playerNames.set(h.color, h.name);
  }
  nameFor(color: number): string | undefined {
    return this.playerNames.get(color);
  }

  /** Leave a room (frees my slot so counts drop). */
  async leaveRoom(roomId: number): Promise<void> {
    try {
      await fetch('/host/rooms/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, sessionPubkey: this.sessionPubkey }),
      });
    } catch {
      /* ignore */
    }
  }

  /** Current snapshot of one room (poll while in the lobby). */
  async roomState(roomId: number): Promise<RoomView> {
    const res = await fetch(`/host/rooms/state?id=${roomId}`);
    return res.json();
  }

  /** Start a room's match (host requires >= 2 real players, no bots). */
  async startRoom(roomId: number): Promise<RoomView & { matchId?: string }> {
    const res = await fetch('/host/rooms/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId }),
    });
    return res.json();
  }

  async settleMatch(): Promise<void> {
    try {
      await fetch('/host/settle', { method: 'POST' });
    } catch {
      /* ignore */
    }
  }

  // --- gasless ER actions (reliable ordered queue) -----------------------
  // Many txs hit the single Game account (you + crank + bots), so concurrent
  // sends get dropped → the local player snaps back. Fix: a serial queue that
  // sends ONE action at a time, awaiting 'processed', so every action lands in
  // order. Prediction gives the instant feel; the queue drains behind it.
  private queue: Array<{ method: 'movePlayer' | 'dropBomb'; args: number[] }> = [];
  private draining = false;

  // Verifiable on-chain activity feed: every landed action's tx signature.
  private txCount = 0;
  private txListeners: ((sig: string, kind: string) => void)[] = [];
  onTx(cb: (sig: string, kind: string) => void): void {
    this.txListeners.push(cb);
  }
  get transactionCount(): number {
    return this.txCount;
  }
  get programId(): string {
    return PROGRAM_ID.toBase58();
  }

  /**
   * Recent on-chain actions for the game account, read straight from the ER.
   * Persistent (not session-bound) so the VERIFY panel always shows the real
   * latest moves/bombs even after a reload. Newest first.
   */
  async recentSignatures(limit = 10): Promise<{ sig: string; failed: boolean }[]> {
    try {
      const sigs = await this.erConn.getSignaturesForAddress(this.gamePDA, { limit });
      return sigs.map((s) => ({ sig: s.signature, failed: s.err != null }));
    } catch {
      return [];
    }
  }

  /**
   * Recent actions with the AUTHOR resolved: every tx's signer is matched
   * against each player's on-chain `authority`, so we can label it "P2 · BOT ·
   * MOVE", "P1 · YOU · BOMB", or "SYSTEM · tick". Fully verifiable — the mapping
   * comes straight from the account (authority per slot + humans bitmask).
   */
  async recentActions(
    limit = 60
  ): Promise<{ sig: string; failed: boolean; kind: string; color: number; role: string }[]> {
    try {
      const sigs = await this.erConn.getSignaturesForAddress(this.gamePDA, { limit });
      // Prefer the live snapshot (stable authorities); else fetch the account.
      if (!this.roster.length) await this.snapshotRoster();
      const authToColor = new Map<string, number>();
      const humanSet = new Set<number>();
      this.roster.forEach((r) => {
        if (r.active) {
          authToColor.set(r.authority, r.color);
          if (r.isHuman) humanSet.add(r.color);
        }
      });
      const mine = this.sessionPubkey;
      // Parallel fetch — 60 sequential getParsedTransaction calls take ~15s and
      // leave the table blank; in parallel it resolves in ~1-2s.
      const txs = await Promise.all(
        sigs.map((s) =>
          this.erConn
            .getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
            .catch(() => null)
        )
      );
      return sigs.map((s, idx) => {
        const tx = txs[idx];
        const signer = tx?.transaction.message.accountKeys.find((k: any) => k.signer)?.pubkey.toBase58();
        const log = (tx?.meta?.logMessages || []).find((l: string) => l.includes('Instruction:')) || '';
        const ins = (log.split('Instruction:')[1] || '').trim();
        const kind = ins === 'MovePlayer' ? 'MOVE' : ins === 'DropBomb' ? 'BOMB' : ins || 'TX';
        let color = -1;
        let role = 'SYSTEM';
        if (signer && authToColor.has(signer)) {
          color = authToColor.get(signer)!;
          role = humanSet.has(color) ? (signer === mine ? 'YOU' : 'PLAYER') : 'BOT';
        }
        return { sig: s.signature, failed: s.err != null, kind, color, role };
      });
    } catch {
      return [];
    }
  }

  /**
   * COMPLETE per-player action history for the match — every MOVE/BOMB tx of
   * every player, precisely. Works because each match has its OWN PDA, so the
   * account's full signature history is exactly this match (no other matches
   * mixed in). Paginates all signatures, then parses them (ticks excluded).
   * `onProgress` reports how many are parsed so the UI can show a live count.
   */
  async matchActions(
    onProgress?: (done: number, total: number) => void
  ): Promise<{ sig: string; failed: boolean; kind: string; color: number; role: string }[]> {
    try {
      // 1) paginate ALL signatures (fast: ~300ms even for hundreds).
      let all: { signature: string; err: unknown }[] = [];
      let before: string | undefined;
      for (let guard = 0; guard < 4; guard++) {
        const page = await this.erConn.getSignaturesForAddress(this.gamePDA, { limit: 1000, before });
        if (!page.length) break;
        all = all.concat(page.map((p) => ({ signature: p.signature, err: p.err })));
        before = page[page.length - 1].signature;
        if (page.length < 1000) break;
      }
      // 2) resolve authorities (live snapshot preferred).
      if (!this.roster.length) await this.snapshotRoster();
      const authToColor = new Map<string, number>();
      const humanSet = new Set<number>();
      this.roster.forEach((r) => {
        if (r.active) {
          authToColor.set(r.authority, r.color);
          if (r.isHuman) humanSet.add(r.color);
        }
      });
      const mine = this.sessionPubkey;
      // 3) parse in BATCHED RPC calls (getParsedTransactions = one request per
      //    chunk instead of one per signature → far fewer round-trips).
      const out: { sig: string; failed: boolean; kind: string; color: number; role: string }[] = [];
      const BATCH = 100;
      for (let i = 0; i < all.length; i += BATCH) {
        const chunk = all.slice(i, i + BATCH);
        let txs: (any | null)[];
        try {
          txs = await this.erConn.getParsedTransactions(
            chunk.map((s) => s.signature),
            { maxSupportedTransactionVersion: 0 }
          );
        } catch {
          txs = chunk.map(() => null);
        }
        chunk.forEach((s, idx) => {
          const tx = txs[idx];
          const log = (tx?.meta?.logMessages || []).find((l: string) => l.includes('Instruction:')) || '';
          const ins = (log.split('Instruction:')[1] || '').trim();
          if (ins !== 'MovePlayer' && ins !== 'DropBomb') return; // skip ticks/system
          const kind = ins === 'MovePlayer' ? 'MOVE' : 'BOMB';
          const signer = tx?.transaction.message.accountKeys.find((k: any) => k.signer)?.pubkey.toBase58();
          let color = -1;
          let role = 'SYSTEM';
          if (signer && authToColor.has(signer)) {
            color = authToColor.get(signer)!;
            role = humanSet.has(color) ? (signer === mine ? 'YOU' : 'PLAYER') : 'BOT';
          }
          out.push({ sig: s.signature, failed: s.err != null, kind, color, role });
        });
        onProgress?.(Math.min(i + BATCH, all.length), all.length);
      }
      return out;
    } catch {
      return [];
    }
  }

  // Roster snapshot (authority per slot) captured WHILE the match is live, so
  // SEE DATA can label txs correctly even after the account is undelegated.
  private roster: {
    color: number;
    active: boolean;
    isHuman: boolean;
    isYou: boolean;
    authority: string;
  }[] = [];

  /** Capture the roster (called once when the match goes live). */
  async snapshotRoster(): Promise<void> {
    try {
      const g: any = await (this.program.account as any).game.fetch(this.gamePDA);
      const humans = g.humans ?? 0;
      const mine = this.sessionPubkey;
      this.roster = g.players.map((p: any, i: number) => ({
        color: i,
        active: p.active === 1,
        isHuman: ((humans >> i) & 1) === 1,
        isYou: p.authority.toBase58() === mine,
        authority: p.authority.toBase58(),
      }));
    } catch {
      /* keep any previous snapshot */
    }
  }

  /** Per-slot roster of the current/last match (for the SEE DATA table header). */
  async matchRoster(): Promise<
    { color: number; active: boolean; isHuman: boolean; isYou: boolean; authority: string }[]
  > {
    if (!this.roster.length) await this.snapshotRoster();
    return this.roster.map(({ color, active, isHuman, isYou, authority }) => ({
      color, active, isHuman, isYou, authority,
    }));
  }

  private enqueue(method: 'movePlayer' | 'dropBomb', args: number[]): void {
    // Cap the queue so fast input can't build unbounded lag (keep latest).
    if (this.queue.length >= 3) this.queue.shift();
    this.queue.push({ method, args });
    if (!this.draining) this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    while (this.queue.length) {
      const a = this.queue.shift()!;
      try {
        // preflight ON: the EU ER drops skipPreflight txs; with preflight the
        // tx is processed reliably. 'confirmed' guarantees it lands (fast on EU).
        const sig = await (this.program.methods as any)
          [a.method](this.matchId, ...a.args)
          .accounts({ game: this.gamePDA, signer: this.session.publicKey })
          .rpc({ skipPreflight: false, commitment: 'confirmed' });
        this.txCount++;
        const kind = a.method === 'dropBomb' ? 'BOMB' : 'MOVE';
        for (const l of this.txListeners) l(sig as string, kind);
      } catch (e) {
        console.warn('[chain] ' + a.method + ' failed:', (e as any)?.message || String(e));
      }
    }
    this.draining = false;
  }

  async debugMove(color: number, dir: number): Promise<string> {
    try {
      const sig = await (this.program.methods as any)
        .movePlayer(this.matchId, color, dir)
        .accounts({ game: this.gamePDA, signer: this.session.publicKey })
        .rpc({ skipPreflight: false, commitment: 'confirmed' });
      return 'OK ' + sig;
    } catch (e) {
      return 'ERR ' + ((e as any)?.message || String(e));
    }
  }

  async ensureRealtime(): Promise<void> {
    /* queue-based; nothing to warm up */
  }
  move(color: number, dir: number): Promise<void> {
    this.enqueue('movePlayer', [color, dir]);
    return Promise.resolve();
  }
  dropBomb(color: number): Promise<void> {
    this.enqueue('dropBomb', [color]);
    return Promise.resolve();
  }
}

function loadSession(): Keypair {
  try {
    const raw = localStorage.getItem('chainbomb-session');
    if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    /* ignore */
  }
  const kp = Keypair.generate();
  try {
    localStorage.setItem('chainbomb-session', JSON.stringify(Array.from(kp.secretKey)));
  } catch {
    /* ignore */
  }
  return kp;
}
