import { API_URL } from "./config";
import { robinhoodChain } from "./chain";

// The explorer for the chain this build actually runs on. This used to be the
// TESTNET explorer, hardcoded, while lib/chain.ts already picked mainnet or
// testnet from NEXT_PUBLIC_ROBINHOOD_NETWORK. A mainnet build would therefore
// have sent every visitor who clicked "see the collection" or "explore the
// chain" to a testnet explorer, where the mainnet collection does not exist and
// whatever sits at that address on testnet does. Same failure as the Uniswap
// deep-link: a wrong-chain out-link nobody notices, because nothing breaks.
const EXPLORER = robinhoodChain.blockExplorers.default.url;

// The pet NFT collection we ADVERTISE. Env-driven on purpose: this used to be a hardcode, and it
// drifted a whole season behind without anything failing. The site kept transacting against the
// correct vault while telling every visitor the collection lived at a dead address from an earlier
// season ("WALLETCHI TEST SEASON" / tWCHI), because a stale display string breaks nothing at
// runtime. Reading the same env the deploy already sets means a season change cannot leave the
// two out of step.
//
// THERE IS NO FALLBACK ADDRESS, on purpose. A hardcoded default is a plausible-looking wrong
// answer the moment the season rolls: it invites a visitor to copy it, verify it, or send to it.
// An unset env renders an honest "not configured" state instead. Callers must check
// PET721_CONFIGURED before showing the value.
export const PET721_ADDRESS = process.env.NEXT_PUBLIC_PET721_ADDRESS?.trim() || "";
export const PET721_CONFIGURED = /^0x[0-9a-fA-F]{40}$/.test(PET721_ADDRESS);

// Single source of truth for the brand. The founder may rename the product; change it here only.
// MINTING SWITCH. Closed by default (2026-10-14: the season ran through the sign-in provider's user
// cap). Reopen by setting NEXT_PUBLIC_MINT_OPEN=1 on Vercel and redeploying. Closed hides every
// "Get my pet" button and swaps the mint form for a thank-you card; existing keepers keep sign-in,
// My pets, and their wallet cards.
export const MINT_OPEN = (process.env.NEXT_PUBLIC_MINT_OPEN?.trim() || "") === "1";

// FINAL FORM SWITCH. The fifth evolution stage (a dragon, a koi, an owl: one of 28 forms past
// PRIME). Off until the API has FORMS_ENABLED on; set NEXT_PUBLIC_FORMS=1 on Vercel with it so the
// evolution row and the how-to line show the fifth stage (the API ignores ?stage=4 while it is off).
export const FORMS_ON = (process.env.NEXT_PUBLIC_FORMS?.trim() || "") === "1";

export const BRAND = {
  name: "WALLETCHI",
  tagline: "An NFT that is its own Apple Wallet or Google Wallet pass. A live testnet demo of ERC-8426, the wallet pass standard.",
  pet: "pet",
  supply: 1000, // mirrors MAX_SUPPLY in contracts/script/showcase.env (Testnet Experience)
  chainName: "Robinhood Chain",
  explorer: EXPLORER,
  contract: PET721_ADDRESS,
  // Null when the collection address is not configured: a link to
  // /address/ (or to a stale season) is worse than no link.
  contractExplorer: PET721_CONFIGURED ? `${EXPLORER}/address/${PET721_ADDRESS}` : null,
};

// ------------------------------------------------------------ testnet experience
// WALLETCHI will not launch on mainnet. This site is the public Testnet Experience: a live demo
// of the wallet pass standard below, on Robinhood Chain testnet, with tokens that have no value.
// The label is said ONCE, in the site chrome (TestnetBar), not sprinkled as caveats.
export const TESTNET = {
  label: "Testnet Experience",
  line: "Runs on Robinhood Chain testnet. Every token here is fake and has no value. This is a live demo of ERC-8426, the wallet pass standard.",
};

