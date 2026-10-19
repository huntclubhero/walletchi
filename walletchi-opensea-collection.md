# WALLETCHI: OpenSea collection description + settings

Paste this into the OpenSea collection **Description** (and adapt for the bio). Set **Royalties** in OpenSea collection settings too (see below).

---

## Collection description (paste to OpenSea)

WALLETCHI is a virtual pet that lives in your Apple or Google Wallet. 2,000 pets. No two alike. Every pet is a real on-chain NFT with its own account, and it is alive: it gets hungry, it can be fed, played with, and cared for, and if it is neglected it dies. The last pet alive wins the whole Pot.

BUYING ON SECONDARY? Read this, it matters.

1. Your pet has a LIVE state. Check its traits before you buy: Status (Alive / Critical / Dead), Life Left, Days Lived, and Care Count. A pet that is Critical is hours from dying unless it is fed. A DEAD pet is a soulbound memorial: it can never be transferred or sold again, so never buy a dead one expecting to move it.
2. Metadata here can lag. OpenSea caches; the ALWAYS-LIVE truth is the pet's own page at www.playwalletchi.com/pet/<id> and the on-chain state. Check the live page before you pay.
3. After you buy: claim your pet's wallet pass at www.playwalletchi.com/claim. Connect the wallet that owns the pet (or enter your email) to prove ownership, and you get an Add to Apple Wallet / Google Wallet link. Your pet keeps all its history: its stats, its care, everything. It does not reset and it will not die from being sold.
4. Then KEEP IT ALIVE. Feed it, water it, play with it from the card in your wallet. Neglect is permanent. Outlast every other pet and the Pot is yours.

Free to hatch. Yours to keep alive. On Robinhood Chain.

---

## OpenSea settings to configure (Hunt)

- ROYALTIES: set a creator royalty (suggest 5%) to your recipient address in OpenSea collection settings. NOTE (honest): OpenSea deprecated forced/on-chain royalty enforcement (Operator Filter, 2023); royalties are marketplace-honored, not hard-enforced. We also add ERC-2981 on-chain royalty info (the standard signal OpenSea reads). This is the realistic maximum in 2026: do NOT expect 100% enforcement, and do NOT block marketplaces (deprecated + would require re-auditing the frozen contracts + breaks legit transfers).
- Collection image / banner: the WALLETCHI mark + a few showcase pets.
- Links: website https://www.playwalletchi.com, the /how-to page.
- Category: collectibles / gaming.

## Notes for us (not for OpenSea)
- Live status attributes are emitted by /metadata/runner/:tokenId from on-chain state; we trigger OpenSea's metadata-refresh on death + critical transitions so the display catches up.
- Dead pets are non-transferable at the contract level (soulbound memorial): any sale reverts.
- The /claim flow verifies on-chain ownership (WalletConnect/SIWE or email) and rotates the pass authToken so a previous owner's pass can no longer control the pet.
