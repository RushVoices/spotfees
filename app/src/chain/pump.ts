// Pump launch + fee collection.
//
// Launch = three transactions, signed in one wallet prompt:
//   1. create the coin on Pump (+ optional dev buy)
//   2. register the Stacks launch (proves you are the creator) and opt the
//      coin into Pump fee sharing
//   3. set Pump's shareholders to the ten Stack vaults at 10% each (Pump
//      locks this list permanently) and open the auction
// Steps 2 and 3 are separate only because together they exceed Solana's
// transaction size limit. If the flow is interrupted after step 1,
// `finishPumpSetup` picks up where it stopped.
//
// Pump SDK calls follow Pump's public docs:
// https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md

import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  PUMP_SDK, OnlinePumpSdk, feeSharingConfigPda, getBuyTokenAmountFromSolAmount, type FeeConfig, type Global,
} from "@pump-fun/pump-sdk";
import {
  Mode, Venue, ixCreateLaunch, ixOpenAuctionPump, pumpBondingCurvePda, pumpSharingConfigPda,
  vaultPdas, fetchLaunch, Status, PUMP_FEES_PROGRAM_ID,
} from "./stacks";
import { env } from "./config";
import { signAndSendSequential } from "./wallet";

const toIxs = (x: TransactionInstruction | TransactionInstruction[]) => (Array.isArray(x) ? x : [x]);
const txOf = (ixs: TransactionInstruction[]) => new Transaction().add(...ixs);
const cu = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });

export interface LaunchParams {
  name: string;
  symbol: string;
  uri: string;
  mode: Mode;
  prebuy: number;
  devBuyLamports: bigint;
}

/**
 * Tokens a SOL dev buy gets on a brand-new curve, quoted the way Pump prices
 * it (fees included), less a 2% cushion so the buy never asks for more than
 * the SOL cap allows.
 */
function estimateTokensOut(global: Global, feeConfig: FeeConfig | null, lamportsIn: bigint): BN {
  const out = getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply: null, bondingCurve: null,
    amount: new BN(lamportsIn.toString()), quoteMint: NATIVE_MINT,
  });
  return out.muln(98).divn(100);
}

/** Pays any creator fees left on the curve to `creator`'s vault. Pump refuses
 * fee-sharing changes while that bucket is non-empty; harmless when empty. */
const sweep = (payer: PublicKey, mint: PublicKey, creator: PublicKey) =>
  PUMP_SDK.sweepCreatorFeeInstruction({ payer, mint, creator, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID });

async function setupTxs(creator: PublicKey, mint: PublicKey, p: { mode: Mode; prebuy: number }) {
  const treasury = new PublicKey(env.treasury);
  // No compute-budget instruction in tx 2 or tx 3: both sit within ~30 bytes
  // of the size limit, and the default (200k CU per instruction) is enough.
  const tx2 = txOf([
    // A sniper's trade between tx 1 and tx 2 can leave fees on the curve.
    await sweep(creator, mint, creator),
    ixCreateLaunch({
      creator, mint, treasury,
      venueAccount: pumpBondingCurvePda(mint),
      venue: Venue.Pump, mode: p.mode, prebuy: p.prebuy,
    }),
    ...toIxs(await PUMP_SDK.createFeeSharingConfig({ creator, mint, pool: null })),
  ]);
  const tx3 = await sharesAndOpenTx(creator, mint, [creator]);
  return [tx2, tx3];
}

async function sharesAndOpenTx(creator: PublicKey, mint: PublicKey, currentShareholders: PublicKey[]) {
  return txOf([
    // From tx 2 on, the coin's creator is its sharing config.
    await sweep(creator, mint, feeSharingConfigPda(mint)),
    ...toIxs(
      await PUMP_SDK.updateFeeSharesV2({
        authority: creator,
        mint,
        currentShareholders,
        newShareholders: vaultPdas(mint).map((address) => ({ address, shareBps: 1000 })),
        quoteMint: NATIVE_MINT,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        bondingCurveComplete: false, // a fresh coin; saves 33 bytes
      }),
    ),
    ixOpenAuctionPump(mint),
  ]);
}

/** The create (+ dev buy) transaction(s) for a new coin. Tx 0 needs the mint keypair's signature. */
async function createTxs(conn: Connection, creator: PublicKey, mint: Keypair, p: Pick<LaunchParams, "name" | "symbol" | "uri" | "devBuyLamports">) {
  const online = new OnlinePumpSdk(conn);
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig().catch(() => null)]);

  const meta = { mint: mint.publicKey, name: p.name, symbol: p.symbol, uri: p.uri, creator, user: creator, mayhemMode: false };
  // [create_v2, user token account, buy]: the SOL-quoted legacy buy keeps
  // create + buy inside one transaction, so nobody can buy before the dev.
  const ixs =
    p.devBuyLamports > 0n
      ? await PUMP_SDK.createV2AndBuyInstructions({
          ...meta,
          global,
          solAmount: new BN(p.devBuyLamports.toString()), // max SOL spent
          amount: estimateTokensOut(global, feeConfig, p.devBuyLamports),
        })
      : [await PUMP_SDK.createV2Instruction(meta)];

  // Two signers (wallet + mint). Prefer one transaction with a compute
  // budget, then one without; a very long name/URI falls back to create,
  // then buy, in back-to-back transactions.
  if (fitsLegacyTx([cu(350_000), ...ixs], creator, 2)) return [txOf([cu(350_000), ...ixs])];
  if (fitsLegacyTx(ixs, creator, 2)) return [txOf(ixs)];
  return [txOf(ixs.slice(0, 1)), txOf([cu(250_000), ...ixs.slice(1)])];
}

