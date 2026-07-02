use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("5trVxcUHFxajdaawgs2EYCaMGfgC982v9VP8iZx88sWZ");

pub const GAME_SEED: &[u8] = b"game";

// Arena dimensions (classic bomberman-style grid)
pub const W: usize = 15;
pub const H: usize = 13;
pub const CELLS: usize = W * H; // 195
pub const WALL_BYTES: usize = (CELLS + 7) / 8; // 25

// Tile helpers -------------------------------------------------------------
#[inline]
fn is_solid(x: usize, y: usize) -> bool {
    // Border + fixed pillars on even/even interior cells
    x == 0 || y == 0 || x == W - 1 || y == H - 1 || (x % 2 == 0 && y % 2 == 0)
}

#[inline]
fn idx(x: usize, y: usize) -> usize {
    y * W + x
}

// Directions
pub const DIR_UP: u8 = 0;
pub const DIR_DOWN: u8 = 1;
pub const DIR_LEFT: u8 = 2;
pub const DIR_RIGHT: u8 = 3;

// Game status
pub const ST_LOBBY: u8 = 0;
pub const ST_LIVE: u8 = 1;
pub const ST_ENDED: u8 = 2;

pub const MOVE_COOLDOWN: u8 = 2; // ticks between moves (~140ms at 70ms/tick)
pub const BOMB_TIMER: u16 = 36; // ticks until explosion (~2.5s at 70ms/tick)
pub const BLAST_LIFE: u8 = 8; // ticks a flame cell stays (~0.56s)
pub const MAX_BOMBS: usize = 12;
pub const MAX_BLASTS: usize = 48;

#[ephemeral]
#[program]
pub mod chainbomb {
    use super::*;

    /// Create (or reset) the shared game account.
    pub fn create_game(ctx: Context<CreateGame>, match_id: u64) -> Result<()> {
        let _ = match_id; // used by the PDA seeds
        let mut g = ctx.accounts.game.load_init()?;
        g.reset();
        Ok(())
    }

    /// Reset a game that is not currently delegated/live.
    pub fn reset_game(ctx: Context<MutateGame>, match_id: u64) -> Result<()> {
        let _ = match_id;
        let mut g = ctx.accounts.game.load_mut()?;
        require!(g.status != ST_LIVE, ChainErr::GameLive);
        g.reset();
        Ok(())
    }

    /// Register a player in `color` slot (0..3) with a given session authority.
    /// The signer (host / funded wallet) pays; `authority` is the player's
    /// session pubkey that will sign gasless moves in the ER.
    pub fn join(ctx: Context<MutateGame>, match_id: u64, color: u8, authority: Pubkey) -> Result<()> {
        let _ = match_id;
        let mut g = ctx.accounts.game.load_mut()?;
        require!(g.status == ST_LOBBY, ChainErr::NotLobby);
        let c = color as usize;
        require!(c < 4, ChainErr::BadColor);
        require!(g.players[c].active == 0, ChainErr::SlotTaken);

        let (sx, sy) = spawn(c);
        let p = &mut g.players[c];
        p.authority = authority;
        p.x = sx as u8;
        p.y = sy as u8;
        p.dir = DIR_DOWN;
        p.alive = 1;
        p.active = 1;
        p.bomb_max = 1;
        p.bomb_used = 0;
        p.radius = 2;
        p.move_cd = 0;
        g.player_count += 1;
        Ok(())
    }

    /// Fill breakable walls from a seed and set the arena live (base layer).
    pub fn init_arena(ctx: Context<MutateGame>, match_id: u64, seed: u64, mode: u8, humans: u8) -> Result<()> {
        let _ = match_id;
        let mut g = ctx.accounts.game.load_mut()?;
        require!(g.status == ST_LOBBY, ChainErr::NotLobby);
        require!(g.player_count >= 1, ChainErr::NoPlayers);
        g.seed = seed;
        g.mode = mode;
        g.humans = humans;
        g.fill_walls(seed);
        g.status = ST_LIVE;
        Ok(())
    }

