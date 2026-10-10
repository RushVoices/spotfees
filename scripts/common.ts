import { Connection, Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const connection = new Connection(RPC_URL, "confirmed");

export function loadKeypair(path = process.env.KEYPAIR ?? `${homedir()}/.config/solana/id.json`): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : process.env[name.toUpperCase().replace(/-/g, "_")] ?? fallback;
  if (v === undefined) throw new Error(`Missing --${name}`);
  return v;
}
