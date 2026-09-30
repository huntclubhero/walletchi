# WALLETCHI Deployments (repo history; formerly titled PUNCHCARD)

> **CURRENT ACTIVE SEASON: see TEST-SEASON.md.** The live testnet season addresses (Pet721 `0x660f...680e`, PetVault `0x3bB8...70A8`, PetIssuer `0xE113...0f4c`, CARE `0xe958...0C68`, validator `0x365F...6432`) live there and DIFFER from the older WALLETCHI rehearsal set recorded below.
>
> **STALE FILE NOTE:** `deployments/testnet.json` records only the retired PUNCHCARD 2026-07-24 deploy; it is stale and kept for history only.
>
> PUNCHCARD and SALMON RUN were scrapped as products on 2026-07-26; their sections below are historical.

## RETIRED: PUNCHCARD | Robinhood Chain Testnet (chainId 46630) | deployed 2026-07-24

| Contract | Address |
|---|---|
| CardIssuer | `0xCf116d722f6562c9A2197E91Fa475575aC7791D4` |
| PunchCard721 | `0xF60b7Ab3343318004FdF0d79c0562aB5f42f05Ca` |
| PunchAccount implementation | `0x0A7eF0f802FA7AE9618F1DF922cB55bd96665e66` |
| PUNCH (ERC-20, 0dp) | `0x30920d178151Df87fc742A4B33EBf6b8713FbE48` |
| MockUSDG (ERC-20, 6dp, dev stand-in) | `0x39f23A5AF1F47FBeeEC3F0D98a253511a5779F31` |
| ERC-6551 Registry (canonical, pre-existing) | `0x000000006551c19487814612e58FE06813775758` |

- Deployer / owner / treasury / relayer: `0x5a97eF885F4369b52dbb23E7cA2FDAe05fB62e6F` (single key for testnet; key lives ONLY in gitignored `.env.testnet` and `server/.env`)
- Config at deploy: perTxCap `25000000` raw ($25), dailyCap `100000000` raw ($100), punchTarget `10`, maxSupply `500`, MockUSDG float pre-minted to the issuer
- RPC: `https://rpc.testnet.chain.robinhood.com` | Explorer: `https://explorer.testnet.chain.robinhood.com` | Faucet: `https://faucet.testnet.chain.robinhood.com`
- Compiler: solc 0.8.24 via Foundry; source of truth for ABIs: `contracts/abi/*.json`

## Robinhood Chain Mainnet (chainId 4663)

Not deployed yet. For the WALLETCHI mainnet sequence see MAINNET-LAUNCH-RUNBOOK.md. The PUNCHCARD-era rules below are historical:
- Fresh dedicated relayer key + SEPARATE treasury key (do not reuse the testnet key)
- `USDG_ADDRESS` must be the REAL USDG token (resolve from Blockscout / Robinhood docs; never assume decimals, set `USDG_DECIMALS` to match)
- The deploy script does NOT auto-fund the issuer on mainnet: bridge the USDG float via Across (USDC in, USDG out) and transfer it to the CardIssuer before issuing cards
- Registry already exists at the canonical address (verified on-chain 2026-07-24)

## RETIRED: SALMON RUN sidecar | Robinhood Chain Testnet (46630) | redeployed 2026-07-26 with idleCatch (idle layer); first deploy superseded, zero cubs existed

| Contract | Address |
|---|---|
| Runner721 (SALMON RUN / CUB) | `0x152ace1561dfaf4d6efd0ec71944c34bc8600ac5` |
| RunnerIssuer (with idleCatch) | `0x74786b8d1ff74ae72aaf9235c7960ee441ee8941` |
| SALMON (ERC-20, 0dp) | `0xAb170f924302B3a52Ca7881A9346998E79c0eC6c` |
| PunchAccount impl (reused) | `0x0A7eF0f802FA7AE9618F1DF922cB55bd96665e66` |

Relayer/owner: `0x5a97eF885F4369b52dbb23E7cA2FDAe05fB62e6F` (same testnet key). maxSupply 1000. baseURI points at the current tunnel /metadata/runner/ (owner-settable; update on Render cutover).

## WALLETCHI (audited v3 @ 0ff05d8) | Robinhood Chain Testnet (46630) | deployed 2026-07-26 | REHEARSAL PARAMS (superseded by the ACTIVE season in TEST-SEASON.md)
| Contract | Address |
|---|---|
| PetVault | `0x779329aff9a1f87540741625b547da7b584eacf2` |
| PetIssuer | `0x16f42c0a057b0a312152d44b61bd1eb1b73de4e5` |
| Pet721 (WALLETCHI/WCHI) | `0x2d9d472ccb4886cdc3b31d06c75c118ab8e4b01c` |
| MockCareToken (18dp) | `0x5657b35c4fc9c0276bdba803f927b2bbba1ca68e` |
| PunchAccount impl (reused) | `0x0A7eF0f802FA7AE9618F1DF922cB55bd96665e66` |

Rehearsal config: MIN_PLAYERS 3, careCost 1e18, potBps/burnBps 1000/9000, lifeTtl 3600, careCooldown 30, challengeWindow 120, burn sink 0x..dEaD. LIVE economy VERIFIED 2026-07-26: mint pet #1 -> TBA seeded 100e18; care() -> pot 0.1e18, dEaD 0.9e18, TBA 99e18 (90/10 burn/pot from the pet's own account confirmed on-chain). Mainnet: fresh keys, real Pons CARE token, MIN_PLAYERS + challengeWindow per audit conditions.
