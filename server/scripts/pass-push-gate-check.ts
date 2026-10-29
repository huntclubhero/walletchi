/**
 * PASS PUSH GATE CHECK (runner/pass-gate.ts, runner/idle.ts pushRunnerPass, runner/apple.ts).
 *
 * iOS 27 warned holders that WALLETCHI passes receive too many updates. The Wallet device logs
 * named three faults; this pins each one against the REAL web service handlers:
 *   1. "pass was unchanged": no push unless the pass the device would download is different.
 *   2. "ignored the if-modified-since header": the pass GET answers 304 when nothing changed, and
 *      Last-Modified is the pass's own last content change.
 *   3. "spurious push ... returned no serial numbers": every push is backed by the list endpoint.
 * THE INVARIANT, checked after every step: for every push we send, the registrations endpoint
 * lists the serial AND the pass GET returns 200 with different content; for every no-change, no
 * push and the pass GET returns 304.
 *
 * Also: quiet hours skip background refreshes but never reminders; care taps still push at once
 * (no debounce, Hunt 2026-10-21); the headcount alone never pushes; the boot refresh pushes
 * nothing on the first boot of this code or when the template hash is unchanged. Google Wallet
 * messages no longer pile up: the active announcement stays pinned plus the newest message, the
 * newest still notifies exactly as before, and a care clears a stale reminder.
 * In-memory store + MockChain, APNs captured at the send hook.
 *
 * Run: npx tsx scripts/pass-push-gate-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://pg:pg@localhost:5432/pg";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.GAME_ENABLED = "false";
process.env.GAME_SERIALS = "";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { pushRunnerPass, _setApplePushSenderForTests, _setPushGateForTests, _setCareRegateMsForTests, _scheduleCareRegateForTests } = await import("../src/runner/idle.js");
const { refreshAllPasses, passRefreshState, runBootRefresh } = await import("../src/runner/pass-refresh.js");
const gate = await import("../src/runner/pass-gate.js");
const { formatUpdatedTag } = await import("../src/runner/pass-time.js");
const { isQuietHour } = await import("../src/runner/quiet.js");
const { assembleRunnerPass } = await import("../src/runner/pass.js");
const { rotateRunnerAuth } = await import("../src/runner/claim.js");
const AdmZip = (await import("adm-zip")).default;
import type { AppContext } from "../src/context.js";
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

// Every APNs send, by token.
const sent: string[] = [];
_setApplePushSenderForTests(async (tokens: string[]) => {
  sent.push(...tokens);
  return tokens.map((token) => ({ token, ok: true, status: 200 }));
});

async function mint(email: string) {
  const co = (await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }).then((r) => r.json())) as { id: string };
  let runner = await store.getRunner(co.id);
  for (let i = 0; i < 80 && runner?.status !== "ready"; i++) {
    await sleep(25);
    runner = await store.getRunner(co.id);
  }
  return runner!;
}

// A simulated iPhone: it holds a sync tag and, per serial, the Last-Modified and content it has.
interface Held {
  lastModified: string | null;
  passJson: string | null;
  /** The authenticationToken inside the copy this phone holds (a claim rotates the pet's). */
  authToken: string;
}
class Phone {
  tag: string | null = null;
  held = new Map<string, Held>();
  constructor(readonly id: string, readonly token: string) {}
  async register(serial: string): Promise<void> {
    await store.upsertRunnerRegistration({ deviceLibraryId: this.id, passTypeId: config.PASS_TYPE_ID, serial, pushToken: this.token });
    this.held.set(serial, { lastModified: null, passJson: null, authToken: (await store.getRunner(serial))!.authToken });
  }
  async list(): Promise<{ status: number; serials: string[]; tag: string | null }> {
    const q = this.tag ? `?passesUpdatedSince=${encodeURIComponent(this.tag)}` : "";
    const r = await fetch(`${base}/runner-apple/v1/devices/${this.id}/registrations/${config.PASS_TYPE_ID}${q}`);
    if (r.status !== 200) return { status: r.status, serials: [], tag: null };
    const b = (await r.json()) as { serialNumbers: string[]; lastUpdated: string };
    return { status: 200, serials: b.serialNumbers, tag: b.lastUpdated };
  }
  async get(serial: string): Promise<{ status: number; lastModified: string | null; passJson: string | null }> {
    const h = this.held.get(serial)!;
    const headers: Record<string, string> = { authorization: `ApplePass ${h.authToken}` };
    if (h?.lastModified) headers["if-modified-since"] = h.lastModified;
    const r = await fetch(`${base}/runner-apple/v1/passes/${config.PASS_TYPE_ID}/${serial}`, { headers });
    if (r.status !== 200) return { status: r.status, lastModified: null, passJson: null };
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: 200, lastModified: r.headers.get("last-modified"), passJson: new AdmZip(buf).readAsText("pass.json") };
  }
  /** What Wallet does on a push: list, then fetch every listed serial. Returns what happened. */
  async onPush(): Promise<{ listed: string[]; fetched: Array<{ serial: string; status: number; changed: boolean }> }> {
    const l = await this.list();
    const fetched: Array<{ serial: string; status: number; changed: boolean }> = [];
    for (const s of l.serials) {
      const g = await this.get(s);
      const before = this.held.get(s)?.passJson ?? null;
      if (g.status === 200) {
        this.held.set(s, { ...this.held.get(s)!, lastModified: g.lastModified, passJson: g.passJson });
      }
      fetched.push({ serial: s, status: g.status, changed: g.status === 200 && g.passJson !== before });
    }
    if (l.tag) this.tag = l.tag;
    return { listed: l.serials, fetched };
  }
}

