// Vercel Edge Function: POST /api/rpc
// Forwards the site's Solana JSON-RPC calls server-side. Public Solana RPCs
// refuse requests sent straight from a website (403), and this also keeps a
// paid RPC key (RPC_URL) off the browser. Tries each upstream in turn.
//
// Env: RPC_URL (optional, e.g. a Helius/Triton URL with its key)

export const config = { runtime: "edge" };

const UPSTREAMS = () =>
  [process.env.RPC_URL, "https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"].filter(Boolean) as string[];

// Only what the site uses, so the route can't be used as a general free RPC.
const ALLOWED = new Set([
  "getAccountInfo", "getMultipleAccounts", "getLatestBlockhash", "isBlockhashValid", "getBlockHeight",
  "sendTransaction", "simulateTransaction", "getSignatureStatuses", "getBalance", "getSlot", "getBlockTime",
  "getMinimumBalanceForRentExemption", "getProgramAccounts", "getTokenAccountBalance", "getTokenSupply",
  "getFeeForMessage", "getEpochInfo", "getGenesisHash", "getVersion",
]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const text = await req.text();
  if (text.length > 64 * 1024) return json({ error: "Request too large" }, 413);
  let body: { method?: string } | { method?: string }[];
  try { body = JSON.parse(text); } catch { return json({ error: "Invalid JSON" }, 400); }
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > 20 || calls.some((c) => !c || !ALLOWED.has(String(c.method)))) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method not allowed" } }, 400);
  }
  let last: Response | null = null;
  for (const url of UPSTREAMS()) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: text });
      // Fall through to the next upstream when this one refuses or is overloaded.
      if (res.status === 403 || res.status === 429 || res.status >= 500) { last = res; continue; }
      return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch {
      continue;
    }
  }
  return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `Solana network is busy (${last?.status ?? "no response"}). Try again in a moment.` } }, 503);
}

declare const process: { env: Record<string, string | undefined> };
