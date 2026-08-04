// Browser polyfills required by @solana/web3.js and @coral-xyz/anchor.
import { Buffer } from 'buffer';

const w = window as unknown as { Buffer?: unknown; global?: unknown; process?: unknown };
if (!w.Buffer) w.Buffer = Buffer;
if (!w.global) w.global = window;
if (!w.process) w.process = { env: {} };
