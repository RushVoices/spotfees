# Spot

**Spot**: turn a token’s creator fees into ten Spots. Buy a share. Earn as it trades.

Creators launch a coin on **pump.fun** (Meteora is supported by the program and SDK code, but not shown on the site). The coin's creator fees are split into ten equal Spots, which are sold by a descending-price auction. Holders earn 10% of the creator fees each, for as long as the coin trades.

> **Status: unaudited, not yet run on a live network.** The program builds with `cargo-build-sbf` (Solana 2.2) and passes its 6 unit tests and 10 integration tests, which run the compiled program against byte-for-byte copies of Pump's and Meteora's accounts. The site's pump.fun launch passes an offline simulation (`npm run test:launch` in `app/`): transaction count, signers, instruction order, and Solana's 1232-byte size limit. Nothing has touched devnet or mainnet yet. Follow the checklist below on **devnet** before any real SOL is involved, and get the program audited before mainnet.

## What's in here

| Path | What it is |
| --- | --- |
| `programs/stacks/` | The Solana program (internal name `stacks`) (Rust, Anchor 0.31.1): auction, ownership, claims, Meteora fee harvesting. |
| `programs/stacks/tests/integration.rs` | 10 end-to-end tests of the compiled program, with Pump and Meteora accounts simulated byte for byte. |
| `app/` | The website. Vite + TypeScript + Three.js. `index.html` is the site, `docs.html` the docs; `src/ui/` is the page logic and the 3D stack (`stack3d.ts`); `src/chain/` talks to Solana; `api/upload.ts` uploads images to IPFS. |
| `scripts/` | One-time setup: create the Meteora config, initialize the Spots config, set your program id. |

## How it works

Each launch gets ten **vault** addresses, one per Spot. Only the Spots program can pay out of them.

- **Pump.** At launch, the coin's Pump fee sharing is set to the ten vaults at 10% each. Pump allows that list to be set only once and then locks it ([Pump docs](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md)). Pump's own `distribute_creator_fees_v2` pays SOL straight into the vaults. Anyone can call it, and the site's **Collect fees** button does.
- **Meteora (Dynamic Bonding Curve).** At launch, the pool's creator role is handed to a program-owned fee authority. `harvest_meteora` claims the creator trading fees and splits them equally into the vaults.

Owning a Spot is a record in the program. Taking, transferring or claiming a Spot never touches Pump or Meteora, whose wiring is fixed before the auction opens. The program checks that wiring on-chain (`open_auction_pump`, `open_auction_meteora`), so buyers don't have to trust the creator.

**Launch flow (one wallet prompt)**

| Venue | Tx 1 | Tx 2 | Tx 3 |
| --- | --- | --- | --- |
| Pump | Create coin (+ dev buy) | Register launch, turn on fee sharing | Set the 10 vaults as shareholders, open auction |
| Meteora | Create pool (+ first buy) | Register launch, hand creator to fee authority, open auction | — |

Registering must happen while the signer is still the coin's creator, so nobody can register someone else's coin. If a Pump launch stops after tx 1, `finishPumpSetup` in `app/src/chain/pump.ts` finishes it.

Pump transaction notes (checked offline against `@pump-fun/pump-sdk` 4.0.0):
- Tx 1 uses `create_v2` + the SOL-quoted `buy`, which fits one legacy transaction with a compute budget. The `buy_v2` variant is ~260 bytes over the limit. If a very long name or URI still doesn't fit, the site falls back to create and buy as two back-to-back transactions.
- Tx 2 and tx 3 start with Pump's `sweep_creator_fee`, which Pump requires before fee-sharing changes when creator fees sit on the curve (e.g. a sniper traded between tx 1 and tx 2). They carry no compute-budget instruction: each is within ~30 bytes of the 1232-byte limit.
- **Collect fees** uses `OnlinePumpSdk.buildDistributeCreatorFeesInstructions`, which adds the sweeps and, after graduation, moves PumpSwap creator fees back first.

**Auction rules.** Degen: 1.5 → 0.5 SOL, −0.125 SOL every 15 s. Builder: 4 → 1 SOL, −0.2 SOL every 15 s. The price restarts at the start after each take. The buyer signs a maximum price; if the price changed, the transaction fails and they pay nothing. Proceeds go to the creator, minus a 2% protocol fee to the treasury. Pre-bought Spots (up to 5) cost the creator only the 2% fee on the floor price.

## Setup

