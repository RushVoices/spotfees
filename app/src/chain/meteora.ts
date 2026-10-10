// Meteora (Dynamic Bonding Curve) launch + fee harvesting.
//
// Launch = two transactions, signed in one wallet prompt:
//   1. create the pool on the Stacks DBC config (+ optional first buy)
//   2. register the Stacks launch (proves you are the pool creator), hand
//      the pool's creator role to the launch's program-owned fee authority,
//      and open the auction
// After step 2 only the Stacks program can claim the pool's creator fees,
// and it can only send them to the ten Stack vaults.

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import { Buffer } from "buffer";
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  DBC_PROGRAM_ID, Mode, Venue, dbcEventAuthority, feeAuthPda, ixCreateLaunch, ixHarvestMeteora, ixOpenAuctionMeteora,
} from "./stacks";
import { env } from "./config";
import { signAndSendSequential } from "./wallet";
import type { LaunchParams } from "./pump";

/** DBC `transfer_pool_creator`, built by hand because the SDK helper reads
 * the pool from chain, and the pool is created in the same flow. Account
 * order from the DBC IDL. */
function ixTransferPoolCreator(pool: PublicKey, config: PublicKey, creator: PublicKey, newCreator: PublicKey) {
  return new TransactionInstruction({
    programId: DBC_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: creator, isSigner: true, isWritable: false },
      { pubkey: newCreator, isSigner: false, isWritable: false },
      { pubkey: dbcEventAuthority(), isSigner: false, isWritable: false },
      { pubkey: DBC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([20, 7, 169, 33, 58, 147, 166, 33]),
  });
}

export async function launchOnMeteora(
  conn: Connection,
  creator: PublicKey,
  p: LaunchParams,
  onStep?: (i: number) => void,
): Promise<{ mint: PublicKey; pool: PublicKey; signatures: string[] }> {
  if (!env.meteoraConfig) throw new Error("Meteora is not configured on this site yet.");
  const config = new PublicKey(env.meteoraConfig);
  const treasury = new PublicKey(env.treasury);
  const client = DynamicBondingCurveClient.create(conn, "confirmed");
  const baseMint = Keypair.generate();
  const pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, config);

  const createPoolParam = {
    name: p.name,
    symbol: p.symbol,
    uri: p.uri,
    payer: creator,
    poolCreator: creator,
    config,
    baseMint: baseMint.publicKey,
  };
  const tx1 =
    p.devBuyLamports > 0n
      ? await client.creator.createPoolWithFirstBuy({
          createPoolParam,
          firstBuyParam: {
            buyer: creator,
            buyAmount: new BN(p.devBuyLamports.toString()),
            // Pool is created in this same transaction, so nobody can trade first.
            minimumAmountOut: new BN(0),
            referralTokenAccount: null,
          },
        })
      : await client.creator.createPool(createPoolParam);

  const tx2 = new Transaction().add(
    ixCreateLaunch({
      creator, mint: baseMint.publicKey, treasury, venueAccount: pool,
      venue: Venue.Meteora, mode: p.mode, prebuy: p.prebuy,
    }),
    ixTransferPoolCreator(pool, config, creator, feeAuthPda(baseMint.publicKey)),
    ixOpenAuctionMeteora(baseMint.publicKey, pool),
  );

  const signatures = await signAndSendSequential(conn, [tx1, tx2], [[baseMint]], onStep);
  return { mint: baseMint.publicKey, pool, signatures };
}

/** Claims the pool's creator fees and splits them into the ten Stack vaults. Permissionless. */
export async function harvestMeteoraFees(conn: Connection, payer: PublicKey, mint: PublicKey, pool: PublicKey) {
  const info = await conn.getAccountInfo(pool);
  if (!info) throw new Error("Pool not found.");
  const data = info.data as Buffer;
  // VirtualPool: 8 disc + 64 tracker + config(32) + creator(32) + base_mint(32) + base_vault(32) + quote_vault(32)
  const baseVault = new PublicKey(data.subarray(168, 200));
  const quoteVault = new PublicKey(data.subarray(200, 232));

  const feeAuth = feeAuthPda(mint);
  const feeAuthQuote = getAssociatedTokenAddressSync(NATIVE_MINT, feeAuth, true);
  const feeAuthBase = getAssociatedTokenAddressSync(mint, feeAuth, true);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer, feeAuthQuote, feeAuth, NATIVE_MINT, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer, feeAuthBase, feeAuth, mint, TOKEN_PROGRAM_ID),
    ixHarvestMeteora({ payer, mint, pool, feeAuthQuote, feeAuthBase, baseVault, quoteVault }),
  );
  return signAndSendSequential(conn, [tx]);
}
