// Connects the page (index.html) to Solana. src/ui/site.ts handles the look
// and animations; this module exposes `window.StacksChain` with the real
// actions and, when the site is configured (see .env.example), swaps the
// sample launches for the ones on chain.

import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { env, isLive } from "./chain/config";
import { connectWallet, signAndSendSequential, walletKey } from "./chain/wallet";
import {
  Mode, Status, Venue, fetchAllLaunches, fetchClaimable, ixClaim, ixTakeStack, ixTransferStack, priceAt, type LaunchState,
} from "./chain/stacks";
import { launchOnPump, finishPumpSetup, collectPumpFees } from "./chain/pump";
import { launchOnMeteora, harvestMeteoraFees } from "./chain/meteora";
import { uploadMetadata } from "./chain/ipfs";
import { Transaction } from "@solana/web3.js";

const conn = isLive() ? new Connection(env.rpcUrl, "confirmed") : null;
const need = () => { if (!conn) throw new Error("This site is not connected to Solana yet."); return conn; };
const sol = (l: bigint) => Number(l) / LAMPORTS_PER_SOL;

// ---- token names/images ------------------------------------------------------

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
interface TokenInfo { name: string; symbol: string; image?: string; description?: string }
const metaCache = new Map<string, TokenInfo>();

function readBorshString(d: Buffer, o: number): [string, number] {
  const n = d.readUInt32LE(o);
  return [d.subarray(o + 4, o + 4 + n).toString("utf8").replace(/\0+$/, ""), o + 4 + n];
}

async function tokenInfo(mint: PublicKey, venue: Venue): Promise<TokenInfo> {
  const key = mint.toBase58();
  if (metaCache.has(key)) return metaCache.get(key)!;
  let info: TokenInfo = { name: key.slice(0, 4) + "…", symbol: "?" };
  let uri = "";
  try {
    if (venue === Venue.Pump) {
      const m = await getTokenMetadata(need(), mint, "confirmed", TOKEN_2022_PROGRAM_ID);
      if (m) { info = { name: m.name, symbol: m.symbol }; uri = m.uri; }
    } else {
      const [pda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX);
      const acc = await need().getAccountInfo(pda);
      if (acc) {
        const d = acc.data as Buffer;
        let o = 1 + 32 + 32;
        let name: string, symbol: string;
        [name, o] = readBorshString(d, o);
        [symbol, o] = readBorshString(d, o);
        [uri] = readBorshString(d, o);
        info = { name, symbol };
      }
    }
    if (uri) {
      const json = await fetch(uri).then((r) => r.json()).catch(() => null);
      if (json?.image) info.image = String(json.image);
      if (json?.description) info.description = String(json.description).slice(0, 500);
    }
  } catch { /* show the fallback */ }
  metaCache.set(key, info);
  return info;
}

// ---- view model for the page -------------------------------------------------

export interface CardView {
  live: true;
  mint: string;
  name: string;
  sym: string;
  image?: string;
  /** The coin's narrative (metadata description). */
  story?: string;
  venue: "Pump" | "Meteora";
  mode: "degen" | "builder";
  sold: number;
  status: "setup" | "open" | "soldout";
  nextIndex: number;
  creator: string;
  hue: string;
  /** performance.now() timestamp that matches the on-chain auction clock. */
  t0: number;
}

const HUES = ["#d9f7e8", "#e8f6c9", "#cdf3e2", "#e2f3ea", "#f0f7d8", "#d6f0ff"];
let launches: LaunchState[] = [];
let chainOffset = 0; // chain unix time - local unix time, in seconds

async function syncClock() {
  try {
    const c = need();
    const slot = await c.getSlot();
    const t = await c.getBlockTime(slot);
    if (t) chainOffset = t - Date.now() / 1000;
  } catch { /* keep 0 */ }
}
const chainNow = () => Date.now() / 1000 + chainOffset;

async function toView(l: LaunchState, i: number): Promise<CardView> {
  const meta = await tokenInfo(l.mint, l.venue);
  const ageMs = (chainNow() - l.clockStart) * 1000;
  return {
    live: true,
    mint: l.mint.toBase58(),
    name: meta.name,
    sym: meta.symbol,
    image: meta.image,
    story: meta.description,
    venue: l.venue === Venue.Pump ? "Pump" : "Meteora",
    mode: l.mode === Mode.Builder ? "builder" : "degen",
    sold: l.sold,
    status: l.status === Status.Open ? "open" : l.status === Status.SoldOut ? "soldout" : "setup",
    nextIndex: l.owners.findIndex((o) => o === null),
    creator: l.creator.toBase58(),
    hue: HUES[i % HUES.length],
    t0: performance.now() - ageMs,
  };
}

async function refresh() {
  if (!conn) return;
  await syncClock();
  launches = await fetchAllLaunches(conn);
  const views = await Promise.all(launches.filter((l) => l.status !== Status.Setup).map(toView));
  window.StacksUI?.setLaunches(views);
  await refreshMine();
}