You need: Rust, the [Solana CLI 2.2](https://docs.anza.xyz/cli/install), [Anchor 0.31.1](https://www.anchor-lang.com/docs/installation) (`avm install 0.31.1`), Node 20+, a [Pinata](https://pinata.cloud) account (image uploads), and an RPC provider (Helius, Triton, QuickNode).

### 1. Your program id

```bash
./scripts/set-program-id.sh
```

This creates `keys/stacks-program-keypair.json` and writes its address into the code. Keep that file private.

### 2. Build and test the program

```bash
cargo build-sbf --manifest-path programs/stacks/Cargo.toml
cargo test -p stacks            # unit tests + 10 integration tests (needs the .so from the line above)
```

All tests should pass. If a dependency version clashes (`litesvm` vs `solana-sdk`), align `solana-sdk` in `programs/stacks/Cargo.toml` with the version `litesvm` pulls in.

### 3. Deploy to devnet

```bash
solana config set --url devnet
solana airdrop 5
solana program deploy target/deploy/stacks.so --program-id keys/stacks-program-keypair.json
```

### 4. Meteora config, then Spots config

```bash
cd scripts && npm install
RPC_URL=https://api.devnet.solana.com npx tsx create-meteora-config.ts
# prints "Meteora config: <ADDRESS>"
RPC_URL=https://api.devnet.solana.com npx tsx init-config.ts --treasury <YOUR_TREASURY_WALLET> --meteora-config <ADDRESS>
```

### 5. Run the site

```bash
cd app && npm install
npm run typecheck       # do this first: it checks every Pump/Meteora SDK call
npm run test:launch     # offline run of the whole pump.fun launch (sizes, signers, order)
cp .env.example .env    # fill in RPC, treasury, Meteora config
npx vercel dev          # runs the site and the /api/upload route together
# or, without uploads: npm run dev   (http://localhost:5173, docs at /docs.html)
```

`npm run typecheck` is the first real check of the website code against the Pump and Meteora SDKs. If an SDK function name or parameter has changed, fix it in `app/src/chain/pump.ts` or `app/src/chain/meteora.ts`. Those two files hold every SDK call.

Deploy with `npx vercel deploy`, setting the same env vars plus `PINATA_JWT` in the Vercel project. Without `VITE_RPC_URL` and `VITE_TREASURY`, the site runs as the visual demo.

## Devnet test checklist

Use three wallets: **Creator**, **Buyer**, **Trader**. Fund each with devnet SOL.

**Pump**
- [ ] Creator launches on Pump with 2 pre-buys. Wallet asks once for 3 transactions; the site shows the coin live.
- [ ] On Solscan, the coin's fee-sharing config lists the 10 vault addresses at 1,000 bps each.
- [ ] Buyer takes a Spot. Creator receives 98% of the price; the treasury receives 2%.
- [ ] Buyer tries to take the same Spot again and gets "Someone took that Spot first."
- [ ] Trader buys and sells the token a few times on Pump to generate fees.
- [ ] Buyer presses **Collect fees**. Every vault's balance goes up by the same amount.
- [ ] Buyer presses **Claim** and receives their vault's balance. A second claim says there's nothing to claim.
- [ ] Creator claims on a pre-bought Spot.

**Meteora** (the harvest step has no automated test, so test it carefully)
- [ ] Creator launches on Meteora. On Solscan, the pool's creator is the launch's fee authority, not the Creator wallet.
- [ ] Buyer takes a Spot; Trader trades the token.
- [ ] Buyer presses **Collect fees** (runs `harvest_meteora`). Vaults each gain one tenth of the claimed fees; the caller gets the temporary account rent back.
- [ ] Buyer claims.

**Edge cases**
- [ ] Close the wallet popup partway through a Pump launch, then finish setup with `finishPumpSetup`.
- [ ] Take a Spot after another wallet takes one first (the price restarted). The take fails and nothing is charged.

## Before mainnet

1. **Audit** `programs/stacks`. It holds real SOL.
2. Move the program's upgrade authority and the config admin to a multisig (e.g. Squads).
3. Tune the Meteora curve (`scripts/create-meteora-config.ts`): market caps and fees are starting values.
4. Rate-limit `/api/upload` so strangers can't use your Pinata account.
5. Get legal advice. Selling shares of a token's fee stream may be regulated where you or your users are.

## Known limits

- **Meteora after migration.** Once a Meteora pool graduates to DAMM v2, new fees come from the locked liquidity position, which is held by the fee authority. This version has no instruction to claim those position fees yet, so they accrue unclaimed until one is added. Bonding-curve fees are fully handled.
- **Meteora creator-only extras.** Pool surplus and migration fees for the creator now belong to the fee authority, with no instruction to withdraw them yet.
- **Venue admins.** Pump has admin tools that can change fee-sharing configs (for community takeovers). Spots can't prevent changes Pump or Meteora make to their own programs.
- **Unsold Spots.** Fees earned by a Spot before anyone buys it wait in its vault and go to whoever takes it.
- **Fees aren't automatic.** Someone has to press Collect fees (Pump distribution or Meteora harvest). A small cron job calling it for active launches would make payouts automatic.
