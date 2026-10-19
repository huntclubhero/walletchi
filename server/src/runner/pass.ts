import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { PKPass } from "passkit-generator";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Runner } from "../store/types.js";
import { loadPassCertificates } from "../passes/certs.js";
import { shortHex } from "../util/format.js";
import { petPassImages, petPosterImages } from "./pet.js";
import { RUNNER_THEME, MEMORIAL_COPY, TESTNET_COPY, runnerNumber, timeOfDayFor, statusThemeFor } from "./theme.js";
import { petName } from "./names.js";
import { signTag, actionPayload, passDownloadCap } from "./sign.js";
import { isAlertLine } from "./reminders.js";
import { moodFor, moodLine, needsInline, dbNeedPct, minNeedSecondsLeft } from "./needs.js";
import { petVisualFor } from "./stage.js";
import { survivorLine, memorialLivedDays, outlastedFromRank, formatCareToken, getSeasonSnapshot, passStatsFrom, headcountVerified } from "./season.js";
import { SETUP_NUDGE_COPY } from "./setup-nudge.js";
import { gameEnabledFor, gameUrl, GAME_TITLE } from "./game.js";
import { nightEnabledFor, nightUrl, NIGHT_TITLE } from "./night.js";
import { memorialLineEnabledFor, memorialLineValue } from "./memorial-line.js";
import { albumEnabledFor, albumNoteMode, albumUrl, ALBUM_TITLE, ALBUM_NOTICE, ALBUM_PRIME } from "./album.js";

// LOCK SCREEN WARNING (Hunt, 2026-10-09/10). The card surfaces on the lock screen
// only in the last LOCK_SCREEN_WARNING_HOURS before the pet dies, from the SAME
// chain countdown the SURVIVES field shows. iOS 18+ reads `relevantDates` (the
// window); iOS 17 and older read the single `relevantDate` (the window's start).
// No chain countdown, a memorial or the champion: no lock-screen date at all,
// never a guessed one. The old "7am" morning pop-up is gone by ruling: it was
// computed in the server's timezone (UTC), i.e. 3am Eastern.
export const LOCK_SCREEN_WARNING_HOURS = 3;
const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
export function relevantDatesFor(
  nowMs: number,
  lifeSecondsLeft: number | null,
): { startDate: string; endDate: string }[] {
  if (!lifeSecondsLeft || lifeSecondsLeft <= 0) return [];
  const deadline = nowMs + lifeSecondsLeft * 1000;
  const start = Math.max(nowMs, deadline - LOCK_SCREEN_WARNING_HOURS * 3600_000);
  return [{ startDate: isoSeconds(start), endDate: isoSeconds(deadline) }];
}

