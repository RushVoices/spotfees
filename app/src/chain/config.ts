// Site configuration, read from Vite env vars (see .env.example).
// With no env vars at all the site can already launch coins on pump.fun
// (mainnet, through the site's /api/rpc route). Spots switch on once the Spot program id and the
// treasury are set.
export const env = {
  cluster: (import.meta.env.VITE_CLUSTER || "mainnet-beta") as "devnet" | "mainnet-beta",
  // Default: the site's own /api/rpc route, which forwards to Solana
  // server-side (public RPCs refuse direct browser requests).
  rpcUrl: import.meta.env.VITE_RPC_URL || (typeof location !== "undefined" ? `${location.origin}/api/rpc` : "https://api.mainnet-beta.solana.com"),
  programId: import.meta.env.VITE_STACKS_PROGRAM_ID || "3jFsMVZrjS6GVwQxh6wQGb71ubnBip6EBFxo9mydt3t3",
  meteoraConfig: import.meta.env.VITE_METEORA_CONFIG || "",
  treasury: import.meta.env.VITE_TREASURY || "",
};

/** True when the Spot program is deployed and configured: auctions, My Spots, fee splits. */
export const isLive = () => !!(import.meta.env.VITE_STACKS_PROGRAM_ID && env.treasury);
