#!/usr/bin/env bash
# REHEARSE the Testnet Showcase deploy on a LOCAL FORK. Writes nothing to any real chain.
#
# It deploys the whole suite with the exact showcase parameters (script/showcase.env), locks the
# validator the way the runbook does, runs VerifyWalletchiWiring (which now also asserts the Wallet
# Pass Extension: 0xef5f1e71 advertised, passBaseURI composed from PASS_BASE_URI, passURI round trip),
# then mints one pet through the issuer to prove the relayer path works end to end.
#
# REHEARSE_E2E=1 additionally runs the REAL server against the fork (server/scripts/wallet-pass-e2e.ts):
# mint through the checkout, transfer on chain, read passURI ON CHAIN, fetch it (401 gated), sign the
# acquire challenge, fetch the manifest (200), download the .pkpass it names.
#
# WHICH CHAIN ID THE FORK REPORTS, AND WHY IT MATTERS. Forge files its broadcast record under the
# chain id, so a fork reporting 46630 would overwrite broadcast/DeployWalletchi.s.sol/46630/run-latest.json,
# the only local record of the live season's addresses. The default fork therefore runs as 31337. The
# e2e needs 46630 (the server pins the Robinhood testnet id), so in that mode this script REDIRECTS
# forge's broadcast and cache directories to a throwaway folder first, and refuses to run otherwise.
#
# Usage (from contracts/, Git Bash):  bash script/showcase-rehearse.sh
#                                     REHEARSE_E2E=1 bash script/showcase-rehearse.sh
set -euo pipefail

FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
FORGE="$FOUNDRY_BIN/forge"; CAST="$FOUNDRY_BIN/cast"; ANVIL="$FOUNDRY_BIN/anvil"
[ -x "$FORGE" ] || FORGE="$FOUNDRY_BIN/forge.exe"
[ -x "$CAST" ] || CAST="$FOUNDRY_BIN/cast.exe"
[ -x "$ANVIL" ] || ANVIL="$FOUNDRY_BIN/anvil.exe"

E2E="${REHEARSE_E2E:-0}"
CHAIN_ID=31337
[ "$E2E" = "1" ] && CHAIN_ID=46630
UPSTREAM="${UPSTREAM_RPC:-https://rpc.testnet.chain.robinhood.com}"
PORT="${REHEARSE_PORT:-8548}"
[ "$E2E" = "1" ] && PORT="${REHEARSE_PORT:-8549}"
RPC="http://127.0.0.1:$PORT"
E2E_PORT="${E2E_SERVER_PORT:-8791}"

if [ "$CHAIN_ID" != "31337" ]; then
  # Never let a 46630-reporting fork write into the real broadcast/cache folders.
  SCRATCH_DIR="$(mktemp -d)"
  export FOUNDRY_BROADCAST="$SCRATCH_DIR/broadcast"
  export FOUNDRY_CACHE_PATH="$SCRATCH_DIR/cache"
  echo "e2e mode: forge broadcast + cache redirected to $SCRATCH_DIR"
fi

started_anvil=""
if ! "$CAST" chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  "$ANVIL" --fork-url "$UPSTREAM" --chain-id "$CHAIN_ID" --port "$PORT" --silent &
  started_anvil=$!
  trap '[ -n "$started_anvil" ] && kill "$started_anvil" 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do "$CAST" chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
