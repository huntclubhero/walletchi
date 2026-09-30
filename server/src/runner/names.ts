// WALLETCHI pet names. Every pet gets its OWN name instead of a number.
//
// "No. 0002" is a serial, not a pet. A Tamagotchi you keep alive for weeks and
// grieve when it dies should be called something. This makes the name the pet's
// primary identity everywhere it appears: the wallet pass, the NFT metadata, the
// site, the memorial.
//
// PROVABLY UNIQUE, same technique as traits.ts. The name space is
// FIRST(64) x SECOND(40) = 2,560 combinations against a 2,000 supply, and tokenId
// maps into it by an AFFINE PERMUTATION: idx = (id * 1597 + 733) mod 2560. 1597 is
// coprime to 2560 (2560 = 2^9 * 5; 1597 is an odd prime, not a multiple of 5), so
// the map is a bijection over Z_2560. Distinct tokenIds therefore ALWAYS produce
// distinct name pairs; no collision is possible within the supply, and no registry
// or reservation is needed. The multiplier also scatters neighbours, so pets minted
// back to back read as unrelated rather than marching down an alphabet.
//
// DERIVED, NOT STORED. The name is a pure function of tokenId, so it needs no
// storage, exists before the pet is minted, survives any database reset, and can be
// recomputed by anyone from the tokenId alone. That last property is what makes it
// honest to publish in the NFT metadata: a holder can verify their pet's name
// without trusting our server.

/** 64 first names: soft, cute, a bit odd. Chosen to read well beside any second name. */
const FIRST = [
  "Pip", "Mossy", "Bramble", "Tuck", "Waffle", "Pebble", "Nim", "Bodhi",
  "Juno", "Maple", "Clove", "Fennel", "Widget", "Pickle", "Sprout", "Tansy",
  "Bilberry", "Nubbin", "Cricket", "Marlow", "Poppy", "Rooster", "Tilly", "Bugsy",
  "Cinder", "Dandy", "Fig", "Gumbo", "Hopper", "Indigo", "Jelly", "Kettle",
  "Lumen", "Mango", "Noodle", "Otto", "Plum", "Quill", "Rusty", "Sable",
  "Truffle", "Umber", "Vesper", "Wren", "Yarrow", "Zuzu", "Biscuit", "Cobble",
  "Dizzy", "Ember", "Flint", "Ginger", "Haze", "Ivy", "Jasper", "Kip",
  "Lolly", "Moth", "Nutmeg", "Olive", "Peanut", "Rune", "Sorrel", "Thistle",
] as const;

/** 40 second names: a little grander, so the pair lands like a proper name. */
const SECOND = [
  "Bumble", "Fern", "Glimmer", "Hollow", "Meadow", "Nimbus", "Puddle", "Quartz",
  "Ripple", "Sparrow", "Thicket", "Willow", "Amber", "Brook", "Cobalt", "Drift",
  "Echo", "Frost", "Grove", "Harbour", "Lantern", "Marble", "Nettle", "Orchard",
  "Pinecone", "Quiver", "Reed", "Shadow", "Tumble", "Velvet", "Whisker", "Zephyr",
  "Acorn", "Blossom", "Clover", "Dapple", "Feather", "Honey", "Juniper", "Lichen",
] as const;

const SPACE = FIRST.length * SECOND.length; // 2,560 > the 2,000 supply
const MULTIPLIER = 1597; // coprime to 2560, so id -> idx is a bijection
const OFFSET = 733;

/**
 * This pet's name. Pure, deterministic, unique across the supply, and computable
 * before the pet exists. Falls back to a stable placeholder for a missing id so no
 * caller ever has to null-check.
 */
export function petName(tokenId: string | number | null | undefined): string {
  const id = Number(tokenId);
  // isInteger, not isFinite: "1.5" is finite and positive, so it passed, and then a fractional
  // index read off the end of the table and rendered the literal string "Sprout undefined". The
  // non-null assertions below hid it from the type checker. tokenIds come from the DB as strings.
  if (!Number.isInteger(id) || id <= 0) return "A WALLETCHI";
  const idx = (id * MULTIPLIER + OFFSET) % SPACE;
  const first = FIRST[Math.floor(idx / SECOND.length)]!;
  const second = SECOND[idx % SECOND.length]!;
  return `${first} ${second}`;
}

/** The name space, so a uniqueness proof can assert against it. */
export const NAME_SPACE = SPACE;

/**
 * The uniqueness claim published in every pet's NFT metadata holds ONLY while the supply fits
 * inside the name space. Nothing else ties the two together: raise RUNNER_SUPPLY_CAP past 2,560
 * and the affine map wraps, so id 2561 silently becomes a duplicate of id 1 and two holders own
 * pets with the same name. That is a claim we made on-chain, so it fails loudly at boot rather
 * than at the 2,561st mint.
 */
export function assertNameSpaceCovers(supplyCap: number): void {
  if (supplyCap > SPACE) {
    throw new Error(
      `RUNNER_SUPPLY_CAP ${supplyCap} exceeds the ${SPACE}-name space: pet names would collide. ` +
        `Add first or second names before raising the supply.`,
    );
  }
}
