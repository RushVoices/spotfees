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

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { PUMP_SDK, OnlinePumpSdk, feeSharingConfigPda } from "@pump-fun/pump-sdk";
import {
  Mode, Venue, ixCreateLaunch, ixOpenAuctionPump, pumpBondingCurvePda, pumpSharingConfigPda,
  vaultPdas, fetchLaunch, Status, PUMP_FEES_PROGRAM_ID,
} from "./stacks";
import { env } from "./config";
import { signAndSendSequential } from "./wallet";

const toIxs = (x: TransactionInstruction | TransactionInstruction[]) => (Array.isArray(x) ? x : [x]);
const txOf = (ixs: TransactionInstruction[]) => new Transaction().add(...ixs);

export interface LaunchParams {
  name: string;
  symbol: string;
  uri: string;
  mode: Mode;
  prebuy: number;
  devBuyLamports: bigint;
}

/** Rough token amount for a SOL dev buy on a fresh curve, with a 3% cushion for fees. */
function estimateTokensOut(global: unknown, lamportsIn: bigint): BN {
  const g = global as { initialVirtualTokenReserves?: BN; initialVirtualSolReserves?: BN };
  const vT = BigInt((g.initialVirtualTokenReserves ?? new BN("1073000000000000")).toString());
  const vS = BigInt((g.initialVirtualSolReserves ?? new BN("30000000000")).toString());
  const solIn = (lamportsIn * 97n) / 100n;
  return new BN(((vT * solIn) / (vS + solIn)).toString());
}

async function setupTxs(creator: PublicKey, mint: PublicKey, p: { mode: Mode; prebuy: number }) {
  const treasury = new PublicKey(env.treasury);
  const tx2 = txOf([
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
    ...toIxs(
      await PUMP_SDK.updateFeeSharesV2({
        authority: creator,
        mint,
        currentShareholders,
        newShareholders: vaultPdas(mint).map((address) => ({ address, shareBps: 1000 })),
        quoteMint: NATIVE_MINT,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      }),
    ),
    ixOpenAuctionPump(mint),
  ]);
}

export async function launchOnPump(
  conn: Connection,
  creator: PublicKey,
  p: LaunchParams,
  onStep?: (i: number) => void,
): Promise<{ mint: PublicKey; signatures: string[] }> {
  const mint = Keypair.generate();
  const online = new OnlinePumpSdk(conn);
  const global = await online.fetchGlobal();

  const createIxs =
    p.devBuyLamports > 0n
      ? await PUMP_SDK.createV2AndBuyV2Instructions({
          global,
          mint: mint.publicKey,
          name: p.name,
          symbol: p.symbol,
          uri: p.uri,
          creator,
          user: creator,
          quoteAmount: new BN(p.devBuyLamports.toString()), // max SOL spent
          amount: estimateTokensOut(global, p.devBuyLamports),
          mayhemMode: false,
        })
      : toIxs(
          await PUMP_SDK.createV2Instruction({
            mint: mint.publicKey,
            name: p.name,
            symbol: p.symbol,
            uri: p.uri,
            creator,
            user: creator,
            mayhemMode: false,
          }),
        );

  const [tx2, tx3] = await setupTxs(creator, mint.publicKey, p);
  const signatures = await signAndSendSequential(conn, [txOf(createIxs), tx2, tx3], [[mint]], onStep);
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
  const bc = await conn.getAccountInfo(pumpBondingCurvePda(mint));
  const graduated = !!bc && bc.data[48] === 1; // BondingCurve.complete
  const sharingConfigAddress = feeSharingConfigPda(mint);
  const info = await conn.getAccountInfo(sharingConfigAddress);
  if (!info) throw new Error("Fee sharing is not set up for this coin.");
  const sharingConfig = PUMP_SDK.decodeSharingConfig(info);

  const ixs: TransactionInstruction[] = [];
  if (graduated) {
    ixs.push(
      ...toIxs(
        await PUMP_SDK.transferCreatorFeesToPumpV2({
          payer, mint, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID,
        }),
      ),
    );
  }
  ixs.push(
    ...toIxs(
      await PUMP_SDK.distributeCreatorFeesV2({
        mint, sharingConfig, sharingConfigAddress, quoteMint: NATIVE_MINT, payer,
        shouldInitializeAta: false, quoteTokenProgram: TOKEN_PROGRAM_ID,
      }),
    ),
  );
  return signAndSendSequential(conn, [txOf(ixs)]);
}
