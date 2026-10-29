# WALLETCHI

A pixel pet that lives in your Apple Wallet or Google Wallet. Mint with just an email, add the card, and tap the back of it to feed, water, play, give a toy or explore. Miss a need for 24 hours and your Chi dies for real: the clock is on chain, nobody can reap it, nobody can save it. The last Chi alive wins the Pot.

Care costs CARE tokens, split 69% burned, 20% player rewards, 10% into the Pot, 1% push gas. Gas is sponsored, so a tap on the card is just a tap.

The testnet season on Robinhood Chain sold out all 1,000 Chis. The mint is closed for good. The ones still alive are the ones people actually kept alive.

## What's on the back of the card

- **CHI SHOT** | a slingshot arcade game, your Chi drawn from its own traits.
- **CHI NIGHT** | a bullet heaven. Survive the night.
- **CHI VALLEY** | a shared valley where your Chi walks around in its real art.
- **CHI CHAT** | one room for every living Chi. Opens only from the pass of a living pet. No pass, no door.
- **Photo album** | banner, PFP, wallpaper, poster and class photo of your Chi. Save and post.

CHI SHOT, CHI NIGHT, the album and the chat never read or write tokens or the chain. Fun is fun, money is money, and a game bug can never kill a pet.

## ERC-8426

The pass is built on ERC-8426, Wallet Pass Extension for NFTs: a standard way for an NFT to carry an Apple or Google Wallet pass, gated to whoever owns the NFT right now. Merged as a Draft into ethereum/ERCs ([PR #2036](https://github.com/ethereum/ERCs/pull/2036)). SDK and conformance tests: [huntclubhero/erc8426-sdk](https://github.com/huntclubhero/erc8426-sdk).

## Live

- Site: https://www.playwalletchi.com
- API: https://api.playwalletchi.com
- Chain: Robinhood Chain testnet (46630). Live addresses come from the API at /api/chain-config.

## Layout

- `contracts/` | Foundry: Pet721, PetIssuer, PetVault, PonsCareToken mirror, transfer validator, ERC-6551 pet accounts.
- `server/` | Express + Prisma: Apple and Google pass signing, APNs push, relayer, mint, care, season, rewards, the games, the album, the chat, the anti-Sybil wall.
- `web-cub/` | Next.js site: mint, arena, pet pages, /me, claim flow.

## Read

- [docs/FIELD-NOTES.md](docs/FIELD-NOTES.md) | what broke in production, why, and the fix.
- [WALLETCHI-SPEC.md](WALLETCHI-SPEC.md) | the product spec.
- [WALLETCHI-AA-SPEC.md](WALLETCHI-AA-SPEC.md) | owner-signed, gas-sponsored care, and why there is no care relayer.
- [AUDIT-REPORT.md](AUDIT-REPORT.md) | the adversarial security audit.
- [server/CHI-CHAT.md](server/CHI-CHAT.md) | how the chat door works.
- [CHI-VALLEY-LINK.md](CHI-VALLEY-LINK.md) | how a pass link becomes a valley join token.
- [SPEC.md](SPEC.md) | history: this repo started as PUNCHCARD, a coffee loyalty card. Then SALMON RUN. Then this.

This is a snapshot of a private repo. It does not auto-sync and there is no history. Deploys run from the private one.

House rule: no em dashes in any copy, anywhere.
