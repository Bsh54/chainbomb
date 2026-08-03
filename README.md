# CHAINBOMB

**A fully on-chain Bomberman — every move, every bomb, every explosion is a Solana transaction, made real-time and gasless with MagicBlock Ephemeral Rollups.**

Classic 15×13 grid, up to 4 players, last one standing wins. The twist: there is no authoritative game server holding the truth. The board lives in a Solana account, and the game logic runs *inside the program*. Players sign their inputs with session keys and stream them into an Ephemeral Rollup, where the state advances tick by tick at real-time speed before being committed back to Solana devnet.

---

## Why this is interesting

A traditional multiplayer game trusts a central server. CHAINBOMB doesn't. The rules — movement cooldowns, bomb timers, blast propagation, who dies — are all enforced by the on-chain program. That means:

- **No trusted referee.** The program is the referee. Nobody can move through a wall or survive a blast they were caught in, because the chain won't let them.
- **Real-time anyway.** Base-layer Solana is far too slow (and too expensive) to run a 14 fps game. Ephemeral Rollups fix exactly this: the account is *delegated* to a rollup, thousands of gasless writes happen there in real time, then the final state is *committed and undelegated* back to L1.
- **Auditable matches.** Because every action is a transaction, a full match is replayable from chain history. The in-game "MATCH DATA" panel reconstructs each player's move list straight from parsed transactions.

This is the hard part of the MagicBlock hackathon brief made concrete: a genuinely latency-sensitive application that would be impossible on base-layer alone, but becomes playable with ERs.

---

## Architecture

```
                       ┌──────────────────────────────────────┐
                       │            Browser client             │
                       │   (TypeScript + Canvas, Vite)         │
                       │  - client-side prediction (you)       │
                       │  - interpolation (remote players)     │
                       │  - session keypair signs ER txs       │
                       └───────────────┬──────────────────────┘
                                       │  gasless move/bomb txs
                                       ▼
   Solana devnet (L1)          MagicBlock Ephemeral Rollup (EU validator)
 ┌───────────────────┐        ┌───────────────────────────────────────┐
 │  chainbomb program│  dele- │  same program, same PDA, but the state │
 │  Game PDA per     │ ─gate─▶ │  advances in real time. `tick` runs   │
 │  match_id         │        │  the physics; move/drop_bomb apply     │
 │                   │ ◀─commit│ inputs. Zero gas, ~tens of ms.        │
 └───────────────────┘  &undel └───────────────────────────────────────┘
          ▲                                     ▲
          │ setup / delegate / settle           │ crank `tick`, relay bot inputs
          │                                     │
     ┌────┴─────────────────────────────────────┴────┐
     │                 Host / crank service           │
     │            (Node, host.mjs, port 7070)          │
     │  - creates a fresh Game PDA per match_id        │
     │  - delegates it to the ER                       │
     │  - cranks `tick` on a fixed interval            │
     │  - drives session bots (solo mode)              │
     │  - room lobbies for real-player multiplayer     │
     │  - commits & settles finished matches           │
     └─────────────────────────────────────────────────┘
```

### Repository layout

| Path | What it is |
|------|-----------|
| `program/` | The Anchor/Solana program. All game rules live in `programs/chainbomb/src/lib.rs`. |
| `host/` | The Node orchestrator (`host.mjs`), the session-bot AI (`smart-bot.mjs`), and the compiled program IDL (`idl/chainbomb.json`). |
| `client/` | The browser game (TypeScript + HTML5 Canvas, built with Vite). On-chain integration lives in `client/src/onchain/`. |

---

## The on-chain program (`program/programs/chainbomb/src/lib.rs`)

The whole board is a single **zero-copy account** (`bytemuck` + Anchor `AccountLoader`) so it's cheap to read and mutate every tick. One account per match, addressed by a **per-match PDA**:

```
seeds = [b"game", match_id.to_le_bytes()]
```

Deriving the PDA from a `match_id: u64` (the first argument of every instruction) is what makes concurrent, independent matches possible — and it permanently sidesteps the "stuck delegation" trap, because a brand-new match is always a brand-new PDA.

Instructions:

