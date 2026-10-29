# WALLETCHI trustless care via account abstraction | spec 2026-08-10

The V2 that removes the last operator lever (audit access-H-1: the relayer could force-care a rival to
steer the winner). Care becomes OWNER-SIGNED + GAS-SPONSORED, so there is no trusted care relayer at all.
Branch: `last-pet-standing`. House rule: no em dashes / "--".

## Why
The last-pet-standing audit found the game trustless EXCEPT the care relayer: a privileged server key
could `care()` any pet, drain a rival's float, and win by attrition. Removing the relayer and having each
owner sign their own care closes it by construction. Robinhood Chain natively supports ERC-4337 + EIP-7702
(verified on-chain: all EntryPoint versions deployed; Alchemy + ZeroDev bundlers; Alchemy Gas Manager;
Privy integration), so the owner can sign a care WITHOUT holding ETH and WITHOUT a wallet migration.

## The flow
Tap the pass care link -> WALLETCHI web page (pet + action) -> user's existing Privy embedded wallet signs
a `care(tokenId, action)` call -> EIP-7702 delegates that EOA to an Alchemy Smart Wallet at send time (no
new address, no deploy) -> Alchemy bundler submits the UserOp -> the Gas Manager policy SPONSORS the gas.
On-chain `msg.sender == the pet owner's EOA == pet.ownerOf(tokenId)`, so it passes the owner-only care().
The issuer-spender still pulls CARE from the pet's TBA (money path unchanged). No relayer in the loop.

SDK: `@alchemy/wallet-apis` + `@privy-io/react-auth` + `viem`.
`createSmartWalletClient({ signer: toViemAccount(privyWallet), transport: alchemyWalletTransport({apiKey}),
chain: robinhoodChain, paymaster: { policyId } })` then `client.sendCalls([{ to: PETVAULT, data: careCalldata }])`.
Robinhood Chain is a custom viem chain (id 4663 mainnet / 46630 testnet, RPC from the chain docs).

## Contract change (DONE, on branch)
- `care()` is OWNER-ONLY: `if (msg.sender != pet.ownerOf(tokenId)) revert NotAuthorizedCarer();`.
- The vault `relayer` field + `setRelayer` + `RelayerSet` + `onlyRelayer` + `NotRelayer` + `Params.relayer`
  are removed. Params is now 12 fields. ABI regenerated (79 members, no relayer/setRelayer).
- MINTING is unchanged: `PetIssuer.issuePet` stays relayer-gated (the server mints on signup; minting a pet
  to a user is not a winner-steering lever, so the issuer relayer stays and pays mint gas as today).

## Server changes (TODO)
- Stop submitting cares (the care relayer path in the chain layer / actions is retired). Keep passes, push,
  mint (issuer relayer), anti-Sybil, drama feed, finalize-poke.
- Pass care links change: they no longer hit a server care endpoint with an HMAC capability token. They open
  the web app's care page for the pet. Owner-signs IS the proof of control, so the ERC-4361 / HMAC-capability
  care-auth machinery becomes unnecessary for care (the wallet-pass auth floor is satisfied by construction).
- Config: an Alchemy API key + Gas Manager policyId (per network) become server/site config.

## Frontend changes (TODO, web-cub)
- The care page: load Privy (existing session), build the care call, create the Alchemy smart-wallet client
  with the Gas Manager policy, sendCalls, show the result. Handle the not-logged-in / claim-first case.

## Setup inputs (JP)
- Alchemy app for Robinhood Chain (TESTNET first, 46630; mainnet 4663 later) -> API key.
- Alchemy Gas Manager sponsorship policy LINKED to that app -> policyId. Safety limits (per-user + global
  daily cap) as a drain circuit-breaker.
- Fund/enable Gas Manager billing (RH gas is ~free; pennies).
- Privy App ID/Secret: already held.

## Build order (build -> test -> audit -> deploy; no shortcuts)
1. Contract change + tests (owner-only care, no relayer). DONE (contract); tests in progress.
2. Frontend AA care flow + server care-relay removal (needs the Alchemy key + policyId).
3. Testnet end-to-end: a real sponsored, owner-signed care with no ETH in the user's wallet.
4. Adversarial audit of the AA flow + the contract change (5-specialist rigor).
5. Merge to main + fresh testnet deploy of the audited contracts, then mainnet gates.

## Phase C (later, needs the live Pons CARE token + a DEX pool for pricing)
Swap the sponsored-gas Gas Manager policy for a CARE-as-gas token paymaster: the player's CARE pays the gas
(paymaster fronts ETH, reimbursed in CARE). Same UX, config swap, no rebuild. Gated on the token trading.
