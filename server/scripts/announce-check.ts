/**
 * ONE-TIME ANNOUNCEMENT CHECK (runner/announce.ts, POST/GET/DELETE /internal/announce).
 * An announcement must never ADD a field: the existing event line (lastEvent) CHANGES to the text
 * and carries changeMessage "%@" only while it shows the ACTIVE announcement. This pins: auth,
 * dryRun, text validation, the field KEY SET is unchanged on a targeted card (storeCard and
 * posterGeneric), non-targets are untouched, a pending reminder is never overwritten, a care
 * drops the changeMessage, DELETE keeps the value and drops the changeMessage, a repeat skips
 * pets already showing the text, memorials are untouched, the active text survives a restart,
 * and ALBUM_NOTE_MODE=off removes the album note from the named serial only.
 * Real handlers, in-memory store + MockChain.
 *
 * Run: npx tsx scripts/announce-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://an:an@localhost:5432/an";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.INTERNAL_STATUS_TOKEN = "announce-check-token";
process.env.POSTER_GENERIC_ENABLED = "true";
process.env.ALBUM_ENABLED = "false";
process.env.ALBUM_SERIALS = "";
process.env.ALBUM_ANNOUNCE = "off";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { assembleRunnerPass } = await import("../src/runner/pass.js");
const { stablePassInputs } = await import("../src/runner/pass-memory.js");
const { getRunnerGoogle } = await import("../src/runner/google.js");
const { checkInLine } = await import("../src/runner/reminders.js");
const { _resetAnnouncementCache } = await import("../src/runner/announce.js");
const { stopAlbumRenderer } = await import("../src/runner/album.js");
import type { AppContext } from "../src/context.js";
import type { Runner } from "../src/store/types.js";
import type { AddressInfo } from "node:net";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const store = new InMemoryStore();
const relayer = new Relayer(new MockChain());
const ctx = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
(config as { PUBLIC_BASE_URL: string }).PUBLIC_BASE_URL = base;
const TOKEN = "announce-check-token";

// Record every Google message instead of calling the API.
const googleMessages: Array<{ serial: string; header: string; body: string; notify: boolean }> = [];
const google = getRunnerGoogle() as unknown as { addMessage: (r: Runner, h: string, b: string, n?: boolean) => Promise<void> };
google.addMessage = async (r, header, body, notify = false) => {
  googleMessages.push({ serial: r.serial, header, body, notify });
};

async function mint(email: string): Promise<Runner> {
  const co = (await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }).then((r) => r.json())) as { id: string };
  let runner = await store.getRunner(co.id);
  for (let i = 0; i < 60 && runner?.status !== "ready"; i++) {
    await sleep(25);
    runner = await store.getRunner(co.id);
  }
  return runner!;
}

const api = (method: string, body?: unknown, token: string | null = TOKEN) =>
  fetch(`${base}/internal/announce`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

async function waitDone(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const s = (await (await api("GET")).json()) as Record<string, unknown>;
    if (!s.running) return s;
    await sleep(25);
  }
  throw new Error("announcement run never finished");
}

type F = { key: string; value?: string; changeMessage?: string; attributedValue?: string };
type PJ = Record<string, Record<string, F[]> | unknown>;
/** The pass exactly as the Wallet web service builds it (stablePassInputs feeds the announcement). */
async function served(serial: string): Promise<PJ> {
  const r = (await store.getRunner(serial))!;
  return (await assembleRunnerPass(r, await stablePassInputs(ctx, r))).passJson as PJ;
}
const SECTIONS = ["headerFields", "primaryFields", "secondaryFields", "auxiliaryFields", "footerFields", "backFields"];
function keySet(p: PJ): string {
  const out: string[] = [];
  for (const dict of ["storeCard", "posterGeneric"]) {
    const d = p[dict] as Record<string, F[]> | undefined;
    for (const sec of SECTIONS) for (const f of d?.[sec] ?? []) out.push(`${dict}.${sec}.${f.key}`);
  }
  return out.sort().join("|");
}
const statusIn = (p: PJ, dict: "storeCard" | "posterGeneric", sec: "auxiliaryFields" | "footerFields") =>
  ((p[dict] as Record<string, F[]> | undefined)?.[sec] ?? []).find((f) => f.key === "status");
// Time-derived values (lock-screen dates) move between two builds; everything else must match.
const stable = (p: PJ) => JSON.stringify(p, (k, v) => (k === "relevantDate" || k === "relevantDates" ? undefined : v));

