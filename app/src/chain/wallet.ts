// Minimal injected-wallet support (Phantom, Solflare, Backpack all expose
// this shape). Swap for @solana/wallet-adapter if you want a wallet picker.
import { Connection, PublicKey, Transaction, Keypair } from "@solana/web3.js";

interface InjectedWallet {
  publicKey: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signAllTransactions<T extends Transaction>(txs: T[]): Promise<T[]>;
  /** Phantom's recommended API: the wallet signs and submits in one step. */
  signAndSendTransaction?(tx: Transaction): Promise<{ signature: string }>;
}

declare global {
  interface Window {
    phantom?: { solana?: InjectedWallet };
    solflare?: InjectedWallet;
    backpack?: InjectedWallet;
    solana?: InjectedWallet;
  }
}

let wallet: InjectedWallet | null = null;
let pubkey: PublicKey | null = null;

function provider(): InjectedWallet | null {
  return window.phantom?.solana ?? window.solflare ?? window.backpack ?? window.solana ?? null;
}

export async function connectWallet(): Promise<PublicKey> {
  const p = provider();
  if (!p) throw new Error("No Solana wallet found. Install Phantom or Solflare.");
  const res = await p.connect();
  wallet = p;
  pubkey = new PublicKey((res?.publicKey ?? p.publicKey)!.toString());
  return pubkey;
}

export const walletKey = () => pubkey;

/**
 * Signs every transaction in one wallet prompt, then sends them one at a
 * time, waiting for each to confirm before sending the next (later ones
 * depend on earlier ones). `extraSigners[i]` partial-signs tx i (e.g. a new
 * mint keypair). `onStep(i)` fires as each one confirms.
 */
export async function signAndSendSequential(
  conn: Connection,
  txs: Transaction[],
  extraSigners: (Keypair[] | undefined)[] = [],
  onStep?: (i: number, sig: string) => void,
): Promise<string[]> {
  if (!wallet || !pubkey) throw new Error("Connect a wallet first.");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  txs.forEach((tx, i) => {
    tx.feePayer = pubkey!;
    tx.recentBlockhash = blockhash;
    const extra = extraSigners[i];
    if (extra?.length) tx.partialSign(...extra);
  });
  // One transaction: let the wallet sign and send it (Phantom's recommended
  // flow; wallets warn less than for sign-only requests).
  if (txs.length === 1 && wallet.signAndSendTransaction) {
    const { signature } = await wallet.signAndSendTransaction(txs[0]);
    await confirmByPolling(conn, signature, null, lastValidBlockHeight, 0);
    onStep?.(0, signature);
    return [signature];
  }
  const signed = await wallet.signAllTransactions(txs);
  const sigs: string[] = [];
  for (let i = 0; i < signed.length; i++) {
    const raw = signed[i].serialize();
    const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
    await confirmByPolling(conn, sig, raw, lastValidBlockHeight, i);
    sigs.push(sig);
    onStep?.(i, sig);
  }
  return sigs;
}

/**
 * Waits for a transaction by polling its status (no websocket, so it works
 * through the site's /api/rpc route), re-sending it every few seconds until
 * it lands or its blockhash expires.
 */
async function confirmByPolling(conn: Connection, sig: string, raw: Buffer | Uint8Array | null, lastValidBlockHeight: number, i: number) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let n = 0; ; n++) {
    await sleep(1000);
    const { value: [st] } = await conn.getSignatureStatuses([sig]);
    if (st?.err) throw new Error(`Transaction ${i + 1} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    if (n % 3 === 2) {
      if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error("Transaction expired: block height exceeded. Try again.");
      if (raw) conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
  }
}
