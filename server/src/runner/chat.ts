import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { ChatMessage, Runner } from "../store/types.js";
import { authInternal } from "../util/internal-auth.js";
import { careOwnerGuard, chatRateHit } from "./claim.js";
import { petName } from "./names.js";
import { GAME_SPRITE, petGameSpriteSvg } from "./pet.js";
import { chatPayload, chatSessionPayload, signTag, verifyTag } from "./sign.js";
import { stageFor } from "./stage.js";
import { runnerNumber } from "./theme.js";
import { traitsFor } from "./traits.js";
import { isLinkPreview } from "./valley.js";

// CHI CHAT: one room, every living Chi's keeper in it, opened from a CHAT link on the pass. The
// link is a CAPABILITY exactly like CHI VALLEY's (sign.ts: the care-link tag keyed by the per-pet
// authToken peppered with CARE_LINK_SECRET), so it dies on a claim and on "Reset my pass links".
// The link on the pass is STABLE; nothing expiring ever goes into the pass (the push gate would push
// every refresh). At tap time this route takes a FRESH ownerOf read, then sets the room cookie (a
// second tag, a different payload, so the cookie can never be turned back into a pass link) and
// 302s to /chat. The room itself carries nothing in its URL: without the cookie it is a closed
// door, and the cookie dies the moment the pet's links rotate or the pet dies.
//
// Pure talk: no tokens, no chain writes, no season state. Messages live in ChatMessage (one row
// each, moderator delete = deletedAt) and reach open rooms over a server-sent event stream, with a
// 20 s catch-up poll underneath it so a dropped stream or a deploy handover never loses a line.

export const CHAT_TITLE = "CHI CHAT";
const COOKIE = "chichat";
const COOKIE_MAX_AGE_S = 7 * 24 * 3600;
const ROOM_PATH = "/chat";
const MAX_BODY_CHARS = 500;
const PAGE = 60;
const MAX_PAGE = 100;
const MAX_STREAMS = 1500;
let maxStreams = MAX_STREAMS;
// Open streams per pet. A fourth tab closes the OLDEST (an old room tab Safari kept alive is the
// usual culprit), so one keeper can never hold more than a handful of the room's stream slots.
const MAX_STREAMS_PER_PET = 3;
// Raw input ceilings, checked BEFORE any regex runs. The body cap is 500 characters after
// normalising; anything this far over it is not a message, and a long run of spaces fed to a
// backtracking pattern is quadratic work done before the pace check ever sees the post.
const MAX_RAW_BODY_CHARS = 2_000;
const MAX_RAW_NAME_CHARS = 200;
const STREAM_HEARTBEAT_MS = 25_000;
const POST_MIN_GAP_MS = 1_500;
const POST_WINDOW_MS = 60_000;
const POST_WINDOW_MAX = 20;

