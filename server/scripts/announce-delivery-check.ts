/**
 * ANNOUNCEMENT DELIVERY RECORD + MEMORIAL EVENT LINE CHECK (runner/announce.ts,
 * runner/memorial-line.ts, POST /internal/announce).
 *
 * (a) DELIVERY RECORD. "Already got it" is a per-card record, not "the line still shows the text":
 *     once a card's line moved on (a care), a re-run of the same text must still skip it; the dry
 *     run counts those as already; a card skipped for a reminder gets the text on a re-run once its
 *     line is free; the record is written BEFORE the push (observed from inside the Google message
 *     hook); the record survives a simulated restart.
 * (b) MEMORIAL LINE. Flag OFF: the FULL passJson of a memorial (and of a living pet) is identical
 *     with and without the switches, and a memorial is skipped (notLiving) by an announcement.
 *     Flag ON (serial, then everyone): the `status` field sits in storeCard.auxiliaryFields AFTER
 *     OUTLASTED / IN MEMORY and alone in posterGeneric.footerFields, the poster primary row keeps
 *     its four fields and no status, no changeMessage unless the line shows the ACTIVE
 *     announcement, an announcement reaches the tombstone (Apple line + ONE notifying Google
 *     message), a tombstone outside the serial list is byte-identical, DELETE keeps the value and
 *     drops the changeMessage on living cards, DELETE silently restores an announced tombstone's
 *     line to the memorial sentence (no changeMessage, no message, living cards and other
 *     tombstones untouched), and switching the flags back off restores the exact bytes of a
 *     tombstone that was never announced.
 *
 * Real handlers, in-memory store + MockChain by default. With CHECK_STORE=prisma the same cases
 * run against PrismaStore on the Postgres DATABASE_URL points at (migrations applied), so the two
 * store methods are proven on both stores.
 *
 * Run: npx tsx scripts/announce-delivery-check.ts
 *      CHECK_STORE=prisma DATABASE_URL=postgres://... npx tsx scripts/announce-delivery-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://ad:ad@localhost:5432/ad";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.INTERNAL_STATUS_TOKEN = "announce-delivery-check-token";
process.env.POSTER_GENERIC_ENABLED = "true";
process.env.ALBUM_ENABLED = "false";
process.env.ALBUM_SERIALS = "";
process.env.ALBUM_ANNOUNCE = "off";
process.env.MEMORIAL_LINE_ENABLED = "false";
process.env.MEMORIAL_LINE_SERIALS = "";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { PrismaStore, getPrisma } = await import("../src/store/prisma.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { assembleRunnerPass } = await import("../src/runner/pass.js");
const { stablePassInputs } = await import("../src/runner/pass-memory.js");
const { getRunnerGoogle } = await import("../src/runner/google.js");
const { checkInLine } = await import("../src/runner/reminders.js");
const { _resetAnnouncementCache, memorialResetState } = await import("../src/runner/announce.js");
const { MEMORIAL_IDLE_LINE, memorialLineEnabledFor } = await import("../src/runner/memorial-line.js");
const { RUNNER_THEME, MEMORIAL_COPY } = await import("../src/runner/theme.js");
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

const usePrisma = process.env.CHECK_STORE === "prisma";
const prisma = usePrisma ? getPrisma() : null;
const store = prisma ? new PrismaStore(prisma) : new InMemoryStore();
console.log(`store: ${usePrisma ? "PrismaStore (Postgres)" : "InMemoryStore"}`);
const relayer = new Relayer(new MockChain());
const ctx = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
(config as { PUBLIC_BASE_URL: string }).PUBLIC_BASE_URL = base;
const TOKEN = "announce-delivery-check-token";
const cfg = config as { MEMORIAL_LINE_ENABLED: boolean; MEMORIAL_LINE_SERIALS?: string };

// Record every Google message instead of calling the API, and note whether the delivery record
// already held the serial at the moment the message went out (record BEFORE push).
const googleMessages: Array<{ serial: string; header: string; body: string; notify: boolean; recordedFirst: boolean }> = [];
const google = getRunnerGoogle() as unknown as {
  addMessage: (r: Runner, h: string, b: string, n?: boolean) => Promise<void>;
  patchObject: (r: Runner, o?: unknown) => Promise<void>;
};
google.addMessage = async (r, header, body, notify = false) => {
  const recordedFirst = (await store.listAnnouncementDeliveries(body)).has(r.serial);
  googleMessages.push({ serial: r.serial, header, body, notify, recordedFirst });
};
// Every card push (silent or not) patches the Google object: record which serials were pinged.
const googlePings: string[] = [];
google.patchObject = async (r) => {
  googlePings.push(r.serial);
};

// Unique per run so a Prisma run against a reused database never collides with an earlier one.
const RUN = Date.now().toString(36);
async function mint(tag: string): Promise<Runner> {
  const co = (await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${tag}-${RUN}@walletchi.test` }),
  }).then((r) => r.json())) as { id: string };
  let runner = await store.getRunner(co.id);
  for (let i = 0; i < 60 && runner?.status !== "ready"; i++) {
    await sleep(25);
    runner = await store.getRunner(co.id);
  }
  if (runner?.status !== "ready") throw new Error(`mint never became ready for ${tag}`);
  return runner;
}

const api = (method: string, body?: unknown, token: string | null = TOKEN) =>
  fetch(`${base}/internal/announce`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

async function waitDone(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i++) {
    const s = (await (await api("GET")).json()) as Record<string, unknown>;
    if (!s.running) return s;
    await sleep(25);
  }
  throw new Error("announcement run never finished");
}
const reasons = (s: Record<string, unknown>) => s.skippedReasons as Record<string, number>;

type F = { key: string; label?: string; value?: string; changeMessage?: string; attributedValue?: string };
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
const section = (p: PJ, dict: "storeCard" | "posterGeneric", sec: string): F[] =>
  (p[dict] as Record<string, F[]> | undefined)?.[sec] ?? [];
const statusIn = (p: PJ, dict: "storeCard" | "posterGeneric", sec: "auxiliaryFields" | "footerFields") =>
  section(p, dict, sec).find((f) => f.key === "status");
// Time-derived values (lock-screen dates) move between two builds; everything else must match.
// For a memorial nothing is time-derived, so this is the FULL passJson.
const stable = (p: PJ) => JSON.stringify(p, (k, v) => (k === "relevantDate" || k === "relevantDates" ? undefined : v));
const changeMessages = (p: PJ) => JSON.stringify(p).match(/"changeMessage"/g)?.length ?? 0;
const DEATH_LINE = MEMORIAL_COPY.memorialLine;

try {
  const a = await mint("a"); // living target
  const b = await mint("b"); // living target
  const alert = await mint("alert"); // living, pending reminder
  const other = await mint("other"); // living, never targeted
  const dead = await mint("dead"); // memorial, gets the line by serial
  const deadOff = await mint("deadoff"); // memorial, never in the serial list
  const deadBlank = await mint("deadblank"); // memorial with no last event at all
  await store.updateRunner(a.serial, { lastEvent: "Napping in the sun." });
  await store.updateRunner(alert.serial, { lastEvent: checkInLine(6 * 3600, ["Water"]) });
  await store.updateRunner(dead.serial, { gone: true, lastEvent: DEATH_LINE, deathRank: 3 });
  await store.updateRunner(deadOff.serial, { gone: true, lastEvent: DEATH_LINE, deathRank: 0 });
  await store.updateRunner(deadBlank.serial, { gone: true, lastEvent: null, deathRank: 0 });
  const TEXT = `CHI NIGHT is live tonight. Tap Play on the back of your card. (${RUN})`;
  const TEXT2 = `Memorial keepers: CHI NIGHT is on your card too. (${RUN})`;

  console.log("\nstore: the two delivery methods");
  check("nothing recorded for a fresh text", (await store.listAnnouncementDeliveries(TEXT)).size === 0);
  await store.recordAnnouncementDelivery(other.serial, `probe ${RUN}`);
  await store.recordAnnouncementDelivery(other.serial, `probe ${RUN}`);
  const probe = await store.listAnnouncementDeliveries(`probe ${RUN}`);
  check("record is idempotent and list returns the serial once", probe.size === 1 && probe.has(other.serial));
  check("a different text is a different record", (await store.listAnnouncementDeliveries(`probe2 ${RUN}`)).size === 0);
  const otherRowAfterRecord = JSON.stringify(await store.getRunner(other.serial));

  console.log("\n(a) delivery record: first run");
  const r1 = await api("POST", { text: TEXT, serials: [a.serial, b.serial, alert.serial] });
  check("POST starts the run (202)", r1.status === 202);
  const d1 = await waitDone();
  check("a and b announced, the reminder pet skipped", d1.done === 3 && d1.skipped === 1 && reasons(d1).reminder === 1 && d1.failed === 0, JSON.stringify(d1));
  const rec1 = await store.listAnnouncementDeliveries(TEXT);
  check("the record holds a and b, not the reminder pet", rec1.size === 2 && rec1.has(a.serial) && rec1.has(b.serial) && !rec1.has(alert.serial));
  check("the record was written BEFORE the Google message went out", googleMessages.length === 2 && googleMessages.every((m) => m.recordedFirst));
  check("recording never moved the untouched pet's row", JSON.stringify(await store.getRunner(other.serial)) === otherRowAfterRecord);

  console.log("\n(a) the line moves on, the record stays");
  await store.updateRunner(a.serial, { lastEvent: "Fed. Mochi is happy." });
  const aRow = JSON.stringify(await store.getRunner(a.serial));
  const bRow = JSON.stringify(await store.getRunner(b.serial));
  googleMessages.length = 0;
  const dry1 = (await (await api("POST", { text: TEXT, serials: [a.serial, b.serial, alert.serial], dryRun: true })).json()) as Record<string, unknown>;
  const ws1 = dry1.wouldSkip as Record<string, number>;
  check("dry run: a (record, line moved on) and b (record) are already; the reminder pet still a reminder", ws1.already === 2 && ws1.reminder === 1 && dry1.wouldAnnounce === 0, JSON.stringify(dry1));
  await api("POST", { text: TEXT, serials: [a.serial, b.serial, alert.serial] });
  const d2 = await waitDone();
  check("re-run: nothing sent, already 2, reminder 1", d2.skipped === 3 && reasons(d2).already === 2 && reasons(d2).reminder === 1 && googleMessages.length === 0, JSON.stringify(d2));
  check("re-run: a's row untouched (its care line stands)", JSON.stringify(await store.getRunner(a.serial)) === aRow);
  check("re-run: b's row untouched", JSON.stringify(await store.getRunner(b.serial)) === bRow);
  const aLine = statusIn(await served(a.serial), "storeCard", "auxiliaryFields");
  check("a's card shows its care line, no changeMessage", aLine?.value === "Fed. Mochi is happy." && aLine.changeMessage === undefined);

  console.log("\n(a) the reminder clears: the re-run reaches that card once");
  await store.updateRunner(alert.serial, { lastEvent: "Napping." });
  const dry2 = (await (await api("POST", { text: TEXT, serials: [a.serial, b.serial, alert.serial], dryRun: true })).json()) as Record<string, unknown>;
  check("dry run: exactly the freed card would be announced", dry2.wouldAnnounce === 1 && (dry2.wouldSkip as Record<string, number>).already === 2, JSON.stringify(dry2));
  await api("POST", { text: TEXT, serials: [a.serial, b.serial, alert.serial] });
  const d3 = await waitDone();
  check("run: one announced, two already", d3.skipped === 2 && reasons(d3).already === 2 && d3.failed === 0 && d3.done === 3, JSON.stringify(d3));
  check("Google: exactly ONE notifying message, for the freed card, record written first", googleMessages.length === 1 && googleMessages[0]!.serial === alert.serial && googleMessages[0]!.notify && googleMessages[0]!.recordedFirst);
  const alertLine = statusIn(await served(alert.serial), "storeCard", "auxiliaryFields");
  check("the freed card's line = text with changeMessage %@", alertLine?.value === TEXT && alertLine.changeMessage === "%@");
  check("the record now holds all three", (await store.listAnnouncementDeliveries(TEXT)).size === 3);
  check("a (already recorded) kept its care line", JSON.stringify(await store.getRunner(a.serial)) === aRow);

  console.log("\n(a) a card that got it and then earned a reminder is already, not reminder");
  await store.updateRunner(b.serial, { lastEvent: checkInLine(6 * 3600, ["Food"]) });
  const dry3 = (await (await api("POST", { text: TEXT, serials: [b.serial], dryRun: true })).json()) as Record<string, unknown>;
  check("dry run counts it as already", (dry3.wouldSkip as Record<string, number>).already === 1 && (dry3.wouldSkip as Record<string, number>).reminder === 0, JSON.stringify(dry3));
  await store.updateRunner(b.serial, { lastEvent: TEXT });

  console.log("\n(a) restart-safe");
  _resetAnnouncementCache();
  googleMessages.length = 0;
  await api("POST", { text: TEXT, serials: [a.serial, b.serial, alert.serial] });
  const d4 = await waitDone();
  check("after a simulated restart the same text is still already for all three", reasons(d4).already === 3 && googleMessages.length === 0, JSON.stringify(d4));

  console.log("\n(a) a new text is a new record");
  const dryNew = (await (await api("POST", { text: TEXT2, serials: [a.serial], dryRun: true })).json()) as Record<string, unknown>;
  check("a different text would reach a recorded card", dryNew.wouldAnnounce === 1, JSON.stringify(dryNew));
  await api("DELETE");

  console.log("\n(b) memorial line OFF: byte-identical and untouchable");
  check("the flag is off by default", !cfg.MEMORIAL_LINE_ENABLED && !cfg.MEMORIAL_LINE_SERIALS && !memorialLineEnabledFor(await store.getRunner(dead.serial) as Runner));
  const deadOffBytes = stable(await served(dead.serial));
  const deadOff2Bytes = stable(await served(deadOff.serial));
  const deadBlankBytes = stable(await served(deadBlank.serial));
  check("a memorial card has no event line in storeCard or poster", !statusIn(await served(dead.serial), "storeCard", "auxiliaryFields") && !statusIn(await served(dead.serial), "posterGeneric", "footerFields"));
  const deadRow = JSON.stringify(await store.getRunner(dead.serial));
  googleMessages.length = 0;
  const dryOff = (await (await api("POST", { text: TEXT2, all: true, dryRun: true })).json()) as Record<string, unknown>;
  check("all: no memorial is a target while the flag is off", dryOff.total === 4, JSON.stringify(dryOff));
  await api("POST", { text: TEXT2, serials: [dead.serial] });
  const dOff = await waitDone();
  check("a memorial named directly is skipped as notLiving", reasons(dOff).notLiving === 1 && dOff.skipped === 1 && googleMessages.length === 0, JSON.stringify(dOff));
  check("memorial row byte-identical", JSON.stringify(await store.getRunner(dead.serial)) === deadRow);
  check("memorial FULL passJson byte-identical (announcement active, flag off)", stable(await served(dead.serial)) === deadOffBytes);
  check("no delivery recorded for the skipped memorial", !(await store.listAnnouncementDeliveries(TEXT2)).has(dead.serial));
  await api("DELETE");

  console.log("\n(b) memorial line ON for one serial");
  const aBytesOff = stable(await served(a.serial));
  cfg.MEMORIAL_LINE_SERIALS = dead.serial;
  check("the helper is true for the named tombstone only", memorialLineEnabledFor({ serial: dead.serial, gone: true }) && !memorialLineEnabledFor({ serial: deadOff.serial, gone: true }) && !memorialLineEnabledFor({ serial: dead.serial, gone: false }));
  const deadOn = await served(dead.serial);
  const aux = section(deadOn, "storeCard", "auxiliaryFields");
  check("storeCard.auxiliaryFields = OUTLASTED then status", aux.length === 2 && aux[0]!.key === "outlasted" && aux[1]!.key === "status", JSON.stringify(aux.map((f) => f.key)));
  check("the line reads the pet's last event with the pet label and no changeMessage", aux[1]!.value === DEATH_LINE && aux[1]!.label === RUNNER_THEME.petLabel && aux[1]!.changeMessage === undefined);
  const primary = section(deadOn, "posterGeneric", "primaryFields");
  const footer = section(deadOn, "posterGeneric", "footerFields");
  check("poster primary still STATUS, LIVED, CARED, OUTLASTED (four, no status line)", primary.map((f) => f.key).join(",") === "petstatus,lived,cared,outlasted", primary.map((f) => f.key).join(","));
  check("poster footer is exactly the memorial line", footer.length === 1 && footer[0]!.key === "status" && footer[0]!.value === DEATH_LINE && footer[0]!.changeMessage === undefined);
  check("secondary and header unchanged by the flag", JSON.stringify(section(deadOn, "storeCard", "secondaryFields")) === JSON.stringify(section(JSON.parse(deadOffBytes) as PJ, "storeCard", "secondaryFields")) && JSON.stringify(section(deadOn, "storeCard", "headerFields")) === JSON.stringify(section(JSON.parse(deadOffBytes) as PJ, "storeCard", "headerFields")));
  check("the ONLY difference from the off bytes is the added line (storeCard aux + poster footer)", keySet(deadOn) === [...keySet(JSON.parse(deadOffBytes) as PJ).split("|"), "storeCard.auxiliaryFields.status", "posterGeneric.footerFields.status"].sort().join("|"));
  check("no changeMessage anywhere on the memorial", changeMessages(deadOn) === 0);
  check("the tombstone outside the list is byte-identical", stable(await served(deadOff.serial)) === deadOff2Bytes);
  check("a living card is byte-identical", stable(await served(a.serial)) === aBytesOff);
  cfg.MEMORIAL_LINE_SERIALS = deadBlank.serial;
  const blankOn = await served(deadBlank.serial);
  const blankAux = section(blankOn, "storeCard", "auxiliaryFields");
  check("a memorial with no last event shows the idle line after IN MEMORY", blankAux.length === 2 && blankAux[0]!.key === "memory" && blankAux[1]!.key === "status" && blankAux[1]!.value === MEMORIAL_IDLE_LINE, JSON.stringify(blankAux.map((f) => [f.key, f.value])));
  check("the idle line is short", MEMORIAL_IDLE_LINE.length <= 20 && !MEMORIAL_IDLE_LINE.includes(String.fromCharCode(0x2014)) && !MEMORIAL_IDLE_LINE.includes("-".repeat(2)), JSON.stringify(MEMORIAL_IDLE_LINE));
  cfg.MEMORIAL_LINE_SERIALS = dead.serial;

  console.log("\n(b) announce to the tombstone");
  googleMessages.length = 0;
  const deadOffRow = JSON.stringify(await store.getRunner(deadOff.serial));
  const dryOn = (await (await api("POST", { text: TEXT2, all: true, dryRun: true })).json()) as Record<string, unknown>;
  check("all: the named tombstone is a target, the other two are not", dryOn.total === 5, JSON.stringify(dryOn));
  await api("POST", { text: TEXT2, serials: [dead.serial, deadOff.serial] });
  const dOn = await waitDone();
  check("the named tombstone is announced, the other skipped as notLiving", dOn.done === 2 && dOn.skipped === 1 && reasons(dOn).notLiving === 1 && dOn.failed === 0, JSON.stringify(dOn));
  const deadAnn = await served(dead.serial);
  const scLine = statusIn(deadAnn, "storeCard", "auxiliaryFields");
  const pgLine = statusIn(deadAnn, "posterGeneric", "footerFields");
  check("storeCard memorial line = text with changeMessage %@", scLine?.value === TEXT2 && scLine.changeMessage === "%@");
  check("poster footer memorial line = text with changeMessage %@", pgLine?.value === TEXT2 && pgLine.changeMessage === "%@");
  check("the memorial line is the only field with a changeMessage", changeMessages(deadAnn) === 2);
  check("key set unchanged by the announcement", keySet(deadAnn) === keySet(deadOn));
  check("Google: exactly ONE notifying message for the tombstone, record written first", googleMessages.length === 1 && googleMessages[0]!.serial === dead.serial && googleMessages[0]!.notify && googleMessages[0]!.body === TEXT2 && googleMessages[0]!.recordedFirst);
  check("the delivery is recorded for the tombstone", (await store.listAnnouncementDeliveries(TEXT2)).has(dead.serial));
  check("the other tombstone's row is byte-identical", JSON.stringify(await store.getRunner(deadOff.serial)) === deadOffRow);
  check("and its pass too", stable(await served(deadOff.serial)) === deadOff2Bytes);
  _resetAnnouncementCache();
  check("the tombstone's banner survives a restart", statusIn(await served(dead.serial), "storeCard", "auxiliaryFields")?.changeMessage === "%@");
  googleMessages.length = 0;
  await api("POST", { text: TEXT2, serials: [dead.serial] });
  check("a repeat is already (record), no message", reasons(await waitDone()).already === 1 && googleMessages.length === 0);

  console.log("\n(b) memorial line ON for everyone");
  cfg.MEMORIAL_LINE_ENABLED = true;
  const dryAll = (await (await api("POST", { text: TEXT2, all: true, dryRun: true })).json()) as Record<string, unknown>;
  check("all: every tombstone is a target, the announced one already", dryAll.total === 7 && (dryAll.wouldSkip as Record<string, number>).already === 1, JSON.stringify(dryAll));
  check("the unlisted tombstone now carries the line, silent", statusIn(await served(deadOff.serial), "storeCard", "auxiliaryFields")?.value === DEATH_LINE && changeMessages(await served(deadOff.serial)) === 0);

  console.log("\n(b) DELETE: living cards keep the value; an announced tombstone goes back to its memorial line, silently");
  check("the sentence a pet dies with is one constant, distinct from the epitaph", (MEMORIAL_COPY.memorialLine as string) === DEATH_LINE && (MEMORIAL_COPY.memorialLine as string) !== (MEMORIAL_COPY.epitaph as string));
  // A living card that shows the same text (as if announced), and the tombstones that do not.
  await store.updateRunner(other.serial, { lastEvent: TEXT2 });
  const otherRowDel = JSON.stringify(await store.getRunner(other.serial));
  const deadOffRowDel = JSON.stringify(await store.getRunner(deadOff.serial));
  const deadBlankRowDel = JSON.stringify(await store.getRunner(deadBlank.serial));
  googleMessages.length = 0;
  googlePings.length = 0;
  const del = await api("DELETE");
  check("DELETE answers with no active text", del.status === 200 && ((await del.json()) as { active: unknown }).active === null);
  for (let i = 0; i < 200 && (memorialResetState().running || (await store.getRunner(dead.serial))!.lastEvent === TEXT2); i++) await sleep(25);
  const reset = memorialResetState();
  check("the reset walked exactly the one tombstone that showed the text", reset.total === 1 && reset.done === 1 && reset.failed === 0 && !reset.running, JSON.stringify(reset));
  const deadDel = await served(dead.serial);
  check("the tombstone's line is the memorial sentence again, in both dictionaries", statusIn(deadDel, "storeCard", "auxiliaryFields")?.value === DEATH_LINE && statusIn(deadDel, "posterGeneric", "footerFields")?.value === DEATH_LINE);
  check("no changeMessage anywhere on it (silent value change)", changeMessages(deadDel) === 0);
  check("its card was pinged once with NO message", googlePings.filter((x) => x === dead.serial).length === 1 && googleMessages.length === 0, JSON.stringify(googlePings.map((x) => x.slice(0, 6))));
  check("the delivery record for the tombstone stands (a re-run would still skip it)", (await store.listAnnouncementDeliveries(TEXT2)).has(dead.serial));
  const otherDel = await served(other.serial);
  check("a living card showing the text keeps it (row byte-identical, not pinged)", JSON.stringify(await store.getRunner(other.serial)) === otherRowDel && !googlePings.includes(other.serial));
  check("and loses only the changeMessage", statusIn(otherDel, "storeCard", "auxiliaryFields")?.value === TEXT2 && changeMessages(otherDel) === 0);
  check("tombstones not showing the text are untouched (rows byte-identical, not pinged)", JSON.stringify(await store.getRunner(deadOff.serial)) === deadOffRowDel && JSON.stringify(await store.getRunner(deadBlank.serial)) === deadBlankRowDel && !googlePings.includes(deadOff.serial) && !googlePings.includes(deadBlank.serial));
  check("a DELETE with nothing active resets nothing", (await api("DELETE")).status === 200 && memorialResetState().total === 1);
  await store.updateRunner(other.serial, { lastEvent: "Napping." });

  console.log("\n(b) switches back off: exact bytes restored");
  cfg.MEMORIAL_LINE_ENABLED = false;
  cfg.MEMORIAL_LINE_SERIALS = "";
  check("the never-announced tombstone is byte-identical to the start", stable(await served(deadOff.serial)) === deadOff2Bytes);
  check("the blank tombstone is byte-identical to the start", stable(await served(deadBlank.serial)) === deadBlankBytes);
  check("the living card is byte-identical to the start", stable(await served(a.serial)) === aBytesOff);
  check("the announced tombstone loses the line again and is byte-identical to the start (its line was restored)", !statusIn(await served(dead.serial), "storeCard", "auxiliaryFields") && stable(await served(dead.serial)) === deadOffBytes);
} finally {
  stopAlbumRenderer();
  server.close();
  if (prisma) await prisma.$disconnect();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
