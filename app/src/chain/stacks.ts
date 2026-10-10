// Client for the Stacks on-chain program. Instruction layouts mirror
// programs/stacks/src/lib.rs exactly (Anchor: 8-byte discriminator + Borsh).

import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Buffer } from "buffer";
import { env } from "./config";

export const NUM_STACKS = 10;
export const STEP_SECONDS = 15;
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_FEES_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DBC_POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export enum Venue { Pump = 0, Meteora = 1 }
export enum Mode { Degen = 0, Builder = 1 }
export enum Status { Setup = 0, Open = 1, SoldOut = 2 }

export const MODES = {
  [Mode.Degen]: { start: 1_500_000_000n, floor: 500_000_000n, drop: 125_000_000n },
  [Mode.Builder]: { start: 4_000_000_000n, floor: 1_000_000_000n, drop: 200_000_000n },
} as const;

const DISC = {
  create_launch: [239, 223, 255, 134, 39, 121, 127, 62],
  open_auction_pump: [63, 19, 150, 0, 83, 96, 254, 16],
  open_auction_meteora: [159, 210, 145, 17, 59, 117, 155, 197],
  take_stack: [220, 104, 130, 136, 126, 223, 69, 219],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
  transfer_stack: [83, 245, 153, 115, 49, 101, 169, 13],
  harvest_meteora: [231, 252, 154, 222, 8, 234, 55, 186],
} as const;
export const LAUNCH_DISC = [144, 51, 51, 163, 206, 85, 213, 38];
export const LAUNCH_SIZE = 568;

export const programId = () => new PublicKey(env.programId);

// ---- PDAs -----------------------------------------------------------------

export const configPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], programId())[0];
export const launchPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("launch"), mint.toBuffer()], programId())[0];
export const vaultPda = (mint: PublicKey, i: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer(), Buffer.from([i])], programId())[0];
export const vaultPdas = (mint: PublicKey) => Array.from({ length: NUM_STACKS }, (_, i) => vaultPda(mint, i));
export const feeAuthPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("fee_auth"), mint.toBuffer()], programId())[0];
export const pumpBondingCurvePda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
export const pumpSharingConfigPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("sharing-config"), mint.toBuffer()], PUMP_FEES_PROGRAM_ID)[0];
export const dbcEventAuthority = () =>
  PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DBC_PROGRAM_ID)[0];

// ---- Price ----------------------------------------------------------------

export function priceAt(l: Pick<LaunchState, "startPrice" | "floorPrice" | "dropPerStep" | "clockStart">, nowSec: number): bigint {
  const elapsed = Math.max(0, nowSec - l.clockStart);
  const steps = BigInt(Math.floor(elapsed / STEP_SECONDS));
  const p = l.startPrice - l.dropPerStep * steps;
  return p < l.floorPrice ? l.floorPrice : p;
}

// ---- Instructions ---------------------------------------------------------

const w = (k: PublicKey, signer = false) => ({ pubkey: k, isSigner: signer, isWritable: true });
const r = (k: PublicKey, signer = false) => ({ pubkey: k, isSigner: signer, isWritable: false });
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };

export function ixCreateLaunch(p: {
  creator: PublicKey; mint: PublicKey; venueAccount: PublicKey; treasury: PublicKey;
  venue: Venue; mode: Mode; prebuy: number;
}) {
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      w(p.creator, true),
      r(configPda()),
      w(p.treasury),
      r(p.mint),
      r(p.venueAccount),
      w(launchPda(p.mint)),
      r(SystemProgram.programId),
      ...vaultPdas(p.mint).map((v) => w(v)),
    ],
    data: Buffer.from([...DISC.create_launch, p.venue, p.mode, p.prebuy]),
  });
}

export function ixOpenAuctionPump(mint: PublicKey) {
  return new TransactionInstruction({
    programId: programId(),
    keys: [w(launchPda(mint)), r(pumpSharingConfigPda(mint))],
    data: Buffer.from(DISC.open_auction_pump),
  });
}

export function ixOpenAuctionMeteora(mint: PublicKey, pool: PublicKey) {
  return new TransactionInstruction({
    programId: programId(),
    keys: [w(launchPda(mint)), r(pool)],
    data: Buffer.from(DISC.open_auction_meteora),
  });
}

export function ixTakeStack(p: { buyer: PublicKey; mint: PublicKey; creator: PublicKey; treasury: PublicKey; index: number; maxPrice: bigint }) {
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      w(p.buyer, true),
      r(configPda()),
      w(launchPda(p.mint)),
      w(p.creator),
      w(p.treasury),
      r(SystemProgram.programId),
    ],
    data: Buffer.concat([Buffer.from(DISC.take_stack), Buffer.from([p.index]), u64(p.maxPrice)]),
  });
}

