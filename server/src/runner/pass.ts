import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { PKPass } from "passkit-generator";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Runner } from "../store/types.js";
import { loadPassCertificates } from "../passes/certs.js";
import { shortHex } from "../util/format.js";
import { petPassImages } from "./pet.js";
import { RUNNER_THEME, MEMORIAL_COPY, TESTNET_COPY, runnerNumber, timeOfDayFor, statusThemeFor } from "./theme.js";
import { petName } from "./names.js";
import { signTag, actionPayload, passDownloadCap } from "./sign.js";
import { moodFor, moodLine, needsInline, dbNeedPct, minNeedSecondsLeft } from "./needs.js";
import { petVisualFor } from "./stage.js";
import { survivorLine, memorialLivedDays, outlastedFromRank, formatCareToken, getSeasonSnapshot, passStatsFrom } from "./season.js";
import { SETUP_NUDGE_COPY } from "./setup-nudge.js";

// The pass relevantDate: the pet's next 7am morning, so the card surfaces on the
// lock screen when the owner wakes.
function nextSevenAmIso(): string {
  const d = new Date();
  d.setHours(7, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.toISOString();
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
    config.STATS_BAND_ENABLED && snap.seasonActive && !runner.gone ? passStatsFrom(snap) : undefined;
  // Evolution stage sizes the strip pet (flag-off / memorial -> today's render).
  const vis = petVisualFor(runner, now);
  const images = await petPassImages({ mood, toys: runner.toys, timeOfDay: timeOfDayFor(now), seed: runner.tokenId ?? runner.serial, stats: stripStats, stage: vis.stage, shellCap: vis.shellCap });
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
  // the winner card celebrates the pot instead). The changeMessage makes a
  // real balance change (a care spend, a rewards claim) land a subtle banner;
  // the value only moves on those economic events, so it cannot spam the way
  // a per-push countdown would.
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
  const headerFields: Field[] = runner.gone || runner.won
    ? [{ key: "petno", label: "NO.", value: petId }]
    : [
        { key: "petno", label: "NO.", value: petId },
        { key: "alive", label: "ALIVE", value: survivorLine() },
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
  const lifeFields: Field[] = lifeSecondsLeft
    ? [
        {
          key: "life",
          label: "SURVIVES",
          value: new Date(now.getTime() + lifeSecondsLeft * 1000)
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
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
  const auxiliaryFields: Field[] = runner.gone
    ? [
        runner.deathRank > 0
          ? { key: "outlasted", label: "OUTLASTED", value: `${outlastedFromRank(runner.deathRank).toLocaleString("en-US")} pets` }
          : { key: "memory", label: "IN MEMORY", value: MEMORIAL_COPY.epitaph },
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
            changeMessage: RUNNER_THEME.statusChangeMessage,
          },
        ];
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
    ...careFields,
    ...rewardsFields,
    { key: "petNoBack", label: `${RUNNER_THEME.petLabel} No.`, value: petId },
    {
      key: "tokenId",
      label: "Token ID",
      value: runner.tokenId ? `No. ${runner.tokenId}` : "Minting",
    },
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

  const petPageUrl = `${config.WEB_APP_URL}/pet/${runner.serial}`;
  const barcode = {
    format: "PKBarcodeFormatQR",
    message: petPageUrl,
    messageEncoding: "iso-8859-1",
    altText: `${RUNNER_THEME.gameName} ${number}`,
  };

  const passJson: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: config.PASS_TYPE_ID,
    teamIdentifier: config.APPLE_TEAM_ID,
    serialNumber: runner.serial,
    organizationName: config.ORGANIZATION_NAME,
    description: RUNNER_THEME.description,
    relevantDate: nextSevenAmIso(), // surface on the lock screen next morning
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
    barcode,
    barcodes: [barcode],
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

  return { passJson, images };
}

// Produce a signed .pkpass (live) or an unsigned structural .pkpass (stub).
// Mirrors the card packaging deliberately (kept separate to avoid touching the
// legacy card pass module).
export async function generateRunnerPkpass(
  runner: Runner,
  opts: RunnerPassOptions = {},
): Promise<{ buffer: Buffer; signed: boolean }> {
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
    return { buffer: pass.getAsBuffer(), signed: true };
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
  return { buffer: zip.toBuffer(), signed: false };
}
