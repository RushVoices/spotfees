#!/usr/bin/env bash
# Generates your own program keypair (if missing) and writes its address
# everywhere the code refers to the Stacks program.
#   ./scripts/set-program-id.sh
set -euo pipefail
cd "$(dirname "$0")/.."
KEY=keys/stacks-program-keypair.json
mkdir -p keys
[ -f "$KEY" ] || solana-keygen new --no-bip39-passphrase -s -o "$KEY"
NEW=$(solana-keygen pubkey "$KEY")
OLD=3jFsMVZrjS6GVwQxh6wQGb71ubnBip6EBFxo9mydt3t3
for f in programs/stacks/src/lib.rs Anchor.toml app/.env.example app/src/chain/config.ts scripts/init-config.ts; do
  sed -i.bak "s/$OLD/$NEW/g" "$f" && rm -f "$f.bak"
done
echo "Program id set to $NEW (keypair: $KEY — keep it private, never commit it)"