export function ixClaim(owner: PublicKey, mint: PublicKey, index: number) {
  return new TransactionInstruction({
    programId: programId(),
    keys: [w(owner, true), r(launchPda(mint)), w(vaultPda(mint, index)), r(SystemProgram.programId)],
    data: Buffer.from([...DISC.claim, index]),
  });
}

export function ixTransferStack(owner: PublicKey, mint: PublicKey, index: number, newOwner: PublicKey) {
  return new TransactionInstruction({
    programId: programId(),
    keys: [r(owner, true), w(launchPda(mint))],
    data: Buffer.concat([Buffer.from([...DISC.transfer_stack, index]), newOwner.toBuffer()]),
  });
}

export function ixHarvestMeteora(p: {
  payer: PublicKey; mint: PublicKey; pool: PublicKey; feeAuthQuote: PublicKey; feeAuthBase: PublicKey;
  baseVault: PublicKey; quoteVault: PublicKey;
}) {
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      w(p.payer, true),
      w(launchPda(p.mint)),
      w(feeAuthPda(p.mint)),
      w(p.feeAuthQuote),
      w(p.feeAuthBase),
      w(p.pool),
      r(DBC_POOL_AUTHORITY),
      w(p.baseVault),
      w(p.quoteVault),
      r(p.mint),
      r(WSOL_MINT),
      r(TOKEN_PROGRAM_ID),
      r(dbcEventAuthority()),
      r(DBC_PROGRAM_ID),
      r(SystemProgram.programId),
      ...vaultPdas(p.mint).map((v) => w(v)),
    ],
    data: Buffer.from(DISC.harvest_meteora),
  });
}

// ---- Account decoding -------------------------------------------------------

export interface LaunchState {
  address: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  venue: Venue;
  venueAccount: PublicKey;
  mode: Mode;
  status: Status;
  startPrice: bigint;
  floorPrice: bigint;
  dropPerStep: bigint;
  createdAt: number;
  clockStart: number;
  owners: (PublicKey | null)[];
  paid: bigint[];
  sold: number;
  totalHarvested: bigint;
}

export function decodeLaunch(address: PublicKey, data: Buffer): LaunchState {
  if (!LAUNCH_DISC.every((b, i) => data[i] === b)) throw new Error("Not a Launch account");
  let o = 8;
  const pk = () => { const k = new PublicKey(data.subarray(o, o + 32)); o += 32; return k; };
  const u8 = () => data[o++];
  const u64r = () => { const v = data.readBigUInt64LE(o); o += 8; return v; };
  const i64r = () => { const v = data.readBigInt64LE(o); o += 8; return Number(v); };
  const mint = pk(), creator = pk();
  const venue = u8() as Venue;
  const venueAccount = pk();
  const mode = u8() as Mode, status = u8() as Status;
  const startPrice = u64r(), floorPrice = u64r(), dropPerStep = u64r();
  const createdAt = i64r(), clockStart = i64r();
  const owners: (PublicKey | null)[] = [];
  for (let i = 0; i < NUM_STACKS; i++) { const k = pk(); owners.push(k.equals(PublicKey.default) ? null : k); }
  const paid: bigint[] = [];
  for (let i = 0; i < NUM_STACKS; i++) paid.push(u64r());
  const sold = u8();
  o += 1 + NUM_STACKS + 1; // bump, vault_bumps, fee_auth_bump
  const totalHarvested = u64r();
  return { address, mint, creator, venue, venueAccount, mode, status, startPrice, floorPrice, dropPerStep, createdAt, clockStart, owners, paid, sold, totalHarvested };
}

export async function fetchLaunch(conn: Connection, mint: PublicKey): Promise<LaunchState | null> {
  const addr = launchPda(mint);
  const info = await conn.getAccountInfo(addr);
  return info ? decodeLaunch(addr, info.data as Buffer) : null;
}

export async function fetchAllLaunches(conn: Connection): Promise<LaunchState[]> {
  const accounts = await conn.getProgramAccounts(programId(), {
    filters: [{ dataSize: LAUNCH_SIZE }],
  });
  return accounts
    .map((a) => { try { return decodeLaunch(a.pubkey, a.account.data as Buffer); } catch { return null; } })
    .filter((x): x is LaunchState => !!x)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Claimable SOL per Stack (vault balance above the rent-exempt minimum). */
export async function fetchClaimable(conn: Connection, mint: PublicKey): Promise<bigint[]> {
  const rentMin = BigInt(await conn.getMinimumBalanceForRentExemption(0));
  const infos = await conn.getMultipleAccountsInfo(vaultPdas(mint));
  return infos.map((i) => {
    const l = BigInt(i?.lamports ?? 0);
    return l > rentMin ? l - rentMin : 0n;
  });
}