// iOS 27 POSTER GENERIC gate. The pass carries a `posterGeneric` dictionary next
// to its `storeCard` one only for pets this says yes to; everything else is the
// pass exactly as before. Rollout order: the serial allowlist (Hunt's own pet,
// then an iOS 27 tester whose screenshot is the approval), then the global flag.
// iOS 26 and earlier ignore the poster dictionary and keep rendering the storeCard.
const POSTER_SERIALS: ReadonlySet<string> = new Set(
  (config.POSTER_GENERIC_SERIALS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);
export function posterEnabledFor(runner: Pick<Runner, "serial">): boolean {
  return config.POSTER_GENERIC_ENABLED || POSTER_SERIALS.has(runner.serial);
}

// Care link on the pass back. SILENT CARE: this opens a server endpoint that submits care() with the
// pet's ON-CHAIN SCOPED session key, so a tap feeds the pet with no website and no signature. The GET is
// side-effect free (it only decides where the tap goes) and hands off to a POST for the actual care.
//
// The link is the same HMAC capability as before (bound to the pet's authToken, rotates on a claim), and
// it is stable whether or not a session is installed: when there is no usable session the GET 302s to the
// owner-signed web care page, which is the proven fallback. That means pass links never need rebuilding
// when a keeper turns silent care on or off.
//
// AUTHORITY NOTE: the HMAC is a capability to ASK, not authority to spend. The actual spending authority
// is the session key's on-chain scope (care() on the PetVault only), plus a fresh ownerOf check on the
// POST. This is NOT the retired confused-deputy relay, which held an unrestricted key.
export function actionUrl(serial: string, authToken: string, action: string, src = "apple"): string {
  const sig = signTag(authToken, actionPayload(serial, action));
  return `${config.PUBLIC_BASE_URL}/api/runner/${serial}/care/${action}?s=${sig}&src=${src}`;
}

// The rewards link that used to sit on the pass back. RETIRED with the claim it
// triggered (season 2 pushes rewards instead), so nothing builds a NEW pass with
// it. It stays exported and unchanged because passes ALREADY IN WALLETS still
// carry the URL it produced, and the route it points at now answers with a
// friendly explainer rather than 404. Delete it only once no live pass can hold
// one of these links.
export function rewardsCollectUrl(serial: string, authToken: string, src = "apple"): string {
  const sig = signTag(authToken, actionPayload(serial, "rewards-collect"));
  return `${config.PUBLIC_BASE_URL}/api/runner/${serial}/rewards/collect?s=${sig}&src=${src}`;
}

interface Field {
  key: string;
  label?: string;
  value: string;
  changeMessage?: string;
  attributedValue?: string; // tappable link markup on the pass back
  // Date-field trio. With isRelative Apple renders the value as a LIVE
  // countdown on the device ("in 18 hr"), redrawn by the OS, so a time-based
  // field stays honest between pushes and costs nothing to keep fresh.
  dateStyle?: string;
  timeStyle?: string;
  isRelative?: boolean;
}

export interface AssembledRunnerPass {
  passJson: Record<string, unknown>;
  images: Record<string, Buffer>;
}

// Options for pass assembly. `transferred` renders the keepsake served to a
// PREVIOUS owner after a claim rotated the auth token: no live meters, no care
// links, and the pass carries `authTokenOverride` (the OLD token the device
// presented) so the rotated token is never leaked to the prior owner.
// `needPct` is the five per-need meter percents (canonical actionType order),
// CHAIN-DERIVED by the caller via season.ts petNeedPctFor when the season is
// live and the pet is alive; absent (or null) the DB meters stand in.
// `needSecondsLeft` is the matching per-need countdown (petNeedSecondsLeftFor);
// when present the combined NEEDS field shows real time, else percents.
// `careBalance` is the pet's LIVE TBA token balance, pre-formatted number-first
// ("98 CARE") by the caller via season.ts petCareBalanceFor (the callers hold
// the ctx/relayer; this assembler stays chain-free). null/absent = the read
// failed or the pet cannot truthfully show one: the field is simply omitted
// (never a wrong "0 CARE").
export interface RunnerPassOptions {
  transferred?: boolean;
  /** Why the keepsake exists. "transfer" (default) after a sale; "reset" after the OWNER asked for
   *  their links to rotate, in which case the card must not claim the pet moved. */
  keepsakeReason?: "transfer" | "reset";
  authTokenOverride?: string;
  needPct?: number[] | null;
  needSecondsLeft?: number[] | null;
  careBalance?: string | null;
  /** Show the FINISH SETUP back field (runner/setup-nudge.ts). The caller decides; default off. */
  setupNudge?: boolean;
  /** The ALIVE header value. Absent (undefined) = the live survivorLine() exactly as before; the
   *  Apple pass callers pass runner/pass-memory.ts's value, which is the fresh verified line or,
   *  when that is not ready, the last line that WAS verified on-chain. null omits the field. */
  aliveLine?: string | null;
  /** The last known SURVIVES value (the ISO deadline a previous pass carried), used ONLY when the
   *  fresh countdown read FAILED (runner/pass-memory.ts decides that). It keeps the field on the
   *  card instead of dropping it; it never drives the lock-screen relevantDates. */
  lifeFallback?: string | null;
  /** The ACTIVE one-time announcement (runner/announce.ts), supplied by stablePassInputs. The
   *  event line carries changeMessage "%@" only while its value equals this text. */
  announcement?: string | null;
}

/** The SURVIVES field value: the deadline as an ISO string at whole seconds. */
export function lifeDeadlineValue(nowMs: number, lifeSecondsLeft: number): string {
  return isoSeconds(nowMs + lifeSecondsLeft * 1000);
}

export function runnerPlayUrl(serial: string): string {
  return `${config.PUBLIC_BASE_URL}/game/${serial}`;
}

// Canonical capability download URL for the .pkpass. The cap segment is
// unguessable without the pet's authToken and rotates with it on a claim, so
// only surfaces that have PROVEN ownership (mint email, claim response) may
// emit this URL. Never emit it on a public serial-keyed endpoint while
// real-value care is possible.
export function runnerPassDownloadUrl(serial: string, authToken: string): string {
  return `${config.PUBLIC_BASE_URL}/runner-passes/${serial}/${passDownloadCap(authToken)}.pkpass`;
}

// Build the WALLETCHI pet pass.json + images. The strip is the living pixel-pet
// scene; the pass back carries the five HMAC-signed care action links.
export async function assembleRunnerPass(
  runner: Runner,
  opts: RunnerPassOptions = {},
): Promise<AssembledRunnerPass> {
  const now = new Date();
  const mood = moodFor(runner, now);
  // The explicit STATUS word + the pass ground/label colors derive from the SAME
  // mood as the scene art, so the word, the color, and the artwork always agree.
  const statusTheme = statusThemeFor(mood, runner.won);
  // Stats band on the strip (flag-gated: the env flip is the art-approval
  // switch). Memorials keep their dignity: no ticker over a gravestone.
  const snap = getSeasonSnapshot();
  const stripStats =
    config.STATS_BAND_ENABLED && headcountVerified(snap) && !runner.gone ? passStatsFrom(snap) : undefined;
  // Evolution stage sizes the strip pet (flag-off / memorial -> today's render).
  const vis = petVisualFor(runner, now);
  const images = await petPassImages({ mood, toys: runner.toys, timeOfDay: timeOfDayFor(now), seed: runner.tokenId ?? runner.serial, stats: stripStats, stage: vis.stage, shellCap: vis.shellCap });
  // Poster face (iOS 27) for gated pets: the artwork + primary logo join the bundle
  // and the icon moves to Apple's current 38 pt size. Flag off: nothing changes.
  const poster = posterEnabledFor(runner);
  if (poster) {
    Object.assign(images, await petPosterImages({ mood, toys: runner.toys, timeOfDay: timeOfDayFor(now), seed: runner.tokenId ?? runner.serial, stage: vis.stage, shellCap: vis.shellCap }));
  }
  const number = runnerNumber(runner.tokenId, runner.serial);
  const petId = number.replace(/^No\.\s*/, "");
  // The pet's own name, derived from tokenId (runner/names.ts). A number is a receipt; this is the
  // thing the keeper is trying to keep alive, so it leads. The number stays beside it because
  // collectors care about it, and a pre-mint pet with no tokenId still gets a sensible fallback.
  const name = petName(runner.tokenId);
  const link = (action: string, label: string): Field => ({
    key: action,
    label: label.toUpperCase(),
    value: label,
    attributedValue: `<a href="${actionUrl(runner.serial, runner.authToken, action)}">${label}</a>`,
  });

  // Keepsake for a RETIRED auth token: static card, no live meters, no care
  // links, and never the current (rotated) auth token. Two reasons, two truths:
  // after a sale the previous owner reads TRANSFERRED; after the owner's own
  // "reset my pass links" the SAME owner still holds this card, so it says the
  // links were reset and points them at the fresh card instead.
  if (opts.transferred) {
    const reset = opts.keepsakeReason === "reset";
    const keepsakeCopy = reset
      ? {
          status: "LINKS RESET",
          frontLabel: "RESET",
          front: "You reset this card's links. Add the fresh card from your account.",
          backLabel: "Links reset",
          back:
            "You asked for this pet's pass links to be reset, so this card is now a keepsake and its buttons no longer work. Sign in to your account page and add the fresh card.",
        }
      : {
          status: "TRANSFERRED",
          frontLabel: "FAREWELL",
          front: "This pet has moved to a new wallet.",
          backLabel: "Transferred",
          back: "This pet was claimed by its new owner, so this pass is now a keepsake. Care actions no longer work from here.",
        };
    const transferredJson: Record<string, unknown> = {
      formatVersion: 1,
      passTypeIdentifier: config.PASS_TYPE_ID,
      teamIdentifier: config.APPLE_TEAM_ID,
      serialNumber: runner.serial,
      organizationName: config.ORGANIZATION_NAME,
      description: RUNNER_THEME.description,
      foregroundColor: "rgb(234,243,245)",
      backgroundColor: "rgb(14,42,58)",
      labelColor: "rgb(249,143,118)",
      webServiceURL: `${config.PUBLIC_BASE_URL}/runner-apple`,
      authenticationToken: opts.authTokenOverride ?? "rotated",
      sharingProhibited: true,
      storeCard: {
        headerFields: [{ key: "petno", label: "NO.", value: petId }],
        // No name banner: the pet's name lives in its NFT metadata and on the
        // pass back, not stamped across the art.
        primaryFields: [],
        secondaryFields: [
          { key: "status", label: "STATUS", value: keepsakeCopy.status, changeMessage: RUNNER_THEME.statusChangeMessage },
        ],
        auxiliaryFields: [
          { key: "farewell", label: keepsakeCopy.frontLabel, value: keepsakeCopy.front },
        ],
        backFields: [
          {
            key: "transferredNote",
            label: keepsakeCopy.backLabel,
            value: keepsakeCopy.back,
          },
          { key: "serialBack", label: "Serial", value: runner.serial },
        ],
      },
    };
    if (poster) {
      // Same keepsake on the poster face: NO. in the header, the STATUS word as the
      // one primary field, the farewell line as the footer, the same back.
      const sc = transferredJson.storeCard as Record<string, Field[]>;
      transferredJson.posterGeneric = {
        headerFields: sc.headerFields,
        primaryFields: sc.secondaryFields,
        footerFields: sc.auxiliaryFields,
        backFields: sc.backFields,
      };
    }
    return { passJson: transferredJson, images };
  }

  // A gone pet's card becomes the memorial: the front carries its lived days + an
  // "in memory" line instead of live meters. An alive pet's header also carries the
  // live survivor count ("ALIVE N / pets in the race"), which piggybacks on care pushes.
  // Header labels stay short ("NO.", "ALIVE"): the full WALLETCHI wordmark is the
  // logo image, and a wide header label makes Apple crop it ("WALLETCh...").
  // The pet's live CARE balance rides the HEADER row (living pets only). Why
  // here: Apple caps a storeCard's secondary + auxiliary fields at FOUR total
  // and SILENTLY DROPS overflow, and the five-needs layout deliberately keeps
  // the secondary row to STATUS + the ONE combined NEEDS field so nothing can
  // be squeezed or truncated away; a third field there would crowd exactly the
  // row that fix protects. Header fields cap at THREE (never dropped: Apple
  // narrows the logo instead), and this is exactly the third slot
  // (petno + alive + carebal), so it is guaranteed visible. Memorials and
  // champions keep their single NO. header (a gravestone has no bank ticker;
  // the winner card celebrates the pot instead). It carries NO changeMessage
  // (see below), so a balance change raises no banner of its own.
  const careBalanceFields: Field[] =
    !runner.gone && !runner.won && opts.careBalance
      ? [
          {
            // NO changeMessage on purpose. A balance banner fires on every care
            // spend and reads as noise ("you have 97 CARE left"), and the raw
            // number means nothing without knowing what a care costs. The value
            // sits on the card for whoever looks; it does not interrupt anyone.
            key: "carebal",
            label: "CARE",
            value: opts.careBalance,
          },
        ]
      : [];
  // ALIVE only from a verified on-chain headcount; otherwise the field is left off.
  const aliveLine = opts.aliveLine !== undefined ? opts.aliveLine : survivorLine();
  const headerFields: Field[] = runner.gone || runner.won
    ? [{ key: "petno", label: "NO.", value: petId }]
    : [
        { key: "petno", label: "NO.", value: petId },
        ...(aliveLine ? [{ key: "alive", label: "ALIVE", value: aliveLine }] : []),
        ...careBalanceFields,
      ];
  // The explicit STATUS word leads the meter row (and the memorial row), matching
  // the pass ground color + the scene art.
  const statusField: Field = { key: "petstatus", label: "STATUS", value: statusTheme.status };
  // ONE CLOCK ON THE FRONT, NOT FIVE. The pet dies when the SOONEST of its five
  // needs lapses, so the only number that decides anything is that minimum. A row
  // of five per-need countdowns ("3h 23h 23h 1d 1d") was cluttered, pushed the
  // layout into truncation, and made the keeper do the min in their head to find
  // the number that actually matters. The card shows SURVIVES; which need is
  // binding belongs in a push, not in a permanent row of five.
  //
  // isRelative lets Apple redraw it as a live countdown on the device, so it keeps
  // falling between pushes with no extra APNs traffic. Rendered ONLY from chain
  // countdowns: the percent fallback cannot be turned into honest time, and a
  // wrong death clock is worse than no death clock. No changeMessage: the value
  // moves on every push and would otherwise fire a lock-screen banner each tick.
  const lifeSecondsLeft =
    runner.gone || runner.won ? null : minNeedSecondsLeft(opts.needSecondsLeft);
  // A failed countdown read keeps the LAST KNOWN deadline on the card (runner/pass-memory.ts) rather
  // than dropping the field: the phone already shows exactly that value, and a field that vanishes
  // and returns reads to iOS as an ADDED field, which raised "Pass changed" (2026-10-17).
  const lifeValue = lifeSecondsLeft
    ? lifeDeadlineValue(now.getTime(), lifeSecondsLeft)
    : !runner.gone && !runner.won && opts.lifeFallback
      ? opts.lifeFallback
      : null;
  const lifeFields: Field[] = lifeValue
    ? [
        {
          key: "life",
          label: "SURVIVES",
          value: lifeValue,
          dateStyle: "PKDateStyleShort",
          timeStyle: "PKDateStyleShort",
          isRelative: true,
        },
      ]
    : [];
  const secondaryFields: Field[] = runner.gone
    ? [
        statusField,
        { key: "lived", label: "LIVED", value: `${memorialLivedDays(runner)} days` },
        { key: "cared", label: "CARED", value: `${runner.careCount} times` },
      ]
    : [statusField, ...lifeFields];
  // THE MEMORIAL EVENT LINE (runner/memorial-line.ts), flag-gated: the same `status` field a living
  // card has, AFTER the memorial field, so a one-time announcement can reach a dead pet's keeper.
  // changeMessage only while it shows the active announcement (a memorial line is never a reminder).
  const memorialLineFields: Field[] = memorialLineEnabledFor(runner)
    ? [
        {
          key: "status",
          label: RUNNER_THEME.petLabel,
          value: memorialLineValue(runner),
          ...(!!opts.announcement && runner.lastEvent === opts.announcement
            ? { changeMessage: RUNNER_THEME.statusChangeMessage }
            : {}),
        },
      ]
    : [];
  const auxiliaryFields: Field[] = runner.gone
    ? [
        runner.deathRank > 0
          ? { key: "outlasted", label: "OUTLASTED", value: `${outlastedFromRank(runner.deathRank).toLocaleString("en-US")} pets` }
          : { key: "memory", label: "IN MEMORY", value: MEMORIAL_COPY.epitaph },
        ...memorialLineFields,
      ]
    : runner.won
      ? [
          { key: "winner", label: "WINNER", value: "Season champion", changeMessage: RUNNER_THEME.statusChangeMessage },
          { key: "pot", label: "POT WON", value: `${formatCareToken(BigInt(runner.wonPrize || "0"))} CARE` },
        ]
      : [
          {
            key: "status",
            label: RUNNER_THEME.petLabel,
            value: runner.lastEvent ?? moodLine(mood),
            // BANNER ONLY FOR A REMINDER (runner/reminders.ts). A change to a field with a
            // changeMessage raises a lock-screen message (Apple collapses several into "Pass
            // changed"), and idle flavor changed this line about
            // seven times a day, teaching keepers to mute the pass that warns them of death.
            // The one other line allowed a banner: the active announcement (runner/announce.ts),
            // only while the line shows exactly that text. Same field, so no field is ever added.
            ...(isAlertLine(runner.lastEvent) || (!!opts.announcement && runner.lastEvent === opts.announcement)
              ? { changeMessage: RUNNER_THEME.statusChangeMessage }
              : {}),
          },
        ];
  // The pet's always-live page (formerly the QR target).
  const petPageUrl = `${config.WEB_APP_URL}/pet/${runner.serial}`;
  const explorerLink = runner.tbaAddress
    ? `${config.robinhood.explorer}/address/${runner.tbaAddress}`
    : config.robinhood.explorer;

  // The five care action links (HMAC-signed). A gone pet shows an epitaph instead.
  const careFields: Field[] = runner.gone
    ? [{ key: "epitaph", label: "IN MEMORY", value: "This pet has passed on. Thank you for the care it knew." }]
    : [
        { key: "care", label: "CARE FOR YOUR PET", value: "Tap an action to keep your pet happy." },
        link("feed", "Feed"),
        link("water", "Give water"),
        link("play", "Play"),
        link("toy", "Give a toy"),
        link("explore", "Explore"),
      ];

  // CHI SHOT: the arcade button, top of the back so it is the first thing a
  // flip shows. Gated per pet (runner/game.ts), so every other pass is unchanged.
  const gameFields: Field[] = gameEnabledFor(runner)
    ? [{
        key: "game",
        label: "PLAY",
        value: GAME_TITLE,
        attributedValue: `<a href="${gameUrl(runner.serial)}">Play ${GAME_TITLE}</a>`,
      }]
    : [];
  // CHI NIGHT, right under CHI SHOT, gated per pet the same way (runner/night.ts). No
  // changeMessage: the button appearing is silent.
  const nightFields: Field[] = nightEnabledFor(runner)
    ? [{
        key: "night",
        label: "PLAY",
        value: NIGHT_TITLE,
        attributedValue: `<a href="${nightUrl(runner.serial)}">Play ${NIGHT_TITLE}</a>`,
      }]
    : [];

  // PHOTO ALBUM (living pets only, gated per pet like the game). The link never carries a
  // changeMessage: Apple fills "%@" from attributedValue, so a banner on it reads as raw HTML. The
  // announcement is its own PLAIN line (Hunt's words, approved 2026-10-17), present only while
  // ALBUM_ANNOUNCE is on; in "banner" mode the line arriving carries the lock-screen message.
  // Observed 2026-10-17 on iOS 27: holders got "Pass changed" PLUS the message when this field
  // was added (root cause still open), so do not assume it is the single banner.
  const albumFields: Field[] = albumEnabledFor(runner)
    ? [
        {
          key: "album",
          label: "ALBUM",
          value: ALBUM_TITLE,
          attributedValue: `<a href="${albumUrl(runner.serial)}">${ALBUM_TITLE}</a>`,
        },
        ...(albumNoteMode(runner) !== "off"
          ? [{
              key: "albumNote",
              label: "NEW",
              value: albumNoteMode(runner) === "prime" ? ALBUM_PRIME : ALBUM_NOTICE,
              ...(albumNoteMode(runner) === "banner" ? { changeMessage: "%@" } : {}),
            }]
          : []),
      ]
    : [];

  // NEWS: one line from us. With NEWS_BANNER its changeMessage ("%@" = the new value) is the banner
  // text, but it is NOT guaranteed to be the only notification: Apple documents that several
  // changeMessage fields changing in one update collapse to a generic "Pass changed", and on
  // 2026-10-17 (iOS 27) adding a back field raised "Pass changed" as well as the message. Every
  // back field also appears twice when the pass carries posterGeneric (it shares one backFields
  // array with storeCard below).
  const newsFields: Field[] = config.NEWS_TEXT
    ? [{ key: "news", label: "NEWS", value: config.NEWS_TEXT, ...(config.NEWS_BANNER ? { changeMessage: "%@" } : {}) }]
    : [];

  // The player-rewards row, right below the care actions. SEASON 2, NO CLAIMS: it
  // is a STATEMENT, not a button. There is nothing to tap because the 2h push
  // engine sends the CARE to the pet's own account on its own, so a "Collect
  // rewards" link would be a button whose only job is to say it was not needed.
  // Only present when the distributor is live (forward-gated: absent on the
  // current season, appears at mainnet). A gone pet shows nothing.
  const rewardsFields: Field[] =
    config.modes.rewardsLive && !runner.gone
      ? [
          {
            key: "collect",
            label: "REWARDS",
            value: "The CARE your pet earns is sent to it automatically, every couple of hours.",
          },
        ]
      : [];

  // An unarmed pet says so FIRST, above the care links it is about to explain (setup-nudge.ts).
  const setupFields: Field[] =
    opts.setupNudge && !opts.transferred && !runner.gone
      ? [{ key: "setup", label: SETUP_NUDGE_COPY.label, value: SETUP_NUDGE_COPY.value }]
      : [];

  const backFields: Field[] = [
    ...setupFields,
    ...newsFields,
    ...gameFields,
    ...nightFields,
    ...albumFields,
    ...careFields,
    ...rewardsFields,
    // One number on the back (Hunt, 2026-10-17): the old "Token ID" row repeated the pet number.
    // Removing a back field is silent on iOS (no banner); never add one back without a reason.
    { key: "petNoBack", label: `${RUNNER_THEME.petLabel} No.`, value: petId },
    {
      key: "tba",
      label: "Token-bound account (ERC-6551)",
      value: shortHex(runner.tbaAddress),
    },
    {
      key: "chain",
      label: "Network",
      value: `Robinhood Chain (${config.ROBINHOOD_NETWORK})`,
    },
    {
      key: "petPage",
      label: "Pet page",
      value: "Open your pet's live page",
      attributedValue: `<a href="${petPageUrl}">Open your pet's live page</a>`,
    },
    { key: "explorer", label: "View on Blockscout", value: explorerLink },
    { key: "serialBack", label: "Serial", value: runner.serial },
    ...(config.ROBINHOOD_NETWORK === "testnet"
      ? [{ key: "testnet", label: TESTNET_COPY.label, value: TESTNET_COPY.body }]
      : []),
    {
      key: "support",
      label: "About",
      value:
        "WALLETCHI: a pet NFT that is its own wallet pass. The front shows its live on-chain state, the links above act on chain, and the card updates when the chain does. Its tokens live in an ERC-6551 account the pet owns.",
    },
  ];

  const warningWindows = relevantDatesFor(now.getTime(), lifeSecondsLeft);
  const passJson: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: config.PASS_TYPE_ID,
    teamIdentifier: config.APPLE_TEAM_ID,
    serialNumber: runner.serial,
    organizationName: config.ORGANIZATION_NAME,
    description: RUNNER_THEME.description,
    // Lock screen: the death-warning window only (see relevantDatesFor); omitted otherwise.
    ...(warningWindows.length > 0
      ? { relevantDate: warningWindows[0]!.startDate, relevantDates: warningWindows }
      : {}),
    // Ground + label colors follow the pet's STATUS (statusThemeFor), so the card
    // itself turns amber when hungry, blue when thirsty, red when critical, etc.
    foregroundColor: statusTheme.foreground,
    backgroundColor: statusTheme.background,
    labelColor: statusTheme.labelColor,
    // Runner passes call back on a SEPARATE web service path so the card apple
    // web service is never touched.
    webServiceURL: `${config.PUBLIC_BASE_URL}/runner-apple`,
    authenticationToken: runner.authToken,
    sharingProhibited: true,
    // NO QR CODE (Hunt, 2026-10-09): it sat on top of the pet art, worst on the
    // full-art iOS 27 poster. It only ever opened the pet page, which now rides
    // the back as a tappable "Pet page" link instead. A pass without barcodes is
    // valid; Apple treats the keys as optional.
    storeCard: {
      headerFields,
      // NO NAME BANNER. The name stamped across the front crowded the art and read
      // as clutter. It stays where it belongs: the NFT metadata, the pass back, and
      // the pet's own page. The card front is the creature, its status and its clock.
      primaryFields: [],
      secondaryFields,
      auxiliaryFields,
      backFields,
    },
  };

  if (poster) {
    // iOS 27 POSTER GENERIC face, from the SAME field objects the storeCard uses
    // (keys may repeat across the two dictionaries; Apple's own example does). Apple
    // states the poster face holds ONE header field, up to FOUR primary fields and
    // one visible footer; the rest is the same back. So: NO. leads the header; the
    // row that matters (STATUS, SURVIVES, then ALIVE and CARE from the storeCard
    // header) fills the primary slots; the mood / last-event line is the footer. A
    // memorial reads STATUS, LIVED, CARED and OUTLASTED (or IN MEMORY); a champion
    // STATUS, WINNER, POT WON. Caps are enforced here rather than trusted to the
    // device, which drops overflow silently.
    // A memorial with the event line (runner/memorial-line.ts) keeps OUTLASTED / IN MEMORY in the
    // primary row (still four: STATUS, LIVED, CARED, OUTLASTED) and puts ONLY that line in the
    // footer, where the living card's event line sits. With the flag off nothing here changes.
    const memorialAux = runner.gone ? auxiliaryFields.filter((f) => f.key !== "status") : auxiliaryFields;
    const primary = runner.gone || runner.won
      ? [...secondaryFields, ...memorialAux]
      : [...secondaryFields, ...headerFields.slice(1)];
    const footer = runner.gone ? memorialLineFields : runner.won ? [] : auxiliaryFields;
    passJson.posterGeneric = {
      headerFields: headerFields.slice(0, 1),
      primaryFields: primary.slice(0, 4),
      ...(footer.length ? { footerFields: footer.slice(0, 1) } : {}),
      backFields,
    };
  }

  return { passJson, images };
}

