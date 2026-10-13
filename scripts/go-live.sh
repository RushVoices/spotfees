#!/usr/bin/env bash
# Puts Spot on Solana and prints the Vercel settings that switch launching on.
#
#   ./scripts/go-live.sh --cluster devnet       --treasury <YOUR_WALLET>
#   ./scripts/go-live.sh --cluster mainnet-beta --treasury <YOUR_WALLET> --rpc <HELIUS_URL>
#
# Needs: Solana CLI 2.2 (solana, solana-keygen, cargo-build-sbf), Rust, Node 20+,
# and a funded wallet at ~/.config/solana/id.json (or KEYPAIR=path). That wallet
# pays for the deploy and becomes the program's upgrade authority and config admin.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=devnet; TREASURY=""; RPC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) CLUSTER="$2"; shift 2 ;;
    --treasury) TREASURY="$2"; shift 2 ;;
    --rpc) RPC="$2"; shift 2 ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
done
[ -n "$TREASURY" ] || { echo "Pass --treasury <wallet that receives the 2% fee>"; exit 1; }
case "$CLUSTER" in devnet|mainnet-beta) ;; *) echo "--cluster must be devnet or mainnet-beta"; exit 1 ;; esac
[ -n "$RPC" ] || RPC="https://api.$CLUSTER.solana.com"
KEYPAIR="${KEYPAIR:-$HOME/.config/solana/id.json}"

for t in solana solana-keygen cargo-build-sbf node npm; do
  command -v "$t" >/dev/null || { echo "Missing $t. Install the Solana CLI 2.2 and Node 20+ first."; exit 1; }
done
[ -f "$KEYPAIR" ] || { echo "No wallet at $KEYPAIR. Create one: solana-keygen new"; exit 1; }

ME=$(solana-keygen pubkey "$KEYPAIR")
BAL=$(solana balance "$ME" --url "$RPC" | awk '{print $1}')
echo "Deployer: $ME ($BAL SOL on $CLUSTER)"
if [ "$CLUSTER" = "mainnet-beta" ]; then
  echo
  echo "MAINNET: the program is unaudited and will hold real SOL. Deploying costs about 3-6 SOL (mostly refundable rent)."
  read -r -p "Type 'deploy' to continue: " OK; [ "$OK" = "deploy" ] || exit 1
elif awk "BEGIN{exit !($BAL < 6)}"; then
  echo "Topping up devnet SOL..."; solana airdrop 5 "$ME" --url "$RPC" || echo "Airdrop failed; get devnet SOL at https://faucet.solana.com"
fi

echo; echo "1/4 Program id"
bash ./scripts/set-program-id.sh
PROGRAM_ID=$(solana-keygen pubkey keys/stacks-program-keypair.json)

echo; echo "2/4 Build"
cargo-build-sbf --manifest-path programs/stacks/Cargo.toml

echo; echo "3/4 Deploy"
SIZE=$(stat -c %s target/deploy/stacks.so 2>/dev/null || stat -f %z target/deploy/stacks.so)
solana program deploy target/deploy/stacks.so \
  --program-id keys/stacks-program-keypair.json \
  --keypair "$KEYPAIR" --url "$RPC" \
  --max-len $(( SIZE * 5 / 4 ))

echo; echo "4/4 Protocol config (treasury $TREASURY, 2% fee)"
( cd scripts && npm install --silent && \
  RPC_URL="$RPC" KEYPAIR="$KEYPAIR" npx tsx init-config.ts --program-id "$PROGRAM_ID" --treasury "$TREASURY" ) \
  || echo "(If it says the config already exists, add --update to change it.)"

cat <<OUT

Spot is on $CLUSTER. Program: $PROGRAM_ID

Now in Vercel -> spotfees -> Settings -> Environment Variables, add:

  VITE_CLUSTER            $CLUSTER
  VITE_RPC_URL            <your Helius/Triton/QuickNode $CLUSTER URL>
  VITE_STACKS_PROGRAM_ID  $PROGRAM_ID
  VITE_TREASURY           $TREASURY
  PINATA_JWT              <from pinata.cloud -> API Keys>

Then redeploy. The Launch button goes live.
Commit the changed program id (git add -A; never commit keys/, it's gitignored).
OUT
