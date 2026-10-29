/**
 * USDG-ON-THE-FACE PREVIEW (runner/usdg-front.ts). Local files only; touches nothing live.
 *
 * For a few pets, by day (light) and by night (dark), renders every image surface the card uses with
 * the CARE chip: the Apple strip (with and without the stats band), the iOS 27 poster artwork and
 * the Google hero, each with a "-nochip" twin. Then, from a REAL assembled pass (assembleRunnerPass
 * with the switch on for a preview serial), a composite of the Apple card front: logo + header row
 * (NO. | ALIVE | USDG) + the strip, so the face can be judged as on a phone.
 * The composite is a mock of Wallet's layout, not Apple's renderer.
 *
 * Run: npx tsx scripts/usdg-chip-preview.ts [--out <dir>] [--care 12481] [--usdg 10000] [--seeds 86,42,777] [--prefix care-chip-]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://preview:preview@localhost:5432/preview"; // never connected
process.env.PASS_STUB_MODE = "true";

const sharp = (await import("sharp")).default;
const { config } = await import("../src/config.js");
const { petPassImages, petPosterImages, petHeroPng } = await import("../src/runner/pet.js");
const { assembleRunnerPass } = await import("../src/runner/pass.js");
const { usdgFaceText } = await import("../src/runner/usdg-front.js");
const { petName } = await import("../src/runner/names.js");
const { runnerNumber } = await import("../src/runner/theme.js");
type Runner = import("../src/store/types.js").Runner;

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = path.resolve(arg("--out") ?? path.join(os.tmpdir(), "walletchi-usdg-chip"));
const CARE = Number(arg("--care") ?? "12481");
const USDG = BigInt(arg("--usdg") ?? "10000") * 10n ** 6n;
const SEEDS = (arg("--seeds") ?? "86,42,777").split(",");
const PREFIX = arg("--prefix") ?? "care-chip-";
fs.mkdirSync(OUT, { recursive: true });

const careChip = CARE.toLocaleString("en-US");
const usdgFace = usdgFaceText(USDG);
const stats = { alive: 141, total: 1000, pot: "12.4K", burned: "378K" };
let written = 0;
const save = (name: string, buf: Buffer) => {
  fs.writeFileSync(path.join(OUT, `${PREFIX}${name}`), buf);
  written += 1;
};

for (const seed of SEEDS) {
  for (const timeOfDay of ["day", "night"] as const) {
    for (const withChip of [true, false]) {
      const tag = `pet${seed}-${timeOfDay === "day" ? "light" : "dark"}${withChip ? "" : "-nochip"}`;
      const chip = withChip ? { careChip } : {};
      save(`${tag}-strip@3x.png`, (await petPassImages({ mood: "happy", toys: 2, timeOfDay, seed, stats, ...chip }))["strip@3x.png"]!);
      save(`${tag}-banner-noband@3x.png`, (await petPassImages({ mood: "happy", toys: 2, timeOfDay, seed, ...chip }))["strip@3x.png"]!);
      save(`${tag}-poster@3x.png`, (await petPosterImages({ mood: "happy", toys: 2, timeOfDay, seed, ...chip }))["artwork@3x.png"]!);
      save(`${tag}-google-hero.png`, await petHeroPng({ mood: "happy", toys: 2, timeOfDay, seed, name: petName(seed), number: runnerNumber(seed, seed), stats, ...chip }));
    }
  }
}

// ---- the composite card front, from a real assembled pass ----------------------------------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const now = Date.now();
function previewRunner(seed: string): Runner {
  return {
    serial: `usdg-preview-${seed}`,
    tokenId: seed,
    tbaAddress: "0xabababababababababababababababababababab",
    ownerAddress: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    email: "preview@walletchi.test",
    bestScore: 0, salmon: 0, runs: 0,
    authToken: "usdg-preview-token-not-a-real-token",
    status: "ready",
    issueTxHash: null, issueNonce: null, failureReason: null,
    idleSalmon: 0, lastTickAt: new Date(now - 3600_000), lastEvent: null,
    lastPushAt: null, lastIdleCatchAt: null, pendingDigest: 0,
    lastHoneyAt: null, lastFishAt: null, lastExploreAt: null, pendingSalmon: 0, activeFork: null, forkExpiresAt: null,
    hunger: 90, thirst: 90, joy: 95,
    lastNeedsAt: new Date(now - 600_000), lastCareAt: new Date(now - 600_000),
    lastWaterAt: null, lastWanderPingAt: null, lastPlayAt: null, lastToyAt: null,
    hatched: true, toys: 2, critical: false, gone: false, won: false, wonPrize: "0", lastStage: 2,
    bornAt: new Date(now - 3 * 86_400_000), diedAt: null, careCount: 12, deathRank: 0,
    privyUserHash: null, googleObjectId: null,
    createdAt: new Date(now - 3 * 86_400_000), updatedAt: new Date(now - 600_000),
  } as Runner;
}
type Field = { key: string; label?: string; value?: string | number };
const fieldValue = (f: Field) => {
  if (typeof f.value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(f.value)) return "23h 40m"; // a relative date (SURVIVES)
  return String(f.value ?? "");
};
async function composite(seed: string, dark: boolean): Promise<Buffer> {
  const runner = previewRunner(seed);
  (config as { USDG_FRONT_SERIALS?: string }).USDG_FRONT_SERIALS = runner.serial;
  const p = await assembleRunnerPass(runner, {
    careBalance: `${careChip} CARE`,
    usdgBalance: usdgFace,
    aliveLine: "141 / 1,000",
    needSecondsLeft: [20 * 3600, 22 * 3600, 23 * 3600, 30 * 3600, 40 * 3600],
  });
  const pass = p.passJson as { storeCard: Record<string, Field[]>; backgroundColor: string; foregroundColor: string; labelColor: string };
  // The strip in the composite follows the light/dark choice so both grounds can be judged.
  const strip = (await petPassImages({ mood: "happy", toys: 2, timeOfDay: dark ? "night" : "day", seed, stats, careChip }))["strip@3x.png"]!;
  const logo = p.images["logo@3x.png"]!;
  const W = 1125;
  const S = 3; // pt to px
  const headerH = 50 * S;
  const stripY = headerH;
  const stripH = 144 * S;
  // Header + art only: the field rows below the strip are unchanged by this switch, and their
  // mood words follow the clock, which would not match a strip forced to day or night here.
  const H = stripY + stripH + 24 * S;
  const label = pass.labelColor;
  const fg = pass.foregroundColor;
  const hdr = pass.storeCard.headerFields ?? [];
  let hx = W - 16 * S;
  let headerSvg = "";
  for (const f of [...hdr].reverse()) {
    const v = fieldValue(f);
    const lw = Math.max(String(f.label ?? "").length * 11 * S * 0.62, v.length * 17 * S * 0.6);
    headerSvg += `<text x="${hx}" y="${20 * S}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${11 * S}" font-weight="700" fill="${label}">${esc(String(f.label ?? ""))}</text>`;
    headerSvg += `<text x="${hx}" y="${40 * S}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${17 * S}" font-weight="600" fill="${fg}">${esc(v)}</text>`;
    hx -= lw + 14 * S;
  }
  const b64 = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" rx="${12 * S}" fill="${pass.backgroundColor}"/>
    <image x="${12 * S}" y="0" width="${120 * S}" height="${headerH}" href="${b64(logo)}"/>
    ${headerSvg}
    <image x="0" y="${stripY}" width="${W}" height="${stripH}" href="${b64(strip)}"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
for (const seed of SEEDS) {
  save(`pet${seed}-light-apple-card-front-mock.png`, await composite(seed, false));
  save(`pet${seed}-dark-apple-card-front-mock.png`, await composite(seed, true));
}
console.log(`wrote ${written} files to ${OUT} (CARE chip ${careChip}, face ${usdgFace})`);