fi
[ "$("$CAST" chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || { echo "refusing: the fork at $RPC is not chain $CHAIN_ID"; exit 1; }
if [ "$CHAIN_ID" != "31337" ] && [ -z "${FOUNDRY_BROADCAST:-}" ]; then echo "refusing: 46630 fork without a redirected broadcast dir"; exit 1; fi

# Throwaway keys. The deployer doubles as relayer + owner (as on the live testnet); the poster is its
# own key because the deploy script refuses POSTER == RELAYER.
deployer_out=$("$CAST" wallet new); poster_out=$("$CAST" wallet new); keeper_out=$("$CAST" wallet new); e2e_keeper_out=$("$CAST" wallet new)
PK=$(echo "$deployer_out" | awk '/Private key/ {print $NF}')
DEPLOYER=$(echo "$deployer_out" | awk '/Address/ {print $NF}')
POSTER_ADDR=$(echo "$poster_out" | awk '/Address/ {print $NF}')
KEEPER=$(echo "$keeper_out" | awk '/Address/ {print $NF}')
E2E_KEEPER_PK=$(echo "$e2e_keeper_out" | awk '/Private key/ {print $NF}')
"$CAST" rpc anvil_setBalance "$DEPLOYER" 0xDE0B6B3A7640000 --rpc-url "$RPC" >/dev/null

set -a
# shellcheck disable=SC1091
. "$(dirname "$0")/showcase.env"
set +a
export PRIVATE_KEY="$PK" POSTER="$POSTER_ADDR"
unset RELAYER TREASURY
# In e2e mode passURI must resolve to the local server, not production.
[ "$E2E" = "1" ] && export PASS_BASE_URI="http://127.0.0.1:$E2E_PORT/wallet-pass/"

LOG_DIR="$(mktemp -d)"
"$FORGE" script script/DeployWalletchi.s.sol --rpc-url "$RPC" --broadcast --slow >"$LOG_DIR/deploy.log" 2>&1 \
  || { tail -40 "$LOG_DIR/deploy.log"; echo "DEPLOY FAILED"; exit 1; }
grep -q "ALL LOCKS ENGAGED" "$LOG_DIR/deploy.log" || { echo "deploy gate-check did not engage every lock"; exit 1; }

addr() { grep -m1 "$1" "$LOG_DIR/deploy.log" | awk '{print $NF}'; }
PET=$(addr "^  Pet721:"); ISSUER=$(addr "^  PetIssuer:"); VAULT=$(addr "^  PetVault:")
DIST=$(addr "CareRewardsDistributor (CARE"); HOLDER_VAULT=$(addr "HolderMerkleVault (USDG")
SPLITTER=$(addr "CareFeeSplitter (USDG in)"); FEE_TOKEN=$(addr "FeeToken MockUSDG"); CARE=$(addr "MockCareToken (18dp)")
VALIDATOR=$(addr "transferValidator:")
echo "rehearsal deploy: pet=$PET issuer=$ISSUER vault=$VAULT"

# Runbook step: freeze the validator (VerifyWalletchiWiring requires pet.validatorLocked()).
"$CAST" send "$PET" "lockValidator()" --private-key "$PK" --rpc-url "$RPC" >/dev/null

verify() {
  PET="$PET" ISSUER="$ISSUER" VAULT="$VAULT" VALIDATOR="$VALIDATOR" CARE_TOKEN="$CARE" \
  ROYALTY_RECIPIENT="$DEPLOYER" ACCOUNT_IMPL="$ACCOUNT_IMPL" DIST="$DIST" HOLDER_VAULT="$HOLDER_VAULT" \
  SPLITTER="$SPLITTER" FEE_TOKEN="$FEE_TOKEN" RELAYER="$DEPLOYER" POSTER="$POSTER_ADDR" PASS_BASE_URI="$PASS_BASE_URI" \
    "$FORGE" script script/VerifyWalletchiWiring.s.sol --rpc-url "$RPC" 2>&1 | grep -E "ALL CHECKS PASSED|wallet pass|Error|revert" \
    | tee "$LOG_DIR/verify.log"
  grep -q "ALL CHECKS PASSED" "$LOG_DIR/verify.log" || { echo "VERIFY FAILED"; exit 1; }
}
verify

# The model the showcase depends on: clock model, season live from deploy, entry open for the whole
# showcase, and not decidable before the entry window closes.
[ "$("$CAST" call "$VAULT" "selloutStartsSeason()(bool)" --rpc-url "$RPC")" = "false" ] || { echo "vault is sellout-gated"; exit 1; }
[ "$("$CAST" call "$VAULT" "entryOpen()(bool)" --rpc-url "$RPC")" = "true" ] || { echo "entry closed"; exit 1; }
[ "$("$CAST" call "$PET" "maxSupply()(uint256)" --rpc-url "$RPC")" = "1000" ] || { echo "maxSupply != 1000"; exit 1; }

# One real mint through the relayer path, then prove the TBA got its starter float.
"$CAST" send "$ISSUER" "issuePet(address)" "$KEEPER" --private-key "$PK" --rpc-url "$RPC" >"$LOG_DIR/mint.log"
gas=$(awk '/^gasUsed/ {print $2}' "$LOG_DIR/mint.log")
TBA=$("$CAST" call "$ISSUER" "accountOf(uint256)(address)" 1 --rpc-url "$RPC")
bal=$("$CAST" call "$CARE" "balanceOf(address)(uint256)" "$TBA" --rpc-url "$RPC" | awk '{print $1}')
[ "$bal" = "$STARTER_TOKENS" ] || { echo "starter float wrong: $bal"; exit 1; }
echo "mint #1 OK: issuePet gasUsed=$gas, TBA $TBA seeded $bal raw CARE"

# Wallet Pass Extension: with a token minted, the verifier's passURI round trip now runs too.
verify
PET_LC=$(echo "$PET" | tr 'A-F' 'a-f')
want="${PASS_BASE_URI}eip155/${CHAIN_ID}/${PET_LC}/1"
got=$("$CAST" call "$PET" "passURI(uint256)(string)" 1 --rpc-url "$RPC" | tr -d '"')
[ "$got" = "$want" ] || { echo "passURI(1) = $got, want $want"; exit 1; }
echo "passURI(1) = $got"

if [ "$E2E" = "1" ]; then
  E2E_RPC="$RPC" E2E_PORT="$E2E_PORT" E2E_PET="$PET" E2E_ISSUER="$ISSUER" E2E_VAULT="$VAULT" E2E_CARE="$CARE" \
  E2E_RELAYER_PK="$PK" E2E_KEEPER_PK="$E2E_KEEPER_PK" \
    npx --prefix ../server tsx ../server/scripts/wallet-pass-e2e.ts || { echo "WALLET PASS E2E FAILED"; exit 1; }
fi
echo "SHOWCASE REHEARSAL PASSED"