try {
  const a = await mint("a@walletchi.test"); // targeted
  const b = await mint("b@walletchi.test"); // targeted
  const other = await mint("other@walletchi.test"); // never targeted
  const alert = await mint("alert@walletchi.test"); // pending reminder
  const dead = await mint("dead@walletchi.test"); // memorial
  await store.updateRunner(a.serial, { lastEvent: "Napping in the sun." });
  await store.updateRunner(alert.serial, { lastEvent: checkInLine(6 * 3600, ["Water"]) });
  await store.updateRunner(dead.serial, { gone: true, lastEvent: "In memory. Thank you for the care it knew." });
  const TEXT = "CHI NIGHT is live tonight. Tap Play on the back of your card.";

  console.log("\nauth");
  check("no bearer is 401", (await api("GET", undefined, null)).status === 401);
  check("a wrong bearer is 401", (await api("POST", { text: TEXT, all: true }, "nope")).status === 401);
  check("DELETE without a bearer is 401", (await api("DELETE", undefined, null)).status === 401);

  console.log("\ntext and target validation");
  const bad: Array<[string, unknown]> = [
    ["empty", ""],
    ["too long (141)", "x".repeat(141)],
    ["markup <", "Hello <b>you</b>"],
    ["a control char", "Hello\u0007you"],
    ["a line break", "Hello\nyou"],
    ["an em dash", "Hello \u2014 you"],
    ["a double hyphen", `Hello ${"-".repeat(2)} you`],
    ["a reminder-shaped line", "Daily care time for everyone"],
    ["not a string", 42],
  ];
  for (const [why, text] of bad) {
    check(`rejects ${why}`, (await api("POST", { text, all: true })).status === 400);
  }
  check("accepts exactly 140 chars (dry run)", (await api("POST", { text: "x".repeat(140), all: true, dryRun: true })).status === 200);
  check("rejects neither serials nor all", (await api("POST", { text: TEXT })).status === 400);
  check("rejects both serials and all", (await api("POST", { text: TEXT, all: true, serials: [a.serial] })).status === 400);
  check("rejects an empty serials list", (await api("POST", { text: TEXT, serials: [] })).status === 400);
  check("rejects a non-string serial", (await api("POST", { text: TEXT, serials: [1] })).status === 400);

  // Baselines, before anything is announced.
  const aBefore = await served(a.serial);
  const otherRow = JSON.stringify(await store.getRunner(other.serial));
  const otherBefore = stable(await served(other.serial));
  const alertRow = JSON.stringify(await store.getRunner(alert.serial));
  const deadRow = JSON.stringify(await store.getRunner(dead.serial));
  const deadBefore = stable(await served(dead.serial));

  console.log("\ndry run");
  const dry = (await (await api("POST", { text: TEXT, all: true, dryRun: true })).json()) as Record<string, unknown>;
  const ws = dry.wouldSkip as Record<string, number>;
  check("all: targets every living pet (memorial excluded)", dry.total === 4, JSON.stringify(dry));
  check("dry run counts the reminder pet as a skip", ws.reminder === 1 && dry.wouldAnnounce === 3);
  check("dry run changes nothing", (await (await api("GET")).json() as { active: unknown }).active === null && JSON.stringify(await store.getRunner(other.serial)) === otherRow && googleMessages.length === 0);

  console.log("\nannounce to named serials (two targets, one reminder pet, one memorial, one unknown)");
  const post = await api("POST", { text: TEXT, serials: [a.serial, b.serial, alert.serial, dead.serial, "no-such-pet"] });
  check("POST starts the run (202)", post.status === 202);
  check("a second POST while running is 409", (await api("POST", { text: TEXT, all: true })).status === 409);
  const done = await waitDone();
  const sr = done.skippedReasons as Record<string, number>;
  check("progress: total 5, done 5, skipped 3, failed 0", done.total === 5 && done.done === 5 && done.skipped === 3 && done.failed === 0, JSON.stringify(done));
  check("skips: reminder 1, memorial 1, unknown 1", sr.reminder === 1 && sr.notLiving === 1 && sr.notFound === 1);
  check("GET reports the active text", done.active === TEXT);

  const aAfter = await served(a.serial);
  const sc = statusIn(aAfter, "storeCard", "auxiliaryFields");
  const pg = statusIn(aAfter, "posterGeneric", "footerFields");
  check("storeCard event line = text with changeMessage %@", sc?.value === TEXT && sc.changeMessage === "%@");
  check("posterGeneric footer event line = text with changeMessage %@", pg?.value === TEXT && pg.changeMessage === "%@");
  check("the field KEY SET is identical to before (nothing added or removed)", keySet(aAfter) === keySet(aBefore), `${keySet(aAfter).split("|").length} keys`);
  const changedChangeMessages = JSON.stringify(aAfter).match(/"changeMessage"/g)?.length ?? 0;
  check("the event line is the only field with a changeMessage", changedChangeMessages === 2, `${changedChangeMessages} (storeCard + poster footer, same field)`);
  check("b got it too", statusIn(await served(b.serial), "storeCard", "auxiliaryFields")?.value === TEXT);
  check(
    "Google: exactly ONE notifying message per announced pet, same text",
    googleMessages.length === 2 &&
      googleMessages.every((m) => m.body === TEXT && m.notify && m.header === "WALLETCHI") &&
      new Set(googleMessages.map((m) => m.serial)).size === 2 &&
      googleMessages.some((m) => m.serial === a.serial) &&
      googleMessages.some((m) => m.serial === b.serial),
    JSON.stringify(googleMessages.map((m) => m.serial.slice(0, 6))),
  );
  check("non-target: row byte-identical (Last-Modified did not move)", JSON.stringify(await store.getRunner(other.serial)) === otherRow);
  check("non-target: served pass identical", stable(await served(other.serial)) === otherBefore);
  check("reminder pet: row byte-identical (the reminder stands)", JSON.stringify(await store.getRunner(alert.serial)) === alertRow);
  check("memorial: row byte-identical", JSON.stringify(await store.getRunner(dead.serial)) === deadRow);
  check("memorial: served pass identical", stable(await served(dead.serial)) === deadBefore);

  console.log("\nrestart-safe");
  _resetAnnouncementCache();
  const aRestart = statusIn(await served(a.serial), "storeCard", "auxiliaryFields");
  check("after a simulated restart the line still carries %@", aRestart?.value === TEXT && aRestart.changeMessage === "%@");
  check("and the pass is unchanged by the restart", stable(await served(a.serial)) === stable(aAfter));

  console.log("\nrepeat");
  googleMessages.length = 0;
  const bRow = JSON.stringify(await store.getRunner(b.serial));
  await api("POST", { text: TEXT, serials: [a.serial, b.serial] });
  const rep = await waitDone();
  check("repeating the same announcement skips both (already showing it)", (rep.skippedReasons as Record<string, number>).already === 2 && rep.skipped === 2);
  check("no message and no row write on a repeat", googleMessages.length === 0 && JSON.stringify(await store.getRunner(b.serial)) === bRow);

  console.log("\na care replaces the line");
  await store.updateRunner(b.serial, { lastEvent: "Fed. Mochi is happy." });
  const bCare = statusIn(await served(b.serial), "storeCard", "auxiliaryFields");
  check("the care line is a normal line (no changeMessage)", bCare?.value === "Fed. Mochi is happy." && bCare.changeMessage === undefined);

  console.log("\nDELETE");
  const del = await api("DELETE");
  check("DELETE clears the active announcement", del.status === 200 && ((await del.json()) as { active: unknown }).active === null);
  const aDel = await served(a.serial);
  const aDelLine = statusIn(aDel, "storeCard", "auxiliaryFields");
  const aDelPoster = statusIn(aDel, "posterGeneric", "footerFields");
  check("a card still showing the text keeps the SAME value", aDelLine?.value === TEXT && aDelPoster?.value === TEXT);
  check("and loses the changeMessage in both dictionaries (silent)", aDelLine?.changeMessage === undefined && aDelPoster?.changeMessage === undefined);
  check("key set still identical", keySet(aDel) === keySet(aBefore));
  _resetAnnouncementCache();
  check("the clear survives a restart too", statusIn(await served(a.serial), "storeCard", "auxiliaryFields")?.changeMessage === undefined);

  console.log("\na new announcement replaces the old one");
  const NEXT = "Season two starts Friday.";
  await api("POST", { text: NEXT, all: true });
  await waitDone();
  check("an announced card shows the new text with %@", statusIn(await served(a.serial), "storeCard", "auxiliaryFields")?.changeMessage === "%@");
  await store.updateRunner(other.serial, { lastEvent: TEXT });
  check("a card still on the OLD text has no changeMessage", statusIn(await served(other.serial), "storeCard", "auxiliaryFields")?.changeMessage === undefined);
  await api("DELETE");

  console.log("\nALBUM_NOTE_MODE=off");
  const cfg = config as { ALBUM_ENABLED: boolean; ALBUM_ANNOUNCE: string; ALBUM_NOTE_SERIALS?: string; ALBUM_NOTE_MODE: string };
  cfg.ALBUM_ENABLED = true;
  cfg.ALBUM_ANNOUNCE = "prime";
  const back = async (s: string) => (((await served(s)).storeCard as Record<string, F[]>).backFields ?? []);
  const bAlbumBefore = JSON.stringify(await back(b.serial));
  check("with prime for everyone, both cards carry the note", (await back(a.serial)).some((f) => f.key === "albumNote") && (await back(b.serial)).some((f) => f.key === "albumNote"));
  cfg.ALBUM_NOTE_SERIALS = a.serial;
  cfg.ALBUM_NOTE_MODE = "off";
  const aBack = await back(a.serial);
  check("off: the named serial loses the note", !aBack.some((f) => f.key === "albumNote"));
  check("off: the named serial keeps the album link", aBack.some((f) => f.key === "album"));
  check("off: every other card is byte-identical (note stays)", JSON.stringify(await back(b.serial)) === bAlbumBefore);
  check("the schema accepts off", (await import("zod")).z.enum(["off", "prime", "quiet", "banner"]).safeParse(config.ALBUM_NOTE_MODE).success);
  cfg.ALBUM_NOTE_SERIALS = "";
  cfg.ALBUM_NOTE_MODE = "prime";
  cfg.ALBUM_ENABLED = false;
  cfg.ALBUM_ANNOUNCE = "off";
} finally {
  stopAlbumRenderer();
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