| Instruction | Role |
|-------------|------|
| `create_game` / `reset_game` | Allocate / reset the board account. |
| `join(color, authority)` | Seat a player in slot 0..3; `authority` is the player's **session pubkey** that will sign gasless moves. |
| `init_arena(seed, mode, humans)` | Deterministically generate destructible blocks from a seed; set player/team layout. |
| `delegate` | Hand the PDA to the Ephemeral Rollup. |
| `move_player(color, dir)` | Move one cell, subject to `MOVE_COOLDOWN`, walls, and blocks. |
| `drop_bomb(color)` | Place a bomb (respects per-player bomb budget & radius). |
| `tick` | Advance the world one step: countdown bombs, propagate blasts, kill players, expire flames, detect the winner. Cranked by the host. |
| `commit` | Commit ER state back to L1 without ending delegation. |
| `settle` | Commit **and** undelegate — the match is over, the final board is back on devnet. |

Timing constants (at ~70 ms/tick): `MOVE_COOLDOWN = 2`, `BOMB_TIMER = 36` (~2.5 s), `BLAST_LIFE = 8` (~0.56 s). The program ships with unit tests for the pure logic (arena generation, blast propagation, win detection).

**Program ID (devnet):** `5trVxcUHFxajdaawgs2EYCaMGfgC982v9VP8iZx88sWZ`

---

## The host (`host/host.mjs`)

A small Node HTTP service (port `7070`) that owns everything the browser shouldn't: delegation, cranking, settlement, and bot control. Design notes that took the most iteration:

- **State via WebSocket, not polling.** The host subscribes to the Game account with `onAccountChange` (commitment `processed`) instead of fetching every tick. This was the fix that stopped the RPC from returning `429 Too Many Requests` and taking the whole process down under concurrent matches.
- **Serialized setup + retry/backoff.** Match base-setup (create → join → init → delegate) runs under a lock so two matches starting at once don't hammer the base RPC into failure. Transaction sends retry with linear backoff.
- **Crash-proof.** Global `uncaughtException` / `unhandledRejection` guards keep one bad match from killing every other live game.
- **Two entry points:**
  - **Solo** (`POST /start`) — a match against session bots. Each bot has its own keypair and signs its own gasless ER inputs.
  - **Rooms** (`/rooms`, `/rooms/join`, `/rooms/start`, …) — three concurrent lobbies for **real players only**, min 2 / max 4 per room, each running as an independent match with its own PDA and crank loop.

### Bots (`host/smart-bot.mjs`)

The solo-mode opponents run A\* pathfinding with a live danger map (which cells are about to be on fire), target commitment with hysteresis so they don't oscillate, and reactive bomb/flee behavior. They read fresh state off the same WebSocket feed the host uses, so they react at real-time speed.

---

## The client (`client/`)

A TypeScript + Canvas game. The on-chain layer lives in `client/src/onchain/`:

- A browser-safe `KeypairWallet` and a **session keypair** so the player signs their own gasless ER transactions without a wallet popup on every move.
- **Client-side prediction** for your own player (instant response) with **reconciliation** against committed chain state; **interpolation** for remote players so they glide instead of teleporting.
- A **collapsible live-transaction widget** showing on-chain activity in real time, and a **MATCH DATA** panel that reconstructs every player's full move history from parsed transactions.
- A **nickname system** synced through the host so players see each other's names across devices.

---

## Running it

> Prerequisites: Rust + Anchor, the Solana CLI, and Node 18+. A funded devnet keypair at `~/.config/solana/id.json`.

**1. Build & deploy the program (devnet):**

```bash
cd program
anchor build
solana program deploy target/deploy/chainbomb.so \
  --program-id target/deploy/chainbomb-keypair.json \
  -u d --upgrade-authority ~/.config/solana/id.json
```

**2. Start the host:**

```bash
cd host
npm install
npm start          # listens on :7070
```

**3. Start the client:**

```bash
cd client
npm install
npm run dev        # Vite dev server
```

Open the client, pick **Play on-chain** for a solo match against bots, or **Multiplayer** to enter a nickname, join one of the three rooms, and start once at least two real players are in.

---

## MagicBlock endpoints (devnet, EU)

| | |
|---|---|
| ER validator | `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` |
| RPC | `https://devnet-eu.magicblock.app/` |
| WebSocket | `wss://devnet-eu.magicblock.app/` |

---

## License

MIT.
