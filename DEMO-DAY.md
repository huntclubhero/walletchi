# WALLETCHI | DEMO-DAY RUNBOOK

Everything below is LIVE on Robinhood Chain testnet (chainId 46630) as of 2026-07-27. The live survival season is real: real ERC-721 pets, real ERC-6551 token-bound accounts, a real Pons-token-mirror CARE economy (90% burn / 10% pot), all on-chain.

## Live URLs
- Site: https://www.playwalletchi.com  (arena at https://www.playwalletchi.com/arena)
- API: https://api.playwalletchi.com  (health: `/health`; arena data: `/api/season/stats`, `/api/season/board`)
- Explorer (verified source): https://explorer.testnet.chain.robinhood.com/address/0x660f660309FC4dc7DD9e85Fd0552be31c655680e?tab=contract

## The 60-second click-path
1. **Open the Arena** (`/arena`). It shows LIVE, on-chain: pot (CARE), pets alive / 2000, fallen. Numbers poll straight from the PetVault. "This pot is real value the survivors split."
2. **Mint a pet with just an email.** No wallet, no seed phrase. Behind the scenes: an anti-Sybil compute wall (proof-of-work) runs so one person cannot farm pets "even with AI", then a Privy embedded wallet is created and the pet mints to it. ~6 seconds.
3. **Show the pet in Apple/Google Wallet.** It is a live pass: status, life-left, care count. It updates.
4. **Feed it.** One tap. The CARE cost is pulled from the pet's own token-bound account: 90% is BURNED to 0x…dEaD, 10% goes to the POT. The pot ticks up live in the arena. No transaction to sign.
5. **The stakes.** Neglect = death. Anyone can permissionlessly "reap" a lapsed pet (no admin). Last pet alive wins the entire pot.

## The live REAP beat (optional, high-impact)
There is a lapsed-but-unreaped sacrifice pet (tokenId 1) in the active season. Reaping is permissionless: anyone can do it.
```
export PATH="$PATH:/c/Users/skadd/.foundry/bin"
cast send 0x3bB8368919aad9fcF67b32EAa2c49280Ce3C70A8 "reap(uint256)" 1 \
  --private-key <any funded testnet key> --rpc-url https://rpc.testnet.chain.robinhood.com
```
It records the death on-chain and drops the alive count. (If it is already reaped by demo time, that itself is the point: a random third party already culled a neglected pet with no admin involved; tx `0xbe889b69…` on the proof season did exactly this.)

## Proof points to name-drop (all verified on-chain, not slideware)
- **Economy is real and exact.** Every care splits 90/10 to the wei. Vault accounting == actual token balances: dEaD holds exactly the burned CARE, the vault holds exactly the pot. Zero drift.
- **Fee-on-transfer safe.** The CARE token mirrors a Pons launch (fixed supply + optional transfer tax). With a 5% tax ON, feeding still works: the vault splits on the amount ACTUALLY received, never the nominal cost. Tested live.
- **Full lifecycle proven:** mint → care → fee-on-transfer → permissionless reap → settle (winner's TBA was paid the entire pot on-chain).
- **Contracts are VERIFIED on the explorer.** Judges can read the real source, ABI, and constructor args for all five contracts. Nothing hidden.
- **Access control holds.** Owner/issuer/relayer functions revert for unauthorized callers; the four immutability locks (issuer, royalty, vaultRef, issuer.vault) are engaged and permanent.

## Contract addresses (active season)
| Contract | Address |
|---|---|
| Pet721 (WALLETCHI) | 0x660f660309FC4dc7DD9e85Fd0552be31c655680e |
| PetVault | 0x3bB8368919aad9fcF67b32EAa2c49280Ce3C70A8 |
| PetIssuer | 0xE1134EA597b47d8Daf405810B3Bfd504d9dC0f4c |
| CARE (Pons mirror) | 0xe958295D7caE338D05054bA7284039cC188E0C68 |

## If something hiccups
- **Arena shows nothing / seasonActive false:** the Render server may be waking from idle (free tier sleeps). Load `/health` once to wake it, wait ~30s, refresh.
- **A mint stalls at "minting":** the relayer is submitting on-chain; give it ~10s and re-poll. Issuer float seeds ~90 more pets before it needs a top-up.
- **This is TESTNET with a FAST playtest config** (1h life, 30s cooldown, 120s settle window). Mainnet uses 24h+ windows, the real Pons CARE token, fresh multisig-held keys: see MAINNET-LAUNCH-RUNBOOK.md. Do not present the testnet single-key setup as the mainnet security model.

## One-line pitch
"A Tamagotchi that lives in your Apple Wallet, minted with just an email, where neglect is permanent and the last pet alive wins a real on-chain pot."
