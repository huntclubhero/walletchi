/**
 * CHI CHAT CHECK (runner/chat.ts): the CHAT link on the pass, the tap that turns it into the room
 * cookie, the room page, the message API, the live stream and the moderator switches. Pins that the
 * link exists ONLY for the pets the rollout names (CHAT_SERIALS), or for every LIVING pet once
 * CHAT_ENABLED is on; that it carries no changeMessage and is the only change to the pass; that NO
 * chat setting touches the passTemplateHash and the background refresh pushes exactly the cards that
 * gain the link; HEAD is a 405; the signed tag (verify, reject, domain separation, rotation); the
 * fresh owner guard (transferred, unavailable); the cookie (attributes, a different tag from the
 * link, dies on rotation and on death); the message text rules; posting pace; muting; paging;
 * the stream (message, delete, presence); escaping; the per-serial tap limiter; link previews.
 * Real handlers, in-memory store + MockChain.
 *
 * Run: npx tsx scripts/chat-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://sg:sg@localhost:5432/sg";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.GAME_ENABLED = "false";
process.env.GAME_SERIALS = "";
process.env.NIGHT_ENABLED = "false";
process.env.NIGHT_SERIALS = "";
process.env.VALLEY_ENABLED = "false";
process.env.VALLEY_SERIALS = "";
process.env.VALLEY_TOKEN_SECRET = "chat-check-only-valley-secret-not-real-0123456789";
process.env.CHAT_ENABLED = "false";
process.env.CHAT_SERIALS = "";
process.env.CHAT_MUTED_SERIALS = "";
process.env.CARE_LINK_SECRET = "chat-check-only-care-link-pepper-not-real";
const INTERNAL = "chat-check-only-internal-token";
process.env.INTERNAL_STATUS_TOKEN = INTERNAL;

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { assembleRunnerPass } = await import("../src/runner/pass.js");
const { getRunnerGoogle } = await import("../src/runner/google.js");
const { passTemplateHash, gateApplePush } = await import("../src/runner/pass-gate.js");
const { chatEnabledFor, chatUrl, chatSessionValue, normalizeBody, normalizeName, postPaceHit, namePaceHit, chatStreamState, _resetChatState, _setMaxStreamsForTests, _recheckStreamsForTests, gifsEnabled } = await import("../src/runner/chat.js");
const { signTag } = await import("../src/runner/sign.js");
const { _resetClaimState } = await import("../src/runner/claim.js");
const { petName } = await import("../src/runner/names.js");
const { runnerNumber } = await import("../src/runner/theme.js");
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
const chain = new MockChain();
const relayer = new Relayer(chain);
const ctx = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
(config as { PUBLIC_BASE_URL: string }).PUBLIC_BASE_URL = base;
const cfg = config as unknown as {
  PUBLIC_BASE_URL: string;
  NIGHT_SERIALS?: string; VALLEY_SERIALS?: string;
  CHAT_ENABLED: boolean; CHAT_SERIALS?: string; CHAT_MUTED_SERIALS?: string;
  modes: { survivalLive: boolean };
};

async function mint(email: string) {
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
type Pet = Awaited<ReturnType<typeof mint>>;
const fresh = async (p: Pet) => (await store.getRunner(p.serial))!;

type BackField = { key: string; label?: string; value?: string; attributedValue?: string; changeMessage?: string };
async function appleBack(r: Pet): Promise<BackField[]> {
  const p = await assembleRunnerPass(r, {});
  return (p.passJson as { storeCard?: { backFields?: BackField[] } }).storeCard?.backFields ?? [];
}
const google = getRunnerGoogle() as unknown as { loyaltyObject: (...a: unknown[]) => { linksModuleData: { uris: Array<{ id: string; uri: string; description: string }> } } };
const gLinks = (r: Pet) => google.loyaltyObject(r, null, null, null, false).linksModuleData.uris;
const tap = (url: string, headers: Record<string, string> = {}) => fetch(url, { redirect: "manual", headers });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const withCookie = (cookie: string, extra: Record<string, string> = {}) => ({ cookie, ...extra });
const room = (cookie?: string) => fetch(`${base}/chat`, { redirect: "manual", headers: cookie ? withCookie(cookie) : {} });
const api = (cookie: string | undefined, path: string, init: RequestInit = {}) =>
  fetch(`${base}/chat/api/${path}`, { ...init, redirect: "manual", headers: { ...(cookie ? withCookie(cookie) : {}), ...((init.headers as Record<string, string>) ?? {}) } });
const post = (cookie: string | undefined, body: unknown) =>
  api(cookie, "messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
const internal = (path: string, init: RequestInit = {}) =>
  fetch(`${base}/internal/${path}`, { ...init, headers: { authorization: `Bearer ${INTERNAL}`, ...((init.headers as Record<string, string>) ?? {}) } });
type Msg = { id: number; serial: string; tokenId: string; name: string; number: string; ci: number; body: string; at: string };

// Read a server-sent event stream until `until` returns true (or the time is up).
async function openStream(cookie: string, after: number) {
  const res = await fetch(`${base}/chat/api/stream?after=${after}`, { headers: withCookie(cookie) });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: Array<{ event: string; data: unknown }> = [];
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
          else if (line.startsWith("retry: ")) events.push({ event: "retry", data: Number(line.slice(7)) });
        }
        if (data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch(() => undefined);
  const waitFor = async (pred: (e: { event: string; data: unknown }) => boolean, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = events.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    return null;
  };
  return { res, events, waitFor, close: () => reader.cancel().catch(() => undefined).then(() => pump) };
}

try {
  const hunt = await mint("hunt@walletchi.test");
  const other = await mint("other@walletchi.test");
  const third = await mint("third@walletchi.test");
  check("the test pets are minted and ready", [hunt, other, third].every((p) => p.status === "ready" && !!p.tokenId));
  const huntLink = chatUrl(hunt.serial, hunt.authToken);
  const huntBefore = JSON.stringify(await appleBack(hunt));
  const otherBefore = JSON.stringify(await appleBack(other));
  const huntGoogleBefore = JSON.stringify(gLinks(hunt));
  const otherGoogleBefore = JSON.stringify(gLinks(other));
  const hashOff = passTemplateHash();

  console.log("\nswitched off (the default)");
  check("no pet is enabled", !chatEnabledFor(hunt) && !chatEnabledFor(other));
  check("no CHAT field on the Apple pass", !(await appleBack(hunt)).some((f) => f.key === "chat"));
  check("no CHAT link on the Google pass", !gLinks(hunt).some((l) => l.id === "chat"));
  check("/chat/:serial is a 404 even with a valid tag", (await tap(huntLink)).status === 404);
  const closed = await room();
  const closedHtml = await closed.text();
  check("the room without a cookie is the closed door (403, no redirect)", closed.status === 403 && closedHtml.includes("Tap CHAT on your WALLETCHI pass to hop back in.") && !closed.headers.get("location"));
  check("the closed door is calm: titled CHI CHAT, no error words", closedHtml.includes("<title>CHI CHAT</title>") && !/error|failed|denied|forbidden/i.test(closedHtml));
  check("the message API without a cookie is a 401", (await api(undefined, "messages?after=0")).status === 401 && (await post(undefined, "hi")).status === 401);
  check("the stream without a cookie is a 401", (await api(undefined, "stream?after=0")).status === 401);
  check("a forged cookie is refused and cleared",
    await (async () => {
      const r = await room(`chichat=${hunt.serial}.${"0".repeat(24)}`);
      return r.status === 403 && /chichat=;.*Max-Age=0/.test(r.headers.get("set-cookie") ?? "");
    })());

  console.log("\nno chat setting touches the template hash");
  const hashStates: Array<[string, () => void]> = [
    ["CHAT_SERIALS", () => { cfg.CHAT_SERIALS = hunt.serial; }],
    ["CHAT_ENABLED", () => { cfg.CHAT_ENABLED = true; }],
    ["CHAT_MUTED_SERIALS", () => { cfg.CHAT_MUTED_SERIALS = hunt.serial; }],
    ["every setting at once", () => { cfg.CHAT_SERIALS = hunt.serial; cfg.CHAT_ENABLED = true; cfg.CHAT_MUTED_SERIALS = other.serial; }],
  ];
  for (const [label, apply] of hashStates) {
    apply();
    check(`${label} leaves passTemplateHash unchanged`, passTemplateHash() === hashOff);
    cfg.CHAT_SERIALS = ""; cfg.CHAT_ENABLED = false; cfg.CHAT_MUTED_SERIALS = "";
  }
  const gateSrc = readFileSync(fileURLToPath(new URL("../src/runner/pass-gate.ts", import.meta.url)), "utf8");
  check("the template hash input names no CHAT setting and does not import chat.ts",
    !/"CHAT_|chatEnabledFor/.test(gateSrc.slice(gateSrc.indexOf("export function passTemplateHash"))) && !/from "\.\/chat\.js"/.test(gateSrc));
  check("flags off, every card is byte-identical (Apple + Google)",
    JSON.stringify(await appleBack(hunt)) === huntBefore && JSON.stringify(gLinks(hunt)) === huntGoogleBefore);

  console.log("\nthe background refresh pushes exactly the cards that gain the link");
  await gateApplePush(ctx, hunt.serial, "force");
  await gateApplePush(ctx, other.serial, "force");
  check("flags off: the background gate pushes nobody",
    !(await gateApplePush(ctx, hunt.serial, "background")).push && !(await gateApplePush(ctx, other.serial, "background")).push);
  cfg.CHAT_SERIALS = hunt.serial;
  const quiet = await gateApplePush(ctx, hunt.serial, "background", Date.now(), { quiet: true });
  check("in quiet hours it waits (not a vital field)", !quiet.push && quiet.reason === "quiet", quiet.reason);
  const gained = await gateApplePush(ctx, hunt.serial, "background");
  check("serials = one pet: the background gate pushes that pet", gained.push && gained.reason === "changed", gained.reason);
  const untouched = await gateApplePush(ctx, other.serial, "background");
  check("and not another pet", !untouched.push && untouched.reason === "unchanged", untouched.reason);
  check("once pushed, the next background run is quiet for it", !(await gateApplePush(ctx, hunt.serial, "background")).push);
  cfg.CHAT_SERIALS = "";

  console.log("\nallowlisted to one pet");
  cfg.CHAT_SERIALS = ` ${hunt.serial} `;
  cfg.NIGHT_SERIALS = hunt.serial;
  cfg.VALLEY_SERIALS = hunt.serial;
  const keys = (await appleBack(hunt)).map((f) => f.key);
  check("CHAT sits right under CHI VALLEY on Apple", keys.indexOf("chat") === keys.indexOf("valley") + 1 && keys.indexOf("valley") >= 0, keys.slice(0, 5).join(","));
  const gKeys = gLinks(hunt).map((l) => l.id);
  check("and on Google", gKeys.indexOf("chat") === gKeys.indexOf("valley") + 1 && gKeys.indexOf("valley") >= 0, gKeys.slice(0, 4).join(","));
  cfg.NIGHT_SERIALS = "";
  cfg.VALLEY_SERIALS = "";
  const hb = await appleBack(hunt);
  const cf = hb.find((f) => f.key === "chat");
  check("the allowlisted pet's Apple pass has the CHAT field", !!cf && cf.label === "CHAT" && cf.value === "CHI CHAT");
  check("it links to the signed /chat link, reading just CHI CHAT", (cf?.attributedValue ?? "") === `<a href="${huntLink}">CHI CHAT</a>`);
  check("the link carries a 24 hex tag", /\/chat\/[^?]+\?s=[0-9a-f]{24}$/.test(huntLink));
  check("it carries NO changeMessage (silent)", cf !== undefined && cf.changeMessage === undefined);
  check("it is the only change to that pass", JSON.stringify(hb.filter((f) => f.key !== "chat")) === huntBefore);
  check("the same pass renders the same link twice (stable, nothing expiring)", JSON.stringify(await appleBack(hunt)) === JSON.stringify(hb));
  const gl = gLinks(hunt).find((l) => l.id === "chat");
  check("the Google pass has the same link", gl?.uri === huntLink && gl?.description === "CHI CHAT");
  check("it is the only change to the Google links", JSON.stringify(gLinks(hunt).filter((l) => l.id !== "chat")) === huntGoogleBefore);
  check("every OTHER Apple pass is byte-identical", JSON.stringify(await appleBack(other)) === otherBefore);
  check("every OTHER Google pass is byte-identical", JSON.stringify(gLinks(other)) === otherGoogleBefore);
  check("another pet's /chat/:serial is a 404", (await tap(chatUrl(other.serial, other.authToken))).status === 404);
  check("an unknown serial is a 404", (await tap(`${base}/chat/not-a-pet?s=${"0".repeat(24)}`)).status === 404);
  const head = await fetch(huntLink, { method: "HEAD", redirect: "manual" });
  check("HEAD is a 405 (no chain read, no cookie, no tap spent)", head.status === 405 && head.headers.get("allow") === "GET" && !head.headers.get("set-cookie"));
  const gone = await store.updateRunner(third.serial, { gone: true });
  cfg.CHAT_ENABLED = true;
  check("CHAT_ENABLED: every living pet is in, a dead one is not", chatEnabledFor(hunt) && chatEnabledFor(other) && !chatEnabledFor(gone!));
  check("a memorial card has no CHAT field", !(await appleBack(gone!)).some((f) => f.key === "chat") && !gLinks(gone!).some((l) => l.id === "chat"));
  cfg.CHAT_ENABLED = false;
  await store.updateRunner(third.serial, { gone: false });

  console.log("\nthe signed tag");
  _resetClaimState();
  const bad = await tap(`${base}/chat/${hunt.serial}?s=${"0".repeat(24)}`);
  const badHtml = await bad.text();
  check("a wrong tag gets the friendly 403 page", bad.status === 403 && badHtml.includes("Not your pet") && badHtml.includes("This link is not valid for you."));
  check("and no cookie, no redirect", !bad.headers.get("set-cookie") && !bad.headers.get("location"));
  check("a missing tag is refused", (await tap(`${base}/chat/${hunt.serial}`)).status === 403);
  check("a care-link tag for the same pet is refused (payloads are domain separated)",
    (await tap(`${base}/chat/${hunt.serial}?s=${signTag(hunt.authToken, `${hunt.serial}:action:feed`)}`)).status === 403);
  check("the CHI VALLEY tag for the same pet is refused",
    (await tap(`${base}/chat/${hunt.serial}?s=${signTag(hunt.authToken, `${hunt.serial}:valley`)}`)).status === 403);
  check("the room cookie's tag is refused as a link",
    (await tap(`${base}/chat/${hunt.serial}?s=${chatSessionValue(hunt.serial, hunt.authToken).split(".")[1]}`)).status === 403);
  check("an unpeppered tag (the raw authToken key) is refused",
    (await tap(`${base}/chat/${hunt.serial}?s=${createHmac("sha256", hunt.authToken).update(`${hunt.serial}:chat`).digest("hex").slice(0, 24)}`)).status === 403);

  console.log("\nthe tap: cookie and redirect");
  const ok = await tap(huntLink);
  const setCookie = ok.headers.get("set-cookie") ?? "";
  const huntCookie = cookieOf(ok);
  check("a valid tap is a 302 to /chat", ok.status === 302 && ok.headers.get("location") === "/chat", `${ok.status} ${ok.headers.get("location")}`);
  check("Cache-Control no-store", (ok.headers.get("cache-control") ?? "").includes("no-store"));
  check("it sets the room cookie: HttpOnly, SameSite=Lax, Path=/chat, 7 days",
    /^chichat=/.test(setCookie) && /HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie) && /Path=\/chat/.test(setCookie) && /Max-Age=604800/.test(setCookie), setCookie);
  check("not Secure on http (local), Secure on https", !/Secure/.test(setCookie) && await (async () => {
    cfg.PUBLIC_BASE_URL = "https://api.example.test";
    const r = await tap(`${base}/chat/${hunt.serial}?s=${huntLink.split("?s=")[1]}`);
    cfg.PUBLIC_BASE_URL = base;
    return /; Secure/.test(r.headers.get("set-cookie") ?? "");
  })());
  const [cSerial, cTag] = decodeURIComponent(huntCookie.slice("chichat=".length)).split(".") as [string, string];
  check("the cookie is serial.tag with a 24 hex tag", cSerial === hunt.serial && /^[0-9a-f]{24}$/.test(cTag));
  check("the cookie's tag is NOT the link's tag (and not a care tag)",
    cTag !== huntLink.split("?s=")[1] && cTag !== signTag(hunt.authToken, `${hunt.serial}:action:feed`));
  check("a second tap sets the same cookie (stable per authToken)", cookieOf(await tap(huntLink)) === huntCookie);

  console.log("\nthe name (first entry)");
  const firstOpen = await room(huntCookie);
  const firstHtml = await firstOpen.text();
  check("the first open is the pick-a-name screen, not the room", firstOpen.status === 200 && firstHtml.includes("Pick your name") && !firstHtml.includes('id="in"'));
  check("it names the Chi the keeper stays", firstHtml.includes(`${petName(hunt.tokenId)} ${runnerNumber(hunt.tokenId, hunt.serial)}`));
  check("it is locked down like the room", (firstOpen.headers.get("content-security-policy") ?? "").includes("default-src 'none'") && (firstOpen.headers.get("cache-control") ?? "").includes("no-store"));
  check("posting before a name is a 409", (await post(huntCookie, "too early")).status === 409);
  const setName = (cookie: string, name: unknown) => api(cookie, "name", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  const nameErr = async (name: unknown) => ((await (await setName(huntCookie, name)).json()) as { error: string }).error;
  check("too short, too long, bad characters, reserved and a non-string are refused with a reason",
    (await nameErr("x")) === "short" && (await nameErr("a".repeat(21))) === "long" && (await nameErr("<b>hi</b>")) === "chars" && (await nameErr("WALLET CHI")) === "reserved" && (await nameErr("Hunt")) === "reserved" && (await nameErr(42)) === "short");
  check("the rules in the unit: NFC, spaces collapsed, emoji refused, 20 code points pass",
    (() => {
      const a = normalizeName("  Hunt   Club  ");
      const b = normalizeName("é".normalize("NFD"));
      return a.ok && a.name === "Hunt Club" && a.key === "huntclub" && !normalizeName("hi 🙂").ok && normalizeName("é".repeat(20)).ok && !b.ok && b.error === "short";
    })());
  const named = await setName(huntCookie, "Hunt Club ");
  check("a good name saves (trimmed) and comes back", named.status === 200 && ((await named.json()) as { name: string }).name === "Hunt Club");
  check("the same name is taken for another pet, ignoring case and spacing",
    await (async () => {
      cfg.CHAT_SERIALS = `${hunt.serial},${other.serial}`;
      const c = cookieOf(await tap(chatUrl(other.serial, other.authToken)));
      const r1 = await setName(c, "hunt club");
      const r2 = await setName(c, "HUNT-CLUB");
      const r3 = await setName(c, "Andy");
      cfg.CHAT_SERIALS = ` ${hunt.serial} `;
      return r1.status === 409 && r2.status === 409 && r3.status === 200;
    })());
  check("the keeper may rename to a variant of their own name", (await setName(huntCookie, "Hunt-Club")).status === 200 && (await setName(huntCookie, "Hunt Club")).status === 200);
  const renamePage = await (await fetch(`${base}/chat/name`, { headers: withCookie(huntCookie) })).text();
  check("/chat/name is the same screen prefilled, with Save and Cancel", renamePage.includes('value="Hunt Club"') && renamePage.includes("Change your name") && renamePage.includes(">Save<") && renamePage.includes('href="/chat"'));
  check("/chat/name without a cookie is the closed door", (await fetch(`${base}/chat/name`)).status === 403);

  console.log("\nthe room");
  const page = await room(huntCookie);
  const html = await page.text();
  check("with the cookie and a name the room is a 200 HTML page", page.status === 200 && (page.headers.get("content-type") ?? "").includes("text/html") && html.includes('id="in"'));
  check("it is locked down: CSP with connect-src 'self', no-store",
    (page.headers.get("content-security-policy") ?? "").includes("connect-src 'self'") && (page.headers.get("content-security-policy") ?? "").includes("default-src 'none'") && (page.headers.get("cache-control") ?? "").includes("no-store"));
  check("it boots as the keeper's name, with the pet's name and number from the pass",
    html.includes(`"name":"Hunt Club"`) && html.includes(`"pet":${JSON.stringify(petName(hunt.tokenId))}`) && html.includes(`"number":${JSON.stringify(runnerNumber(hunt.tokenId, hunt.serial))}`));
  check("the title is CHI CHAT, the composer is there, the stream and the API are wired",
    html.includes("<title>CHI CHAT</title>") && html.includes('id="in"') && html.includes("/chat/api/stream?after=") && html.includes("/chat/api/messages?after="));
  check("the room URL carries nothing (no serial, no tag)", !html.includes(huntLink) && !html.includes(cTag));
  check("the face route serves the pet's own pixel face to room members only",
    await (async () => {
      const f = await api(huntCookie, `face/${other.serial}.svg`);
      const noCookie = await api(undefined, `face/${other.serial}.svg`);
      const unknown = await api(huntCookie, "face/not-a-pet.svg");
      return f.status === 200 && (f.headers.get("content-type") ?? "").includes("image/svg+xml") && (f.headers.get("cache-control") ?? "").includes("private") && (await f.text()).includes("<svg") && noCookie.status === 401 && unknown.status === 404;
    })());

  console.log("\nmessages");
  _resetChatState();
  const first = await post(huntCookie, "hello from the pass");
  const firstJson = (await first.json()) as { message: Msg };
  const m1 = firstJson.message;
  check("a post is a 201 with the message", first.status === 201 && m1.body === "hello from the pass" && m1.id === 1, String(first.status));
  check("it carries the pet's serial, tokenId, the keeper's name, the pet's name and number, a colour index and a time",
    m1.serial === hunt.serial && m1.tokenId === hunt.tokenId && m1.name === "Hunt Club" && (m1 as unknown as { pet: string }).pet === petName(hunt.tokenId) && m1.number === runnerNumber(hunt.tokenId, hunt.serial) && m1.ci >= 0 && m1.ci < 7 && !Number.isNaN(Date.parse(m1.at)));
  const read = (await (await api(huntCookie, "messages?after=0")).json()) as { messages: Msg[]; hasMore: boolean; online: number };
  check("the catch-up read returns it (after=0)", read.messages.length === 1 && read.messages[0]!.id === m1.id && read.hasMore === false && read.online >= 1);
  check("after=its id returns nothing new", ((await (await api(huntCookie, `messages?after=${m1.id}`)).json()) as { messages: Msg[] }).messages.length === 0);
  check("a second post inside 1.5 s is a 429 with Retry-After (and not stored)",
    await (async () => {
      const r = await post(huntCookie, "too fast");
      const j = (await r.json()) as { error: string };
      const all = (await (await api(huntCookie, "messages?after=0")).json()) as { messages: Msg[] };
      return r.status === 429 && j.error === "slow down" && Number(r.headers.get("retry-after")) >= 1 && all.messages.length === 1;
    })());
  cfg.CHAT_SERIALS = `${hunt.serial},${other.serial}`;
  const otherCookie = cookieOf(await tap(chatUrl(other.serial, other.authToken)));
  check("the other pet's tap gets its own cookie", /^chichat=/.test(otherCookie) && otherCookie !== huntCookie);
  const second = (await (await post(otherCookie, "  hey!  \r\nsecond line\n\n\n\nafter blanks\u0007\u0000 tab\tok ")).json()) as { message: Msg };
  check("the text is normalised: trimmed, CRLF to LF, blank runs collapsed, control characters dropped, tab kept",
    second.message.body === "hey!\nsecond line\n\nafter blanks tab\tok", JSON.stringify(second.message.body));
  check("both pets' lines read in id order", ((await (await api(huntCookie, "messages?after=0")).json()) as { messages: Msg[] }).messages.map((m) => m.id).join(",") === `${m1.id},${second.message.id}`);
  check("the room boots with the lines so far", (await (await room(otherCookie)).text()).includes(`"body":"hello from the pass"`));

  console.log("\nthe text rules");
  check("empty, whitespace, a number and a missing body are 'empty'",
    [normalizeBody(""), normalizeBody("   \n\t "), normalizeBody(12), normalizeBody(undefined)].every((r) => !r.ok && r.error === "empty"));
  check("500 code points pass, 501 fail (an emoji is one character)",
    normalizeBody("🙂".repeat(500)).ok && !normalizeBody("🙂".repeat(501)).ok && (normalizeBody("x".repeat(501)) as { error?: string }).error === "too long");
  check("a 400 on the API: empty and too long", (await post(otherCookie, "")).status === 400 && (await post(otherCookie, "x".repeat(501))).status === 400);
  check("the pace: 20 a minute per pet, then Retry-After, then a new window",
    (() => {
      const t0 = 10_000_000;
      let okCount = 0;
      for (let i = 0; i < 25; i++) if (postPaceHit("pace-pet", t0 + i * 2000) === null) okCount += 1;
      const blocked = postPaceHit("pace-pet", t0 + 25 * 2000);
      const later = postPaceHit("pace-pet", t0 + 61_000);
      return okCount === 20 && blocked !== null && blocked >= 1 && later === null;
    })());

  console.log("\nescaping");
  await sleep(1600);
  const xss = (await (await post(huntCookie, "<script>alert(1)</script> & \"quotes\"")).json()) as { message: Msg };
  check("the API keeps the text as typed (the page escapes it)", xss.message.body === "<script>alert(1)</script> & \"quotes\"");
  const xssPage = await (await room(huntCookie)).text();
  check("the room page never carries a raw < from a message", !xssPage.includes("<script>alert(1)") && xssPage.includes("\\u003cscript>alert(1)"));

  console.log("\npaging");
  for (let i = 0; i < 70; i++) await store.addChatMessage(third.serial, third.tokenId!, `line ${i}`);
  const bootPage = await (await room(huntCookie)).text();
  const bootJson = JSON.parse(bootPage.slice(bootPage.indexOf("const BOOT=") + "const BOOT=".length, bootPage.indexOf(";\n(()=>{"))) as { messages: Msg[]; hasMore: boolean };
  check("the room boots with the newest 60 in order and hasMore", bootJson.messages.length === 60 && bootJson.hasMore === true && bootJson.messages.at(-1)!.body === "line 69" && bootJson.messages[0]!.id < bootJson.messages[1]!.id);
  const olderPage = (await (await api(huntCookie, `messages?before=${bootJson.messages[0]!.id}`)).json()) as { messages: Msg[]; hasMore: boolean };
  check("before=<first id> pages up: the rest, oldest first, hasMore false",
    olderPage.messages.length === 73 - 60 && olderPage.hasMore === false && olderPage.messages[0]!.id === 1 && olderPage.messages.at(-1)!.id === bootJson.messages[0]!.id - 1, `${olderPage.messages.length}`);
  check("limit is clamped to 100", ((await (await api(huntCookie, "messages?after=0&limit=5000")).json()) as { messages: Msg[] }).messages.length === 73);
  check("a junk cursor reads as none", (await api(huntCookie, "messages?after=abc")).status === 200 && (await api(huntCookie, "messages?before=-1")).status === 200);

  console.log("\nthe live stream");
  _resetChatState();
  const s1 = await openStream(huntCookie, 0);
  check("the stream is text/event-stream, no-cache, no buffering",
    s1.res.status === 200 && (s1.res.headers.get("content-type") ?? "").includes("text/event-stream") && (s1.res.headers.get("cache-control") ?? "").includes("no-cache") && s1.res.headers.get("x-accel-buffering") === "no");
  check("it opens with a retry hint and a presence line", !!(await s1.waitFor((e) => e.event === "retry" && e.data === 3000)) && !!(await s1.waitFor((e) => e.event === "presence")));
  check("after=0 replays the history (up to 100)", !!(await s1.waitFor((e) => e.event === "message" && (e.data as Msg).body === "line 69")) && s1.events.filter((e) => e.event === "message").length === 73);
  const s2 = await openStream(otherCookie, 1_000_000);
  check("a second Chi arriving raises presence to 2 on both streams",
    !!(await s1.waitFor((e) => e.event === "presence" && (e.data as { online: number }).online === 2)) && !!(await s2.waitFor((e) => e.event === "presence" && (e.data as { online: number }).online === 2)));
  const st = chatStreamState();
  check("/internal state counts 2 streams, 2 online", st.streams === 2 && st.online === 2);
  await sleep(1600);
  const live = (await (await post(otherCookie, "live line")).json()) as { message: Msg };
  check("a post reaches every open stream as a message event",
    !!(await s1.waitFor((e) => e.event === "message" && (e.data as Msg).id === live.message.id)) && !!(await s2.waitFor((e) => e.event === "message" && (e.data as Msg).id === live.message.id)));
  check("a stream for the same pet twice counts one online", await (async () => {
    const s3 = await openStream(otherCookie, 1_000_000);
    await s3.waitFor((e) => e.event === "presence");
    const twice = chatStreamState();
    await s3.close();
    await sleep(50);
    return twice.streams === 3 && twice.online === 2 && chatStreamState().streams === 2;
  })());

  console.log("\nmoderation");
  check("/internal/chat needs the bearer token", (await fetch(`${base}/internal/chat`)).status === 401 || (await fetch(`${base}/internal/chat`)).status === 404);
  const istat = (await (await internal("chat")).json()) as { streams: number; online: number; latest: Msg[]; serials: string };
  check("/internal/chat reports streams, online, the rollout and the latest lines", istat.streams === 2 && istat.online === 2 && istat.latest.at(-1)!.id === live.message.id && istat.serials.includes(hunt.serial));
  const del = await internal(`chat/messages/${live.message.id}`, { method: "DELETE" });
  check("DELETE /internal/chat/messages/:id soft-deletes", del.status === 200 && ((await del.json()) as { deleted: Msg }).deleted.id === live.message.id);
  check("every stream hears the delete", !!(await s1.waitFor((e) => e.event === "delete" && (e.data as { id: number }).id === live.message.id)) && !!(await s2.waitFor((e) => e.event === "delete")));
  check("reads skip it", !((await (await api(huntCookie, "messages?after=0")).json()) as { messages: Msg[] }).messages.some((m) => m.id === live.message.id));
  check("deleting again is a 200, an unknown id a 404, junk a 400",
    (await internal(`chat/messages/${live.message.id}`, { method: "DELETE" })).status === 200 && (await internal("chat/messages/999999", { method: "DELETE" })).status === 404 && (await internal("chat/messages/abc", { method: "DELETE" })).status === 400);
  check("DELETE without the token is refused", (await fetch(`${base}/internal/chat/messages/1`, { method: "DELETE" })).status !== 200);
  const cleared = await internal(`chat/names/${hunt.serial}`, { method: "DELETE" });
  check("DELETE /internal/chat/names/:serial clears a name: open rooms hear the pass name, the keeper picks again",
    cleared.status === 200 && !!(await s1.waitFor((e) => e.event === "rename" && (e.data as { serial: string; name: string }).serial === hunt.serial && (e.data as { name: string }).name === petName(hunt.tokenId))) && (await (await room(huntCookie)).text()).includes("Pick your name") && (await post(huntCookie, "nameless")).status === 409);
  check("a cleared name is free for another pet, and the keeper can take a new one",
    (await setName(otherCookie, "Hunt Club")).status === 200 && (await setName(otherCookie, "Andy")).status === 200 && (await setName(huntCookie, "Hunt Club")).status === 200 && !!(await s2.waitFor((e) => e.event === "rename" && (e.data as { name: string }).name === "Hunt Club")));
  check("an unknown serial is a 404", (await internal("chat/names/not-a-pet", { method: "DELETE" })).status === 404);
  cfg.CHAT_MUTED_SERIALS = other.serial;
  await sleep(1600);
  const mutedPost = await post(otherCookie, "muted?");
  check("a muted pet cannot post (429 muted) but still reads and opens the room",
    mutedPost.status === 429 && ((await mutedPost.json()) as { error: string }).error === "muted" && (await api(otherCookie, "messages?after=0")).status === 200 && (await (await room(otherCookie)).text()).includes("you cannot post right now"));
  check("the un-muted pet is unaffected", (await post(huntCookie, "still here")).status === 201);
  cfg.CHAT_MUTED_SERIALS = "";
  await s1.close();
  await s2.close();
  await sleep(50);
  check("closed streams are gone from the count", chatStreamState().streams === 0);

  console.log("\ndeath and rotation close the door");
  await store.updateRunner(other.serial, { gone: true });
  check("a dead pet: the link is a 404, the cookie is refused (401 API, 403 room), the stream is refused",
    (await tap(chatUrl(other.serial, other.authToken))).status === 404 && (await api(otherCookie, "messages?after=0")).status === 401 && (await room(otherCookie)).status === 403 && (await api(otherCookie, "stream?after=0")).status === 401);
  await store.updateRunner(other.serial, { gone: false });
  check("alive again, the cookie works", (await api(otherCookie, "messages?after=0")).status === 200);
  await store.updateRunner(other.serial, { authToken: "rotated-auth-token-for-the-chat-check" });
  const rotated = await fresh(other);
  check("rotation: the old link is refused", (await tap(chatUrl(other.serial, other.authToken))).status === 403);
  check("rotation: the old cookie is refused", (await api(otherCookie, "messages?after=0")).status === 401 && (await room(otherCookie)).status === 403);
  const newTap = await tap(chatUrl(rotated.serial, rotated.authToken));
  const newCookie = cookieOf(newTap);
  check("the new pass's link works and its cookie differs", newTap.status === 302 && /^chichat=/.test(newCookie) && newCookie !== otherCookie && (await api(newCookie, "messages?after=0")).status === 200);

  console.log("\nreview fixes (PR #102 review)");
  const mangled = await room("chichat=%E0");
  check("a mangled cookie is the closed door, not a 500 (room, API, stream)",
    mangled.status === 403 && (await api("chichat=%E0", "messages?after=0")).status === 401 && (await api("chichat=%E0", "stream?after=0")).status === 401);
  check("the door pages never auto-close (no script, no timer)",
    !(await mangled.text()).includes("<script") && !(await (await tap(`${base}/chat/${hunt.serial}?s=${"0".repeat(24)}`)).text()).includes("<script"));
  check("the rename pace: 5 in 10 minutes per pet, then Retry-After",
    (() => {
      const t0 = 50_000_000;
      let okCount = 0;
      for (let i = 0; i < 7; i++) if (namePaceHit("rename-pet", t0 + i * 1000) === null) okCount += 1;
      return okCount === 5 && namePaceHit("rename-pet", t0 + 8000) !== null && namePaceHit("rename-pet", t0 + 10 * 60_000 + 1) === null;
    })());
  check("the full room answers 429 (EventSource stops) with Retry-After, and the poll still works",
    await (async () => {
      _setMaxStreamsForTests(0);
      const r = await api(huntCookie, "stream?after=0");
      _setMaxStreamsForTests(1500);
      return r.status === 429 && Number(r.headers.get("retry-after")) >= 1 && (await api(huntCookie, "messages?after=0")).status === 200;
    })());
  check("the per-card push route needs the token, 404s an unknown serial, and answers for a known one",
    (await fetch(`${base}/internal/passes/push/${hunt.serial}`, { method: "POST" })).status !== 200 &&
    (await internal("passes/push/not-a-pet", { method: "POST" })).status === 404 &&
    await (async () => {
      const r = await internal(`passes/push/${hunt.serial}`, { method: "POST" });
      const j = (await r.json()) as { serial: string; apple: string };
      return r.status === 200 && j.serial === hunt.serial && typeof j.apple === "string";
    })());

  console.log("\nGIFs (GIPHY behind the server's key; stubbed here)");
  const cfgG = config as unknown as { GIPHY_API_KEY?: string };
  check("no key: no GIF button, the search is a 404, a GIF post is refused",
    !gifsEnabled() && !(await (await room(huntCookie)).text()).includes('id="gifb"') && (await api(huntCookie, "gifs?q=hi")).status === 404 &&
    (await api(huntCookie, "messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gif: "abc" }) })).status === 400);
  const realFetch = globalThis.fetch;
  const giphyCalls: string[] = [];
  const fakeGif = (id: string, w = 200, h = 150) => ({ id, images: { fixed_width: { url: `https://media2.giphy.com/media/${id}/200w.gif`, webp: `https://media2.giphy.com/media/${id}/200w.webp`, width: String(w), height: String(h) } } });
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.giphy.com/")) return realFetch(input, init);
    giphyCalls.push(url);
    const u = new URL(url);
    if (u.searchParams.get("api_key") !== "chat-check-fake-giphy-key") return new Response("{}", { status: 401 });
    if (u.pathname === "/v1/gifs/trending") return Response.json({ data: [fakeGif("trend1"), fakeGif("trend2", 200, 300), { id: "bad", images: { fixed_width: { url: "https://evil.example/x.gif", width: "200", height: "100" } } }] });
    if (u.pathname === "/v1/gifs/search") return Response.json({ data: u.searchParams.get("q") === "nothing" ? [] : [fakeGif("s1"), fakeGif("s2")] });
    const m = /^\/v1\/gifs\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
    if (m) return m[1] === "missing" ? Response.json({ data: {} }, { status: 404 }) : Response.json({ data: fakeGif(m[1]!, 200, 112) });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  cfgG.GIPHY_API_KEY = "chat-check-fake-giphy-key";
  try {
    check("with a key the room shows the GIF button and the GIPHY mark, and the CSP admits giphy images", await (async () => { const r = await room(huntCookie); const h = await r.text(); return h.includes('id="gifb"') && h.includes("POWERED BY GIPHY") && (r.headers.get("content-security-policy") ?? "").includes("img-src 'self' data: https://*.giphy.com"); })());
    const tr = (await (await api(huntCookie, "gifs")).json()) as { gifs: Array<{ id: string; url: string; w: number; h: number }> };
    check("trending through the proxy: only giphy-hosted gifs, webp preferred, sizes as numbers",
      tr.gifs.length === 2 && tr.gifs[0]!.id === "trend1" && tr.gifs[0]!.url.endsWith("/200w.webp") && tr.gifs[1]!.h === 300 && !tr.gifs.some((g) => g.url.includes("evil")));
    const before = giphyCalls.length;
    await api(huntCookie, "gifs");
    check("a repeat is served from the cache (no second GIPHY call)", giphyCalls.length === before);
    check("search works and an empty result is an empty list, not an error",
      ((await (await api(huntCookie, "gifs?q=cats")).json()) as { gifs: unknown[] }).gifs.length === 2 && ((await (await api(huntCookie, "gifs?q=nothing")).json()) as { gifs: unknown[] }).gifs.length === 0);
    check("the search needs the cookie", (await api(undefined, "gifs")).status === 401);
    await sleep(1600);
    const gp = await api(huntCookie, "messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gif: "s1" }) });
    const gj = (await gp.json()) as { message: Msg & { gif?: { id: string; url: string; w: number; h: number } } };
    check("a GIF post resolves the id server-side and stores the giphy url and size",
      gp.status === 201 && gj.message.body === "" && gj.message.gif?.id === "s1" && gj.message.gif.url === "https://media2.giphy.com/media/s1/200w.webp" && gj.message.gif.w === 200 && gj.message.gif.h === 112);
    check("it reads back with the gif, and the room renders it", ((await (await api(huntCookie, `messages?after=${gj.message.id - 1}`)).json()) as { messages: Array<{ gif?: { id: string } }> }).messages[0]!.gif?.id === "s1" && (await (await room(huntCookie)).text()).includes('"gif":{"id":"s1"'));
    await sleep(1600);
    check("a bad id, an unknown id and a non-id are refused",
      (await api(huntCookie, "messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gif: "../x" }) })).status === 400 &&
      (await api(huntCookie, "messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gif: 12 }) })).status === 400 &&
      (await api(huntCookie, "messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gif: "missing" }) })).status === 503);
  } finally {
    globalThis.fetch = realFetch;
    cfgG.GIPHY_API_KEY = undefined;
  }

  console.log("\nthe fresh owner guard");
  _resetClaimState();
  const realOwner = await chain.petOwnerOf(hunt.tokenId!);
  chain.setPetOwnerMock(hunt.tokenId!, "0x000000000000000000000000000000000000b0b0");
  for (const liveMode of [false, true]) {
    cfg.modes.survivalLive = liveMode;
    const moved = await tap(huntLink);
    const movedHtml = await moved.text();
    check(`a pet sold but not claimed is refused with the new home page, no cookie (survival ${liveMode ? "live" : "off"})`,
      moved.status === 403 && movedHtml.includes("This Chi has a new home") && !moved.headers.get("set-cookie") && !moved.headers.get("location"));
  }
  check("a sold pet's LIVE cookie is shown the door too (room 403 new home, cookie cleared, post 403), once the owner cache turns",
    await (async () => {
      _resetClaimState(); // the cached owner read must see the new owner
      const r = await room(huntCookie);
      const p = await post(huntCookie, "still me?");
      return r.status === 403 && (await r.text()).includes("This Chi has a new home") && /chichat=;.*Max-Age=0/.test(r.headers.get("set-cookie") ?? "") && p.status === 403;
    })());
  chain.setPetOwnerMock(hunt.tokenId!, realOwner);
  _resetClaimState();
  check("back with its owner, the same cookie works again", (await room(huntCookie)).status === 200);
  cfg.modes.survivalLive = true;
  const rel = relayer as unknown as { petOwnerOf: (id: string) => Promise<string> };
  const realRead = rel.petOwnerOf.bind(relayer);
  rel.petOwnerOf = async () => { throw new Error("rpc down"); };
  const down = await tap(huntLink);
  const downHtml = await down.text();
  check("an unreadable chain is a 503 with Retry-After, no cookie", down.status === 503 && down.headers.get("retry-after") === "60" && downHtml.includes("Tap again in a minute") && !down.headers.get("set-cookie"));
  rel.petOwnerOf = realRead;
  check("with the chain back, the tap works again", (await tap(huntLink)).status === 302);
  cfg.modes.survivalLive = false;

  console.log("\novernight hardening (2026-10-29)");
  _resetChatState();
  _resetClaimState();
  cfg.CHAT_SERIALS = `${hunt.serial},${other.serial}`;
  // B1: the raw body is capped before any regex, and trailing space is trimmed per line.
  check("a raw body over 2000 characters is refused before normalising", (normalizeBody("x".repeat(2001)) as { error?: string }).error === "too long");
  check("100k spaces with no newline is answered at once (no quadratic regex)", (() => {
    const t0 = performance.now();
    const a = normalizeBody(" ".repeat(100_000));
    const b = normalizeBody(" ".repeat(1_990) + "x");
    return !a.ok && b.ok && b.body === "x" && performance.now() - t0 < 50;
  })());
  check("trailing space and tabs are trimmed per line", (normalizeBody("a   \nb\t \nc") as { body?: string }).body === "a\nb\nc");
  check("a raw name over 200 characters is 'long' before any regex", (normalizeName("a".repeat(201)) as { error?: string }).error === "long");
  // B4: invisibles go, look-alikes fold.
  check("zero-width, bidi and BOM characters are stripped from messages",
    (normalizeBody("he\u200Bl\u202El\uFEFFo\u2066 w\u2060orld\u200F") as { body?: string }).body === "hello world");
  check("an all-invisible message is empty", (normalizeBody("\u200B\u200D\u2060") as { error?: string }).error === "empty");
  check("invisibles are stripped from names before the rules run",
    (() => { const n = normalizeName("An\u200Bdy\u202E"); return n.ok && n.name === "Andy"; })() && (normalizeName("ad\u200Bmin") as { error?: string }).error === "reserved");
  check("Greek and Cyrillic look-alikes of reserved words are reserved",
    ["\u0397unt", "\u041Dunt", "h\u03C5nt", "W\u0410LLETCHI", "\u0430dmin", "Hünt", "Supp\u043ert"].every((n) => (normalizeName(n) as { error?: string }).error === "reserved"));
  check("look-alikes fold to one key (Latin Bob, Cyrillic Bob)", (() => {
    const a = normalizeName("Bob");
    const b = normalizeName("\u0412\u043Eb");
    return a.ok && b.ok && a.key === b.key && b.name === "\u0412\u043Eb";
  })());
  check("accents fold on Latin only: Cyrillic short i stays its own letter (no false collisions)", (() => {
    const a = normalizeName("\u0410\u043D\u0434\u0440\u0435\u0439");
    const b = normalizeName("\u0410\u043D\u0434\u0440\u0435\u0438");
    return a.ok && b.ok && a.key !== b.key;
  })());
  check("a look-alike of a taken name is taken (Cyrillic Es in Hunt Club)",
    (await setName(newCookie, "Hunt \u0421lub")).status === 409);
  // Review #106: rows saved under the OLDER key rule ("Jos\u00e9" keyed "jos\u00e9", "Jose" keyed "jose").
  {
    const legacyStore = store as unknown as { _putLegacyChatName: (s: string, n: string, k: string) => void };
    const huntName = await store.getChatName(hunt.serial);
    legacyStore._putLegacyChatName(other.serial, "Jos\u00e9", "jos\u00e9");
    legacyStore._putLegacyChatName(third.serial, "Jose", "jose");
    check("a keeper re-saving their own legacy name is NOT taken (it folds to their own row)",
      (await setName(newCookie, "Jos\u00e9")).status === 200 && (await store.getChatName(other.serial)) === "Jos\u00e9");
    check("another keeper cannot take a name that folds onto a legacy row (stored key or re-keyed name)",
      (await setName(huntCookie, "Jose")).status === 409 && (await setName(huntCookie, "JOS\u00c9")).status === 409 && (await store.getChatName(hunt.serial)) === huntName);
    await store.clearChatName(third.serial);
  }
  // B1: the room's API has an 8 kb JSON limit; the rest of the app keeps its own.
  check("a 9 kb body on /chat/api is a 413 JSON answer, not a 500",
    await (async () => {
      const r = await api(huntCookie, "messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "x".repeat(9_000) }) });
      return r.status === 413 && ((await r.json()) as { error: string }).error === "too long";
    })());
  check("a 9 kb name is a 413 too, and broken JSON is a 400",
    (await api(huntCookie, "name", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x".repeat(9_000) }) })).status === 413 &&
    (await api(huntCookie, "messages", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" })).status === 400);
  check("routes outside /chat/api still take bodies over 8 kb",
    (await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x@walletchi.test", pad: "y".repeat(20_000) }) })).status !== 413);
  // B3: three streams per pet, the oldest makes room.
  {
    const ss = [] as Array<Awaited<ReturnType<typeof openStream>>>;
    for (let i = 0; i < 4; i++) {
      const st = await openStream(huntCookie, 1_000_000);
      await st.waitFor((e) => e.event === "presence");
      ss.push(st);
    }
    check("a fourth stream for one pet evicts the oldest, three stay open",
      !!(await ss[0]!.waitFor((e) => e.event === "evicted")) && chatStreamState().streams === 3 && !ss.slice(1).some((x) => x.events.some((e) => e.event === "evicted")));
    const o = await openStream(newCookie, 1_000_000);
    await o.waitFor((e) => e.event === "presence");
    check("another pet's stream does not count against that cap", chatStreamState().streams === 4 && !ss.slice(1).some((x) => x.events.some((e) => e.event === "evicted")));
    // B2: the heartbeat re-check. A healthy room stays open; a failed read keeps it open too.
    await _recheckStreamsForTests();
    check("the heartbeat re-check leaves valid sessions open", chatStreamState().streams === 4 && !ss.some((x) => x.events.some((e) => e.event === "bye")));
    const realGet = store.getRunner.bind(store);
    (store as unknown as { getRunner: unknown }).getRunner = async () => { throw new Error("db blip"); };
    await _recheckStreamsForTests();
    (store as unknown as { getRunner: unknown }).getRunner = realGet;
    check("a failed read on the re-check keeps every stream (a blip never empties the room)", chatStreamState().streams === 4);
    // Review #106: a slow pass must never overlap the next heartbeat's.
    let reads = 0;
    (store as unknown as { getRunner: unknown }).getRunner = async (s: string) => { reads += 1; await sleep(150); return realGet(s); };
    await Promise.all([_recheckStreamsForTests(), _recheckStreamsForTests(), _recheckStreamsForTests()]);
    (store as unknown as { getRunner: unknown }).getRunner = realGet;
    check("overlapping re-checks run ONE pass (an in-flight guard), not three", reads === 2 && chatStreamState().streams === 4, `${reads} session reads for 2 cookies`);
    // Sold: the cached owner read turns, the heartbeat says bye to that pet's streams only.
    const realOwner2 = await chain.petOwnerOf(hunt.tokenId!);
    chain.setPetOwnerMock(hunt.tokenId!, "0x000000000000000000000000000000000000b0b0");
    _resetClaimState();
    await _recheckStreamsForTests();
    check("a sold pet's open streams get 'bye' on the heartbeat and close",
      (await Promise.all(ss.slice(1).map((x) => x.waitFor((e) => e.event === "bye")))).every(Boolean) && chatStreamState().streams === 1);
    check("the sold pet's message read and stream are refused (403, cookie cleared)",
      await (async () => {
        const m = await api(huntCookie, "messages?after=0");
        const st = await api(huntCookie, "stream?after=0");
        return m.status === 403 && /chichat=;.*Max-Age=0/.test(m.headers.get("set-cookie") ?? "") && st.status === 403;
      })());
    chain.setPetOwnerMock(hunt.tokenId!, realOwner2);
    _resetClaimState();
    // Rotated links: the cookie dies, so the heartbeat closes that room too.
    const keptToken = (await fresh(other)).authToken;
    await store.updateRunner(other.serial, { authToken: "rotated-again-for-the-heartbeat-check" });
    await _recheckStreamsForTests();
    check("rotated links: the open stream gets 'bye' on the heartbeat", !!(await o.waitFor((e) => e.event === "bye")) && chatStreamState().streams === 0);
    await store.updateRunner(other.serial, { authToken: keptToken });
    for (const x of [...ss, o]) await x.close();
    check("the page closes on 'bye' and stops reconnecting on 'evicted'",
      await (async () => { const h = await (await room(huntCookie)).text(); return h.includes("addEventListener('bye'") && h.includes("addEventListener('evicted'"); })());
  }
  _resetChatState();
  _resetClaimState();

  console.log("\nlink previews and the per-serial limiter (10 a minute)");
  _resetClaimState();
  const previewOwnerReads = { n: 0 };
  const relCount = relayer as unknown as { petOwnerOf: (id: string) => Promise<string> };
  const ownerRead = relCount.petOwnerOf.bind(relayer);
  relCount.petOwnerOf = async (id: string) => { previewOwnerReads.n += 1; return ownerRead(id); };
  let previewsOk = true;
  for (const ua of ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0", "WhatsApp/2.23.20.0 A", "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)", "TelegramBot (like TwitterBot)"]) {
    for (let i = 0; i < 3; i++) {
      const pv = await tap(huntLink, { "user-agent": ua });
      const h = await pv.text();
      if (pv.status !== 200 || pv.headers.get("location") || pv.headers.get("set-cookie") || !h.includes("Open this link from your WALLETCHI pass")) previewsOk = false;
    }
  }
  check("link previews (iMessage, WhatsApp, Discord, Telegram) get a plain 200 page, no cookie", previewsOk);
  check("and no chain read", previewOwnerReads.n === 0, String(previewOwnerReads.n));
  relCount.petOwnerOf = ownerRead;
  for (let i = 0; i < 15; i++) await tap(`${base}/chat/${hunt.serial}?s=${"f".repeat(24)}`);
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) codes.push((await tap(huntLink)).status);
  check("previews and wrong-tag taps do not spend the owner's window, and 10 taps pass", codes.slice(0, 10).every((s) => s === 302), codes.join(","));
  const over = await tap(huntLink);
  check("the 11th and later are a 429 with Retry-After", codes[10] === 429 && over.status === 429 && Number(over.headers.get("retry-after")) >= 1);
  check("another pet's window is its own", (await tap(chatUrl(rotated.serial, rotated.authToken))).status === 302);
  _resetClaimState();
} finally {
  _resetChatState();
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
