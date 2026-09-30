# WALLETCHI TEST SEASON | Robinhood Chain TESTNET (46630) | deployed 2026-07-27

FAST PLAYTEST CONFIG: this is the demo/playtest season. Real mainnet uses challengeWindow >= 24h, larger MIN_PLAYERS, a real Pons-launched care token, and fresh keys. TESTNET ONLY.

RPC `https://rpc.testnet.chain.robinhood.com` | Explorer `https://explorer.testnet.chain.robinhood.com` | chainId 46630
Deployer / owner / relayer (single testnet key, in `server/.env` RELAYER_PRIVATE_KEY): `0x5a97eF885F4369b52dbb23E7cA2FDAe05fB62e6F`

## ACTIVE SEASON (Pons-mirror care token) | POINT THE SERVER HERE

| Contract | Address |
|---|---|
| PonsCareToken (CARE, 18dp, 1B fixed supply) | `0xe958295D7caE338D05054bA7284039cC188E0C68` |
| Pet721 (WALLETCHI TEST SEASON / tWCHI) | `0x660f660309FC4dc7DD9e85Fd0552be31c655680e` |
| PetIssuer | `0xE1134EA597b47d8Daf405810B3Bfd504d9dC0f4c` |
| PetVault | `0x3bB8368919aad9fcF67b32EAa2c49280Ce3C70A8` |
| WalletchiTransferValidator (permissive) | `0x365F00012B64b03722523B3546cd892040036432` |
| PunchAccount impl (reused) | `0x0A7eF0f802FA7AE9618F1DF922cB55bd96665e66` |

Post-deploy gate-check: ALL 4 LOCKS ENGAGED (pet.issuerLocked, pet.royaltyLocked, pet.vaultRefLocked, issuer.vaultLocked).

Contracts VERIFIED on Blockscout (2026-07-27, judges can read full source + ABI + decoded constructor args):
PonsCareToken / Pet721 / PetIssuer / PetVault / WalletchiTransferValidator all show is_verified:true at
`https://explorer.testnet.chain.robinhood.com/address/<addr>?tab=contract` (solc 0.8.24, optimizer 500; creation bytecode prefix-matched the local forge build exactly).

Params: lifeTtl 3600s (contract floor) | careCost 1e18 | burn/pot 9000/1000 bps | careCooldown 30s | challengeWindow 120s | minPlayers 2 | maxSupply 2000 | starterTokens 100e18 | perTxCap 1e18 | dailyCap 2880e18 | careDeadline 0 (owner closes manually)

State right now: pets 1-3 minted to the deployer. Pet 1 is a deliberate sacrifice (never cared): it lapses at unix `1785202670` and stays reapable after that, a live demo beat (`cast send $VAULT "reap(uint256)" 1`). Pets 2 and 3 are being cared; pot currently 0.39e18 CARE, totalBurned 3.51e18. Issuer float: ~9.7k CARE (funds starter seeds for ~97 more pets; top up from the deployer stash when low).

## SERVER ENV (to point the site at this season)

```
SURVIVAL_ENABLED=true
PETVAULT_ADDRESS=0x3bB8368919aad9fcF67b32EAa2c49280Ce3C70A8
CARE_TOKEN_ADDRESS=0xe958295D7caE338D05054bA7284039cC188E0C68
RUNNER_ISSUER_ADDRESS=0xE1134EA597b47d8Daf405810B3Bfd504d9dC0f4c
RUNNER_721_ADDRESS=0x660f660309FC4dc7DD9e85Fd0552be31c655680e
PET721_ADDRESS=0x660f660309FC4dc7DD9e85Fd0552be31c655680e
```

(RELAYER_PRIVATE_KEY already set. NOT applied to the live demo server; apply when cutting over.)

## HOW TO PLAY (cast, until the site is wired)

```bash
export PATH="$PATH:/c/Users/skadd/.foundry/bin"
RPC=https://rpc.testnet.chain.robinhood.com
VAULT=0x3bB8368919aad9fcF67b32EAa2c49280Ce3C70A8
ISSUER=0xE1134EA597b47d8Daf405810B3Bfd504d9dC0f4c
CARE=0xe958295D7caE338D05054bA7284039cC188E0C68
```

