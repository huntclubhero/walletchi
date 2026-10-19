/**
 * PASS BUNDLE CHECK (the "we did not change the card" proof)
 *
 * Builds REAL signed .pkpass bundles through generateRunnerPkpass with a throwaway self-signed
 * certificate, unzips them, and compares what the signing library actually EMITTED (pass.json,
 * the manifest of file hashes, the file list) against a committed fixture.
 *
 * Why the signed path and not the stub: passkit-generator validates pass.json with a schema that
 * strips keys it does not know, silently. The unsigned stub (what `npm run smoke` exercises) zips
 * our raw JSON and cannot see that. A change that survives the stub and dies in the signer is
 * exactly the kind this check exists to catch.
 *
 * Determinism: the clock is frozen (relevantDate, the SURVIVES countdown, time-of-day art), the
 * process TZ is UTC, every env the pass embeds is pinned here (dotenv never overrides a set var),
 * and the season snapshot is the pre-season stub. The manifest SHA-1s therefore pin the image
 * bytes too, so an image renderer change shows up as a hash diff.
 *
 * Cases: alive (happy), alive with the setup nudge, hungry, memorial, champion, keepsake after a
 * transfer, keepsake after an owner reset.
 *
 * Run:   npm run pass-bundle:check             compare against scripts/fixtures/pass-bundle.json
 *        npm run pass-bundle:check -- --capture  rewrite the fixture from the current code
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import forge from "node-forge";
import AdmZip from "adm-zip";
import sharp from "sharp";

// ---- Frozen clock, BEFORE any import that reads the time. 15:00 UTC is "day" for the scene
// art and outside every quiet-hours window. Code using `new Date()` or `Date.now()` gets this
// instant; explicit constructor arguments pass through untouched.
process.env.TZ = "UTC";
const FROZEN_MS = Date.parse("2026-10-04T15:00:00.000Z");
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FROZEN_MS);
    else super(...(args as [number]));
  }
  static override now(): number {
    return FROZEN_MS;
  }
}
(globalThis as unknown as { Date: unknown }).Date = FrozenDate;

// ---- Throwaway signing identity (same shape as scripts/apns-session-check.ts). Nothing here is a
// real Apple credential; the bundle proves structure, not installability.
function selfSigned(): { certPem: string; p12b64: string; password: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new RealDate(FROZEN_MS - 60_000);
  cert.validity.notAfter = new RealDate(FROZEN_MS + 365 * 24 * 3600_000);
  const attrs = [{ name: "commonName", value: "pass-bundle-check" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const password = "pass-bundle-check";
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" });
  return {
    certPem: forge.pki.certificateToPem(cert),
    p12b64: forge.util.encode64(forge.asn1.toDer(p12).getBytes()),
    password,
  };
}
const pair = selfSigned();

// ---- Pinned env. Everything the pass embeds or that flips a render branch is set explicitly so
// the fixture does not depend on the machine's .env (dotenv fills only UNSET vars).
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = "postgres://bundle:bundle@localhost:5432/bundle";
process.env.PASS_STUB_MODE = "false";
process.env.PASS_CERT_P12_BASE64 = pair.p12b64;
process.env.PASS_CERT_PASSWORD = pair.password;
process.env.APPLE_WWDR_PEM_BASE64 = Buffer.from(pair.certPem, "utf8").toString("base64");
process.env.PASS_TYPE_ID = "pass.com.example.bundlecheck";
process.env.APPLE_TEAM_ID = "BUNDLECHK0";
process.env.ORGANIZATION_NAME = "WALLETCHI";
process.env.PUBLIC_BASE_URL = "https://api.walletchi.test";
process.env.WEB_APP_URL = "https://walletchi.test";
process.env.CARE_LINK_SECRET = "pass-bundle-check-care-link-secret";
process.env.ROBINHOOD_NETWORK = "testnet";
process.env.STATS_BAND_ENABLED = "false";
process.env.TRAITS_V2_ENABLED = "true";
process.env.REWARDS_DISTRIBUTOR_ADDRESS = ""; // rewardsLive=false: no REWARDS back field
process.env.PET721_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.TESTER_ALLOWLIST = "";
process.env.POSTER_GENERIC_ENABLED = process.argv.includes("--poster-on") ? "true" : "false";
process.env.POSTER_GENERIC_SERIALS = "";

const { generateRunnerPkpass } = await import("../src/runner/pass.js");
type Runner = import("../src/store/types.js").Runner;
type RunnerPassOptions = import("../src/runner/pass.js").RunnerPassOptions;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "pass-bundle.json");
const CAPTURE = process.argv.includes("--capture");
const POSTER_ON = process.argv.includes("--poster-on");

const DAY = 24 * 3600_000;
const at = (msAgo: number) => new RealDate(FROZEN_MS - msAgo);

function runner(over: Partial<Runner> = {}): Runner {
  return {
    serial: "bundle-check-serial",
    tokenId: "42",
    tbaAddress: "0xabababababababababababababababababababab",
    ownerAddress: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    email: "bundle@walletchi.test",
    bestScore: 0,
    salmon: 0,
    runs: 0,
    authToken: "bundle-check-auth-token-0123456789",
    status: "ready",
    issueTxHash: null,
    issueNonce: null,
    failureReason: null,
    idleSalmon: 0,
    lastTickAt: at(DAY / 24),
    lastEvent: "Found a shiny pebble by the river.",
    lastPushAt: null,
    lastIdleCatchAt: null,
    pendingDigest: 0,
    lastHoneyAt: null,
    lastFishAt: null,
    lastExploreAt: null,
    pendingSalmon: 0,
    activeFork: null,
    forkExpiresAt: null,
    hunger: 80,
    thirst: 70,
    joy: 90,
    lastNeedsAt: at(DAY / 24),
    lastCareAt: at(DAY / 12),
    lastWaterAt: null,
    lastWanderPingAt: null,
    lastPlayAt: null,
    lastToyAt: null,
    hatched: true,
    toys: 2,
    critical: false,
    gone: false,
    won: false,
    wonPrize: "0",
    lastStage: 2,
    bornAt: at(3 * DAY),
    diedAt: null,
    careCount: 12,
    deathRank: 0,
    privyUserHash: null,
    googleObjectId: null,
    createdAt: at(3 * DAY),
    updatedAt: at(DAY / 24),
    ...over,
  };
}

const LIVE: RunnerPassOptions = {
  needPct: [80, 70, 90, 60, 50],
  needSecondsLeft: [20 * 3600, 18 * 3600, 23 * 3600, 86_400, 86_400],
  careBalance: "98 CARE",
  setupNudge: false,
};

const CASES: Array<{ name: string; runner: Runner; opts: RunnerPassOptions }> = [
  { name: "alive", runner: runner(), opts: LIVE },
  { name: "alive-setup-nudge", runner: runner(), opts: { ...LIVE, setupNudge: true } },
  { name: "hungry", runner: runner({ hunger: 10, lastEvent: null }), opts: { ...LIVE, needPct: [10, 70, 90, 60, 50], needSecondsLeft: [2 * 3600, 18 * 3600, 23 * 3600, 86_400, 86_400] } },
  {
    name: "memorial",
    runner: runner({ gone: true, critical: false, hunger: 0, thirst: 0, joy: 0, bornAt: at(10 * DAY), diedAt: at(DAY), careCount: 33, deathRank: 7, lastEvent: null }),
    opts: {},
  },
  { name: "champion", runner: runner({ won: true, wonPrize: "1234500000000000000000" }), opts: LIVE },
  {
    name: "keepsake-transfer",
    runner: runner(),
    opts: { transferred: true, keepsakeReason: "transfer", authTokenOverride: "retired-token-0123456789abcdef" },
  },
  {
    name: "keepsake-reset",
    runner: runner(),
    opts: { transferred: true, keepsakeReason: "reset", authTokenOverride: "retired-token-0123456789abcdef" },
  },
];

interface Emitted {
  files: string[];
  manifest: Record<string, string>;
  passJson: Record<string, unknown>;
  // PNG bytes by file name, for dimension checks. Not part of the fixture (the
  // manifest hashes already pin the bytes); dropped before capture.
  pngs: Record<string, Buffer>;
}

async function emit(c: (typeof CASES)[number]): Promise<Emitted> {
  const { buffer, signed } = await generateRunnerPkpass(c.runner, c.opts);
  if (!signed) throw new Error(`${c.name}: bundle came back UNSIGNED; the stub path proves nothing here`);
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const files = entries.map((e) => e.entryName).sort();
  const manifest = JSON.parse(zip.readAsText("manifest.json")) as Record<string, string>;
  const passJson = JSON.parse(zip.readAsText("pass.json")) as Record<string, unknown>;
  // Sanity on the bundle itself: every non-manifest, non-signature file is hashed, and the hash is right.
  for (const e of entries) {
    if (e.entryName === "manifest.json" || e.entryName === "signature") continue;
    const sha = createHash("sha1").update(e.getData()).digest("hex");
    if (manifest[e.entryName] !== sha) throw new Error(`${c.name}: manifest hash mismatch for ${e.entryName}`);
  }
  if (!files.includes("signature")) throw new Error(`${c.name}: no signature file in the bundle`);
  const pngs: Record<string, Buffer> = {};
  for (const e of entries) if (e.entryName.endsWith(".png")) pngs[e.entryName] = e.getData();
  return { files, manifest, passJson, pngs };
}

// Deep diff as a list of JSON-pointer-ish paths, so a failure says WHERE, not just "differs".
function diff(a: unknown, b: unknown, at = "$", out: string[] = []): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${at}: length ${a.length} -> ${b.length}`);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff(a[i], b[i], `${at}[${i}]`, out);
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      if (!(k in ao)) out.push(`${at}.${k}: added`);
      else if (!(k in bo)) out.push(`${at}.${k}: removed`);
      else diff(ao[k], bo[k], `${at}.${k}`, out);
    }
    return out;
  }
  if (a !== b) out.push(`${at}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  return out;
}

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passes += 1;
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const emitted: Record<string, Emitted> = {};
for (const c of CASES) emitted[c.name] = await emit(c);

if (CAPTURE) {
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  const forFixture = Object.fromEntries(Object.entries(emitted).map(([k, { pngs: _pngs, ...rest }]) => [k, rest]));
  fs.writeFileSync(FIXTURE, JSON.stringify(forFixture, null, 2) + "\n");
  console.log(`captured ${CASES.length} cases to ${path.relative(process.cwd(), FIXTURE)}`);
  process.exit(0);
}

if (!fs.existsSync(FIXTURE)) {
  console.error(`no fixture at ${FIXTURE}; run with --capture first (on the code you trust)`);
  process.exit(2);
}
const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, Emitted>;

console.log(`pass bundle check (poster ${POSTER_ON ? "ON" : "off"})`);
for (const c of CASES) {
  const got = emitted[c.name]!;
  const want = fixture[c.name];
  if (!want) {
    check(`${c.name}: fixture has this case`, false, "missing; re-capture");
    continue;
  }
  if (!POSTER_ON) {
    // Flag off: the emitted bundle must equal the fixture exactly, files, hashes and JSON.
    const { pngs: _pngs, ...comparable } = got;
    const d = diff(want, comparable);
    check(`${c.name}: emitted bundle equals fixture`, d.length === 0, d.slice(0, 8).join(" | "));
    check(`${c.name}: no poster artefacts`, !("posterGeneric" in got.passJson) && !got.files.some((f) => /^(artwork|primaryLogo)/.test(f)));
  } else {
    // Flag on: the storeCard half and every pre-existing file must be untouched...
    const d = diff(want.passJson["storeCard"], got.passJson["storeCard"]);
    check(`${c.name}: storeCard dictionary unchanged with poster on`, d.length === 0, d.slice(0, 8).join(" | "));
    // The icon is EXPECTED to change (Apple's 38 pt size replaces the 29 pt one) and
    // pass.json gains the poster dictionary; everything else, strip and logo included,
    // must be the same bytes.
    const unchanged = Object.entries(want.manifest).filter(([f]) => !f.startsWith("icon") && f !== "pass.json");
    const differing = unchanged.filter(([f, h]) => got.manifest[f] !== h).map(([f]) => f);
    check(`${c.name}: strip + logo files byte-identical with poster on`, differing.length === 0, differing.join(","));
    // ...and the poster half must be present and within Apple's stated caps.
    const poster = got.passJson["posterGeneric"] as Record<string, unknown[]> | undefined;
    check(`${c.name}: posterGeneric present`, Boolean(poster));
    if (poster) {
      const len = (k: string) => (Array.isArray(poster[k]) ? poster[k]!.length : 0);
      check(`${c.name}: poster header 1, primary <= 4, footer <= 1`, len("headerFields") === 1 && len("primaryFields") >= 1 && len("primaryFields") <= 4 && len("footerFields") <= 1, `h=${len("headerFields")} p=${len("primaryFields")} f=${len("footerFields")}`);
      const keys = (["headerFields", "primaryFields", "footerFields", "backFields"] as const).flatMap((k) => ((poster[k] ?? []) as Array<{ key: string }>).map((f) => f.key));
      check(`${c.name}: poster field keys unique`, new Set(keys).size === keys.length);
      // passkit-generator pads every dictionary with empty arrays for the groups a
      // style does not use (3.5.7 did the same with additionalInfoFields). Empty is
      // fine, Apple ignores it; a POPULATED secondary/auxiliary group is the mistake.
      check(`${c.name}: poster secondary/auxiliary groups empty`, len("secondaryFields") === 0 && len("auxiliaryFields") === 0);
    }
    const need = ["artwork.png", "artwork@2x.png", "artwork@3x.png", "primaryLogo.png", "primaryLogo@2x.png", "primaryLogo@3x.png"];
    check(`${c.name}: poster image files present`, need.every((f) => got.files.includes(f)), need.filter((f) => !got.files.includes(f)).join(","));
    // Pixel dimensions straight from the bundle: Apple's point sizes at 1x/2x/3x.
    const expect: Record<string, [number, number]> = {
      "artwork.png": [358, 448], "artwork@2x.png": [716, 896], "artwork@3x.png": [1074, 1344],
      "primaryLogo.png": [126, 30], "primaryLogo@2x.png": [252, 60], "primaryLogo@3x.png": [378, 90],
      "icon.png": [38, 38], "icon@2x.png": [76, 76], "icon@3x.png": [114, 114],
      "strip.png": [375, 144], "strip@2x.png": [750, 288], "strip@3x.png": [1125, 432],
    };
    const wrong: string[] = [];
    for (const [f, [w, h]] of Object.entries(expect)) {
      const png = got.pngs[f];
      if (!png) continue;
      const m = await sharp(png).metadata();
      if (m.width !== w || m.height !== h) wrong.push(`${f}=${m.width}x${m.height}`);
    }
    check(`${c.name}: image pixel sizes match Apple's point sizes`, wrong.length === 0, wrong.join(","));
  }
}

// ONE NUMBER ON THE BACK (Hunt, 2026-10-17): the "Token ID" row repeated the pet number and is
// gone; "Pet No." stays. Checked on the emitted bundle, storeCard and (poster on) posterGeneric.
for (const c of CASES) {
  if (c.opts.transferred) continue; // keepsakes carry their own short back (no number rows)
  const pj = emitted[c.name]!.passJson;
  const dicts = POSTER_ON ? (["storeCard", "posterGeneric"] as const) : (["storeCard"] as const);
  for (const d of dicts) {
    const keys = (((pj[d] as Record<string, unknown> | undefined)?.["backFields"] ?? []) as Array<{ key: string }>).map((f) => f.key);
    check(`${c.name}: ${d} back has petNoBack and no tokenId`, keys.includes("petNoBack") && !keys.includes("tokenId"), keys.join(","));
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