/**
 * Run `act`, then assert THE INVARIANT for every phone: pushed => listed + 200 with new content;
 * not pushed => not listed and a direct GET answers 304.
 */
async function step(
  name: string,
  phones: Phone[],
  serial: string,
  expectPush: boolean,
  act: () => Promise<unknown>,
  // false: the card DID change but must wait (quiet hours), so a direct GET would rightly be 200
  checkGet = true,
): Promise<void> {
  const before = sent.length;
  await act();
  const pushedTokens = sent.slice(before);
  for (const p of phones) {
    const pushed = pushedTokens.includes(p.token);
    if (expectPush) check(`${name}: pushed ${p.id}`, pushed, `sent ${pushedTokens.length}`);
    else check(`${name}: NO push to ${p.id}`, !pushed, `sent ${pushedTokens.length}`);
    if (pushed) {
      const r = await p.onPush();
      check(`${name}: the list names the serial (no spurious push)`, r.listed.includes(serial), r.listed.join(",") || "204");
      const f = r.fetched.find((x) => x.serial === serial);
      check(`${name}: the pass GET is 200 with different content`, !!f && f.status === 200 && f.changed, JSON.stringify(f));
      const again = await p.get(serial);
      check(`${name}: fetching again right after is 304`, again.status === 304, String(again.status));
    } else {
      const l = await p.list();
      check(`${name}: the list does not name it`, !l.serials.includes(serial), l.serials.join(",") || "204");
      if (checkGet) {
        const g = await p.get(serial);
        check(`${name}: the pass GET is 304`, g.status === 304, String(g.status));
      }
    }
  }
}

const quietCfg = config as { IDLE_QUIET_START_HOUR: number; IDLE_QUIET_END_HOUR: number };
const savedQuiet = { s: quietCfg.IDLE_QUIET_START_HOUR, e: quietCfg.IDLE_QUIET_END_HOUR };
function setQuiet(on: boolean): void {
  if (on) {
    quietCfg.IDLE_QUIET_START_HOUR = 0;
    quietCfg.IDLE_QUIET_END_HOUR = 0; // a 0..0 window is "never"; widen below
    // a window that covers every hour: start 0, end 24 is not allowed, so use (h, h-1)
    const h = new Date().getUTCHours();
    quietCfg.IDLE_QUIET_START_HOUR = 0;
    quietCfg.IDLE_QUIET_END_HOUR = 23;
    if (!isQuietHour(new Date())) {
      quietCfg.IDLE_QUIET_START_HOUR = h;
      quietCfg.IDLE_QUIET_END_HOUR = (h + 23) % 24;
    }
  } else {
    // a window that never contains now
    quietCfg.IDLE_QUIET_START_HOUR = savedQuiet.s;
    quietCfg.IDLE_QUIET_END_HOUR = savedQuiet.e;
    if (isQuietHour(new Date())) {
      for (let s = 0; s < 24 && isQuietHour(new Date()); s++) {
        quietCfg.IDLE_QUIET_START_HOUR = s;
        quietCfg.IDLE_QUIET_END_HOUR = (s + 1) % 24;
      }
    }
  }
}
async function waitRefresh(): Promise<void> {
  for (let i = 0; i < 200 && passRefreshState().running; i++) await sleep(25);
}

