// Minimal injected-wallet support (Phantom, Solflare, Backpack all expose
// this shape). Swap for @solana/wallet-adapter if you want a wallet picker.
import { Connection, PublicKey, Transaction, Keypair } from "@solana/web3.js";

interface InjectedWallet {
  publicKey: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signAllTransactions<T extends Transaction>(txs: T[]): Promise<T[]>;
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
  const signed = await wallet.signAllTransactions(txs);
  const sigs: string[] = [];
  for (let i = 0; i < signed.length; i++) {
    const sig = await conn.sendRawTransaction(signed[i].serialize(), { skipPreflight: false });
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`Transaction ${i + 1} failed: ${JSON.stringify(res.value.err)}`);
    sigs.push(sig);
    onStep?.(i, sig);
  }
  return sigs;
}