async function refreshMine() {
  const me = walletKey();
  if (!conn || !me) { window.StacksUI?.renderMine(null); return; }
  const mine = launches.filter((l) => l.owners.some((o) => o?.equals(me)));
  const rows: { mint: string; name: string; sym: string; index: number; claimable: number; venue: string }[] = [];
  for (const l of mine) {
    const claimable = await fetchClaimable(conn, l.mint);
    const meta = await tokenInfo(l.mint, l.venue);
    l.owners.forEach((o, i) => {
      if (o?.equals(me)) rows.push({ mint: l.mint.toBase58(), name: meta.name, sym: meta.symbol, index: i, claimable: sol(claimable[i]), venue: l.venue === Venue.Pump ? "Pump" : "Meteora" });
    });
  }
  window.StacksUI?.renderMine(rows);
}

// ---- actions -------------------------------------------------------------------

const api = {
  live: isLive(),
  cluster: env.cluster,

  async connect(): Promise<string> {
    const k = await connectWallet();
    refreshMine().catch(() => {});
    return k.toBase58();
  },

  refresh,

  async launch(
    p: { venue: "pump" | "meteora"; name: string; symbol: string; image: File; description?: string; twitter?: string; telegram?: string; website?: string; mode: "degen" | "builder"; prebuy: number; devBuySol: number },
    onStep: (step: number) => void,
  ) {
    const c = need();
    const me = walletKey() ?? (await connectWallet());
    onStep(0);
    const uri = await uploadMetadata(p.image, { name: p.name, symbol: p.symbol, description: p.description, twitter: p.twitter, telegram: p.telegram, website: p.website });
    const params = {
      name: p.name, symbol: p.symbol, uri,
      mode: p.mode === "builder" ? Mode.Builder : Mode.Degen,
      prebuy: p.prebuy,
      devBuyLamports: BigInt(Math.round(p.devBuySol * LAMPORTS_PER_SOL)),
    };
    const result = p.venue === "pump"
      ? await launchOnPump(c, me, params, (i) => onStep(i + 1))
      : await launchOnMeteora(c, me, params, (i) => onStep(i + 1));
    refresh().catch(() => {});
    return { mint: result.mint.toBase58(), signatures: result.signatures, explorer: explorer(result.signatures.at(-1)!) };
  },

  async finishSetup(mint: string, mode: "degen" | "builder", prebuy: number) {
    const me = walletKey() ?? (await connectWallet());
    const sigs = await finishPumpSetup(need(), me, new PublicKey(mint), { mode: mode === "builder" ? Mode.Builder : Mode.Degen, prebuy });
    refresh().catch(() => {});
    return sigs;
  },

  /** Takes Spot `index` of `mint`, paying at most `maxSol`. */
  async take(mint: string, index: number, maxSol: number) {
    const c = need();
    const me = walletKey() ?? (await connectWallet());
    const l = launches.find((x) => x.mint.toBase58() === mint);
    if (!l) throw new Error("Launch not found. Refresh and try again.");
    const maxPrice = BigInt(Math.round(maxSol * LAMPORTS_PER_SOL));
    const tx = new Transaction().add(ixTakeStack({ buyer: me, mint: l.mint, creator: l.creator, treasury: new PublicKey(env.treasury), index, maxPrice }));
    const [sig] = await signAndSendSequential(c, [tx]);
    refresh().catch(() => {});
    return { signature: sig, explorer: explorer(sig) };
  },

  /** Current on-chain price in SOL for a launch (for display). */
  priceNow(mint: string): number | null {
    const l = launches.find((x) => x.mint.toBase58() === mint);
    return l ? sol(priceAt(l, chainNow())) : null;
  },

  /** Pays out fees collected so far into all ten vaults (anyone can do this). */
  async collectFees(mint: string) {
    const c = need();
    const me = walletKey() ?? (await connectWallet());
    const l = launches.find((x) => x.mint.toBase58() === mint);
    if (!l) throw new Error("Launch not found.");
    const sigs = l.venue === Venue.Pump
      ? await collectPumpFees(c, me, l.mint)
      : await harvestMeteoraFees(c, me, l.mint, l.venueAccount);
    await refreshMine();
    return sigs;
  },

  /** Moves Spot `index` (and its unclaimed SOL) to another wallet. */
  async transfer(mint: string, index: number, to: string) {
    const c = need();
    const me = walletKey() ?? (await connectWallet());
    const newOwner = new PublicKey(to);
    const [sig] = await signAndSendSequential(c, [new Transaction().add(ixTransferStack(me, new PublicKey(mint), index, newOwner))]);
    await refresh();
    return { signature: sig, explorer: explorer(sig) };
  },

  async claim(mint: string, index: number) {
    const c = need();
    const me = walletKey() ?? (await connectWallet());
    const [sig] = await signAndSendSequential(c, [new Transaction().add(ixClaim(me, new PublicKey(mint), index))]);
    await refreshMine();
    return { signature: sig, explorer: explorer(sig) };
  },
};

function explorer(sig: string) {
  return `https://solscan.io/tx/${sig}${env.cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

declare global {
  interface Window {
    StacksChain?: typeof api;
    StacksUI?: {
      setLaunches(list: CardView[]): void;
      renderMine(rows: { mint: string; name: string; sym: string; index: number; claimable: number; venue: string }[] | null): void;
      toast(msg: string): void;
    };
  }
}

window.StacksChain = api;
window.dispatchEvent(new Event("stacks:ready"));
if (api.live) {
  refresh().catch((e) => window.StacksUI?.toast(`Could not load launches: ${e.message ?? e}`));
  setInterval(() => refresh().catch(() => {}), 20_000);
}