- Mint a pet (relayer only): `cast send $ISSUER "issuePet(address)" <to>` : TBA auto-created + seeded 100 CARE + registered (life timer starts).
- Pet TBA: `cast call $ISSUER "accountOf(uint256)(address)" <id>`
- FAUCET CARE (buy/top-up): the Pons mirror has NO open mint (fixed supply, like a real Pons launch). Transfer from the deployer stash (tax-exempt, untaxed): `cast send $CARE "transfer(address,uint256)" <petTBA> <amount>`. (The retired mock season's MockCareToken had open `mint(to,amount)`; this season deliberately does not.)
- FEED / WATER (relayer or pet owner): `cast send $VAULT "care(uint256,uint8)" <id> <actionType>` : pulls 1 CARE from the pet's TBA, burns 90% to 0x...dEaD, 10% to pot, resets the life timer. 30s per-pet cooldown.
- Life check: `cast call $VAULT "petState(uint256)(bool,bool,uint64,bool,uint256)" <id>` (registered, reaped, lastCareAt, isAlive, secondsLeft)
- REAP a lapsed pet (permissionless): `cast send $VAULT "reap(uint256)" <id>`
- SETTLE: owner `closeSeason(seedId)` (or `0`) -> `claimPot(bestId)` -> after 120s `finalize()` pays the whole pot to the winner's TBA.

## PONS TAX KNOBS (fee-on-transfer testing)

The care token mirrors a Pons launch: fixed supply to deployer, optional transfer tax (max 10%), owner-settable. Current: tax OFF (0 bps). Vault + issuer are taxExempt (mirrors LP/router exemptions); pet TBAs are NOT, so with tax on, the care pull (TBA -> vault) is the taxed leg.

- Enable 5% tax: `cast send $CARE "setTax(uint96,address)" 500 <recipient>`
- Disable: `cast send $CARE "setTax(uint96,address)" 0 <recipient>`
- Exemptions: `cast send $CARE "setTaxExempt(address,bool)" <addr> true|false`

PROVEN 2026-07-27 on-chain: with 5% tax ON, care() does NOT revert; the vault receives 0.95 CARE post-tax and splits THAT 90/10 (burn 0.855 to dEaD, pot +0.095, tax recipient +0.05). The vault accounts on balance actually received, so the economy is fee-on-transfer safe (PetVault.sol care(): balBefore/After around pullCare).

## PROOF SEASON (mock token, FULL LIFECYCLE settled 2026-07-27, retired)

Pet721 `0xD07611144437087CD13405FF427BdC6739AaFcB0` | PetIssuer `0xD37eb20770D0c476FF854060Aa74D79F419665De` | PetVault `0x0BEE3f588cccB98C79450cEA1010EE70B1fB47D0` | MockCareToken `0x103Fba6e7De04a77E48e142026B149A9f031da9c` | validator `0x58E735584A97CA88436f1BFdbC978d5B0B106d62`

Same fast params. Played end-to-end on-chain: 3 pets, 6 cares (exact 90/10 every time), closeSeason seeded pet 3, finalize() paid the 0.6 CARE pot into pet 3's TBA (97.0 -> 97.6, potClaimed true, vault emptied; tx `0xc006f148c661000501840c17440e342d76123f90687b2f04aefe4d772d6e2e65`).

REAP PROVEN (permissionless): pet 1 (never cared) lapsed at unix `1785201888` and was reaped by `0x765563e8f481dc5e9663a6ece43db5ce187ceb4a` (tx `0xbe889b69e1482849feb4f3bf7cdd07d20c451f9d104a6e8f639499f8853661cf`) -- an address that is NOT the owner/relayer (`0x5a97...`), i.e. a random third party culled the neglected pet with no admin involved. On-chain result: petState reaped=true, isAlive=false, aliveCount 3 -> 2. A second reap attempt correctly reverted `NotReapable` (anti-double-reap guard). This closes the full lifecycle: mint -> care(90/10 burn/pot) -> fee-on-transfer safe -> permissionless reap -> settle.