    /// Delegate the game account to the Ephemeral Rollup.
    pub fn delegate(ctx: Context<DelegateInput>, match_id: u64) -> Result<()> {
        let mid = match_id.to_le_bytes();
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[GAME_SEED, mid.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|a| a.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Move a player one cell (gasless in the ER). Signer must be the authority.
    pub fn move_player(ctx: Context<MutateGame>, match_id: u64, color: u8, dir: u8) -> Result<()> {
        let _ = match_id;
        let mut g = ctx.accounts.game.load_mut()?;
        require!(g.status == ST_LIVE, ChainErr::NotLive);
        let c = color as usize;
        require!(c < 4, ChainErr::BadColor);
        require!(
            g.players[c].active == 1 && g.players[c].alive == 1,
            ChainErr::DeadOrEmpty
        );
        require!(
            g.players[c].authority == ctx.accounts.signer.key(),
            ChainErr::NotAuthority
        );
        if g.players[c].move_cd > 0 {
            return Ok(());
        }

        let (mut nx, mut ny) = (g.players[c].x as i32, g.players[c].y as i32);
        match dir {
            DIR_UP => ny -= 1,
            DIR_DOWN => ny += 1,
            DIR_LEFT => nx -= 1,
            DIR_RIGHT => nx += 1,
            _ => return Ok(()),
        }
        g.players[c].dir = dir;

        if nx < 0 || ny < 0 || nx >= W as i32 || ny >= H as i32 {
            return Ok(());
        }
        let (ux, uy) = (nx as usize, ny as usize);
        if is_solid(ux, uy) || g.wall_at(ux, uy) || g.bomb_at(ux, uy) {
            return Ok(());
        }
        g.players[c].x = ux as u8;
        g.players[c].y = uy as u8;
        g.players[c].move_cd = MOVE_COOLDOWN;

        // pickup bonus
        g.pickup_bonus(c);
        Ok(())
    }

    /// Drop a bomb at the player's current cell.
    pub fn drop_bomb(ctx: Context<MutateGame>, match_id: u64, color: u8) -> Result<()> {
        let _ = match_id;
        let mut g = ctx.accounts.game.load_mut()?;
        require!(g.status == ST_LIVE, ChainErr::NotLive);
        let c = color as usize;
        require!(c < 4, ChainErr::BadColor);
        require!(
            g.players[c].active == 1 && g.players[c].alive == 1,
            ChainErr::DeadOrEmpty
        );
        require!(
            g.players[c].authority == ctx.accounts.signer.key(),
            ChainErr::NotAuthority
        );
        if g.players[c].bomb_used >= g.players[c].bomb_max {
            return Ok(());
        }
        let (bx, by, prad) = (g.players[c].x, g.players[c].y, g.players[c].radius);
        if g.bomb_at(bx as usize, by as usize) {
            return Ok(());
        }
        let mut placed = false;
        for b in g.bombs.iter_mut() {
            if b.active == 0 {
                b.active = 1;
                b.x = bx;
                b.y = by;
                b.owner = color;
                b.radius = prad;
                b.timer = BOMB_TIMER;
                placed = true;
                break;
            }
        }
        if placed {
            g.players[c].bomb_used += 1;
        }
        Ok(())
    }

    /// Advance the simulation one tick (gasless in ER; anyone can crank).
    pub fn tick(ctx: Context<MutateGame>, match_id: u64) -> Result<()> {
        let _ = match_id;
        let mut g = ctx.accounts.game.load_mut()?;
        if g.status != ST_LIVE {
            return Ok(());
        }
        g.tick += 1;

        // cooldowns
        for p in g.players.iter_mut() {
            if p.move_cd > 0 {
                p.move_cd -= 1;
            }
        }
        // blasts fade
        for bl in g.blasts.iter_mut() {
            if bl.life > 0 {
                bl.life -= 1;
            }
        }
        // bombs
        let mut explode: Vec<usize> = Vec::new();
        for (i, b) in g.bombs.iter_mut().enumerate() {
            if b.active == 1 {
                if b.timer > 0 {
                    b.timer -= 1;
                }
                if b.timer == 0 {
                    explode.push(i);
                }
            }
        }
        for i in explode {
            g.explode(i);
        }
        g.check_victory();
        Ok(())
    }

    /// Manual commit of the game state within the ER.
    pub fn commit(ctx: Context<CommitGame>, match_id: u64) -> Result<()> {
        let _ = match_id;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.game.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Settle: commit final state and undelegate back to Solana.
    pub fn settle(ctx: Context<CommitGame>, match_id: u64) -> Result<()> {
        let _ = match_id;
        {
            let mut g = ctx.accounts.game.load_mut()?;
            g.check_victory();
            if g.status != ST_ENDED {
                g.status = ST_ENDED;
                g.winner = g.last_alive();
            }
        }
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.game.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

#[inline]
fn spawn(c: usize) -> (usize, usize) {
    match c {
        0 => (1, 1),
        1 => (W - 2, 1),
        2 => (1, H - 2),
        _ => (W - 2, H - 2),
    }
}

#[zero_copy]
#[derive(Default)]
#[repr(C)]
pub struct Player {
    pub authority: Pubkey, // 32
    pub x: u8,
    pub y: u8,
    pub dir: u8,
    pub alive: u8,
    pub active: u8,
    pub bomb_max: u8,
    pub bomb_used: u8,
    pub radius: u8,
    pub move_cd: u8,
    pub _pad: [u8; 7], // align to 8
}

#[zero_copy]
#[derive(Default)]
#[repr(C)]
pub struct Bomb {
    pub timer: u16,
    pub x: u8,
    pub y: u8,
    pub owner: u8,
    pub radius: u8,
    pub active: u8,
    pub _pad: u8,
}

#[zero_copy]
#[derive(Default)]
#[repr(C)]
pub struct BlastCell {
    pub x: u8,
    pub y: u8,
    pub life: u8,
    pub _pad: u8,
}

// Fields ordered by descending alignment to keep the zero-copy layout free of
// padding (required for bytemuck Pod). u64 -> u32 -> u16 arrays -> u8 arrays.
#[account(zero_copy)]
#[repr(C)]
pub struct Game {
    pub seed: u64,                        // align 8
    pub tick: u32,                        // align 4
    pub bombs: [Bomb; MAX_BOMBS],         // align 2 (12*8 = 96)
    pub players: [Player; 4],             // align 1 (4*48 = 192)
    pub blasts: [BlastCell; MAX_BLASTS],  // align 1 (48*4 = 192)
    pub walls: [u8; WALL_BYTES],          // 25 (breakable walls bitset)
    pub bonus: [u8; WALL_BYTES],          // 25 (bonus present bitset)
    pub bonus_type: [u8; CELLS],          // 195 (type per cell)
    pub status: u8,
    pub player_count: u8,
    pub winner: i8,
    pub mode: u8,                         // 0 = FFA, 1 = co-op (humans vs bots)
    pub humans: u8,                       // bitmask: bit c set => color c is human
    pub _pad: [u8; 2],                    // total 744 (multiple of 8)
}

impl Game {
    fn reset(&mut self) {
        self.players = [Player::default(); 4];
        self.bombs = [Bomb::default(); MAX_BOMBS];
        self.blasts = [BlastCell::default(); MAX_BLASTS];
        self.seed = 0;
        self.tick = 0;
        self.walls = [0; WALL_BYTES];
        self.bonus = [0; WALL_BYTES];
        self.bonus_type = [0; CELLS];
        self.status = ST_LOBBY;
        self.player_count = 0;
        self.winner = -1;
        self.mode = 0;
        self.humans = 0;
    }

    fn bit_get(arr: &[u8], i: usize) -> bool {
        (arr[i >> 3] >> (i & 7)) & 1 == 1
    }
    fn bit_set(arr: &mut [u8], i: usize, v: bool) {
        if v {
            arr[i >> 3] |= 1 << (i & 7);
        } else {
            arr[i >> 3] &= !(1 << (i & 7));
        }
    }

    fn wall_at(&self, x: usize, y: usize) -> bool {
        Self::bit_get(&self.walls, idx(x, y))
    }
    fn bonus_at(&self, x: usize, y: usize) -> bool {
        Self::bit_get(&self.bonus, idx(x, y))
    }

    fn bomb_at(&self, x: usize, y: usize) -> bool {
        self.bombs
            .iter()
            .any(|b| b.active == 1 && b.x as usize == x && b.y as usize == y)
    }

    fn safe_spawn_zone(&self, x: usize, y: usize) -> bool {
        // Keep spawn corners + adjacent cells clear of walls
        for c in 0..4 {
            let (sx, sy) = spawn(c);
            let dx = (sx as i32 - x as i32).abs();
            let dy = (sy as i32 - y as i32).abs();
            if dx + dy <= 1 {
                return true;
            }
        }
        false
    }

    fn fill_walls(&mut self, seed: u64) {
        let mut rng = seed ^ 0x9E3779B97F4A7C15;
        for y in 0..H {
            for x in 0..W {
                if is_solid(x, y) || self.safe_spawn_zone(x, y) {
                    continue;
                }
                rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let r = (rng >> 33) & 0xFF;
                if r > 76 {
                    // ~70% chance wall
                    Self::bit_set(&mut self.walls, idx(x, y), true);
                    // ~40% of walls hide a bonus
                    rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
                    let rb = (rng >> 40) & 0xFF;
                    if rb < 102 {
                        Self::bit_set(&mut self.bonus, idx(x, y), true);
                        // bonus type 0..3 (bomb, power, speed, kick)
                        self.bonus_type[idx(x, y)] = ((rng >> 8) & 3) as u8;
                    }
                }
            }
        }
    }

    fn pickup_bonus(&mut self, c: usize) {
        let (x, y) = (self.players[c].x as usize, self.players[c].y as usize);
        // bonus is only pickable if the wall over it is destroyed (i.e. no wall)
        if self.bonus_at(x, y) && !self.wall_at(x, y) {
            let t = self.bonus_type[idx(x, y)];
            match t {
                0 => self.players[c].bomb_max = (self.players[c].bomb_max + 1).min(6),
                1 => self.players[c].radius = (self.players[c].radius + 1).min(8),
                2 => { /* speed: reduce cooldown effect - keep simple */ }
                _ => { /* kick placeholder */ }
            }
            Self::bit_set(&mut self.bonus, idx(x, y), false);
        }
    }

    fn add_blast(&mut self, x: usize, y: usize) {
        for bl in self.blasts.iter_mut() {
            if bl.life == 0 {
                bl.x = x as u8;
                bl.y = y as u8;
                bl.life = BLAST_LIFE;
                return;
            }
        }
    }

    fn explode(&mut self, bi: usize) {
        let (bx, by, radius, owner) = {
            let b = &self.bombs[bi];
            (b.x as i32, b.y as i32, b.radius as i32, b.owner as usize)
        };
        self.bombs[bi].active = 0;
        let mode = self.mode;
        let humans = self.humans;
        if self.players[owner].bomb_used > 0 {
            self.players[owner].bomb_used -= 1;
        }

        // collect blast cells
        let mut cells: Vec<(usize, usize)> = vec![(bx as usize, by as usize)];
        let dirs = [(0i32, -1i32), (0, 1), (-1, 0), (1, 0)];
        for (dx, dy) in dirs {
            for r in 1..=radius {
                let nx = bx + dx * r;
                let ny = by + dy * r;
                if nx < 0 || ny < 0 || nx >= W as i32 || ny >= H as i32 {
                    break;
                }
                let (ux, uy) = (nx as usize, ny as usize);
                if is_solid(ux, uy) {
                    break;
                }
                cells.push((ux, uy));
                if self.wall_at(ux, uy) {
                    // destroy wall and stop
                    Self::bit_set(&mut self.walls, idx(ux, uy), false);
                    break;
                }
            }
        }

        // apply blasts: flames, kills, chain bombs
        for (x, y) in cells {
            self.add_blast(x, y);
            // kill players standing here (co-op: no friendly fire between allies,
            // but you can still die to your OWN bomb)
            for pi in 0..self.players.len() {
                let p = &mut self.players[pi];
                if p.active == 1 && p.alive == 1 && p.x as usize == x && p.y as usize == y {
                    if mode == 1
                        && pi != owner
                        && ((humans >> pi) & 1) == ((humans >> owner) & 1)
                    {
                        continue; // ally spared
                    }
                    p.alive = 0;
                }
            }
            // chain-detonate bombs
            for j in 0..self.bombs.len() {
                if self.bombs[j].active == 1
                    && self.bombs[j].x as usize == x
                    && self.bombs[j].y as usize == y
                    && self.bombs[j].timer > 1
                {
                    self.bombs[j].timer = 1;
                }
            }
        }
    }

    fn alive_count(&self) -> u8 {
        self.players
            .iter()
            .filter(|p| p.active == 1 && p.alive == 1)
            .count() as u8
    }

    fn last_alive(&self) -> i8 {
        for (i, p) in self.players.iter().enumerate() {
            if p.active == 1 && p.alive == 1 {
                return i as i8;
            }
        }
        -1
    }

    fn first_human(&self) -> i8 {
        for pi in 0..4 {
            let p = &self.players[pi];
            if p.active == 1 && p.alive == 1 && (self.humans >> pi) & 1 == 1 {
                return pi as i8;
            }
        }
        -1
    }

    fn check_victory(&mut self) {
        if self.status != ST_LIVE || self.player_count < 2 {
            return;
        }
        if self.mode == 1 {
            // co-op: humans (team H) vs bots (team B)
            let (mut humans_alive, mut humans_total) = (0u8, 0u8);
            let (mut bots_alive, mut bots_total) = (0u8, 0u8);
            for pi in 0..4 {
                let p = &self.players[pi];
                if p.active == 0 {
                    continue;
                }
                if (self.humans >> pi) & 1 == 1 {
                    humans_total += 1;
                    if p.alive == 1 {
                        humans_alive += 1;
                    }
                } else {
                    bots_total += 1;
                    if p.alive == 1 {
                        bots_alive += 1;
                    }
                }
            }
            if bots_total > 0 && bots_alive == 0 {
                self.status = ST_ENDED;
                self.winner = self.first_human();
            } else if humans_total > 0 && humans_alive == 0 {
                self.status = ST_ENDED;
                self.winner = self.last_alive();
            }
            return;
        }
        if self.alive_count() <= 1 {
            self.status = ST_ENDED;
            self.winner = self.last_alive();
        }
    }
}

// -------------------------------------------------------------------------
// Contexts
// -------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateGame<'info> {
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + core::mem::size_of::<Game>(),
        seeds = [GAME_SEED, match_id.to_le_bytes().as_ref()],
        bump
    )]
    pub game: AccountLoader<'info, Game>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct MutateGame<'info> {
    #[account(mut, seeds = [GAME_SEED, match_id.to_le_bytes().as_ref()], bump)]
    pub game: AccountLoader<'info, Game>,
    pub signer: Signer<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK the game pda to delegate
    #[account(mut, del)]
    pub pda: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CommitGame<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED, match_id.to_le_bytes().as_ref()], bump)]
    pub game: AccountLoader<'info, Game>,
}