// The standard this site demonstrates, and where it is being discussed.
export const ERC = {
  // Assigned by the ERC editors 2026-09-28. Status is Draft until the editors move it on.
  number: "ERC-8426",
  status: "Draft",
  title: "Wallet Pass Extension for NFTs",
  // ERC-165 id. Pet721 implements it (supportsInterface returns true; SeasonConfig 1b0ee1d).
  interfaceId: "0xef5f1e71",
  // The published spec (live since the PR merged as Draft 2026-10-24), and its source in ethereum/ERCs.
  specUrl: "https://ercs.ethereum.org/ERCS/erc-8426",
  specSourceUrl: "https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8426.md",
  // PR #2036 merged into ethereum/ERCs master 2026-10-24T06:06:23Z (eip-review-bot auto-merge after
  // the editor approval). The label is written in EST by Hunt's call.
  mergedAt: "2026-10-24T06:06:23Z",
  mergedLabel: "Oct 24, 2026 · 2:06 AM EST",
  discussionUrl:
    "https://ethereum-magicians.org/t/erc-8426-wallet-pass-extension-for-nfts/29358",
};

// The ERC pull request (ethereum/ERCs #2036, opened 2026-09-25, numbered ERC-8426 on 2026-09-28). Setting it shows the PR links.
export const ERC_PR_URL: string | null = "https://github.com/ethereum/ERCs/pull/2036";

// The reference SDK and demo (github.com/huntclubhero/erc8426-sdk): @erc8426/core, client, issuer,
// apple, react and conformance on npm. No version number here on purpose: it would drift the day
// after the next publish, and the npm page always says the current one.
export const ERC_SDK = {
  npm: "https://www.npmjs.com/org/erc8426",
  repo: "https://github.com/huntclubhero/erc8426-sdk",
  demo: "https://erc8426-demo.vercel.app",
  docs: "https://github.com/huntclubhero/erc8426-sdk/blob/main/docs",
};

// The WALLETCHI source, public snapshot on GitHub. Not "the reference implementation": the ERC names its own
// (assets/eip-8426 in ethereum/ERCs); WALLETCHI is a live implementation.
export const WALLETCHI_SOURCE = "https://github.com/huntclubhero/walletchi";

// Apple / Google platform credentials, as DISPLAYED. Live-checked 2026-09-22 (team-lead) against
// Google's Wallet API (issuer approved; pass class reviewStatus=approved) and the production Apple
// Pass Type ID certificate (expires 2027-08-23).
//
// MASKED STRINGS ONLY. The full IDs never ship to the client bundle: this file is the only copy,
// and it holds the masked form. Each mask keeps the TRUE length (one dot per hidden character).
//
// WORDING LAW: Apple has NO pass review. The honest Apple claim is the certificate Apple ISSUED.
// Never write "approved", "verified" or "certified" next to Apple. Google did approve both the
// issuer account and the pass class, so "approved" is correct there and only there.
export const PLATFORM_CREDENTIALS = {
  checkedOn: "Sep 22, 2026",
  apple: {
    platform: "Apple Wallet",
    claims: ["Apple-issued Pass Type ID certificate"],
    rows: [
      { label: "Team ID", value: "H97••••53A", mono: true }, // 10 chars, middle 4 masked
      { label: "Pass Type ID", value: "pass.com.halldon.•••••••••", mono: true }, // last segment masked
      { label: "Valid through", value: "Aug 2027", mono: false },
    ],
  },
  google: {
    platform: "Google Wallet",
    claims: ["Issuer approved by Google", "Pass class approved"],
    rows: [
      { label: "Issuer ID", value: "3388•••••••••••5037", mono: true }, // 19 chars, first 4 + last 4
      { label: "Pass class", value: "Approved", mono: false },
      { label: "Status", value: "Active", mono: false },
    ],
  },
} as const;

// The showcase season AS DISPLAYED. Mirrors contracts/script/showcase.env (LIFE_TTL, STARTER_TOKENS,
// ENTRY_WINDOW_SECS / MIN_SEASON_DURATION, MIN_PLAYERS). If a redeploy changes any of them, change
// it here ONLY: every page reads these. Hunt may still move the need clock to 48h.
export const SEASON = {
  needClockHours: 24,
  starterCare: 1495,
  // Cares per rolling 24h a LAUNCH-WEEK pet's account allows (WalletchiAccount.dailyCap / careCost,
  // baked in at mint; verified on-chain 2026-10-17 for pets No. 1 to 162). Pets minted after that
  // are effectively uncapped; the care page reads the real limit from the API and only falls back
  // to this. Future launches mint with 500.
  dailyCares: 20,
  // The last pet number that carries the launch-week cap and the FINAL FORM shortcut
  // (FORMS_LEGACY_MAX_TOKEN=162 on Render, FINAL-FORMS.md "Mint-day plan").
  legacyMaxToken: 162,
  rosterDays: 60,
  minPlayers: 3,
};