try {
  console.log("\nunit: the comparator");
  {
    const a = { "storeCard.headerFields.alive": { value: "94 / 270" }, "storeCard.auxiliaryFields.status": { value: "hi", cm: "%@" } };
    const b = { ...a, "storeCard.headerFields.alive": { value: "93 / 270" } };
    check("headcount alone: a background refresh sees no change (fix 7)", gate.sameContent(a, b, { ignoreHeadcount: true, fieldsOnly: true }));
    check("headcount alone: a served pass still counts it as new content", !gate.sameContent(a, b));
    const l1 = { "storeCard.secondaryFields.life": { value: "2026-10-21T10:00:00Z" } };
    const l2 = { "storeCard.secondaryFields.life": { value: "2026-10-21T10:00:01Z" } };
    const l3 = { "storeCard.secondaryFields.life": { value: "2026-10-21T16:00:00Z" } };
    check("a second of SURVIVES jitter is not a change", gate.sameContent(l1, l2));
    check("a care that moves SURVIVES by hours is a change", !gate.sameContent(l1, l3));
    const m1 = { x: { value: "1" }, _bundle: { value: "aa" } };
    check("a row without a bundle hash is compared on fields only", gate.sameContent({ x: { value: "1" } }, m1));
    check("a different bundle hash counts for a served pass", !gate.sameContent({ ...m1, _bundle: { value: "bb" } }, m1));
    check("but never for a push decision", gate.sameContent({ ...m1, _bundle: { value: "bb" } }, m1, { fieldsOnly: true }));
    const t0 = Date.UTC(2026, 9, 21, 12, 0, 0, 400);
    const lm = gate.nextLastModified({ lastModified: new Date(Date.UTC(2026, 9, 21, 12, 0, 0)) }, t0);
    check("two versions in one second never share a Last-Modified", lm.getTime() === Date.UTC(2026, 9, 21, 12, 0, 1));
    const row = { lastModified: new Date(Date.UTC(2026, 9, 21, 12, 0, 0)), servedAt: new Date(Date.UTC(2026, 9, 21, 15, 0, 0)) };
    check("an old row re-stamped on every serve cannot look newer than its own second", gate.changedAtOf(row).getTime() === Date.UTC(2026, 9, 21, 12, 0, 0, 999));
  }

  console.log("\nsetup: two pets, one phone each, plus a phone holding both");
  setQuiet(false);
  const pet = await mint("keeper@walletchi.test");
  const other = await mint("other@walletchi.test");
  const phone = new Phone("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "aa".repeat(32));
  const both = new Phone("f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6", "bb".repeat(32));
  await phone.register(pet.serial);
  await both.register(pet.serial);
  await both.register(other.serial);
  // First install: each phone downloads its passes once (no tag yet, everything listed).
  for (const p of [phone, both]) await p.onPush();
  check("after install the phone holds the pass", !!phone.held.get(pet.serial)?.lastModified);

  console.log("\nthe art is deterministic (otherwise every GET would be a new version)");
  {
    const r = (await store.getRunner(pet.serial))!;
    const a1 = await assembleRunnerPass(r, {});
    const a2 = await assembleRunnerPass(r, {});
    check("same pet, same moment: same bundle hash", gate.bundleHash(a1.images) === gate.bundleHash(a2.images));
  }

  await step("unchanged pass, a care-path push", [phone], pet.serial, false, () => pushRunnerPass(ctx, pet.serial));
  await step("unchanged pass, the scheduled refresh", [phone, both], pet.serial, false, async () => {
    check("scheduled refresh starts", await refreshAllPasses(ctx, "scheduled", { mode: "background" }));
    await waitRefresh();
    check("it pushed nobody and counted them unchanged", passRefreshState().pushed === 0 && passRefreshState().unchanged >= 2, JSON.stringify(passRefreshState()));
  });

  console.log("\nfive care taps: each changes the card, each pushes at once (no debounce)");
  for (let i = 1; i <= 5; i++) {
    await sleep(1100);
    await step(`care tap ${i}`, [phone], pet.serial, true, async () => {
      await store.updateRunner(pet.serial, { lastEvent: `Your Chi was cared for, but it still needs Water: ${10 - i}h left.`, careCount: i });
      await pushRunnerPass(ctx, pet.serial);
    });
  }
  await step("a sixth care push with nothing new on the card", [phone], pet.serial, false, () => pushRunnerPass(ctx, pet.serial));

  console.log("\nAPNs refuses a push: the next call retries it instead of calling the pass unchanged");
  {
    await sleep(1100);
    _setApplePushSenderForTests(async (tokens: string[]) => tokens.map((token) => ({ token, ok: false, status: 500, reason: "InternalServerError" })));
    await store.updateRunner(pet.serial, { lastEvent: "Your Chi was cared for. It is happy and full." });
    check("the push went out and APNs refused it", (await pushRunnerPass(ctx, pet.serial)) === "pushed");
    _setApplePushSenderForTests(async (tokens: string[]) => {
      sent.push(...tokens);
      return tokens.map((token) => ({ token, ok: true, status: 200 }));
    });
    await step("the next push for the same version", [phone], pet.serial, true, () => pushRunnerPass(ctx, pet.serial, { mode: "background" }));
    await step("and once delivered, it is unchanged again", [phone], pet.serial, false, () => pushRunnerPass(ctx, pet.serial, { mode: "background" }));
  }

  console.log("\nthe phone holding both pets: a push for one never drags the other along");
  await step("a change to the other pet", [both], other.serial, true, async () => {
    await store.updateRunner(other.serial, { lastEvent: "Your Chi was cared for. It is happy and full." });
    await pushRunnerPass(ctx, other.serial);
  });
  {
    // `both` also holds `pet`, which changed five times above without it syncing: one sync now
    // brings it up to date, then both serials are quiet.
    await both.onPush();
    const l = await both.list();
    check("after syncing, the two-pass phone is told nothing changed", l.status === 204, String(l.status));
  }

  console.log("\nquiet hours: background refreshes wait, warnings never do");
  setQuiet(true);
  check("(the test window is quiet now)", isQuietHour(new Date()));
  await sleep(1100);
  await store.updateRunner(pet.serial, { lastEvent: "Your Chi is napping in the sun." });
  await step("a background push in quiet hours", [phone], pet.serial, false, () => pushRunnerPass(ctx, pet.serial, { mode: "background" }), false);
  await step("the scheduled refresh in quiet hours", [phone], pet.serial, false, async () => {
    await refreshAllPasses(ctx, "scheduled", { mode: "background" });
    await waitRefresh();
    check("it counted them as quiet", passRefreshState().quiet >= 1 && passRefreshState().pushed === 0, JSON.stringify(passRefreshState()));
  }, false);
  await step("a reminder in quiet hours still goes", [phone], pet.serial, true, async () => {
    await store.updateRunner(pet.serial, { lastEvent: "Last chance: your Chi dies in 2h 10m. Tap Water." });
    await pushRunnerPass(ctx, pet.serial, { message: { header: "Last chance", body: "x", notify: true } });
  });
  setQuiet(false);

  console.log("\nthe hourly refresh catches a real change nobody pushed");
  await sleep(1100);
  await store.updateRunner(pet.serial, { lastEvent: "Your Chi found a shiny pebble." });
  await step("the scheduled refresh after a silent change", [phone], pet.serial, true, async () => {
    await refreshAllPasses(ctx, "scheduled", { mode: "background" });
    await waitRefresh();
  });
  await step("and the next hour, with nothing new, pushes nothing", [phone], pet.serial, false, async () => {
    await refreshAllPasses(ctx, "scheduled", { mode: "background" });
    await waitRefresh();
  });

  console.log("\na change with no push: a direct GET (pull to refresh) is still honest");
  await sleep(1100);
  {
    await store.updateRunner(pet.serial, { lastEvent: "Your Chi stretched." });
    const g = await phone.get(pet.serial);
    check("the GET serves the new content (200)", g.status === 200, String(g.status));
    if (g.status === 200) phone.held.set(pet.serial, { ...phone.held.get(pet.serial)!, lastModified: g.lastModified, passJson: g.passJson });
    const g2 = await phone.get(pet.serial);
    check("and right after, 304", g2.status === 304, String(g2.status));
    // A pull to refresh moves no sync tag, so the phone's NEXT sync (whenever a push brings one)
    // names this serial once more; its fetch is then a 304, never a full unchanged pass.
    const s1 = await phone.onPush();
    check("the next sync fetches it with a 304 (never the full pass again)", s1.fetched.every((f) => f.status === 304), JSON.stringify(s1.fetched));
    await step("a push after that, with nothing newer", [phone], pet.serial, false, () => pushRunnerPass(ctx, pet.serial));
  }

  console.log("\na claim rotates the token: the old phone must fetch its keepsake");
  await sleep(1100);
  await step("a link reset (claim path, forced push)", [phone], pet.serial, true, async () => {
    const r = (await store.getRunner(pet.serial))!;
    await rotateRunnerAuth(ctx, r, { reason: "reset" }); // pushes with mode "force" itself
  });
  {
    const g = await phone.get(pet.serial);
    check("the old phone's keepsake answers 304 once it holds it", g.status === 304, String(g.status));
    // The keeper adds the fresh card (new token) to the same phone; later steps use that card.
    await phone.register(pet.serial);
    const fresh = await phone.get(pet.serial);
    phone.held.set(pet.serial, { ...phone.held.get(pet.serial)!, lastModified: fresh.lastModified, passJson: fresh.passJson });
    await phone.onPush();
    check("the fresh card is installed", fresh.status === 200, String(fresh.status));
  }

  console.log("\nboot refresh: the template hash");
  {
    await store.updateRunner(other.serial, { lastEvent: "Something the boot run must not push." });
    const n0 = sent.length;
    check("first boot of this code: hash stored, nothing pushed", (await runBootRefresh(ctx)) === "first-boot" && sent.length === n0);
    check("the hash is stored durably", (await store.getPassFieldMemory(gate.TEMPLATE_HASH_KEY)) === gate.passTemplateHash());
    check("an ordinary restart: unchanged, nothing pushed", (await runBootRefresh(ctx)) === "unchanged" && sent.length === n0);
    const c = config as { NEWS_TEXT?: string };
    c.NEWS_TEXT = "A new trick.";
    check("a template setting changed: the hash differs", gate.passTemplateHash() !== (await store.getPassFieldMemory(gate.TEMPLATE_HASH_KEY)));
    await sleep(1100);
    check("the boot run starts", (await runBootRefresh(ctx)) === "changed");
    await waitRefresh();
    check("it pushed the cards that changed", sent.length > n0, `sent ${sent.length - n0}`);
    const r = await both.onPush();
    check("and every pushed card is listed and different", r.fetched.length > 0 && r.fetched.every((f) => f.status === 200 && f.changed), JSON.stringify(r.fetched));
    check("the next boot is unchanged again", (await runBootRefresh(ctx)) === "unchanged");
    c.NEWS_TEXT = undefined;
    await store.putPassFieldMemory(gate.TEMPLATE_HASH_KEY, gate.passTemplateHash());
  }

  console.log("\nGoogle Wallet messages: announcement + live reminder + newest, never a pile");
  {
    const gmod = await import("../src/runner/google.js");
    const { _resetAnnouncementCache } = await import("../src/runner/announce.js");
    const announce = "Welcome to the experiment. P.S. I love you";
    type M = { id?: string; header?: string; body?: string; messageType?: string; displayInterval?: { end?: { date: string } } };
    let msgs: M[] = [];
    const patches: Array<{ before: M[]; after: M[] }> = [];
    const added: M[] = [];
    const ops: string[] = [];
    let refuseNotify = false; // simulate the few-per-day notification cap
    let refuseAll = false;
    let getDelayMs = 0;
    const g = gmod.getRunnerGoogle() as unknown as {
      live: boolean;
      accessToken: () => Promise<string>;
      walletFetch: (url: string, token: string, init?: RequestInit) => Promise<Response>;
      patchObject: (...a: unknown[]) => Promise<void>;
      addMessage: (...a: unknown[]) => Promise<void>;
      clearReminderMessages: (r: unknown) => Promise<void>;
    };
    const saved = { live: g.live, accessToken: g.accessToken, walletFetch: g.walletFetch, patchObject: g.patchObject };
    g.live = true;
    g.accessToken = async () => "test-token";
    g.patchObject = async () => undefined; // the object body itself is not under test here
    g.walletFetch = async (url: string, _t: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (method === "GET") {
        ops.push("GET");
        const snapshot = JSON.parse(JSON.stringify(msgs)) as M[];
        if (getDelayMs) await sleep(getDelayMs);
        return new Response(JSON.stringify({ id: "obj", messages: snapshot }), { status: 200 });
      }
      const body = JSON.parse(String(init.body ?? "{}")) as { messages?: M[]; message?: M };
      if (method === "PATCH" && body.messages) {
        ops.push("PATCH");
        patches.push({ before: msgs, after: body.messages });
        msgs = body.messages;
        return new Response("{}", { status: 200 });
      }
      if (method === "POST" && url.endsWith("/addMessage") && body.message) {
        ops.push("POST");
        if (refuseAll || (refuseNotify && body.message.messageType === "TEXT_AND_NOTIFY")) {
          return new Response(JSON.stringify({ error: { message: "QuotaExceeded" } }), { status: 429 });
        }
        added.push(body.message);
        msgs = [...msgs, body.message];
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    const showing = (now = Date.now()) => msgs.filter((m) => !m.displayInterval?.end || Date.parse(m.displayInterval.end.date) > now);
    const bodies = () => showing().map((m) => m.body);
    const remind = (body: string, hours = 5) =>
      pushRunnerPass(ctx, other.serial, { message: { header: "Last chance", body, notify: true, endsAt: new Date(Date.now() + hours * 3600_000) } });
    const arena = (body: string) =>
      pushRunnerPass(ctx, other.serial, { message: { header: "The Arena", body, endsAt: new Date(Date.now() + 24 * 3600_000) } });
    try {
      // The card as the Android screenshot showed it: the announcement and a pile of old lines.
      msgs = [
        { id: "a1", header: "WALLETCHI", body: announce, messageType: "TEXT_AND_NOTIFY" },
        { id: "d1", header: "The Arena", body: "A pet just went dark. 40 still breathing.", messageType: "TEXT" },
        { id: "d2", header: "The Arena", body: "A pet just went dark. 41 still breathing.", messageType: "TEXT" },
        { id: "r1", header: "Last chance", body: "Last chance: your Chi dies in 1h 29m. Tap Water.", messageType: "TEXT_AND_NOTIFY" },
        { id: "r2", header: "Your Chi needs you", body: "Your Chi dies in 8h 59m.", messageType: "TEXT_AND_NOTIFY" },
      ];
      await store.setActiveAnnouncement(announce);
      _resetAnnouncementCache(); // the real announce route writes through this cache
      const r = (await store.getRunner(other.serial))!;
      const deadline = new Date(Date.now() + 5 * 3600_000);
      ops.length = 0;
      await pushRunnerPass(ctx, other.serial, { message: { header: "Your Chi needs you", body: "Your Chi dies in 5h 0m. Tap Feed.", notify: true, endsAt: deadline } });
      check("the new message is ADDED FIRST, then the old ones are pruned", ops.join(",") === "POST,GET,PATCH", ops.join(","));
      check("append replaced: announcement + the newest message only", JSON.stringify(bodies()) === JSON.stringify([announce, "Your Chi dies in 5h 0m. Tap Feed."]), JSON.stringify(bodies()));
      check("the announcement is kept pinned", bodies().includes(announce));
      const last = patches[patches.length - 1]!.after;
      const newest = added[added.length - 1]!;
      check("the prune PATCH sends every OLDER message as plain TEXT (it can never re-notify)", last.filter((m) => m.id !== newest.id).every((m) => m.messageType === "TEXT"));
      check("and carries the new message exactly as it was added", JSON.stringify(last.find((m) => m.id === newest.id)) === JSON.stringify(newest));
      check("notify preserved on the newest message (TEXT_AND_NOTIFY through addMessage)", newest.messageType === "TEXT_AND_NOTIFY");
      check("a reminder ends at the pet's deadline", newest.displayInterval?.end?.date === deadline.toISOString(), JSON.stringify(newest.displayInterval));
      const plain = gmod.newWalletMessage("WALLETCHI", "x", false, null);
      check("a non-notifying message stays TEXT with no end", plain.messageType === "TEXT" && plain.displayInterval === undefined);

      console.log("  (an Arena line while a reminder is still live)");
      await arena("A pet just went dark. 39 still breathing.");
      check("the live reminder stays: announcement + reminder + newest", JSON.stringify(bodies()) === JSON.stringify([announce, "Your Chi dies in 5h 0m. Tap Feed.", "A pet just went dark. 39 still breathing."]), JSON.stringify(bodies()));
      check("an Arena line is plain TEXT (no notification, as before)", added[added.length - 1]!.messageType === "TEXT");
      await arena("A pet just went dark. 38 still breathing.");
      check("the next Arena line replaces the last one, the reminder still stays", JSON.stringify(bodies()) === JSON.stringify([announce, "Your Chi dies in 5h 0m. Tap Feed.", "A pet just went dark. 38 still breathing."]), JSON.stringify(bodies()));
      await remind("Last chance: your Chi dies in 2h 0m. Tap Feed.");
      check("a newer reminder supersedes the older one", JSON.stringify(bodies()) === JSON.stringify([announce, "Last chance: your Chi dies in 2h 0m. Tap Feed."]), JSON.stringify(bodies()));

      console.log("  (a care lands and the pet is no longer due)");
      await g.clearReminderMessages(r);
      check("old reminder cleared after care: no reminder left showing", !showing().some((m) => gmod.isReminderMessage(m)), JSON.stringify(bodies()));
      check("and the announcement is still there", JSON.stringify(bodies()) === JSON.stringify([announce]), JSON.stringify(bodies()));
      check("the clear PATCH notifies nobody (all TEXT)", patches[patches.length - 1]!.after.every((m) => m.messageType === "TEXT"));
      const nPatches = patches.length;
      await g.clearReminderMessages(r);
      check("nothing to clear: no PATCH at all", patches.length === nPatches);

      console.log("  (Google refuses a notifying message: the daily cap)");
      await remind("Last chance: your Chi dies in 1h 0m. Tap Water.");
      refuseNotify = true;
      await remind("Last chance: your Chi dies in 0h 40m. Tap Water.");
      refuseNotify = false;
      check("the refused reminder is retried as plain TEXT and lands", bodies().includes("Last chance: your Chi dies in 0h 40m. Tap Water.") && added[added.length - 1]!.messageType === "TEXT", JSON.stringify(bodies()));
      refuseAll = true;
      const before = JSON.stringify(bodies());
      await arena("A pet just went dark. 37 still breathing.");
      refuseAll = false;
      check("an add that fails outright prunes NOTHING: the Last chance stays on the card", JSON.stringify(bodies()) === before, JSON.stringify(bodies()));

      console.log("  (two messages for one card at the same moment)");
      getDelayMs = 30;
      ops.length = 0;
      await Promise.all([arena("A pet just went dark. 36 still breathing."), arena("A pet just went dark. 35 still breathing.")]);
      getDelayMs = 0;
      check("writes to one card are serialized (no prune reads before the other add lands)", ops.join(",") === "POST,GET,PATCH,POST,GET,PATCH", ops.join(","));
      const vis = bodies();
      check("so the newest message is never pruned away", vis.includes("A pet just went dark. 35 still breathing.") || vis.includes("A pet just went dark. 36 still breathing."), JSON.stringify(vis));
      check("and only one Arena line shows", vis.filter((b) => (b ?? "").startsWith("A pet just went dark")).length === 1, JSON.stringify(vis));

      console.log("  (a new announcement)");
      const next = "Season two starts Friday.";
      await store.setActiveAnnouncement(next);
      _resetAnnouncementCache();
      await pushRunnerPass(ctx, other.serial, { message: { header: "WALLETCHI", body: next, notify: true } });
      check("a new announcement replaces the old one (the live reminder stays)", bodies().includes(next) && !bodies().includes(announce), JSON.stringify(bodies()));
      check("and it notifies exactly as before", added[added.length - 1]!.messageType === "TEXT_AND_NOTIFY" && added[added.length - 1]!.displayInterval === undefined);
      check("pure: a message we cannot see yet is never pruned around", gmod.pruneMessagesAfterAdd([{ id: "x" }], "missing", null, Date.now()) === null);
    } finally {
      g.live = saved.live;
      g.accessToken = saved.accessToken;
      g.walletFetch = saved.walletFetch;
      g.patchObject = saved.patchObject;
      await store.setActiveAnnouncement(null);
      _resetAnnouncementCache();
    }
  }

  console.log("\nthe gate fails OPEN: a gate that cannot decide never costs a reminder");
  {
    await sleep(1100);
    _setPushGateForTests(async () => {
      throw new Error("injected: DB blip");
    });
    const n0 = sent.length;
    await pushRunnerPass(ctx, pet.serial, { message: { header: "Last chance", body: "x", notify: true } });
    check("an injected gate throw on a reminder still pushes", sent.length > n0, `sent ${sent.length - n0}`);
    const n1 = sent.length;
    await pushRunnerPass(ctx, pet.serial, { mode: "background" });
    check("but the silent background refresh does not (it tries again next hour)", sent.length === n1);
    _setPushGateForTests(null);
    await phone.onPush(); // resync after the ungated push
  }

  console.log("\none late look after a care (NOT a debounce: the tap's own push already went)");
  {
    _setCareRegateMsForTests(60);
    await sleep(1100);
    const n0 = sent.length;
    await store.updateRunner(pet.serial, { lastEvent: "Your Chi was cared for. It is happy and full!" });
    _scheduleCareRegateForTests(ctx, pet.serial);
    check("nothing is pushed until the late look runs", sent.length === n0);
    await sleep(250);
    check("the late look pushes a change the first push missed", sent.length > n0, `sent ${sent.length - n0}`);
    const heldBefore = phone.held.get(pet.serial)?.lastModified;
    const rows = (await store.listServedPassSnapshots(pet.serial)).map((x) => `${x.lastModified.toISOString()}@${x.servedAt.toISOString()}`);
    const r1 = await phone.onPush();
    check("and the phone finds it listed and new", r1.fetched.some((f) => f.serial === pet.serial && f.status === 200 && f.changed), JSON.stringify({ f: r1.fetched, heldBefore, rows, now: new Date().toISOString(), tag: phone.tag }));
    const n1 = sent.length;
    _scheduleCareRegateForTests(ctx, pet.serial);
    await sleep(250);
    check("with nothing new, the late look is free (no push)", sent.length === n1);
    _setCareRegateMsForTests(25_000);
  }

  console.log("\na read that started before a care can never refill the cache with the old value");
  {
    const { cachedPetNeeds, forgetPetChainReads, _resetPetNeedsCache } = await import("../src/runner/season.js");
    _resetPetNeedsCache();
    let release: ((v: unknown) => void) | null = null;
    let calls = 0;
    const slowCtx = {
      relayer: {
        petNeeds: async () => {
          calls += 1;
          if (calls === 1) return new Promise((res) => (release = res));
          return { needAt: [2, 2, 2, 2, 2] };
        },
      },
    } as unknown as AppContext;
    const stale = cachedPetNeeds(slowCtx, "gen-test");
    forgetPetChainReads("gen-test", null); // the care lands while the old read is in flight
    release!({ needAt: [1, 1, 1, 1, 1] });
    await stale;
    const fresh = (await cachedPetNeeds(slowCtx, "gen-test")) as unknown as { needAt: number[] };
    check("after the care, the next read goes to the chain, not the stale in-flight value", calls === 2 && fresh.needAt[0] === 2, `calls ${calls}`);
    _resetPetNeedsCache();
  }

  console.log("\nquiet hours: only vital fields may push at night");
  {
    const prev = { "storeCard.secondaryFields.life": { value: "2026-10-21T10:00:00Z" }, "storeCard.auxiliaryFields.status": { value: "Your Chi is napping." } };
    const flavor = { ...prev, "storeCard.auxiliaryFields.status": { value: "Your Chi found a pebble." } };
    const clock = { ...prev, "storeCard.secondaryFields.life": { value: "2026-10-21T18:00:00Z" } };
    const warn = { ...prev, "storeCard.auxiliaryFields.status": { value: "Last chance: your Chi dies in 1h 0m. Tap Water." } };
    check("a flavor line waits for morning", gate.sameContent(prev, flavor, { vitalOnly: true }));
    check("a moved SURVIVES deadline is vital (the old hourly epoch was the night safety net)", !gate.sameContent(prev, clock, { vitalOnly: true }));
    check("an event line that now shows a reminder is vital", !gate.sameContent(prev, warn, { vitalOnly: true }));
  }

  console.log("\nAPNs refusal retry only while no phone has fetched the version");
  {
    await sleep(1100);
    _setApplePushSenderForTests(async (tokens: string[]) => tokens.map((token) => ({ token, ok: false, status: 500, reason: "InternalServerError" })));
    await store.updateRunner(pet.serial, { lastEvent: "Your Chi rolled over." });
    await pushRunnerPass(ctx, pet.serial);
    _setApplePushSenderForTests(async (tokens: string[]) => {
      sent.push(...tokens);
      return tokens.map((token) => ({ token, ok: true, status: 200 }));
    });
    // The phone fetched it on its own (another pass's sync, a pull to refresh).
    await phone.onPush();
    await step("the retry after the phone already has it", [phone], pet.serial, false, () => pushRunnerPass(ctx, pet.serial, { mode: "background" }));
  }

} finally {
  quietCfg.IDLE_QUIET_START_HOUR = savedQuiet.s;
  quietCfg.IDLE_QUIET_END_HOUR = savedQuiet.e;
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