// -------------------------------------------------------------------------
// Unit tests (pure game-logic — no Solana runtime needed)
// -------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn blank_game() -> Game {
        // Safe: Game is Pod/zero-copy (all-zero is a valid instance).
        let mut g: Game = unsafe { core::mem::zeroed() };
        g.reset();
        g
    }

    fn add_player(g: &mut Game, c: usize) {
        let (x, y) = spawn(c);
        g.players[c].active = 1;
        g.players[c].alive = 1;
        g.players[c].x = x as u8;
        g.players[c].y = y as u8;
        g.players[c].bomb_max = 1;
        g.players[c].radius = 2;
        g.player_count += 1;
    }

    #[test]
    fn solid_pattern_is_correct() {
        assert!(is_solid(0, 0)); // border
        assert!(is_solid(14, 12)); // corner
        assert!(is_solid(2, 2)); // interior pillar (even,even)
        assert!(!is_solid(1, 1)); // spawn is walkable
        assert!(!is_solid(1, 2)); // odd,even walkable
    }

    #[test]
    fn reset_clears_everything() {
        let mut g = blank_game();
        g.tick = 42;
        g.status = ST_LIVE;
        g.reset();
        assert_eq!(g.tick, 0);
        assert_eq!(g.status, ST_LOBBY);
        assert_eq!(g.player_count, 0);
        assert_eq!(g.winner, -1);
    }

    #[test]
    fn fill_walls_keeps_spawn_zones_clear_and_solids_empty() {
        let mut g = blank_game();
        g.fill_walls(123456789);
        for c in 0..4 {
            let (sx, sy) = spawn(c);
            assert!(!g.wall_at(sx, sy), "spawn cell must be clear");
        }
        // no wall on solid cells
        for y in 0..H {
            for x in 0..W {
                if is_solid(x, y) {
                    assert!(!g.wall_at(x, y), "solid cell must never hold a wall");
                }
            }
        }
    }

    #[test]
    fn fill_walls_is_deterministic() {
        let mut a = blank_game();
        let mut b = blank_game();
        a.fill_walls(777);
        b.fill_walls(777);
        assert_eq!(a.walls, b.walls);
        assert_eq!(a.bonus, b.bonus);
    }

    #[test]
    fn explosion_destroys_wall_and_kills_player() {
        let mut g = blank_game();
        add_player(&mut g, 0); // P0 at (1,1)
        add_player(&mut g, 1); // P1 at (13,1)
        g.status = ST_LIVE;

        // put a breakable wall at (3,1) and move P1 onto (2,1)
        Game::bit_set(&mut g.walls, idx(3, 1), true);
        g.players[1].x = 2;
        g.players[1].y = 1;

        // bomb at (1,1) radius 3 from P0
        g.bombs[0].active = 1;
        g.bombs[0].x = 1;
        g.bombs[0].y = 1;
        g.bombs[0].owner = 0;
        g.bombs[0].radius = 3;
        g.players[0].bomb_used = 1;

        g.explode(0);

        assert_eq!(g.bombs[0].active, 0, "bomb consumed");
        assert!(!g.wall_at(3, 1), "wall in blast path destroyed");
        assert_eq!(g.players[1].alive, 0, "player in blast killed");
        assert!(g.blasts.iter().any(|b| b.life > 0), "flames spawned");
    }

    #[test]
    fn explosion_stops_at_solid_block() {
        let mut g = blank_game();
        add_player(&mut g, 0);
        add_player(&mut g, 1);
        g.status = ST_LIVE;
        // P1 behind the solid pillar at (2,2): put P1 at (3,1)? pillar (2,2) blocks vertical.
        // Place a player at (2,1) reachable, and one shielded won't be tested here.
        g.players[1].x = 4; // far, out of radius 2 from (1,1)
        g.players[1].y = 1;

        g.bombs[0].active = 1;
        g.bombs[0].x = 1;
        g.bombs[0].y = 1;
        g.bombs[0].owner = 0;
        g.bombs[0].radius = 2;
        g.explode(0);
        assert_eq!(g.players[1].alive, 1, "player out of range survives");
    }

    #[test]
    fn victory_when_one_left() {
        let mut g = blank_game();
        add_player(&mut g, 0);
        add_player(&mut g, 1);
        g.status = ST_LIVE;
        g.players[1].alive = 0; // P1 dead
        g.check_victory();
        assert_eq!(g.status, ST_ENDED);
        assert_eq!(g.winner, 0);
    }

    #[test]
    fn pickup_bonus_increases_stat() {
        let mut g = blank_game();
        add_player(&mut g, 0);
        let (x, y) = (g.players[0].x as usize, g.players[0].y as usize);
        Game::bit_set(&mut g.bonus, idx(x, y), true);
        g.bonus_type[idx(x, y)] = 0; // extra bomb
        let before = g.players[0].bomb_max;
        g.pickup_bonus(0);
        assert_eq!(g.players[0].bomb_max, before + 1);
        assert!(!g.bonus_at(x, y), "bonus consumed");
    }
}

#[error_code]
pub enum ChainErr {
    #[msg("Game is live")]
    GameLive,
    #[msg("Game not in lobby")]
    NotLobby,
    #[msg("Game not live")]
    NotLive,
    #[msg("Bad color")]
    BadColor,
    #[msg("Slot already taken")]
    SlotTaken,
    #[msg("No players")]
    NoPlayers,
    #[msg("Player dead or empty")]
    DeadOrEmpty,
    #[msg("Signer is not the player authority")]
    NotAuthority,
}