// Parsed once per distinct env value (the env does not change at runtime, but the
// gate check flips it in-process).
function serialSet(): (raw: string | undefined) => ReadonlySet<string> {
  let seenRaw: string | undefined;
  let set: ReadonlySet<string> = new Set();
  return (raw) => {
    if (raw !== seenRaw) {
      seenRaw = raw;
      set = new Set((raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
    }
    return set;
  };
}
const chatSerials = serialSet();
const mutedSerials = serialSet();

/**
 * True when this pet's pass carries the CHAT link and the room is open to it. LIVING pets only,
 * minted (a tokenId), in the rollout.
 */
export function chatEnabledFor(runner: Pick<Runner, "serial" | "gone" | "status" | "tokenId">): boolean {
  if (runner.gone || runner.status !== "ready" || !runner.tokenId) return false;
  return config.CHAT_ENABLED || chatSerials(config.CHAT_SERIALS).has(runner.serial);
}

export function chatMutedFor(runner: Pick<Runner, "serial">): boolean {
  return mutedSerials(config.CHAT_MUTED_SERIALS).has(runner.serial);
}

export function chatUrl(serial: string, authToken: string): string {
  return `${config.PUBLIC_BASE_URL}/chat/${serial}?s=${signTag(authToken, chatPayload(serial))}`;
}

/** The room cookie's value for this pet: dies with the authToken (claim, reset). */
export function chatSessionValue(serial: string, authToken: string): string {
  return `${serial}.${signTag(authToken, chatSessionPayload(serial))}`;
}

// The avatar crop: 14 cells square around the body centre, nudged up a little for the head.
const FACE_CROP = {
  x: (GAME_SPRITE.bodyCx - 7) * GAME_SPRITE.cell,
  y: (GAME_SPRITE.bodyCy - 7.5) * GAME_SPRITE.cell,
  size: 14 * GAME_SPRITE.cell,
};

// Telegram's seven peer colours, picked by pet number so a Chi keeps its colour everywhere.
const NAME_COLORS_LIGHT = ["#CC5049", "#3F9D4A", "#B9880C", "#2A8AC7", "#8257D6", "#CC5A94", "#2096A0"];
const NAME_COLORS_DARK = ["#FF8E86", "#7BD37F", "#E8C45B", "#6DB8F5", "#B59CFF", "#FF8BC2", "#5CD3DE"];
function colorIndex(tokenId: string): number {
  let n = 0;
  for (const ch of tokenId) n = (n * 10 + (ch.charCodeAt(0) - 48)) % 7;
  return n;
}

interface ChatMessageOut {
  id: number;
  serial: string;
  tokenId: string;
  name: string; // the keeper's chosen room name (the pass name until one is picked)
  pet: string; // the pass name
  number: string;
  ci: number; // name colour index
  tint: string; // the pet's body colour (its avatar ring)
  body: string;
  gif?: GifOut;
  at: string;
}
function tintOf(seed: string): string {
  return traitsFor(seed).palette.B;
}
interface GifOut {
  id: string;
  url: string;
  w: number;
  h: number;
}
function parseGif(raw: string | null): GifOut | undefined {
  if (!raw) return undefined;
  try {
    const g = JSON.parse(raw) as Partial<GifOut>;
    if (typeof g.id === "string" && typeof g.url === "string" && typeof g.w === "number" && typeof g.h === "number") return { id: g.id, url: g.url, w: g.w, h: g.h };
  } catch {
    /* a row written by hand */
  }
  return undefined;
}
function toOut(m: ChatMessage, chosen: string | undefined): ChatMessageOut {
  const pet = petName(m.tokenId);
  const gif = parseGif(m.gif);
  return {
    ...(gif ? { gif } : {}),
    id: m.id,
    serial: m.serial,
    tokenId: m.tokenId,
    name: chosen ?? pet,
    pet,
    number: runnerNumber(m.tokenId, m.serial),
    ci: colorIndex(m.tokenId),
    tint: tintOf(m.tokenId),
    body: m.body,
    at: m.createdAt.toISOString(),
  };
}
/** Rows to wire shape, with every poster's chosen name looked up once. */
async function outAll(ctx: AppContext, rows: ChatMessage[]): Promise<ChatMessageOut[]> {
  const names = await ctx.store.getChatNames([...new Set(rows.map((m) => m.serial))]);
  return rows.map((m) => toOut(m, names.get(m.serial)));
}

interface You {
  serial: string;
  tokenId: string;
  name: string; // chosen room name
  pet: string; // pass name
  number: string;
  ci: number;
  tint: string;
}
function youOf(runner: Runner, chosen: string | null): You {
  const tokenId = runner.tokenId!;
  const pet = petName(tokenId);
  return { serial: runner.serial, tokenId, name: chosen ?? pet, pet, number: runnerNumber(tokenId, runner.serial), ci: colorIndex(tokenId), tint: tintOf(tokenId) };
}

// How many Chis are in the room's world: the living roster, counted at most every 5 minutes.
const LIVING_CACHE_MS = 5 * 60_000;
let livingCache: { at: number; n: number } | null = null;
async function livingCount(ctx: AppContext): Promise<number> {
  if (livingCache && Date.now() - livingCache.at < LIVING_CACHE_MS) return livingCache.n;
  const n = (await ctx.store.allMintedRunners()).filter((r) => r.status === "ready" && !r.gone).length;
  livingCache = { at: Date.now(), n };
  return n;
}

// ---- invisible characters ----
// Zero-width characters, bidi controls and other invisibles go from every message and name: they
// let a line reorder itself on screen, hide text, or make two names that look the same compare
// different. (Soft hyphen U+00AD, Arabic letter mark U+061C and Mongolian vowel separator U+180E
// ride along with the listed ranges.)
const INVISIBLES = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
export function stripInvisibles(s: string): string {
  return s.replace(INVISIBLES, "");
}

// ---- look-alike letters ----
// The reserved and uniqueness compare runs on a FOLDED key: Greek and Cyrillic letters that render
// like Latin ones become those Latin letters, and accents are dropped, so "Ηunt" with a Greek Eta,
// "hυnt" with an upsilon or "Hünt" all key as "hunt". Upper and lower case are folded separately
// where they look different (Greek Eta is H but eta is n). Display names are never changed.
const CONFUSABLES: Record<string, string> = {
  // Greek capitals
  "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k", "Μ": "m", "Ν": "n",
  "Ο": "o", "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x",
  // Greek small
  "α": "a", "β": "b", "γ": "y", "ε": "e", "η": "n", "ι": "i", "κ": "k", "μ": "u", "ν": "v",
  "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w", "ϲ": "c", "ϳ": "j",
  // Cyrillic capitals
  "А": "a", "В": "b", "Е": "e", "Ё": "e", "Ѕ": "s", "І": "i", "Ї": "i", "Ј": "j", "К": "k",
  "М": "m", "Н": "h", "О": "o", "Р": "p", "С": "c", "Т": "t", "У": "y", "Х": "x", "Ү": "y",
  "Һ": "h", "Ԁ": "d", "Ԛ": "q", "Ԝ": "w", "Ӏ": "l",
  // Cyrillic small
  "а": "a", "в": "b", "е": "e", "ё": "e", "ѕ": "s", "і": "i", "ї": "i", "ј": "j", "к": "k",
  "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ү": "y",
  "һ": "h", "ԁ": "d", "ԛ": "q", "ԝ": "w", "ӏ": "l", "ь": "b",
  // Latin look-alikes NFKC leaves alone
  "ı": "i", "ɑ": "a", "ɡ": "g", "ɩ": "i", "ʏ": "y",
};
export function foldConfusables(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFKC")) out += CONFUSABLES[ch] ?? ch;
  // Accents last, on Latin letters only (other scripts need their marks): decompose, drop the
  // combining marks that sit on a Latin letter, recompose.
  return out.normalize("NFKD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC").toLowerCase();
}

// ---- the room name ----
// The uniqueness key under the CURRENT rule: look-alikes folded, then spacing and _ . - ' dropped.
// Also how rows saved under the older rule are re-keyed for the compare (store setChatName).
export function nameKeyOf(name: string): string {
  return foldConfusables(name).replace(/[\s_.\-']+/g, "");
}

// Picked once on first entry, saved per pet, changeable from the avatar. 2 to 20 characters of
// letters, numbers, spaces and _ . - ' ; unique across the room ignoring case and spacing, so no
// two keepers can look alike. A few words are reserved so nobody can pose as the house.
const NAME_MIN = 2;
const NAME_MAX = 20;
const NAME_RESERVED = new Set(["walletchi", "hunt", "halldon", "admin", "mod", "moderator", "support", "team", "chichat", "system"]);
export type NameCheck = { ok: true; name: string; key: string } | { ok: false; error: "short" | "long" | "chars" | "reserved" };
export function normalizeName(raw: unknown): NameCheck {
  if (typeof raw !== "string") return { ok: false, error: "short" };
  if (raw.length > MAX_RAW_NAME_CHARS) return { ok: false, error: "long" };
  const name = stripInvisibles(raw.normalize("NFC")).replace(/\s+/g, " ").trim();
  const len = [...name].length;
  if (len < NAME_MIN) return { ok: false, error: "short" };
  if (len > NAME_MAX) return { ok: false, error: "long" };
  if (!/^[\p{L}\p{N} _.\-']+$/u.test(name)) return { ok: false, error: "chars" };
  const key = nameKeyOf(name);
  if (key.length === 0 || NAME_RESERVED.has(key)) return { ok: false, error: "reserved" };
  return { ok: true, name, key };
}

// ---- the message text ----
// Plain text only. Control characters and invisibles go (newlines and tabs stay), trailing space
// on each line goes, runs of blank lines collapse, and the length is counted in code points so an
// emoji is one character, not two. An oversized raw body is refused before any of that runs, and
// trailing space is trimmed per line (linear) rather than by a /[ \t]+\n/ pattern, which
// backtracks quadratically over a long run of spaces with no newline after it.
export function normalizeBody(raw: unknown): { ok: true; body: string } | { ok: false; error: "empty" | "too long" } {
  if (typeof raw !== "string") return { ok: false, error: "empty" };
  if (raw.length > MAX_RAW_BODY_CHARS) return { ok: false, error: "too long" };
  const body = stripInvisibles(raw.replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n\t]/gu, ""))
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!body) return { ok: false, error: "empty" };
  if ([...body].length > MAX_BODY_CHARS) return { ok: false, error: "too long" };
  return { ok: true, body };
}

// ---- posting pace, per pet ----
type Pace = { last: number; windowStart: number; count: number };
const pace = new Map<string, Pace>();
const MAX_PACE_KEYS = 5_000;
/** Retry-after seconds when this pet is posting too fast, else null (and the post is counted). */
export function postPaceHit(serial: string, now = Date.now()): number | null {
  let p = pace.get(serial);
  if (!p || now - p.windowStart >= POST_WINDOW_MS) {
    if (!p && pace.size >= MAX_PACE_KEYS) {
      for (const [k, v] of pace) if (now - v.windowStart >= POST_WINDOW_MS) pace.delete(k);
    }
    p = { last: 0, windowStart: now, count: 0 };
    pace.set(serial, p);
  }
  if (now - p.last < POST_MIN_GAP_MS) return Math.max(1, Math.ceil((p.last + POST_MIN_GAP_MS - now) / 1000));
  if (p.count >= POST_WINDOW_MAX) return Math.max(1, Math.ceil((p.windowStart + POST_WINDOW_MS - now) / 1000));
  p.last = now;
  p.count += 1;
  return null;
}

// ---- GIFs, through GIPHY ----
// The page never talks to GIPHY: searches go through /chat/api/gifs with the server's key, and a
// GIF post names only the gif id, which the server resolves itself (so a line can never carry an
// arbitrary URL). GIPHY's terms want the "Powered by GIPHY" mark on the picker; the page shows it.
const GIPHY_API = "https://api.giphy.com/v1/gifs";
const GIF_LIMIT = 24;
const GIF_RATING = "pg-13";
const GIF_TIMEOUT_MS = 6_000;
const GIF_CACHE_MS = 5 * 60_000;
const GIF_CACHE_MAX = 300;
export function gifsEnabled(): boolean {
  return Boolean(config.GIPHY_API_KEY);
}
type GiphyImage = { url?: string; webp?: string; width?: string; height?: string };
type GiphyGif = { id?: string; images?: { fixed_width?: GiphyImage; fixed_width_small?: GiphyImage } };
export interface GifPick {
  id: string;
  url: string; // animated webp (or gif) at 200 px wide
  w: number;
  h: number;
}
function pickOf(g: GiphyGif): GifPick | null {
  const img = g.images?.fixed_width;
  const url = img?.webp || img?.url;
  const w = Number(img?.width), h = Number(img?.height);
  if (!g.id || !url || !/^https:\/\/[a-z0-9.-]+\.giphy\.com\//i.test(url) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { id: g.id, url, w, h };
}
async function giphy(path: string, params: Record<string, string>): Promise<unknown> {
  const key = config.GIPHY_API_KEY;
  if (!key) throw new Error("gifs off");
  const q = new URLSearchParams({ api_key: key, ...params });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), GIF_TIMEOUT_MS);
  try {
    const res = await fetch(`${GIPHY_API}${path}?${q}`, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`giphy ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
const gifCache = new Map<string, { at: number; gifs: GifPick[] }>();
export async function gifSearch(q: string, offset: number): Promise<GifPick[]> {
  const key = `${q}\u0000${offset}`;
  const hit = gifCache.get(key);
  if (hit && Date.now() - hit.at < GIF_CACHE_MS) return hit.gifs;
  const data = (await (q
    ? giphy("/search", { q, limit: String(GIF_LIMIT), offset: String(offset), rating: GIF_RATING, lang: "en" })
    : giphy("/trending", { limit: String(GIF_LIMIT), offset: String(offset), rating: GIF_RATING }))) as { data?: GiphyGif[] };
  const gifs = (data.data ?? []).map(pickOf).filter((g): g is GifPick => g !== null);
  gifCache.set(key, { at: Date.now(), gifs });
  if (gifCache.size > GIF_CACHE_MAX) gifCache.delete(gifCache.keys().next().value!);
  return gifs;
}
export async function gifById(id: string): Promise<GifPick | null> {
  const data = (await giphy(`/${encodeURIComponent(id)}`, { rating: GIF_RATING })) as { data?: GiphyGif };
  return data.data ? pickOf(data.data) : null;
}
const GIF_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---- rename pace, per pet: 5 in 10 minutes ----
const NAME_WINDOW_MS = 10 * 60_000;
const NAME_WINDOW_MAX = 5;
const namePace = new Map<string, { windowStart: number; count: number }>();
export function namePaceHit(serial: string, now = Date.now()): number | null {
  let p = namePace.get(serial);
  if (!p || now - p.windowStart >= NAME_WINDOW_MS) {
    if (!p && namePace.size >= MAX_PACE_KEYS) {
      for (const [k, v] of namePace) if (now - v.windowStart >= NAME_WINDOW_MS) namePace.delete(k);
    }
    p = { windowStart: now, count: 0 };
    namePace.set(serial, p);
  }
  if (p.count >= NAME_WINDOW_MAX) return Math.max(1, Math.ceil((p.windowStart + NAME_WINDOW_MS - now) / 1000));
  p.count += 1;
  return null;
}

// ---- the live stream ----
// Each stream keeps what it needs to re-check its own session on the heartbeat: the request (its
// cookie) and the app context.
type Stream = { res: Response; serial: string; req: Request; ctx: AppContext };
const streams = new Set<Stream>();
let heartbeat: NodeJS.Timeout | null = null;

function onlineCount(): number {
  const s = new Set<string>();
  for (const x of streams) s.add(x.serial);
  return s.size;
}

function send(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown): void {
  for (const s of streams) {
    try {
      send(s.res, event, data);
    } catch {
      streams.delete(s);
    }
  }
}

function presenceChanged(): void {
  broadcast("presence", { online: onlineCount() });
}

function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    if (streams.size === 0) {
      clearInterval(heartbeat!);
      heartbeat = null;
      return;
    }
    for (const s of streams) {
      try {
        s.res.write(": ping\n\n");
      } catch {
        streams.delete(s);
      }
    }
    void recheckStreams();
  }, STREAM_HEARTBEAT_MS);
  heartbeat.unref?.();
}

// LOST ACCESS CLOSES THE ROOM. The page has always listened for 'bye' (close, then reload into
// whatever door applies); now the server sends it. On each heartbeat every open stream's cookie is
// re-checked (sessionOf: rotated links, a dead pet, out of the rollout) along with the owner
// through the cached read, once per distinct cookie. A read that fails keeps the stream: an RPC or
// database blip must never empty the room.
let recheckInFlight = false;
async function recheckStreams(): Promise<void> {
  // A slow database or RPC must never stack re-checks: one pass at a time, the next tick starts fresh.
  if (recheckInFlight) return;
  recheckInFlight = true;
  try {
    await recheckStreamsOnce();
  } finally {
    recheckInFlight = false;
  }
}

async function recheckStreamsOnce(): Promise<void> {
  const groups = new Map<string, Stream[]>();
  for (const s of streams) {
    const key = s.req.headers.cookie ?? "";
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  let closed = 0;
  for (const group of groups.values()) {
    const first = group[0]!;
    let ok = true;
    try {
      const runner = await sessionOf(first.ctx, first.req);
      ok = runner !== null && (await stillOwner(first.ctx, runner));
    } catch {
      ok = true;
    }
    if (ok) continue;
    for (const s of group) if (endStream(s, "bye")) closed += 1;
  }
  if (closed > 0) presenceChanged();
}

// Close one stream with a last event. True when it was still open.
function endStream(s: Stream, event: "bye" | "evicted"): boolean {
  if (!streams.delete(s)) return false;
  try {
    send(s.res, event, {});
    s.res.end();
  } catch {
    /* already gone */
  }
  return true;
}

/** Test hook: run the heartbeat's session re-check now instead of waiting 25 s. */
export async function _recheckStreamsForTests(): Promise<void> {
  await recheckStreams();
}

/** Open-room statistics for /internal/chat (and the chat check). */
export function chatStreamState(): { streams: number; online: number } {
  return { streams: streams.size, online: onlineCount() };
}

// Test hook: drop every open stream and the posting pace between check scenarios.
export function _resetChatState(): void {
  for (const s of streams) {
    try {
      s.res.end();
    } catch {
      /* closed */
    }
  }
  streams.clear();
  pace.clear();
  namePace.clear();
  maxStreams = MAX_STREAMS;
}

// Test hook: a smaller stream cap, so the full-room answer can be exercised.
export function _setMaxStreamsForTests(n: number): void {
  maxStreams = n;
}

// ---- cookies ----
function cookieOf(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null; // a mangled cookie is no cookie
      }
    }
  }
  return null;
}

function cookieAttrs(): string {
  const secure = config.PUBLIC_BASE_URL.startsWith("https:") ? "; Secure" : "";
  return `; Path=${ROOM_PATH}; HttpOnly; SameSite=Lax${secure}`;
}

function setSessionCookie(res: Response, value: string): void {
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(value)}; Max-Age=${COOKIE_MAX_AGE_S}${cookieAttrs()}`);
}

function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${COOKIE}=; Max-Age=0${cookieAttrs()}`);
}

/** The pet behind the room cookie, or null (no cookie, a rotated token, a dead pet, out of the rollout). */
async function sessionOf(ctx: AppContext, req: Request): Promise<Runner | null> {
  const value = cookieOf(req, COOKIE);
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const serial = value.slice(0, dot);
  const tag = value.slice(dot + 1);
  const runner = await ctx.store.getRunner(serial);
  if (!runner || !chatEnabledFor(runner)) return null;
  if (!verifyTag(runner.authToken, chatSessionPayload(serial), tag)) return null;
  return runner;
}

/**
 * The tap took a fresh owner read, but the cookie outlives it: a keeper who sells the pet keeps a
 * valid cookie until the buyer claims (which rotates the authToken). So the room and every post
 * re-check the owner through the cached read (60 s, claim.ts); a sold pet is shown the door. An
 * unreadable chain counts as ok here (a read path), so an RPC blip never locks the room.
 */
async function stillOwner(ctx: AppContext, runner: Runner): Promise<boolean> {
  return (await careOwnerGuard(ctx, runner)) !== "transferred";
}

// ---- the page ----
const CHAT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: https://*.giphy.com",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function escapeJsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

interface Boot {
  title: string;
  you: You;
  online: number;
  living: number;
  messages: ChatMessageOut[];
  hasMore: boolean;
  muted: boolean;
  gifs: boolean;
  colors: { light: string[]; dark: string[] };
}

// The wallpaper: a tile of soft doodles (hearts, stars, paws, bones, leaves, fish, sparks) over
// the room colour, the way Telegram's default wallpaper works. One SVG, tinted per scheme.
function wallpaper(stroke: string): string {
  // hearts, four-point stars, paws, bones, leaves, fish, bolts, sparks, a tiny egg and a fruit
  const d = [
    "M30 44c-7-9-18-2-13 7 3 6 13 12 13 12s10-6 13-12c5-9-6-16-13-7z",
    "M120 20l3 8 8 3-8 3-3 8-3-8-8-3 8-3z",
    "M180 70a5 5 0 1 1 0 .1zM168 62a4 4 0 1 1 0 .1zM192 62a4 4 0 1 1 0 .1zM174 50a3.5 3.5 0 1 1 0 .1zM186 50a3.5 3.5 0 1 1 0 .1z",
    "M40 120h26M40 120a5 5 0 1 1 0-.1M40 120a5 5 0 1 0 0 .1M66 120a5 5 0 1 1 0-.1M66 120a5 5 0 1 0 0 .1",
    "M130 140c12-14 28-11 28 0s-16 14-28 0zM130 140l28 0",
    "M60 180c8-10 22-10 30 0-8 10-22 10-30 0zM90 180l9-7v14zM70 178a1.5 1.5 0 1 1 0 .1",
    "M186 150l-7 12h6l-4 12 10-15h-6z",
    "M100 86l2 5 5 2-5 2-2 5-2-5-5-2 5-2z",
    "M20 70l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z",
    "M160 190c-5-6-12-1-9 5 2 4 9 8 9 8s7-4 9-8c3-6-4-11-9-5z",
    "M226 110c0-9 6-16 12-16s12 7 12 16-5 13-12 13-12-4-12-13z",
    "M86 232a9 9 0 1 1 0 .1M86 223v-6M86 217c3-3 7-3 9 0",
    "M240 30l2 5 5 2-5 2-2 5-2-5-5-2 5-2z",
    "M20 230h18M20 230a3.5 3.5 0 1 1 0-.1M38 230a3.5 3.5 0 1 1 0-.1",
    "M210 210c8-9 18-5 18 2s-10 9-18-2z",
    "M140 250a4 4 0 1 1 0 .1zM130 244a3 3 0 1 1 0 .1zM150 244a3 3 0 1 1 0 .1z",
  ];
  const paths = d.map((p) => `<path d="${p}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260" viewBox="0 0 260 260" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
const WALLPAPER_LIGHT = wallpaper("rgba(52,84,112,0.16)");
const WALLPAPER_DARK = wallpaper("rgba(255,255,255,0.07)");

function roomPage(boot: Boot): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F6F6F6">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#17212B">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="format-detection" content="telephone=no">
<title>${esc(boot.title)}</title>
<style>
:root{
  --wp:${WALLPAPER_LIGHT};--bg0:#D5E3EF;--bg1:#E9EEF3;
  --bar:rgba(247,248,250,.86);--line:rgba(0,0,0,.1);--text:#0B0F14;--sub:#7C8794;
  --in:#FFFFFF;--out:#E4FFC9;--meta:#9AA5B1;--meta-out:#5FA955;--accent:#2F8FEA;--on-accent:#fff;
  --pill:rgba(44,58,72,.42);--pill-text:#fff;--field:#fff;--field-line:rgba(0,0,0,.12);--fab:#fff;--fab-ink:#6F7B88;
  --shadow:0 1px 2px rgba(20,30,40,.10),0 6px 18px -12px rgba(20,30,40,.25);--ring:#fff;
  --col:720px;--pad:max(10px,calc((100% - var(--col))/2));
}
@media (prefers-color-scheme: dark){:root{
  --wp:${WALLPAPER_DARK};--bg0:#0C141D;--bg1:#101B27;
  --bar:rgba(20,29,39,.84);--line:rgba(255,255,255,.08);--text:#F2F5F8;--sub:#7F8C9A;
  --in:#1A2633;--out:#2B5278;--meta:#6E8093;--meta-out:#8DB4E2;--accent:#5EB5F7;--on-accent:#fff;
  --pill:rgba(16,24,33,.78);--pill-text:#CBD5DF;--field:#1E2A37;--field-line:rgba(255,255,255,.1);--fab:#1A2633;--fab-ink:#9AA8B6;
  --shadow:0 1px 1px rgba(0,0,0,.25);--ring:#1A2633;
}}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;background:var(--bg0);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;overscroll-behavior:none;text-rendering:optimizeLegibility}
body{position:fixed;inset:0;height:var(--vvh,100dvh);display:flex;flex-direction:column;overflow:hidden;background:var(--wp) center top/260px 260px repeat,linear-gradient(180deg,var(--bg0),var(--bg1))}
.bar{flex:none;background:var(--bar);-webkit-backdrop-filter:saturate(180%) blur(22px);backdrop-filter:saturate(180%) blur(22px);border-bottom:.5px solid var(--line);padding-top:env(safe-area-inset-top);z-index:3}
.hd{height:54px;display:grid;grid-template-columns:76px 1fr 76px;align-items:center;max-width:calc(var(--col) + 40px);margin:0 auto;padding:0 10px}
.who{display:flex;align-items:center;height:36px;padding-left:4px}
.who img{width:30px;height:30px;border-radius:50%;background:var(--in);border:2px solid var(--ring);box-shadow:0 0 0 1.5px var(--tint,transparent);image-rendering:pixelated;margin-left:-9px;display:block}
.who img:first-child{margin-left:0}
.hd .t{text-align:center;line-height:1.15;min-width:0}
.hd .t b{display:block;font-size:17px;font-weight:700;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hd .t span{display:block;font-size:12.5px;color:var(--sub);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hd .t span i{font-style:normal;color:var(--accent)}
.me{justify-self:end;width:38px;height:38px;border-radius:50%;overflow:hidden;background:var(--in);border:2px solid var(--ring);box-shadow:0 0 0 1.5px var(--tint,transparent);cursor:pointer}
.me img{width:100%;height:100%;display:block;image-rendering:pixelated}
.list{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px var(--pad) 12px;scroll-behavior:auto;overscroll-behavior:contain;position:relative}
.more{position:absolute;top:calc(env(safe-area-inset-top) + 62px);left:50%;transform:translateX(-50%);background:var(--pill);color:var(--pill-text);font-size:12px;font-weight:600;padding:5px 10px;border-radius:999px;z-index:2;opacity:0;transition:opacity .15s;pointer-events:none}
.more.on{opacity:1}
.day{display:flex;justify-content:center;margin:10px 0 6px;pointer-events:none}
.fd{position:absolute;top:calc(env(safe-area-inset-top) + 62px);left:50%;transform:translateX(-50%);background:var(--pill);color:var(--pill-text);font-size:12.5px;font-weight:600;padding:4px 10px;border-radius:999px;z-index:2;opacity:0;transition:opacity .18s;pointer-events:none;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.fd.on{opacity:1}
.day span{background:var(--pill);color:var(--pill-text);font-size:12.5px;font-weight:600;padding:4px 10px;border-radius:999px;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.row{display:flex;align-items:flex-end;gap:7px;margin:1.5px 0;max-width:100%}
.row.first{margin-top:7px}
.row.out{justify-content:flex-end}
.av{flex:none;width:32px;height:32px;border-radius:50%;overflow:hidden;background:var(--in);border:1.5px solid var(--ring);box-shadow:0 0 0 1.5px var(--tint,transparent);visibility:hidden}
.row.last .av{visibility:visible}
.row.out .av{display:none}
.av img{width:100%;height:100%;display:block;image-rendering:pixelated}
.b{position:relative;max-width:min(76%,460px);padding:6px 11px 7px;border-radius:18px;font-size:16.5px;line-height:1.3;word-wrap:break-word;overflow-wrap:anywhere;white-space:pre-wrap;box-shadow:var(--shadow)}
.row.in .b{background:var(--in);border-top-left-radius:18px;border-bottom-left-radius:18px}
.row.in:not(.first) .b{border-top-left-radius:6px}
.row.in:not(.last) .b{border-bottom-left-radius:6px}
.row.in.last .b{border-bottom-left-radius:4px}
.row.out .b{background:var(--out)}
.row.out:not(.first) .b{border-top-right-radius:6px}
.row.out:not(.last) .b{border-bottom-right-radius:6px}
.row.out.last .b{border-bottom-right-radius:4px}
.row.last .b::after{content:"";position:absolute;bottom:0;width:10px;height:15px}
.row.in.last .b::after{left:-7px;background:radial-gradient(15px 15px at 0 0,transparent 14px,var(--in) 15px) no-repeat;transform:scaleX(-1)}
.row.out.last .b::after{right:-7px;background:radial-gradient(15px 15px at 0 0,transparent 14px,var(--out) 15px) no-repeat}
.nm{display:flex;align-items:baseline;gap:6px;font-size:14px;font-weight:650;margin:1px 0 2px;line-height:1.2}
.nm small{font-weight:500;font-size:11.5px;color:var(--meta);letter-spacing:.01em}
.b .tm{float:right;margin:8px -5px -4px 9px;font-size:11px;color:var(--meta);line-height:1;display:inline-flex;align-items:center;gap:3px;white-space:nowrap}
.row.out .b .tm{color:var(--meta-out)}
.tm svg{width:14px;height:10px;display:block}
.row.pending .b{opacity:.72}
@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}
.row.new{animation:pop .24s cubic-bezier(.2,.8,.2,1)}
@media (prefers-reduced-motion: reduce){.row.new,.toast,.gs{animation:none;transition:none}}
.b.media{padding:3px;overflow:hidden}
.b.media .nm{padding:4px 9px 2px}
.b.media .gif{display:block;width:min(260px,100%);height:auto;border-radius:15px}
.b.media .tm{position:absolute;right:9px;bottom:9px;margin:0;float:none;background:rgba(0,0,0,.45);color:#fff;padding:3px 7px;border-radius:10px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.row.out .b.media .tm{color:#fff}
.empty{height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
.empty div{background:var(--in);color:var(--text);font-size:15px;line-height:1.45;padding:22px 24px;border-radius:22px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:10px;box-shadow:var(--shadow);max-width:300px}
.empty img{width:72px;height:72px;border-radius:50%;background:var(--bg1);image-rendering:pixelated;border:2px solid var(--ring);box-shadow:0 0 0 2px var(--tint,transparent)}
.empty b{font-size:17px;font-weight:700}
.empty span{color:var(--sub)}
.fab{position:absolute;right:calc(var(--pad) + 2px);bottom:calc(var(--composer,56px) + 14px);width:42px;height:42px;border-radius:50%;background:var(--fab);color:var(--fab-ink);border:.5px solid var(--line);box-shadow:0 4px 14px rgba(0,0,0,.18);display:none;align-items:center;justify-content:center;z-index:2}
.fab.on{display:flex}.fab svg{width:18px;height:18px}
.fab i{position:absolute;top:-6px;left:50%;transform:translateX(-50%);background:var(--accent);color:var(--on-accent);font-style:normal;font-size:11px;font-weight:700;min-width:18px;height:18px;line-height:18px;text-align:center;border-radius:9px;padding:0 5px}
.cp{flex:none;background:var(--bar);-webkit-backdrop-filter:saturate(180%) blur(22px);backdrop-filter:saturate(180%) blur(22px);border-top:.5px solid var(--line);padding:7px var(--pad) calc(env(safe-area-inset-bottom) + 7px);display:flex;align-items:flex-end;gap:8px;z-index:3}
.fld{flex:1;display:flex;align-items:flex-end;min-height:38px;background:var(--field);border:.5px solid var(--field-line);border-radius:19px;padding:0 14px;transition:border-color .15s,box-shadow .15s}
.fld:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
textarea{flex:1;border:0;outline:0;background:transparent;color:var(--text);font:inherit;font-size:16.5px;line-height:21px;padding:8px 0;max-height:126px;resize:none;caret-color:var(--accent)}
textarea::placeholder{color:var(--sub)}
.snd{flex:none;width:38px;height:38px;border-radius:50%;border:0;background:var(--accent);color:var(--on-accent);display:flex;align-items:center;justify-content:center;opacity:.35;transition:opacity .15s,transform .1s;box-shadow:0 3px 10px -4px var(--accent)}
.snd.on{opacity:1}.snd:active{transform:scale(.92)}.snd svg{width:18px;height:18px;margin-left:2px}
.muted{flex:1;text-align:center;color:var(--sub);font-size:14px;padding:10px 0}
.toast{position:absolute;left:50%;bottom:calc(var(--composer,56px) + 20px);transform:translateX(-50%);background:var(--pill);color:var(--pill-text);font-size:14px;font-weight:600;padding:9px 14px;border-radius:12px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:4;white-space:nowrap;max-width:90%;overflow:hidden;text-overflow:ellipsis;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.toast.on{opacity:1}
.gifb{flex:none;height:38px;padding:0 11px;border-radius:19px;border:.5px solid var(--field-line);background:var(--field);color:var(--sub);font:inherit;font-size:13px;font-weight:700;letter-spacing:.02em}
.gifb.on{color:var(--accent);border-color:var(--accent)}
.gs{position:absolute;left:0;right:0;bottom:var(--composer,56px);height:min(46vh,380px);background:var(--bar);-webkit-backdrop-filter:saturate(180%) blur(22px);backdrop-filter:saturate(180%) blur(22px);border-top:.5px solid var(--line);display:flex;flex-direction:column;z-index:3;padding:0 var(--pad)}
.gs[hidden]{display:none}
.gsh{display:flex;gap:8px;padding:8px 2px 6px}
.gsh .fld{min-height:34px}
.gsh input{flex:1;border:0;outline:0;background:transparent;color:var(--text);font:inherit;font-size:15px}
.gsx{flex:none;border:0;background:transparent;color:var(--accent);font:inherit;font-size:15px;font-weight:600;padding:0 4px}
.gg{flex:1;overflow-y:auto;padding:0 0 8px;column-count:2;column-gap:6px}
@media (min-width:600px){.gg{column-count:3}}
.gg img{display:block;width:100%;height:auto;border-radius:10px;margin-bottom:6px;break-inside:avoid;background:rgba(127,127,127,.15)}
.gg .none{column-span:all;color:var(--sub);font-size:14px;text-align:center;padding:30px 0}
.gsf{flex:none;text-align:center;color:var(--sub);font-size:11px;font-weight:600;letter-spacing:.06em;padding:4px 0 calc(env(safe-area-inset-bottom) + 4px)}
a{color:inherit}
@media (max-width:360px){.b{font-size:15.5px;max-width:82%}.hd{grid-template-columns:64px 1fr 64px}.who img:nth-child(3){display:none}}
@media (min-width:700px){.b{max-width:min(68%,520px)}.hd .t b{font-size:18px}}
</style></head><body>
<div class="bar"><div class="hd">
  <div class="who" id="who"></div>
  <div class="t"><b>${esc(boot.title)}</b><span id="sub"></span></div>
  <div class="me" id="me" title="You" style="--tint:${esc(boot.you.tint)}"><img src="/chat/api/face/${esc(boot.you.serial)}.svg" alt=""></div>
</div></div>
<div class="list" id="list"></div>
<div class="more" id="more">Loading earlier lines</div>
<div class="fd" id="fd"></div>
<button class="fab" id="fab" aria-label="Jump to the latest"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg><i id="fabn" hidden></i></button>
<div class="cp" id="cp">
  ${boot.muted
    ? `<div class="muted">You can read the room, but you cannot post right now.</div>`
    : `${boot.gifs ? `<button class="gifb" id="gifb" aria-label="GIFs">GIF</button>` : ""}<div class="fld"><textarea id="in" rows="1" placeholder="Message" autocomplete="off" autocapitalize="sentences" enterkeyhint="send" maxlength="${MAX_BODY_CHARS * 2}"></textarea></div>
  <button class="snd" id="snd" aria-label="Send"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.4-7.5c.8-.4.8-1.5 0-1.8L3.4 3.6c-.7-.3-1.4.3-1.3 1l1.2 6.2L14 12l-10.7 1.2-1.2 6.2c-.1.7.6 1.3 1.3 1z"/></svg></button>`}
</div>
${boot.gifs && !boot.muted ? `<div class="gs" id="gs" hidden><div class="gsh"><div class="fld"><input id="gq" type="search" placeholder="Search GIPHY" autocomplete="off" autocorrect="off" enterkeyhint="search"></div><button class="gsx" id="gsx">Close</button></div><div class="gg" id="gg"></div><div class="gsf">POWERED BY GIPHY</div></div>` : ""}
<div class="toast" id="toast"></div>
<script>
const BOOT=/*__BOOT__*/null;
(()=>{
const $=(id)=>document.getElementById(id);
const list=$('list'),fab=$('fab'),fabn=$('fabn'),sub=$('sub'),toastEl=$('toast'),input=$('in'),snd=$('snd'),cp=$('cp');
const dark=matchMedia('(prefers-color-scheme: dark)');
const you=BOOT.you;let online=BOOT.online;let living=BOOT.living;let hasMore=BOOT.hasMore;const who=$('who'),more=$('more'),fd=$('fd');let fdT=null;let lastId=0,firstId=0;let unread=0;let loadingOlder=false;
const byId=new Map();const pending=new Map();let pendingSeq=0;let booted=false;
const esc=(s)=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const color=(ci)=>(dark.matches?BOOT.colors.dark:BOOT.colors.light)[ci%7];
const tfmt=new Intl.DateTimeFormat([],{hour:'2-digit',minute:'2-digit'});
const dfmt=new Intl.DateTimeFormat([],{month:'long',day:'numeric'});
const dfmtY=new Intl.DateTimeFormat([],{month:'long',day:'numeric',year:'numeric'});
const dayKey=(d)=>d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate();
function dayLabel(d){const now=new Date();const t=new Date(now.getFullYear(),now.getMonth(),now.getDate());const diff=Math.round((t-new Date(d.getFullYear(),d.getMonth(),d.getDate()))/864e5);if(diff===0)return 'Today';if(diff===1)return 'Yesterday';return d.getFullYear()===now.getFullYear()?dfmt.format(d):dfmtY.format(d)}
const CHECK='<svg viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 6l3.4 3.4L13.5 1"/></svg>';
const CLOCK='<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="6" cy="6" r="4.6"/><path d="M6 3.4V6l1.8 1.2"/></svg>';
function setSub(){sub.innerHTML=esc(String(living))+' Chis &middot; '+(online<=1?'you are '+esc(you.name):'<i>'+online+' here now</i>')}
// the faces in the header: the last three Chis to speak, newest first
function updateWho(){const seen=[];const rows=[...list.querySelectorAll('.row')].reverse();for(const r of rows){if(r.dataset.serial===you.serial)continue;if(!seen.some(x=>x.serial===r.dataset.serial))seen.push({serial:r.dataset.serial,tint:r.dataset.tint});if(seen.length===3)break}
  who.innerHTML=seen.map(x=>'<img src="/chat/api/face/'+encodeURIComponent(x.serial)+'.svg" alt="" style="--tint:'+esc(x.tint||'')+'">').join('')}
function toast(t){toastEl.textContent=t;toastEl.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(()=>toastEl.classList.remove('on'),1800)}
function nearBottom(){return list.scrollHeight-list.scrollTop-list.clientHeight<120}
function toBottom(){list.scrollTop=list.scrollHeight;unread=0;fab.classList.remove('on');fabn.hidden=true}
function bubble(m,mine){
  const row=document.createElement('div');row.className='row '+(mine?'out':'in')+(m.pending?' pending':'');row.dataset.id=m.id;row.dataset.serial=m.serial;row.dataset.number=m.number;row.dataset.tint=m.tint||'';row.dataset.day=dayKey(new Date(m.at));row.dataset.at=m.at;
  const av=document.createElement('div');av.className='av';av.style.setProperty('--tint',m.tint||'transparent');if(!mine){av.innerHTML='<img src="/chat/api/face/'+encodeURIComponent(m.serial)+'.svg" alt="" loading="lazy">'}
  const b=document.createElement('div');b.className='b';
  const nm=mine?'':'<span class="nm" style="color:'+color(m.ci)+'">'+esc(m.name)+'<small>'+esc(m.number)+'</small></span>';
  const tm='<span class="tm">'+tfmt.format(new Date(m.at))+(mine?(m.pending?CLOCK:CHECK):'')+'</span>';
  if(m.gif){b.classList.add('media');b.innerHTML=nm+'<img class="gif" src="'+esc(m.gif.url)+'" width="'+(m.gif.w|0)+'" height="'+(m.gif.h|0)+'" alt="GIF" loading="lazy">'+tm}
  else b.innerHTML=nm+esc(m.body)+tm;
  if(mine){row.appendChild(b);row.appendChild(av)}else{row.appendChild(av);row.appendChild(b)}
  return row;
}
function dayPill(d){const el=document.createElement('div');el.className='day';el.dataset.pill=dayKey(d);el.innerHTML='<span>'+esc(dayLabel(d))+'</span>';return el}
// One pill per day: nothing is added when the list already ends on that day (a pill or a row).
function ensurePill(d){const key=dayKey(d);const last=list.lastElementChild;if(last&&((last.classList.contains('day')&&last.dataset.pill===key)||(last.classList.contains('row')&&last.dataset.day===key)))return;list.appendChild(dayPill(d))}
// Take a row out and the pill above it if nothing else follows the pill.
function dropRow(row){const prev=row.previousElementSibling;row.remove();if(prev&&prev.classList.contains('day')){const n=prev.nextElementSibling;if(!n||!n.classList.contains('row'))prev.remove()}}
// Grouping: first/last of a run by the same Chi, so the tail and the avatar sit on the last bubble only.
function regroup(){
  const rows=[...list.querySelectorAll('.row')];
  for(let i=0;i<rows.length;i++){const r=rows[i],p=rows[i-1],n=rows[i+1];
    const samePrev=p&&p.dataset.serial===r.dataset.serial&&p.dataset.day===r.dataset.day;
    const sameNext=n&&n.dataset.serial===r.dataset.serial&&n.dataset.day===r.dataset.day;
    r.classList.toggle('first',!samePrev);r.classList.toggle('last',!sameNext);
    const nm=r.querySelector('.nm');if(nm)nm.style.display=samePrev?'none':'';
  }
  const empty=list.querySelector('.empty');if(rows.length&&empty)empty.remove();
  if(!rows.length&&!empty){const e=document.createElement('div');e.className='empty';e.innerHTML='<div style="--tint:'+esc(you.tint)+'"><img src="/chat/api/face/'+encodeURIComponent(you.serial)+'.svg" alt=""><b>Quiet in here</b><span>You are the first one in. Say hi, the other Chis will see it.</span></div>';list.appendChild(e)}
  updateWho();
}
function append(m){
  if(byId.has(m.id))return false;
  const d=new Date(m.at);
  ensurePill(d);
  const row=bubble(m,m.serial===you.serial);if(booted)row.classList.add('new');list.appendChild(row);byId.set(m.id,row);
  if(m.id>lastId)lastId=m.id;if(!firstId||m.id<firstId)firstId=m.id;
  return true;
}
function prepend(ms){
  if(!ms.length)return;
  const before=list.scrollHeight;const frag=document.createDocumentFragment();let prevKey=null;
  for(const m of ms){if(byId.has(m.id))continue;const d=new Date(m.at);const key=dayKey(d);if(key!==prevKey){frag.appendChild(dayPill(d));prevKey=key}
    const row=bubble(m,m.serial===you.serial);frag.appendChild(row);byId.set(m.id,row);if(!firstId||m.id<firstId)firstId=m.id}
  // the pill that used to open the view is now a duplicate when the day continues
  const firstOld=list.querySelector('.day');
  list.insertBefore(frag,list.firstChild);
  if(firstOld&&prevKey===firstOld.dataset.pill)firstOld.remove();
  regroup();list.scrollTop+=list.scrollHeight-before;
}
function remove(id){const row=byId.get(id);if(!row)return;dropRow(row);byId.delete(id);regroup()}
function arrive(m){
  const was=nearBottom();
  // my own line coming back over the stream: swap the pending bubble for the real one
  if(m.serial===you.serial){for(const [k,p] of pending){if((p.gif&&m.gif&&p.gif===m.gif.id)||(!p.gif&&!m.gif&&p.body===m.body)){dropRow(p.row);pending.delete(k);break}}}
  if(!append(m))return;regroup();
  if(was||m.serial===you.serial)toBottom();else{unread++;fabn.textContent=unread;fabn.hidden=false;fab.classList.add('on')}
}
async function api(path,opts){const r=await fetch(path,Object.assign({credentials:'same-origin',cache:'no-store'},opts||{}));if(r.status===401||r.status===403){location.reload();throw new Error('session')}return r}
async function catchUp(){try{const r=await api('/chat/api/messages?after='+lastId);if(!r.ok)return;const j=await r.json();online=j.online;if(j.living)living=j.living;setSub();for(const m of j.messages)arrive(m)}catch(e){}}
async function older(){if(!hasMore||loadingOlder||!firstId)return;loadingOlder=true;more.classList.add('on');try{const r=await api('/chat/api/messages?before='+firstId);if(!r.ok)return;const j=await r.json();hasMore=j.hasMore;prepend(j.messages)}catch(e){}finally{loadingOlder=false;more.classList.remove('on')}}
// live stream, with the catch-up poll underneath it
let es=null;function stream(){if(es)es.close();es=new EventSource('/chat/api/stream?after='+lastId);
  es.addEventListener('message',(e)=>arrive(JSON.parse(e.data)));
  es.addEventListener('delete',(e)=>remove(JSON.parse(e.data).id));
  es.addEventListener('rename',(e)=>{const r=JSON.parse(e.data);if(r.serial===you.serial){you.name=r.name;setSub()}for(const row of list.querySelectorAll('.row[data-serial="'+r.serial+'"]')){const nm=row.querySelector('.nm');if(nm)nm.innerHTML=esc(r.name)+'<small>'+esc(row.dataset.number)+'</small>'}});
  es.addEventListener('presence',(e)=>{const p=JSON.parse(e.data);online=p.online;if(p.living)living=p.living;setSub()});
  es.addEventListener('bye',()=>{es.close();setTimeout(()=>location.reload(),400)});
  es.addEventListener('evicted',()=>{es.close();es=null});
  es.onerror=()=>{};}
setInterval(catchUp,20000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){catchUp();stream()}});
addEventListener('online',()=>{catchUp();stream()});
list.addEventListener('scroll',()=>{if(list.scrollTop<80)older();if(nearBottom()){unread=0;fab.classList.remove('on');fabn.hidden=true}
  // the floating day: the day of the first line in view, shown while scrolling, gone when still
  const top=list.getBoundingClientRect().top;let first=null;for(const r of list.querySelectorAll('.row')){if(r.getBoundingClientRect().bottom>top+8){first=r;break}}
  if(first&&first.dataset.at){fd.textContent=dayLabel(new Date(first.dataset.at));fd.classList.add('on');clearTimeout(fdT);fdT=setTimeout(()=>fd.classList.remove('on'),900)}});
fab.onclick=()=>toBottom();
$('me').onclick=()=>{location.href='/chat/name'};
// composer
if(input){
  const coarse=matchMedia('(pointer: coarse)').matches;
  const grow=()=>{input.style.height='auto';input.style.height=Math.min(120,input.scrollHeight)+'px';snd.classList.toggle('on',input.value.trim().length>0);document.documentElement.style.setProperty('--composer',cp.offsetHeight+'px')};
  input.addEventListener('input',grow);grow();
  input.addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey&&!coarse){e.preventDefault();sendNow()}});
  snd.onclick=()=>sendNow();
  async function sendNow(){
    const body=input.value.trim();if(!body)return;
    input.value='';grow();input.focus();
    const key=++pendingSeq;const m={id:'p'+key,serial:you.serial,tokenId:you.tokenId,name:you.name,number:you.number,ci:you.ci,tint:you.tint,body,at:new Date().toISOString(),pending:true};
    ensurePill(new Date(m.at));
    const row=bubble(m,true);row.classList.add('new');list.appendChild(row);pending.set(key,{row,body});regroup();toBottom();
    const undo=()=>{dropRow(row);pending.delete(key);regroup();input.value=body;grow()};
    try{
      const r=await api('/chat/api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body})});
      if(r.status===429){const j=await r.json().catch(()=>({}));toast(j.error==='muted'?'You cannot post right now':'Slow down a moment');undo();return}
      if(!r.ok){toast('Not sent');undo();return}
      const j=await r.json();
      if(pending.has(key)){dropRow(row);pending.delete(key);arrive(j.message)}
    }catch(e){if(String(e.message)!=='session'){toast('No connection');undo()}}
  }
  // GIFs
  const gifb=$('gifb'),gs=$('gs'),gq=$('gq'),gg=$('gg'),gsx=$('gsx');
  if(gifb&&gs){
    let open=false,seq=0,timer=null;
    const show=(on)=>{open=on;gs.hidden=!on;gifb.classList.toggle('on',on);if(on){load('');gq.focus()}};
    gifb.onclick=()=>show(!open);gsx.onclick=()=>show(false);
    async function load(q){const my=++seq;gg.innerHTML='';try{const r=await api('/chat/api/gifs?q='+encodeURIComponent(q));const j=await r.json();if(my!==seq)return;
      if(!j.gifs||!j.gifs.length){gg.innerHTML='<div class="none">Nothing for that. Try another word.</div>';return}
      for(const g of j.gifs){const im=document.createElement('img');im.src=g.url;im.width=g.w;im.height=g.h;im.alt='GIF';im.loading='lazy';im.onclick=()=>sendGif(g);gg.appendChild(im)}}
      catch(e){if(my===seq)gg.innerHTML='<div class="none">GIFs are taking a moment. Try again.</div>'}}
    gq.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>load(gq.value.trim()),300)});
    async function sendGif(g){
      show(false);
      const key=++pendingSeq;const m={id:'p'+key,serial:you.serial,tokenId:you.tokenId,name:you.name,number:you.number,ci:you.ci,tint:you.tint,body:'',gif:g,at:new Date().toISOString(),pending:true};
      ensurePill(new Date(m.at));
      const row=bubble(m,true);row.classList.add('new');list.appendChild(row);pending.set(key,{row,body:'',gif:g.id});regroup();toBottom();
      const undo=()=>{dropRow(row);pending.delete(key);regroup()};
      try{
        const r=await api('/chat/api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({gif:g.id})});
        if(r.status===429){const j=await r.json().catch(()=>({}));toast(j.error==='muted'?'You cannot post right now':'Slow down a moment');undo();return}
        if(!r.ok){toast('Not sent');undo();return}
        const j=await r.json();
        if(pending.has(key)){dropRow(row);pending.delete(key);arrive(j.message)}
      }catch(e){if(String(e.message)!=='session'){toast('No connection');undo()}}
    }
  }
}
// the keyboard: size the page to the visible viewport so the composer rides above it
function fit(){const vv=window.visualViewport;const h=vv?vv.height:innerHeight;const was=nearBottom();document.documentElement.style.setProperty('--vvh',h+'px');document.documentElement.style.setProperty('--composer',cp.offsetHeight+'px');if(was)requestAnimationFrame(toBottom)}
if(window.visualViewport){visualViewport.addEventListener('resize',fit);visualViewport.addEventListener('scroll',()=>{window.scrollTo(0,0)})}
addEventListener('resize',fit);
// boot
for(const m of BOOT.messages)append(m);regroup();setSub();fit();toBottom();stream();booted=true;
// name colours are baked per scheme at render time: a scheme flip simply redraws the room
dark.addEventListener('change',()=>location.reload());
})();
</script>
</body></html>`;
}

// A closed door or a refusal: one static page in the room's palette. It never auto-closes.
function doorPage(title: string, body: string, emoji: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F6F6F6">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#17212B">
<title>${esc(title)}</title>
<style>
:root{--wp:${WALLPAPER_LIGHT};--bg0:#D5E3EF;--bg1:#E9EEF3;--text:#0B0F14;--sub:#7C8794;--card:#fff;--line:rgba(0,0,0,.1)}
@media (prefers-color-scheme: dark){:root{--wp:${WALLPAPER_DARK};--bg0:#0C141D;--bg1:#101B27;--text:#F2F5F8;--sub:#7F8C9A;--card:#1A2633;--line:rgba(255,255,255,.08)}}
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%;color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
body{min-height:100dvh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:var(--wp) center top/260px 260px repeat,linear-gradient(180deg,var(--bg0),var(--bg1)) fixed}
body>div{background:var(--card);border-radius:28px;padding:30px 26px;max-width:360px;box-shadow:0 2px 4px rgba(20,30,40,.08),0 24px 60px -24px rgba(20,30,40,.35);border:.5px solid var(--line)}
.e{font-size:56px;line-height:1}
h1{font-size:23px;font-weight:700;letter-spacing:-.02em;margin-top:16px}
p{color:var(--sub);font-size:16px;line-height:1.45;margin-top:8px}
</style></head><body><div><div class="e">${esc(emoji)}</div><h1>${esc(title)}</h1><p>${esc(body)}</p></div></body></html>`;
}

// The pick-a-name screen: first entry, and again from the avatar to rename.
function namePage(you: You, current: string | null): string {
  const renaming = current !== null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F6F6F6">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#17212B">
<meta name="format-detection" content="telephone=no">
<title>${esc(CHAT_TITLE)}</title>
<style>
:root{--wp:${WALLPAPER_LIGHT};--bg0:#D5E3EF;--bg1:#E9EEF3;--text:#0B0F14;--sub:#7C8794;--card:#fff;--line:rgba(0,0,0,.1);--accent:#2F8FEA;--on-accent:#fff;--field:#fff;--field-line:rgba(0,0,0,.12);--err:#E5484D;--ring:#fff}
@media (prefers-color-scheme: dark){:root{--wp:${WALLPAPER_DARK};--bg0:#0C141D;--bg1:#101B27;--text:#F2F5F8;--sub:#7F8C9A;--card:#1A2633;--line:rgba(255,255,255,.08);--accent:#5EB5F7;--on-accent:#fff;--field:#1E2A37;--field-line:rgba(255,255,255,.1);--err:#FF6B6B;--ring:#1A2633}}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{min-height:100%;color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
body{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:calc(env(safe-area-inset-top) + 24px) 24px calc(env(safe-area-inset-bottom) + 24px);background:var(--wp) center top/260px 260px repeat,linear-gradient(180deg,var(--bg0),var(--bg1)) fixed}
.card{width:100%;max-width:380px;background:var(--card);border-radius:28px;padding:30px 24px 24px;display:flex;flex-direction:column;align-items:center;box-shadow:0 2px 4px rgba(20,30,40,.08),0 24px 60px -24px rgba(20,30,40,.35);border:.5px solid var(--line)}
.face{width:112px;height:112px;border-radius:50%;overflow:hidden;background:var(--bg1);border:3px solid var(--ring);box-shadow:0 0 0 3px var(--tint,transparent),0 12px 28px -12px rgba(0,0,0,.35);animation:bob 3s ease-in-out infinite}
@keyframes bob{50%{transform:translateY(-5px)}}
@media (prefers-reduced-motion: reduce){.face{animation:none}}
.face img{width:100%;height:100%;display:block;image-rendering:pixelated}
h1{font-size:26px;font-weight:700;letter-spacing:-.02em;margin-top:20px;text-align:center}
.sub{color:var(--sub);font-size:15px;line-height:1.45;margin-top:8px;text-align:center}
.sub b{color:var(--text);font-weight:600}
form{width:100%;margin-top:24px;display:flex;flex-direction:column;gap:12px}
.fld{display:flex;align-items:center;min-height:52px;background:var(--field);border:.5px solid var(--field-line);border-radius:16px;padding:0 16px;transition:border-color .15s,box-shadow .15s}
.fld:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
input{flex:1;border:0;outline:0;background:transparent;color:var(--text);font:inherit;font-size:17px;caret-color:var(--accent)}
input::placeholder{color:var(--sub)}
.hint{color:var(--sub);font-size:13px;text-align:center;line-height:1.4;min-height:18px}
.hint.err{color:var(--err)}
button{min-height:52px;border:0;border-radius:16px;background:var(--accent);color:var(--on-accent);font:inherit;font-size:17px;font-weight:600;opacity:.4;transition:opacity .15s,transform .1s;box-shadow:0 8px 20px -10px var(--accent)}
button.on{opacity:1}button:active{transform:scale(.98)}
.cancel{display:block;text-align:center;color:var(--accent);font-size:16px;text-decoration:none;padding:8px}
</style></head><body>
<div class="card">
<div class="face" style="--tint:${esc(you.tint)}"><img src="/chat/api/face/${esc(you.serial)}.svg" alt=""></div>
<h1>${renaming ? "Change your name" : "Pick your name"}</h1>
<p class="sub">This is how other Chis see you in ${esc(CHAT_TITLE)}. Your Chi stays <b>${esc(you.pet)} ${esc(you.number)}</b>.</p>
<form id="f" autocomplete="off">
  <div class="fld"><input id="n" type="text" placeholder="Your name" maxlength="${NAME_MAX}" autocapitalize="words" autocorrect="off" spellcheck="false" enterkeyhint="go" value="${esc(current ?? "")}" autofocus></div>
  <div class="hint" id="h">${NAME_MIN} to ${NAME_MAX} characters. Letters, numbers and spaces.</div>
  <button id="b" type="submit">${renaming ? "Save" : "Start chatting"}</button>
  ${renaming ? `<a class="cancel" href="/chat">Cancel</a>` : ""}
</form>
</div>
<script>
(()=>{
const n=document.getElementById('n'),b=document.getElementById('b'),h=document.getElementById('h'),f=document.getElementById('f');
const base=h.textContent;
const WHY={short:'A little longer, please (at least ${NAME_MIN} characters).',long:'A little shorter, please (${NAME_MAX} characters max).',chars:'Letters, numbers and spaces only.',reserved:'That one is taken. Try another.',taken:'That name is taken. Try another.'};
const fit=()=>{b.classList.toggle('on',n.value.trim().length>=${NAME_MIN});h.textContent=base;h.classList.remove('err')};
n.addEventListener('input',fit);fit();
f.addEventListener('submit',async(e)=>{e.preventDefault();const name=n.value.trim();if(name.length<${NAME_MIN})return;b.disabled=true;
  try{const r=await fetch('/chat/api/name',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({name})});
    if(r.status===401||r.status===403){location.reload();return}
    const j=await r.json().catch(()=>({}));
    if(r.ok){location.replace('/chat');return}
    h.textContent=WHY[j.error]||'Could not save that name.';h.classList.add('err')}
  catch(e){h.textContent='No connection. Try again.';h.classList.add('err')}
  finally{b.disabled=false}});
})();
</script>
</body></html>`;
}

type Wrapped = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Wrapped) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

export function chatRouter(ctx: AppContext): Router {
  const r = Router();

  const page = (res: Response, code: number, title: string, body: string, emoji: string) => {
    res.setHeader("Cache-Control", "no-store");
    return res.status(code).type("html").send(doorPage(title, body, emoji));
  };
  const newHome = (res: Response) => {
    clearSessionCookie(res);
    return page(res, 403, "This Chi has a new home", "This Chi moved to a new wallet. Claim it on the WALLETCHI claim page to chat.", "🔒");
  };
  // The bare room with no session. Most often Safari reopening an old room tab without the cookie,
  // so it reads as a calm way back in, not as an error (keepers took the old copy for "the API
  // failed"). Still a 403 for anything that is not a person.
  const closedDoor = (res: Response) =>
    page(res, 403, CHAT_TITLE, "Tap CHAT on your WALLETCHI pass to hop back in.", "💬");

  // ---- the name page (before the tap route: "/chat/name" must never read as a serial) ----

  r.get("/chat/name", wrap(async (req, res) => {
    const runner = await sessionOf(ctx, req);
    if (!runner) return closedDoor(res);
    if (!(await stillOwner(ctx, runner))) return newHome(res);
    const chosen = await ctx.store.getChatName(runner.serial);
    res.setHeader("Content-Security-Policy", CHAT_CSP);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(namePage(youOf(runner, chosen), chosen));
  }));

  // ---- the tap: pass link -> cookie -> room ----

  // Express answers HEAD with the GET handler, which would read the chain and spend the owner's
  // tap window (link previews and prefetchers send HEAD). GET only.
  r.head("/chat/:serial", (_req, res) => {
    res.setHeader("Allow", "GET");
    res.status(405).end();
  });

  r.get("/chat/:serial", wrap(async (req, res) => {
    const serial = req.params.serial!;
    const runner = await ctx.store.getRunner(serial);
    // 404 unless the pet is in the rollout, so the URL shape cannot reach the room before then.
    if (!runner || !chatEnabledFor(runner)) return res.status(404).json({ error: "not found" });
    if (isLinkPreview(req.get("user-agent"))) {
      return page(res, 200, CHAT_TITLE, "Open this link from your WALLETCHI pass to join the room.", "💬");
    }
    if (!verifyTag(runner.authToken, chatPayload(serial), req.query.s)) {
      return page(res, 403, "Not your pet", "This link is not valid for you.", "🔒");
    }
    const retry = chatRateHit(serial);
    if (retry !== null) {
      res.setHeader("Retry-After", String(retry));
      return page(res, 429, "One moment", "Too many taps. Tap again in a minute.", "⏳");
    }
    // The authoritative read: a pet sold since its last claim still carries the seller's valid tag.
    const guard = await careOwnerGuard(ctx, runner, { fresh: true });
    if (guard === "unavailable") {
      res.setHeader("Retry-After", "60");
      return page(res, 503, "One moment", "We could not check on your pet just now. Tap again in a minute.", "⏳");
    }
    if (guard === "transferred") {
      return page(res, 403, "This Chi has a new home", "This Chi moved to a new wallet. Claim it on the WALLETCHI claim page to chat.", "🔒");
    }
    setSessionCookie(res, chatSessionValue(runner.serial, runner.authToken));
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, ROOM_PATH);
  }));

  // ---- the room ----

  r.get(ROOM_PATH, wrap(async (req, res) => {
    const runner = await sessionOf(ctx, req);
    if (!runner) {
      if (req.headers.cookie?.includes(`${COOKIE}=`)) clearSessionCookie(res);
      return closedDoor(res);
    }
    if (!(await stillOwner(ctx, runner))) return newHome(res);
    // First entry: pick a name before the room.
    const chosen = await ctx.store.getChatName(runner.serial);
    if (chosen === null) {
      res.setHeader("Content-Security-Policy", CHAT_CSP);
      res.setHeader("Cache-Control", "no-store");
      return res.type("html").send(namePage(youOf(runner, null), null));
    }
    const rows = await ctx.store.latestChatMessages(PAGE + 1);
    const hasMore = rows.length > PAGE;
    const messages = await outAll(ctx, hasMore ? rows.slice(1) : rows);
    const boot: Boot = {
      title: CHAT_TITLE,
      you: youOf(runner, chosen),
      online: Math.max(1, onlineCount()),
      living: await livingCount(ctx),
      messages,
      hasMore,
      muted: chatMutedFor(runner),
      gifs: gifsEnabled(),
      colors: { light: NAME_COLORS_LIGHT, dark: NAME_COLORS_DARK },
    };
    const html = roomPage(boot).replace("/*__BOOT__*/null", () => escapeJsonForScript(boot));
    res.setHeader("Content-Security-Policy", CHAT_CSP);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html);
  }));

  // ---- the name ----

  r.post("/chat/api/name", wrap(async (req, res) => {
    const runner = await sessionOf(ctx, req);
    if (!runner) return res.status(401).json({ error: "open the room from your pass" });
    res.setHeader("Cache-Control", "no-store");
    const body = (req.body ?? {}) as { name?: unknown };
    const check = normalizeName(body.name);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const retry = namePaceHit(runner.serial);
    if (retry !== null) {
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({ error: "slow down" });
    }
    const result = await ctx.store.setChatName(runner.serial, check.name, check.key, nameKeyOf);
    if (result === "taken") return res.status(409).json({ error: "taken" });
    broadcast("rename", { serial: runner.serial, name: check.name });
    res.json({ name: check.name });
  }));

  // ---- messages ----

  const clampLimit = (v: unknown) => {
    const n = typeof v === "string" ? Number.parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PAGE) : PAGE;
  };
  const idParam = (v: unknown): number | null => {
    if (typeof v !== "string" || !/^\d{1,12}$/.test(v)) return null;
    return Number.parseInt(v, 10);
  };

  r.get("/chat/api/messages", wrap(async (req, res) => {
    const runner = await sessionOf(ctx, req);
    if (!runner) return res.status(401).json({ error: "open the room from your pass" });
    res.setHeader("Cache-Control", "no-store");
    if (!(await stillOwner(ctx, runner))) {
      clearSessionCookie(res);
      return res.status(403).json({ error: "this Chi has a new home" });
    }
    const limit = clampLimit(req.query.limit);
    const before = idParam(req.query.before);
    if (before !== null) {
      const rows = await ctx.store.latestChatMessages(limit + 1, before);
      const hasMore = rows.length > limit;
      return res.json({ messages: await outAll(ctx, hasMore ? rows.slice(1) : rows), hasMore, online: Math.max(1, onlineCount()), living: await livingCount(ctx) });
    }
    const after = idParam(req.query.after) ?? 0;
    const rows = await ctx.store.chatMessagesAfter(after, limit);
    res.json({ messages: await outAll(ctx, rows), hasMore: rows.length === limit, online: Math.max(1, onlineCount()), living: await livingCount(ctx) });
  }));

  r.get("/chat/api/gifs", wrap(async (req, res) => {
    const runner = await sessionOf(ctx, req);
    if (!runner) return res.status(401).json({ error: "open the room from your pass" });
    if (!gifsEnabled()) return res.status(404).json({ error: "gifs off" });
    res.setHeader("Cache-Control", "no-store");
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
    const offset = idParam(req.query.offset) ?? 0;
    try {
      res.json({ gifs: await gifSearch(q, Math.min(offset, 240)) });
    } catch (err) {
      logger.warn({ err: String(err) }, "chat: giphy search failed");
      res.status(503).json({ error: "gifs unavailable" });
    }
  }));

  r.post("/chat/api/messages", wrap(async (req, res) => {
    const runner = await sessionOf(ctx, req);
    if (!runner) return res.status(401).json({ error: "open the room from your pass" });
    res.setHeader("Cache-Control", "no-store");
    if (!(await stillOwner(ctx, runner))) {
      clearSessionCookie(res);
      return res.status(403).json({ error: "this Chi has a new home" });
    }
    if (chatMutedFor(runner)) return res.status(429).json({ error: "muted" });
    const body = (req.body ?? {}) as { body?: unknown; gif?: unknown };
    // A line is text, or a GIF (the id only; the server resolves it), never an arbitrary URL.
    let text = "";
    let gif: GifPick | null = null;
    if (body.gif !== undefined) {
      if (!gifsEnabled()) return res.status(400).json({ error: "gifs off" });
      if (typeof body.gif !== "string" || !GIF_ID.test(body.gif)) return res.status(400).json({ error: "bad gif" });
    } else {
      const norm = normalizeBody(body.body);
      if (!norm.ok) return res.status(400).json({ error: norm.error });
      text = norm.body;
    }
    const chosen = await ctx.store.getChatName(runner.serial);
    if (chosen === null) return res.status(409).json({ error: "pick a name first" });
    const retry = postPaceHit(runner.serial);
    if (retry !== null) {
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({ error: "slow down" });
    }
    if (body.gif !== undefined) {
      try {
        gif = await gifById(body.gif as string);
      } catch (err) {
        logger.warn({ err: String(err) }, "chat: giphy lookup failed");
        return res.status(503).json({ error: "gifs unavailable" });
      }
      if (!gif) return res.status(400).json({ error: "bad gif" });
    }
    const m = toOut(await ctx.store.addChatMessage(runner.serial, runner.tokenId!, text, gif ? JSON.stringify(gif) : null), chosen);
    broadcast("message", m);
    res.status(201).json({ message: m });
  }));

  // ---- the live stream ----

  r.get("/chat/api/stream", wrap(async (req, res) => {
    const runner = await sessionOf(ctx, req);
    if (!runner) return res.status(401).json({ error: "open the room from your pass" });
    if (!(await stillOwner(ctx, runner))) {
      clearSessionCookie(res);
      return res.status(403).json({ error: "this Chi has a new home" });
    }
    // A 429, not a 503: EventSource keeps reconnecting after a 503 (about every 3 s, Retry-After
    // ignored) while a 429 makes it stop; the page's 20 s poll and its visibility/online handlers
    // reopen the stream later.
    if (streams.size >= maxStreams) {
      res.setHeader("Retry-After", "30");
      return res.status(429).json({ error: "room is full, the page keeps polling" });
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write("retry: 3000\n\n");
    // Per-pet cap: the oldest of this pet's streams makes room. 'evicted' tells that page to stop
    // reconnecting; it keeps its 20 s catch-up poll and reopens the stream when it is shown again.
    const mine = [...streams].filter((x) => x.serial === runner.serial);
    for (const old of mine.slice(0, Math.max(0, mine.length - (MAX_STREAMS_PER_PET - 1)))) endStream(old, "evicted");
    const s: Stream = { res, serial: runner.serial, req, ctx };
    streams.add(s);
    startHeartbeat();
    // Anything posted between the page's last id and this connection opening.
    const after = idParam(req.query.after);
    if (after !== null) {
      try {
        for (const m of await outAll(ctx, await ctx.store.chatMessagesAfter(after, MAX_PAGE))) send(res, "message", m);
      } catch (err) {
        logger.warn({ err: String(err) }, "chat: stream catch-up read failed");
      }
    }
    send(res, "presence", { online: onlineCount(), living: await livingCount(ctx) });
    presenceChanged();
    const close = () => {
      if (!streams.delete(s)) return;
      presenceChanged();
    };
    req.on("close", close);
    res.on("close", close);
    res.on("error", close);
  }));

  // ---- the avatar: the pet's own pixel face, room members only ----

  r.get("/chat/api/face/:serial.svg", wrap(async (req, res) => {
    const viewer = await sessionOf(ctx, req);
    if (!viewer) return res.status(401).json({ error: "open the room from your pass" });
    const runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner || !runner.tokenId) return res.status(404).json({ error: "not found" });
    // The game sprite leaves room for wings and hats; an avatar wants the face, so the viewBox is
    // cropped to a square around the body (the circle on the page trims the rest).
    const svg = petGameSpriteSvg(runner.tokenId, "happy", stageFor(runner, new Date()))
      .replace(/<svg([^>]*?)\swidth="[^"]*"\sheight="[^"]*"\sviewBox="[^"]*"/, `<svg$1 width="${FACE_CROP.size}" height="${FACE_CROP.size}" viewBox="${FACE_CROP.x} ${FACE_CROP.y} ${FACE_CROP.size} ${FACE_CROP.size}"`);
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(svg);
  }));

  // ---- moderation (bearer INTERNAL_STATUS_TOKEN, like every /internal route) ----

  r.get("/internal/chat", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    const latest = await ctx.store.latestChatMessages(clampLimit(req.query.limit));
    res.json({ ...chatStreamState(), enabled: config.CHAT_ENABLED, serials: config.CHAT_SERIALS ?? "", muted: config.CHAT_MUTED_SERIALS ?? "", latest: await outAll(ctx, latest) });
  }));

  r.delete("/internal/chat/messages/:id", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    const id = idParam(req.params.id);
    if (id === null) return res.status(400).json({ error: "bad id" });
    const m = await ctx.store.deleteChatMessage(id);
    if (!m) return res.status(404).json({ error: "not found" });
    broadcast("delete", { id });
    logger.info({ id, serial: m.serial }, "chat: message deleted by a moderator");
    res.json({ deleted: toOut(m, await ctx.store.getChatName(m.serial) ?? undefined) });
  }));

  // A moderator clears a name: the keeper picks a new one on their next open; open rooms show the
  // pass name meanwhile.
  r.delete("/internal/chat/names/:serial", wrap(async (req, res) => {
    if (!authInternal(req, res)) return;
    const runner = await ctx.store.getRunner(req.params.serial!);
    if (!runner || !runner.tokenId) return res.status(404).json({ error: "not found" });
    await ctx.store.clearChatName(runner.serial);
    broadcast("rename", { serial: runner.serial, name: petName(runner.tokenId) });
    logger.info({ serial: runner.serial }, "chat: name cleared by a moderator");
    res.json({ cleared: runner.serial });
  }));

  return r;
}