// Evolution AS DISPLAYED. Mirrors the server defaults in server/src/config.ts (STAGE2_*, STAGE3_*,
// STAGE4_*) and FINAL-FORMS.md; a pet advances on EITHER enough cares OR enough days. Change it
// here only if Render overrides the defaults.
export const EVOLUTION = {
  grownCares: 10,
  grownDays: 3,
  primeCares: 30,
  primeDays: 10,
  formCares: 60,
  formDays: 21,
  forms: 28,
  families: 8,
};

// Care reminders AS DISPLAYED (server/src/runner/reminders.ts, CHECKIN_HOURS / LAST_CHANCE_HOURS in
// config.ts): a check-in when the weakest need has this long left, then one last chance.
export const REMINDERS = {
  checkInHours: 8,
  lastChanceHours: 2,
};
/** Days the starter float lasts at the MINIMUM upkeep: one 1-CARE care per need per clock. */
export const STARTER_DAYS = Math.floor(SEASON.starterCare / (5 * (24 / SEASON.needClockHours)));
/** "24 hour" / "48 hour" for prose; "24h" for LCD labels. */
export const NEED_CLOCK_LABEL = `${SEASON.needClockHours} hour`;

// External systems the player uses themselves. We never swap or custody: these are out-links.
// CARE launches on letscash.fun (Robinhood Chain), paired against USDG.
export const OUT_LINKS = {
  across: "https://across.to",
  uniswap: "https://app.uniswap.org/swap",
  letscash: "https://letscash.fun",
};

// The care token address. Set on every season INCLUDING testnet, where it points at a MOCK
// token, so it means "we have an address to read balances with", NOT "this token trades".
export const CARE_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_CARE_TOKEN_ADDRESS?.trim() || "";

// Is CARE actually LAUNCHED and tradeable? Deliberately a SEPARATE, explicit opt-in and NOT
// derived from the address. Deriving it burned us: a testnet season sets the address to a mock,
// which flipped every "token launching soon" guard OFF and published a live swap deep-link for a
// token that exists only on Robinhood testnet. Uniswap's app does not support chain 46630, so that
// link resolved against ETHEREUM MAINNET and pointed real money at whatever contract happens to
// sit at that address there. An out-link that can spend real funds must never be inferred.
// Flip NEXT_PUBLIC_CARE_TOKEN_LAUNCHED=true only when CARE is genuinely live on letscash.fun.
export const CARE_TOKEN_LAUNCHED =
  (process.env.NEXT_PUBLIC_CARE_TOKEN_LAUNCHED?.trim() || "").toLowerCase() === "true";
export const CARE_TOKEN_READY = CARE_TOKEN_LAUNCHED && CARE_TOKEN_ADDRESS.length > 6;

/**
 * Where a keeper buys CARE. CARE launches on letscash.fun (Uniswap v4 pool-level tax), so the
 * venue is letscash, never the Uniswap app: nothing in this game routes through it, and its
 * interface does not support Robinhood Chain. Pre-launch this is the plain letscash home page.
 */
export function careSwapUrl(): string {
  return CARE_TOKEN_READY ? `${OUT_LINKS.letscash}/token/${CARE_TOKEN_ADDRESS}` : OUT_LINKS.letscash;
}

/** @deprecated Kept as an alias so no call site can resurrect the mainnet-Uniswap deep-link. */
export function uniswapSwapUrl(): string {
  return careSwapUrl();
}

/** letscash.fun token page once the token address is known. */
export function letscashTokenUrl(): string {
  return CARE_TOKEN_READY ? `${OUT_LINKS.letscash}/token/${CARE_TOKEN_ADDRESS}` : OUT_LINKS.letscash;
}

// -------------------------------------------------------------------- pet image
// server-dev2's canonical square (800x800) portrait renders. All share one renderer, so they
// always match the wallet pass + metadata. These light up when :8080 ships the build carrying
// them; until then the UI falls back to canonical-hue pixel swatches.
//   - a user's own minted pet (reflects live mood + toys): by SERIAL.
//   - any pet, public + pre-mint (branded tile, number, rarity badge): by TOKENID.
export function petImageUrl(serial: string): string {
  return `${API_URL}/api/runner/${encodeURIComponent(serial)}/portrait.png`;
}

export function petPortraitByToken(tokenId: string | number): string {
  return `${API_URL}/api/pet/${encodeURIComponent(String(tokenId))}/preview.png`;
}
