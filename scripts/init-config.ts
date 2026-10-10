// One-time setup of the Stacks program config (run by the admin wallet that
// will control it). Re-run with --update to change settings later.
//
//   RPC_URL=... npx tsx init-config.ts --treasury <WALLET> --meteora-config <CONFIG> [--fee-bps 200] [--launch-fee 0] [--update]
import { PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { connection, loadKeypair, arg } from "./common";

const PROGRAM_ID = new PublicKey(arg("program-id", "3jFsMVZrjS6GVwQxh6wQGb71ubnBip6EBFxo9mydt3t3"));
const admin = loadKeypair();
const treasury = new PublicKey(arg("treasury"));
const meteoraConfig = new PublicKey(arg("meteora-config", PublicKey.default.toBase58()));
const feeBps = Number(arg("fee-bps", "200"));
const launchFee = BigInt(Math.round(Number(arg("launch-fee", "0")) * 1e9));
const update = process.argv.includes("--update");

const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
const params = Buffer.alloc(32 + 2 + 8 + 32);
treasury.toBuffer().copy(params, 0);
params.writeUInt16LE(feeBps, 32);
params.writeBigUInt64LE(launchFee, 34);
meteoraConfig.toBuffer().copy(params, 42);

const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: update
    ? [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: config, isSigner: false, isWritable: true },
      ]
    : [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
  data: Buffer.concat([
    Buffer.from(update ? [29, 158, 252, 191, 10, 83, 219, 99] : [175, 175, 109, 31, 13, 152, 155, 237]),
    params,
  ]),
});
const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [admin]);
console.log(update ? "Config updated:" : "Config created:", config.toBase58());
console.log("Treasury:", treasury.toBase58(), "| fee:", feeBps, "bps | Meteora config:", meteoraConfig.toBase58());
console.log("Transaction:", sig);
