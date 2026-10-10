// Creates the one Meteora DBC config every Stacks launch on Meteora uses.
// Run once per network, then put the printed address in:
//   - the Stacks on-chain config (init-config.ts --meteora-config)
//   - the site's VITE_METEORA_CONFIG
//
//   RPC_URL=... npx tsx create-meteora-config.ts
//
// Key choices:
//   creatorTradingFeePercentage: 100 -> all non-protocol trading fees go to
//     the pool creator, which Stacks turns into the ten Stack vaults.
//   tokenType SPL, quote = SOL: what the Stacks harvest instruction expects.
//   Liquidity after migration is permanently locked to the creator, so it
//     stays with the Stacks fee authority.
// The curve shape (market caps, fees) is a starting point. Tune it before
// mainnet.
import { Keypair, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  ActivationType, BaseFeeMode, CollectFeeMode, DammV2DynamicFeeMode, DynamicBondingCurveClient,
  MigratedCollectFeeMode, MigrationFeeOption, MigrationOption, TokenAuthorityOption, TokenDecimal, TokenType,
  buildCurveWithMarketCap,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, loadKeypair } from "./common";

const wallet = loadKeypair();
const configKeypair = Keypair.generate();

const curve = buildCurveWithMarketCap({
  token: {
    tokenType: TokenType.SPLToken,
    tokenBaseDecimal: TokenDecimal.SIX,
    tokenQuoteDecimal: TokenDecimal.NINE,
    tokenAuthorityOption: TokenAuthorityOption.Immutable,
    totalTokenSupply: 1_000_000_000,
    leftover: 0,
  },
  fee: {
    baseFeeParams: {
      baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 },
    },
    dynamicFeeEnabled: true,
    collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 100,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: true,
  },
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.Customizable,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: {
      collectFeeMode: MigratedCollectFeeMode.QuoteToken,
      dynamicFee: DammV2DynamicFeeMode.Enabled,
      poolFeeBps: 100,
    },
  },
  liquidityDistribution: {
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 0,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 100,
  },
  lockedVesting: {
    totalLockedVestingAmount: 0,
    numberOfVestingPeriod: 0,
    cliffUnlockAmount: 0,
    totalVestingDuration: 0,
    cliffDurationFromMigrationTime: 0,
  },
  activationType: ActivationType.Timestamp,
  initialMarketCap: 30, // in SOL
  migrationMarketCap: 400, // in SOL
});

const client = DynamicBondingCurveClient.create(connection, "confirmed");
const tx = await client.partner.createConfig({
  config: configKeypair.publicKey,
  feeClaimer: wallet.publicKey,
  leftoverReceiver: wallet.publicKey,
  payer: wallet.publicKey,
  quoteMint: NATIVE_MINT,
  ...curve,
});
const sig = await sendAndConfirmTransaction(connection, tx, [wallet, configKeypair]);
console.log("Meteora config:", configKeypair.publicKey.toBase58());
console.log("Transaction:", sig);
