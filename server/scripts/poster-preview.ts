/**
 * POSTER PREVIEW (Phase 0 of the iOS 27 Poster Generic rollout; touches nothing on Render)
 *
 * Two outputs, both to a local folder:
 *
 *   1. The poster ARTWORK files (358x448 pt @3x = 1074x1344 px) and the primary logo for a
 *      spread of pets and moods, so the art can be judged as the real asset Wallet will draw.
 *      No faked Apple composite: the finished poster exists only on an iOS 27 device.
 *
 *   2. With --pkpass: ONE signed pass carrying BOTH the storeCard and posterGeneric
 *      dictionaries, signed with the LOCAL production certificate (server/.env), with a
 *      preview serial and NO web service URL. It installs as a standalone static card next
 *      to a real pet, never updates, and is deleted afterwards. On iOS 26 it must look like
 *      today's card (the fallback); on iOS 27 it shows the poster.
 *
 *      The serial is forced to a "poster-preview-" prefix. Real pet serials are UUIDs, and
 *      Wallet REPLACES a pass with the same type + serial: a preview pointed at a real serial
 *      would overwrite the holder's live pass with a static one. This script cannot do that.
 *
 * Run:   npx tsx scripts/poster-preview.ts [--out <dir>] [--pkpass]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOG_LEVEL ??= "silent";
process.env.POSTER_GENERIC_ENABLED = "true";

const { config } = await import("../src/config.js");
const { assembleRunnerPass } = await import("../src/runner/pass.js");
const { petPosterImages, petPassImages } = await import("../src/runner/pet.js");
const { moodFor } = await import("../src/runner/needs.js");
const { timeOfDayFor } = await import("../src/runner/theme.js");
const { petVisualFor } = await import("../src/runner/stage.js");
const { loadPassCertificates } = await import("../src/passes/certs.js");
const { PKPass } = await import("passkit-generator");
type Runner = import("../src/store/types.js").Runner;
type Mood = Parameters<typeof petPosterImages>[0]["mood"];

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]!) : path.join(os.tmpdir(), "walletchi-poster-preview");
const WANT_PKPASS = args.includes("--pkpass");
// Diagnostic variants for the device test, each its own serial so they install side by side:
//   storecard-only      CONTROL: today's pass exactly (storeCard, today's images), through the new signing library
//   both                the planned pass: storeCard + posterGeneric, poster images added, icon at 38 pt
//   both-legacy-images  storeCard + posterGeneric KEY, but today's image files only (isolates key vs files)
//   poster-generic      posterGeneric + a generic fallback (Apple's own documented pairing), poster images
const vIdx = args.indexOf("--variant");
const VARIANT = (vIdx >= 0 && args[vIdx + 1]) ? args[vIdx + 1]! : "both";
if (!["both", "storecard-only", "both-legacy-images", "poster-generic"].includes(VARIANT)) throw new Error(`unknown --variant ${VARIANT}`);
fs.mkdirSync(OUT, { recursive: true });

// ---- 1. Artwork spread -------------------------------------------------------------
const SEEDS = ["1", "42", "777"];
const MOODS: Mood[] = ["happy", "hungry", "critical", "sleeping", "egg", "gone"];
let written = 0;
for (const seed of SEEDS) {
  for (const mood of MOODS) {
    const imgs = await petPosterImages({ mood, toys: mood === "egg" ? 0 : 2, timeOfDay: "day", seed, stage: mood === "egg" ? undefined : 2 });
    fs.writeFileSync(path.join(OUT, `artwork-seed${seed}-${mood}@3x.png`), imgs["artwork@3x.png"]!);
    written += 1;
  }
}
const logoImgs = await petPosterImages({ mood: "happy", seed: "1", timeOfDay: "day" });
fs.writeFileSync(path.join(OUT, "primaryLogo@3x.png"), logoImgs["primaryLogo@3x.png"]!);
fs.writeFileSync(path.join(OUT, "icon@3x.png"), logoImgs["icon@3x.png"]!);
console.log(`wrote ${written} artwork files + primaryLogo + icon to ${OUT}`);

if (!WANT_PKPASS) process.exit(0);

// ---- 2. Signed preview pass ----------------------------------------------------------
if (!config.modes.appleLive) {
  console.error("Apple signing is not live in this environment (PASS_STUB_MODE or missing PASS_CERT_*). No pass written.");
  process.exit(2);
}
const certs = loadPassCertificates();
if (!certs) {
  console.error("loadPassCertificates returned null. No pass written.");
  process.exit(2);
}

const day = new Date().toISOString().slice(0, 10);
const SERIAL = `poster-preview-${day}-${VARIANT}`;
if (!/^poster-preview-\d{4}-\d{2}-\d{2}-[a-z-]+$/.test(SERIAL) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(SERIAL)) {
  throw new Error("preview serial must carry the poster-preview- prefix and never look like a real UUID serial");
}

const now = Date.now();
const runner: Runner = {
  serial: SERIAL,
  tokenId: "42",
  tbaAddress: "0xabababababababababababababababababababab",
  ownerAddress: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
  email: "preview@walletchi.test",
  bestScore: 0, salmon: 0, runs: 0,
  authToken: "poster-preview-token-not-a-real-token",
  status: "ready",
  issueTxHash: null, issueNonce: null, failureReason: null,
  idleSalmon: 0, lastTickAt: new Date(now - 3600_000), lastEvent: "Found a shiny pebble by the river.",
  lastPushAt: null, lastIdleCatchAt: null, pendingDigest: 0,
  lastHoneyAt: null, lastFishAt: null, lastExploreAt: null, pendingSalmon: 0, activeFork: null, forkExpiresAt: null,
  hunger: 80, thirst: 70, joy: 90,
  lastNeedsAt: new Date(now - 3600_000), lastCareAt: new Date(now - 7200_000),
  lastWaterAt: null, lastWanderPingAt: null, lastPlayAt: null, lastToyAt: null,
  hatched: true, toys: 2, critical: false, gone: false, won: false, wonPrize: "0", lastStage: 2,
  bornAt: new Date(now - 3 * 86_400_000), diedAt: null, careCount: 12, deathRank: 0,
  privyUserHash: null, googleObjectId: null,
  createdAt: new Date(now - 3 * 86_400_000), updatedAt: new Date(now - 3600_000),
};

const assembled = await assembleRunnerPass(runner, {
  needPct: [80, 70, 90, 60, 50],
  needSecondsLeft: [20 * 3600, 18 * 3600, 23 * 3600, 86_400, 86_400],
  careBalance: "98 CARE",
});
const passJson = { ...assembled.passJson };
// Standalone: no web service, so Wallet never asks our server about this serial.
delete passJson.webServiceURL;
delete passJson.authenticationToken;
if (!("posterGeneric" in passJson) || !("storeCard" in passJson)) throw new Error("preview must start from BOTH dictionaries");
if (VARIANT === "storecard-only") delete passJson.posterGeneric;
if (VARIANT === "poster-generic") {
  // generic has no strip; its layout takes the same field groups plus a thumbnail.
  passJson.generic = passJson.storeCard;
  delete passJson.storeCard;
}
const dicts = ["storeCard", "generic", "posterGeneric"].filter((k) => k in passJson);

// Today's exact image set (29 pt icon, logo, strip; no artwork, no primaryLogo) for the
// variants that must not carry the poster files.
let images = assembled.images;
if (VARIANT === "storecard-only" || VARIANT === "both-legacy-images") {
  const at = new Date();
  const vis = petVisualFor(runner, at);
  images = await petPassImages({ mood: moodFor(runner, at), toys: runner.toys, timeOfDay: timeOfDayFor(at), seed: runner.tokenId ?? runner.serial, stage: vis.stage, shellCap: vis.shellCap });
}

const files: Record<string, Buffer> = { "pass.json": Buffer.from(JSON.stringify(passJson)), ...images };
const pass = new PKPass(files, {
  wwdr: certs.wwdrPem,
  signerCert: certs.signerCertPem,
  signerKey: certs.signerKeyPem,
  signerKeyPassphrase: certs.passphrase || undefined,
});
const out = path.join(OUT, `walletchi-poster-preview-${day}-${VARIANT}.pkpass`);
fs.writeFileSync(out, pass.getAsBuffer());
console.log(`wrote signed preview pass: ${out}`);
console.log(`  serial ${SERIAL}, passType ${config.PASS_TYPE_ID}, no webServiceURL, dictionaries: ${dicts.join(" + ")}`);
console.log("  Email it to the phone and open the attachment. Delete the card from Wallet afterwards.");