export async function launchOnPump(
  conn: Connection,
  creator: PublicKey,
  p: LaunchParams,
  onStep?: (i: number) => void,
): Promise<{ mint: PublicKey; signatures: string[] }> {
  const mint = Keypair.generate();
  const create = await createTxs(conn, creator, mint, p);
  const [tx2, tx3] = await setupTxs(creator, mint.publicKey, p);
  const extra = create.length - 1; // report progress as the usual 3 steps
  let created = false;
  try {
    const signatures = await signAndSendSequential(conn, [...create, tx2, tx3], [[mint]], (i) => {
      created = true;
      if (i >= extra) onStep?.(i - extra);
    });
    return { mint: mint.publicKey, signatures };
  } catch (err) {
    // The coin exists but its Spots aren't set up: tell the caller which coin,
    // so it can offer finishPumpSetup.
    if (created) throw Object.assign(err instanceof Error ? err : new Error(String(err)), { unfinishedMint: mint.publicKey.toBase58() });
    throw err;
  }
}

/**
 * A plain pump.fun launch (create + optional dev buy), for when the Spot
 * program isn't live yet. The creator keeps the creator fees; the coin can
 * be switched to Spots later with `finishPumpSetup`, from the same wallet.
 */
export async function launchPumpDirect(
  conn: Connection,
  creator: PublicKey,
  p: Pick<LaunchParams, "name" | "symbol" | "uri" | "devBuyLamports">,
  onStep?: (i: number) => void,
): Promise<{ mint: PublicKey; signatures: string[] }> {
  const mint = Keypair.generate();
  const create = await createTxs(conn, creator, mint, p);
  const signatures = await signAndSendSequential(conn, create, [[mint]], (i) => {
    if (i === create.length - 1) onStep?.(0);
  });
  return { mint: mint.publicKey, signatures };
}

/** Parses Pump's sharing_config (see programs/stacks/src/lib.rs for the layout). */
function readSharingConfig(data: Buffer) {
  const adminRevoked = data[75] !== 0;
  const len = data.readUInt32LE(76);
  const holders: PublicKey[] = [];
  for (let k = 0; k < len; k++) holders.push(new PublicKey(data.subarray(80 + k * 34, 112 + k * 34)));
  return { adminRevoked, holders };
}

/** Completes a Pump launch whose coin exists but whose Stacks setup did not finish. */
export async function finishPumpSetup(conn: Connection, creator: PublicKey, mint: PublicKey, p: { mode: Mode; prebuy: number }) {
  const launch = await fetchLaunch(conn, mint);
  const sc = await conn.getAccountInfo(pumpSharingConfigPda(mint));
  let txs: Transaction[];
  if (!launch) {
    if (sc && sc.owner.equals(PUMP_FEES_PROGRAM_ID)) {
      throw new Error("This coin already has Pump fee sharing set up outside Slice, so it can't be registered.");
    }
    txs = await setupTxs(creator, mint, p);
  } else if (launch.status !== Status.Setup) {
    return [];
  } else {
    const cfg = sc ? readSharingConfig(sc.data as Buffer) : null;
    if (!cfg) throw new Error("Fee sharing was never created for this coin.");
    txs = cfg.adminRevoked
      ? [txOf([ixOpenAuctionPump(mint)])]
      : [await sharesAndOpenTx(creator, mint, cfg.holders)];
  }
  return signAndSendSequential(conn, txs);
}

/**
 * Pays every Stack vault its share of the creator fees collected so far.
 * Permissionless: anyone can run it, typically the person about to claim.
 */
export async function collectPumpFees(conn: Connection, payer: PublicKey, mint: PublicKey) {
  const info = await conn.getAccountInfo(feeSharingConfigPda(mint));
  if (!info) throw new Error("Fee sharing is not set up for this coin.");
  // Sweeps fees left on the curve / pool, consolidates AMM fees once the coin
  // has graduated, then distributes to the ten vaults.
  const { instructions, sweepCount } = await new OnlinePumpSdk(conn).buildDistributeCreatorFeesInstructions(mint, {
    quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID, payer,
  });
  const all = [cu(400_000), ...instructions];
  if (fitsLegacyTx(all, payer)) return signAndSendSequential(conn, [txOf(all)]);
  // Too big for one legacy transaction: sweep first, then distribute.
  return signAndSendSequential(conn, [
    txOf([cu(200_000), ...instructions.slice(0, sweepCount)]),
    txOf([cu(400_000), ...instructions.slice(sweepCount)]),
  ].filter((t) => t.instructions.length > 1));
}

/** True when the instructions serialize into one legacy transaction (1232 bytes). */
export function fitsLegacyTx(ixs: TransactionInstruction[], payer: PublicKey, signers = 1): boolean {
  try {
    const tx = txOf(ixs);
    tx.feePayer = payer;
    tx.recentBlockhash = PublicKey.default.toBase58();
    return tx.serializeMessage().length + 1 + 64 * signers <= 1232;
  } catch {
    return false;
  }
}
