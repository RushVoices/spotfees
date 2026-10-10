// Site configuration, read from Vite env vars (see .env.example).
export const env = {
  cluster: (import.meta.env.VITE_CLUSTER || "devnet") as "devnet" | "mainnet-beta",
  rpcUrl: import.meta.env.VITE_RPC_URL || "",
  programId: import.meta.env.VITE_STACKS_PROGRAM_ID || "3jFsMVZrjS6GVwQxh6wQGb71ubnBip6EBFxo9mydt3t3",
  meteoraConfig: import.meta.env.VITE_METEORA_CONFIG || "",
  treasury: import.meta.env.VITE_TREASURY || "",
};

/** True when the site has what it needs to talk to the chain. */
export const isLive = () => !!(env.rpcUrl && env.treasury);
