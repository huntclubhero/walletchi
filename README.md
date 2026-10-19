# WALLETCHI

A Tamagotchi-style pixel pet that lives in your Apple/Google Wallet. Mint free with just an email. Caring for it costs CARE tokens, split 69% burned, 20% player rewards, 10% into the Pot, 1% push gas. It has five needs (feed, water, play, toy, explore), and if any one goes unserved for 24 hours the pet dies: a pure on-chain clock, permanent, no reap step and no admin. The last pet alive wins the on-chain Pot. On Robinhood Chain (testnet season live).

Prior products in this repo (PUNCHCARD coffee loyalty, SALMON RUN) are RETIRED; their infrastructure is Walletchi's foundation.

## Live

- Site: https://www.playwalletchi.com (Vercel)
- API: https://api.playwalletchi.com (Render)
- Chain: Robinhood Chain (mainnet 4663 target; active testnet season on 46630, live addresses from the API's /api/chain-config)

## Monorepo layout

- contracts/ | Foundry: Pet721, PetIssuer, PetVault, PonsCareToken mirror, transfer validator, ERC-6551 pet accounts
- server/ | Express + Prisma: pass issuance/signing (Apple/Google), APNs push, relayer, mint + care + season APIs, anti-Sybil wall
- web-cub/ | Next.js site: mint, arena (live pot + survivors), pet pages, /claim ownership flow

## Key docs

- WALLETCHI-SPEC.md | the product spec (source of truth)
- AUDIT-REPORT.md | consolidated adversarial security audit
- DEMO-DAY.md | live demo click-path + talking points
- DEPLOYMENTS.md | deployment history (includes retired PUNCHCARD / SALMON RUN sets)
- SPEC.md | HISTORICAL (retired PUNCHCARD spec)

House rule: no em dashes / "--" in any copy anywhere.
