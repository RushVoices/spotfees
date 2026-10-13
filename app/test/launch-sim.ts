// Offline end-to-end run of the pump.fun launch (src/chain/pump.ts) against a
// fake RPC and a fake wallet. Checks what it can without a network: number of
// transactions, signers, the 1232-byte size limit, instruction order, and the
// progress callbacks. Run: npm run test:launch
import { Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL, ComputeBudgetProgram } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import BN from "bn.js";
import { pumpIdl, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { launchOnPump, launchPumpDirect } from "../src/chain/pump";
import { programId, Mode } from "../src/chain/stacks";

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`); if (!ok) failures++; };

// ---- a plausible pump Global account, built from Pump's own IDL ----
type IdlType = string | { array?: [IdlType, number]; vec?: IdlType; option?: IdlType; defined?: { name: string } };
const idl = pumpIdl as unknown as { types: { name: string; type: { kind: string; fields?: { name: string; type: IdlType }[]; variants?: unknown[] } }[] };
function dflt(t: IdlType): unknown {
  if (typeof t === "string") {
    if (t === "pubkey") return Keypair.generate().publicKey;
    if (t === "bool") return false;
    if (t === "string") return "";
    if (/^[ui](8|16|32)$/.test(t)) return 0;
    return new BN(0);
  }
  if (t.array) return Array.from({ length: t.array[1] }, () => dflt(t.array![0]));
  if (t.vec) return [];
  if (t.option) return null;
  const def = idl.types.find((x) => x.name === t.defined!.name)!;
  if (def.type.kind === "enum") return { [(def.type.variants![0] as { name: string }).name]: {} };
  return Object.fromEntries(def.type.fields!.map((f) => [f.name, dflt(f.type)]));
}
const global = dflt({ defined: { name: "Global" } }) as Record<string, unknown>;
Object.assign(global, {
  initialized: true,
  initial_virtual_token_reserves: new BN("1073000000000000"),
  initial_virtual_sol_reserves: new BN("30000000000"),
  initial_real_token_reserves: new BN("793100000000000"),
  token_total_supply: new BN("1000000000000000"),
  fee_basis_points: new BN(95),
  creator_fee_basis_points: new BN(30),
});
const coder = new BorshAccountsCoder(pumpIdl as never);

(async () => {
  // coder.encode() uses a 1000-byte buffer; Global is larger, so encode by hand.
  const layout = (coder as unknown as { accountLayouts: Map<string, { layout: { encode(v: unknown, b: Buffer): number } }> }).accountLayouts.get("Global")!.layout;
  const body = Buffer.alloc(8192);
  const len = layout.encode(global, body);
  const disc = (pumpIdl as unknown as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === "Global")!.discriminator;
  const globalData = Buffer.concat([Buffer.from(disc), body.subarray(0, len)]);
  // ---- fake RPC ----
  const sent: Transaction[] = [];
  const conn = {
    async getAccountInfo(k: PublicKey) {
      if (k.equals(GLOBAL_PDA)) return { data: globalData, owner: PUMP_PROGRAM_ID, lamports: 1e9, executable: false };
      if (k.equals(PUMP_FEE_CONFIG_PDA)) return null; // fee config: SDK falls back
      return null;
    },
    async getMultipleAccountsInfo(ks: PublicKey[]) { return Promise.all(ks.map((k) => this.getAccountInfo(k))); },
    async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 }; },
    async sendRawTransaction(raw: Buffer, o?: { skipPreflight?: boolean }) { if (!o?.skipPreflight) sent.push(Transaction.from(raw)); return `sig${sent.length}`; },
    async getSignatureStatuses() { return { value: [{ err: null, confirmationStatus: "confirmed" }] }; },
    async getBlockHeight() { return 1; },
  };

  // ---- fake wallet (Phantom shape) ----
  const user = Keypair.generate();
  const g = globalThis as unknown as { window: unknown };
  g.window = {
    phantom: {
      solana: {
        publicKey: user.publicKey,
        async connect() { return { publicKey: user.publicKey }; },
        async disconnect() {},
        async signAllTransactions(txs: Transaction[]) { txs.forEach((t) => t.partialSign(user)); return txs; },
      },
    },
  };
  const { connectWallet } = await import("../src/chain/wallet");
  await connectWallet();

  const longUri = "https://ipfs.io/ipfs/" + "Q".repeat(59); // CIDv1 worst case
  for (const [label, devBuy, name, sym, uri] of [
    ["no dev buy", 0n, "Gigachad Cat", "GIGA", "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"],
    ["1 SOL dev buy", BigInt(LAMPORTS_PER_SOL), "Gigachad Cat", "GIGA", "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"],
    ["dev buy, max-length name/ticker/URI", BigInt(LAMPORTS_PER_SOL), "N".repeat(32), "S".repeat(10), longUri],
  ] as const) {
    console.log(`\n${label}`);
    sent.length = 0;
    const steps: number[] = [];
    const r = await launchOnPump(conn as never, user.publicKey, { name, symbol: sym, uri, mode: Mode.Degen, prebuy: 2, devBuyLamports: devBuy }, (i) => steps.push(i));
    check(sent.length >= 3 && sent.length <= 4, `${sent.length} transactions sent, one wallet prompt`);
    check(JSON.stringify(steps) === "[0,1,2]", `progress steps ${JSON.stringify(steps)}`);
    sent.forEach((t, i) => {
      const size = t.serialize().length;
      check(size <= 1232, `tx ${i + 1}: ${size} bytes, ${t.instructions.length} instructions`);
      check(t.verifySignatures(), `tx ${i + 1}: fully signed`);
    });
    const first = sent[0];
    check(first.signatures.some((s) => s.publicKey.equals(r.mint)), "tx 1 is signed by the new mint");
    if (devBuy > 0n && sent.length === 3) {
      check(first.instructions.filter((ix) => ix.programId.equals(PUMP_PROGRAM_ID)).length === 2, "tx 1 holds create + dev buy (no sniping gap)");
    }
    const progs = (t: Transaction) => t.instructions.map((ix) =>
      ix.programId.equals(PUMP_PROGRAM_ID) ? "pump" : ix.programId.equals(PUMP_FEE_PROGRAM_ID) ? "pump-fees" : ix.programId.equals(programId()) ? "spot" : ix.programId.equals(ComputeBudgetProgram.programId) ? "budget" : "other");
    const tx2 = sent[sent.length - 2], tx3 = sent[sent.length - 1];
    check(JSON.stringify(progs(tx2)) === '["pump","spot","pump-fees"]', `tx ${sent.length - 1}: sweep → create_launch → create_fee_sharing_config (${progs(tx2).join(", ")})`);
    check(JSON.stringify(progs(tx3)) === '["pump","pump-fees","spot"]', `tx ${sent.length}: sweep → update_fee_shares_v2 → open_auction_pump (${progs(tx3).join(", ")})`);
  }
  // Plain pump.fun launch (Spot program not live yet): one transaction,
  // through signAndSendTransaction like Phantom.
  const ph = (g.window as { phantom: { solana: Record<string, unknown> } }).phantom.solana;
  ph.signAndSendTransaction = async (t: Transaction) => { t.partialSign(user); sent.push(t); return { signature: `sig${sent.length}` }; };
  for (const [label, devBuy] of [["direct: no dev buy", 0n], ["direct: 1 SOL dev buy", BigInt(LAMPORTS_PER_SOL)]] as const) {
    console.log(`\n${label}`);
    sent.length = 0;
    const steps: number[] = [];
    const r = await launchPumpDirect(conn as never, user.publicKey, { name: "Gigachad Cat", symbol: "GIGA", uri: longUri, devBuyLamports: devBuy }, (i) => steps.push(i));
    check(sent.length === 1, `${sent.length} transaction, one wallet prompt`);
    check(JSON.stringify(steps) === "[0]", `progress steps ${JSON.stringify(steps)}`);
    const t = sent[0];
    check(t.serialize().length <= 1232 && t.verifySignatures(), `${t.serialize().length} bytes, fully signed`);
    check(t.signatures.some((x) => x.publicKey.equals(r.mint)), "signed by the new mint");
    check(t.instructions.every((ix) => !ix.programId.equals(programId())), "no Spot program instructions");
    const pumpIxs = t.instructions.filter((ix) => ix.programId.equals(PUMP_PROGRAM_ID)).length;
    check(pumpIxs === (devBuy > 0n ? 2 : 1), devBuy > 0n ? "create + dev buy in the same transaction" : "create only");
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll launch checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