// Produce a signed .pkpass (live) or an unsigned structural .pkpass (stub).
// Mirrors the card packaging deliberately (kept separate to avoid touching the
// legacy card pass module).
export async function generateRunnerPkpass(
  runner: Runner,
  opts: RunnerPassOptions = {},
): Promise<{ buffer: Buffer; signed: boolean; passJson: Record<string, unknown> }> {
  const assembled = await assembleRunnerPass(runner, opts);
  const certs = loadPassCertificates();

  if (certs) {
    const buffers: Record<string, Buffer> = {
      "pass.json": Buffer.from(JSON.stringify(assembled.passJson)),
      ...assembled.images,
    };
    const pass = new PKPass(buffers, {
      wwdr: certs.wwdrPem,
      signerCert: certs.signerCertPem,
      signerKey: certs.signerKeyPem,
      signerKeyPassphrase: certs.passphrase || undefined,
    });
    return { buffer: pass.getAsBuffer(), signed: true, passJson: assembled.passJson as Record<string, unknown> };
  }

  logger.warn(
    { serial: runner.serial },
    "PASS_STUB_MODE: emitting UNSIGNED runner .pkpass (structure only). Set PASS_CERT_P12_BASE64 to sign.",
  );
  const zip = new AdmZip();
  const files: Record<string, Buffer> = {
    "pass.json": Buffer.from(JSON.stringify(assembled.passJson, null, 2)),
    ...assembled.images,
  };
  const manifest: Record<string, string> = {};
  for (const [name, buf] of Object.entries(files)) {
    manifest[name] = createHash("sha1").update(buf).digest("hex");
    zip.addFile(name, buf);
  }
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
  return { buffer: zip.toBuffer(), signed: false, passJson: assembled.passJson as Record<string, unknown> };
}
