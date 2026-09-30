# WALLETCHI

**An NFT pet that is its own Apple Wallet and Google Wallet pass.** Live state on the card, on-chain actions from the card, no app to install.

- Reference implementation of **[ERC-8426: Wallet Pass Extension](https://github.com/ethereum/ERCs/pull/2036)**, the standard I wrote for binding a token to a platform wallet pass.
- Play the live testnet showcase: **https://www.playwalletchi.com**
- Stack: Solidity (Foundry, ERC-721 + ERC-6551 pet accounts + EIP-7702 smart accounts, sponsored gas), Express + Prisma (Apple/Google pass signing, APNs push, anti-Sybil wall), Next.js.

> Public snapshot of a private working repo, without its history. All rights reserved.

A Tamagotchi-style pixel pet that lives in your Apple/Google Wallet. Mint free with just an email. Caring for it costs real tokens: 90% burned, 10% into the Pot. Neglect is permanent (anyone can reap a lapsed pet, no admin), and the last pet alive wins the entire on-chain Pot. On Robinhood Chain; the current testnet showcase runs 1,000 pets per season.

Prior products in this repo (PUNCHCARD coffee loyalty, SALMON RUN) are RETIRED; their infrastructure is Walletchi's foundation.

## Live

- Site: https://www.playwalletchi.com (Vercel)
- API: https://api.playwalletchi.com (Render)
- Chain: Robinhood Chain (mainnet 4663 target; active testnet season on 46630, addresses in TEST-SEASON.md)

## Monorepo layout

- contracts/ | Foundry: Pet721, PetIssuer, PetVault, PonsCareToken mirror, transfer validator, ERC-6551 pet accounts
- server/ | Express + Prisma: pass issuance/signing (Apple/Google), APNs push, relayer, mint + care + season APIs, anti-Sybil wall
- web-cub/ | Next.js site: mint, arena (live pot + survivors), pet pages, /claim ownership flow

## Key docs

- WALLETCHI-SPEC.md | the product spec (source of truth)
- TEST-SEASON.md | CURRENT active testnet season: addresses, params, cast playbook
- MAINNET-LAUNCH-RUNBOOK.md | push-button mainnet launch sequence
- AUDIT-REPORT.md | consolidated adversarial security audit
- DEMO-DAY.md | live demo click-path + talking points
- DEPLOYMENTS.md | deployment history (includes retired PUNCHCARD / SALMON RUN sets)
- SPEC.md | HISTORICAL (retired PUNCHCARD spec)

House rule: no em dashes / "--" in any copy anywhere.
