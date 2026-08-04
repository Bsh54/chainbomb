# CHAINBOMB

A fully on-chain Bomberman on Solana. Classic 15×13 grid, up to 4 players, last one standing wins — except the game logic runs inside a Solana program instead of a game server. Every move, bomb and explosion is a transaction, made real-time and gasless with **MagicBlock Ephemeral Rollups**: the board account is delegated to a rollup, the match runs there at real-time speed, then the final state is committed back to devnet.

**Program ID (devnet):** `5trVxcUHFxajdaawgs2EYCaMGfgC982v9VP8iZx88sWZ`

## Structure

| Path | What it is |
|------|-----------|
| `program/` | The Solana/Anchor program — all game rules live in `programs/chainbomb/src/lib.rs` (a zero-copy account, one PDA per match). |
| `host/` | Node orchestrator (`host.mjs`): creates matches, delegates to the ER, cranks `tick`, settles. Includes the bot AI (`smart-bot.mjs`) and the program IDL. |
| `client/` | The browser game (TypeScript + HTML5 Canvas, Vite). On-chain code is in `client/src/onchain/`. |

## Program instructions

`create_game` / `reset_game` (allocate the board) · `join` (seat a player with a session key) · `init_arena` (generate the map from a seed) · `delegate` (hand the PDA to the rollup) · `move_player` / `drop_bomb` (player inputs) · `tick` (advance the world — bombs, blasts, deaths, winner) · `commit` / `settle` (push state back to L1).

## Running it

Requirements: Rust + Anchor, the Solana CLI, Node 18+, and a funded devnet keypair at `~/.config/solana/id.json`.

**1. Build & deploy the program (devnet):**
```bash
cd program
anchor build
solana program deploy target/deploy/chainbomb.so \
  --program-id target/deploy/chainbomb-keypair.json \
  -u d --upgrade-authority ~/.config/solana/id.json
```

**2. Start the host** (port `7070`):
```bash
cd host
npm install
npm start
```

**3. Start the client:**
```bash
cd client
npm install
npm run dev
```

Then open the client: **Play on-chain** for a solo match against bots, or **Multiplayer** to pick a nickname, join a room and start once at least two players are in.

## MagicBlock endpoints (devnet, EU)

- Validator: `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e`
- RPC: `https://devnet-eu.magicblock.app/`
- WebSocket: `wss://devnet-eu.magicblock.app/`

## License

MIT.
