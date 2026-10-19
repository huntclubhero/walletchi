import { createHash, randomBytes } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Runner } from "../store/types.js";
import { RUNNER_THEME, MEMORIAL_COPY, TESTNET_COPY, runnerNumber, statusThemeFor, timeOfDayFor } from "./theme.js";
import { petName } from "./names.js";
import {
  moodFor,
  moodLine,
  needsMeter,
  needsInline,
  needsUrgencyOrder,
  needShortTime,
  dbNeedPct,
  minNeedSecondsLeft,
  survivesShort,
} from "./needs.js";
import { stageFor } from "./stage.js";
import { memorialLivedDays, getSeasonSnapshot, passStatsFrom, headcountVerified, NEED_LABELS } from "./season.js";
import { actionUrl } from "./pass.js";
import { gameEnabledFor, gameUrl, GAME_TITLE } from "./game.js";
import { nightEnabledFor, nightUrl, NIGHT_TITLE } from "./night.js";
import { memorialLineEnabledFor, memorialLineValue } from "./memorial-line.js";
import { albumEnabledFor, albumUrl, ALBUM_TITLE } from "./album.js";
import { SETUP_NUDGE_COPY } from "./setup-nudge.js";

// Google Wallet loyalty object variant for RUNNER. Separate class + module from
// the legacy card Google integration so card behaviour is untouched. Stubs loudly
// until GOOGLE_SA_KEY_BASE64 + GOOGLE_ISSUER_ID are set.

const WALLET_API = "https://walletobjects.googleapis.com/walletobjects/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
// Every Google call is bounded: these fetches sit on care/idle/claim paths and
// a hung socket must not park them (fetch has no default timeout).
const FETCH_TIMEOUT_MS = 10_000;
const fetchTimeout = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);

// Save-to-wallet allowlist origins. Google REJECTS the save when the page's
// origin is not in the JWT's `origins`, and the live site answers on BOTH
// playwalletchi.com and www.playwalletchi.com: allowlist the apex AND the www
// variant of each configured URL so the button works from either host.
// localhost / IP hosts get no www variant.
export function saveOrigins(): string[] {
  const out = new Set<string>();
  for (const raw of [config.WEB_APP_URL, config.PUBLIC_BASE_URL]) {
    try {
      const url = new URL(raw);
      out.add(url.origin);
      const host = url.hostname;
      if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) continue;
      const alt = new URL(url.origin);
      alt.hostname = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
      out.add(alt.origin);
    } catch {
      out.add(raw);
    }
  }
  return [...out];
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

// Object id suffixes. Google allows [A-Za-z0-9._-] after the issuer id; serials are uuids.
const safeSerial = (serial: string) => serial.replace(/[^A-Za-z0-9_-]/g, "");

/** The id every pet's object had before rotation existed; still used until a pet first rotates. */
export function legacyObjectSuffix(serial: string): string {
  return `runner_${safeSerial(serial)}`;
}

/**
 * A fresh object suffix for a rotation. Random, never derived from the authToken (the id is visible
 * to anyone holding a save link, the token is the HMAC secret behind every care link), and still
 * prefixed by the serial so ops can tell whose object it is.
 */
export function newGoogleObjectSuffix(serial: string): string {
  return `${legacyObjectSuffix(serial)}_${randomBytes(8).toString("hex")}`;
}

/** Copy for a retired Google object, mirroring the Apple keepsake (pass.ts) word for word. */
export const RETIRED_OBJECT_COPY = {
  transfer: {
    status: "TRANSFERRED",
    header: "Transferred",
    body: "This pet was claimed by its new owner, so this pass is now a keepsake. Care actions no longer work from here.",
  },
  reset: {
    status: "LINKS RESET",
    header: "Links reset",
    body: "You asked for this pet's pass links to be reset, so this card is now a keepsake and its buttons no longer work. Sign in to your account page and add the fresh card.",
  },
} as const;

// --- Operational state surfaced on /internal/status ---------------------------

export interface GoogleProbeResult {
  at: string;
  ok: boolean;
  detail: string;
}
let lastProbe: GoogleProbeResult | null = null;
export function getGoogleProbe(): GoogleProbeResult | null {
  return lastProbe;
}

export interface GoogleBackfillResult {
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: number;
  failed: number;
  lastError?: string;
}
let lastBackfill: GoogleBackfillResult | null = null;
let backfillRunning = false;
export function getGoogleBackfill(): GoogleBackfillResult | null {
  return lastBackfill;
}

// Save/delete callback events from Google (informational, UNVERIFIED: we do not
// validate Google's callback signature, so this feeds ops visibility only and
// must never gate anything). Bounded ring.
export interface WalletCallbackEvent {
  at: string;
  eventType: string;
  objectId: string;
}
const callbackEvents: WalletCallbackEvent[] = [];
let callbackSaves = 0;
let callbackDeletes = 0;
export function recordWalletCallback(eventType: string, objectId: string): void {
  // Attacker-suppliable strings (the endpoint is public and unverified): bound
  // them so the ring buffer and logs cannot be flooded with megabyte payloads.
  const type = eventType.slice(0, 32);
  const obj = objectId.slice(0, 128);
  if (/save/i.test(type)) callbackSaves += 1;
  if (/del/i.test(type)) callbackDeletes += 1;
  callbackEvents.push({ at: new Date().toISOString(), eventType: type, objectId: obj });
  if (callbackEvents.length > 200) callbackEvents.shift();
  logger.info({ eventType: type, objectId: obj }, "google wallet callback");
}
export function getWalletCallbacks(): { saves: number; deletes: number; recent: WalletCallbackEvent[] } {
  return { saves: callbackSaves, deletes: callbackDeletes, recent: callbackEvents.slice(-20) };
}

export class RunnerGoogleWallet {
  readonly live: boolean;
  private sa: ServiceAccount | null = null;
  private issuerId: string | null = null;
  private classEnsured = false;
  // Last-sent object hash per serial: the idle engine patches every ready pet
  // every tick, and at 2,000 pets an unconditional PATCH is pure quota burn
  // when nothing visible changed. In-memory is fine (one instance serves the
  // API; a restart just re-sends one round).
  private lastSentHash = new Map<string, string>();
  // Objects a rotation retired. A push that read the runner BEFORE the rotation committed (the idle
  // engine awaits chain reads between its read and its write, and a backfill crawls a list captured
  // at its start) would otherwise PATCH the retired object with the full live body, state ACTIVE
  // included, and undo the retirement. It carries only the old, already dead links, so nothing
  // leaks, but the keepsake would look live again. Every write checks this set first. In memory is
  // enough: the window it closes is seconds wide, and one instance serves the API.
  private retiredObjectIds = new Set<string>();

  /** Mark an object retired BEFORE the rotation commits, so no stale push can write to it after. */
  markRetired(objectId: string): void {
    this.retiredObjectIds.add(objectId);
  }

  /** Undo markRetired when the rotation did not commit, so the still-current object is not frozen. */
  unmarkRetired(objectId: string): void {
    this.retiredObjectIds.delete(objectId);
  }

  private isRetired(id: string): boolean {
    if (!this.retiredObjectIds.has(id)) return false;
    logger.info({ id }, "google write skipped: object was retired by a rotation (stale runner)");
    return true;
  }

  constructor() {
    this.live = config.modes.googleLive;
    if (this.live) {
      this.sa = JSON.parse(
        Buffer.from(config.GOOGLE_SA_KEY_BASE64!, "base64").toString("utf8"),
      ) as ServiceAccount;
      this.issuerId = config.GOOGLE_ISSUER_ID!;
    }
  }

  private classId(): string {
    return `${this.issuerId}.${config.GOOGLE_LOYALTY_CLASS_SUFFIX}_runner`;
  }
  // The object a pet's links live in. Every account that saved a Google object shares it, so the
  // object id ROTATES with the pass authToken (claim.ts rotateRunnerAuth stores a fresh suffix):
  // fresh links always go into a new object, and the old one is retired (retireObject). A pet
  // that has never rotated keeps the legacy id, so cards saved before this existed keep updating.
  objectId(runner: Pick<Runner, "serial" | "googleObjectId">): string {
    return `${this.issuerId}.${runner.googleObjectId ?? legacyObjectSuffix(runner.serial)}`;
  }

  // THE ACCESS TOKEN IS CACHED (launch fix 4). It used to be minted on every call:
  // an RS256 signature (CPU on the event loop) plus a round trip to Google's token
  // endpoint, three times per mint (ensureObject, the fulfilment saveUrl, the
  // pass-link saveUrl) and once per pass push. A service-account token is good for
  // an hour and is not bound to the object it is used on, so one token serves every
  // call until shortly before it expires. In-flight exchanges are shared too, so a
  // burst that arrives on a cold cache performs ONE exchange, not one per keeper.
  // A failed exchange caches nothing (the next call retries), and the refresh runs
  // a full minute early so a token never expires between the check and the call.
  //
  // Expiry is measured from BEFORE the exchange request, not from when the answer
  // arrived: a token exchange that took 8 s under load still expires on Google's
  // clock, which started when Google issued it, so stamping the arrival time would
  // overstate the token's life by exactly the latency. Together with the minute of
  // early refresh this is the skew budget for both latency and clock drift.
  //
  // A token Google REJECTS (401 on any Wallet API call) is dropped at once, so a
  // revoked or rotated service-account key costs one failed call, not an hour of
  // them. Only the rejected token is dropped: if a newer one has already replaced
  // it, that one stays.
  private tokenCache: { token: string; expiresAtMs: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;
  private static readonly TOKEN_REFRESH_EARLY_MS = 60_000;
  // The parsed service-account key. importPKCS8 parses the PEM and builds a
  // CryptoKey on every call; the key never changes for the life of this instance,
  // and it signs both the token assertion and every save-link JWT.
  private signingKeyPromise: ReturnType<typeof importPKCS8> | null = null;

  private signingKey(): ReturnType<typeof importPKCS8> {
    if (!this.signingKeyPromise) {
      this.signingKeyPromise = importPKCS8(this.sa!.private_key, "RS256");
      // A parse failure must not be cached forever (it would be a config error
      // anyway, but a transient one must be retryable).
      this.signingKeyPromise.catch(() => {
        this.signingKeyPromise = null;
      });
    }
    return this.signingKeyPromise;
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAtMs - RunnerGoogleWallet.TOKEN_REFRESH_EARLY_MS > now) {
      return this.tokenCache.token;
    }
    if (!this.tokenInFlight) {
      this.tokenInFlight = this.exchangeToken().finally(() => {
        this.tokenInFlight = null;
      });
    }
    return this.tokenInFlight;
  }

  /**
   * Every Wallet REST call goes through here so a 401 retires the cached token.
   * The caller still sees the 401 and handles it exactly as before (this call
   * fails); the NEXT call exchanges a fresh token instead of reusing a dead one.
   */
  private async walletFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
      signal: init.signal ?? fetchTimeout(),
    });
    if (res.status === 401 && this.tokenCache?.token === token) {
      this.tokenCache = null;
      logger.warn("google wallet rejected the cached access token (401); the next call exchanges a fresh one");
    }
    return res;
  }

  private async exchangeToken(): Promise<string> {
    const key = await this.signingKey();
    const requestedAtMs = Date.now();
    const now = Math.floor(requestedAtMs / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.sa!.client_email)
      .setSubject(this.sa!.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: fetchTimeout(),
    });
    if (!res.ok) {
      throw new Error(`google token exchange failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      // Never cache (or hand out) "undefined" as a bearer token.
      throw new Error("google token exchange answered without an access_token");
    }
    // Google answers expires_in in seconds (3600 today); anything odd falls back to the hour.
    const ttlSec = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    this.tokenCache = { token: body.access_token, expiresAtMs: requestedAtMs + ttlSec * 1000 };
    return body.access_token;
  }

  private loyaltyClass() {
    return {
      id: this.classId(),
      issuerName: config.ORGANIZATION_NAME,
      reviewStatus: "UNDER_REVIEW",
      programName: RUNNER_THEME.gameName,
      hexBackgroundColor: "#0E2A3A",
      programLogo: {
        sourceUri: { uri: `${config.PUBLIC_BASE_URL}/assets/logo.png` },
      },
      // Google POSTs save/delete events here, which is the only way to know who
      // actually holds the pass (the Android analogue of Apple device
      // registrations). Handler is log-only.
      callbackOptions: {
        url: `${config.PUBLIC_BASE_URL}/api/google/wallet-callback`,
      },
    };
  }

  // Art cache-buster. Google caches heroImage by URL, so a constant URL freezes
  // the pet at add-time. Version the URL with the states that change the card
  // render (mood word, lifecycle flags, toys, time of day) and each PATCH makes
  // Google re-fetch: the Android pet now visibly lives like the Apple one.
  private artVersion(runner: Runner, status: string, now: Date): string {
    // The stats band puts GLOBAL numbers on the card render, so when it is on
    // the version must move with them or Google serves stale stats forever. The
    // compact strings are already quantized (see compactCare), which bounds the
    // re-fetch rate to meaningful changes.
    let statsKey = "";
    if (config.STATS_BAND_ENABLED) {
      const snap = getSeasonSnapshot();
      if (headcountVerified(snap)) {
        const st = passStatsFrom(snap);
        statsKey = `|${st.alive}|${st.pot}|${st.burned}|${st.fdv ?? ""}`;
      }
    }
    // Evolution stage changes the card render (size + flourish), so it must move
    // the art version or Google freezes an evolved pet at its pre-evolution art.
    // Appended only under v2 so flag-off versions stay byte-identical to today.
    const stageSeg =
      config.TRAITS_V2_ENABLED && !runner.gone ? `|s${stageFor(runner, now)}` : "";
    // The wide hero PRINTS the pet's name and number, and both are derived from
    // the tokenId, which is null for the moments between checkout and the mint
    // landing. Without this the art could stay cached on the placeholder identity
    // ("A WALLETCHI") after the real one arrived, since nothing else in this hash
    // moves when a tokenId is assigned.
    const idSeg = `|${runner.tokenId ?? ""}`;
    return createHash("sha256")
      .update(
        `${status}|${runner.hatched}|${runner.critical}|${runner.gone}|${runner.won}|${runner.toys}|${timeOfDayFor(now)}${statsKey}${stageSeg}${idSeg}`,
      )
      .digest("hex")
      .slice(0, 10);
  }

  // `needPct` + `needSecondsLeft` mirror the Apple pass's combined five-need
  // field (canonical actionType order), chain-derived by callers that hold a
  // ctx (idle pushRunnerPass); absent, the DB meters stand in as percents
  // (they are chain-projected on every reconcile). `careBalanceIn` mirrors the
  // Apple header's live TBA balance ("98 CARE", season.ts petCareBalanceFor),
  // again ctx-holder supplied: the push cycle patches it in; absent (create /
  // saveUrl paths, failed read) the module is simply omitted, never "0 CARE".
  private loyaltyObject(
    runner: Runner,
    needPctIn?: number[] | null,
    needSecondsLeftIn?: number[] | null,
    careBalanceIn?: string | null,
    setupNudge = false,
  ) {
    const number = runnerNumber(runner.tokenId, runner.serial);
    // The pet's OWN name is its identity on this card too, not just on the Apple pass. The names
    // commit only touched pass.ts, so an Android keeper kept seeing "WALLETCHI No. 0002" while an
    // iPhone keeper saw "Nutmeg Thicket" for the same pet. The number is kept alongside it, since
    // it is what the NFT and the explorer key on.
    const name = petName(runner.tokenId);
    const identity = `${name} (${number})`;
    // WALLETCHI pet content, mirroring the Apple pass: STATUS word from the same
    // mood the scene art uses, toys (alive) or lived days (memorial), and the
    // freshest narration line. No QR code (see the barcode key below).
    const now = new Date();
    const mood = moodFor(runner, now);
    const statusTheme = statusThemeFor(mood, runner.won);
    // FIVE-NEEDS mirror of the Apple COMBINED card (audit #3), within Google's
    // two points slots: STATUS keeps the primary slot and ALL FIVE needs ride
    // the secondary as one compact glyph + countdown value, most urgent first
    // (memorials keep LIVED). The roomy per-need breakdown (label + meter +
    // countdown, one line each, same urgency order) rides the "NEEDS" text
    // module below the narration: text modules wrap, so nothing can be
    // truncated away. Alive-gated: a memorial shows no need meters (dead
    // stamps would show phantom time).
    const needPct = needPctIn ?? dbNeedPct(runner);
    const needSecondsLeft = needSecondsLeftIn ?? null;
    const secondary = runner.gone
      ? { label: "LIVED", balance: { string: `${memorialLivedDays(runner)} days` } }
      : {
          label: "NEEDS",
          balance: { string: needsInline(needPct, needSecondsLeft) },
        };
    // SURVIVES: the same at-a-glance death countdown the Apple card carries, the
    // minimum of the five need timers. Two differences, both forced by Google:
    // there is no relative-date field (Apple's live on-device countdown has no
    // analogue), so this is HOUR-GRANULAR on purpose and the object's dirty
    // check then patches at most once an hour instead of every idle tick; and
    // both loyalty-points slots are already spoken for (STATUS + NEEDS), so it
    // rides a text module, which wraps and can never truncate. It leads the
    // modules because it is the one number that decides whether the pet lives.
    const lifeSecondsLeft =
      runner.gone || runner.won ? null : minNeedSecondsLeft(needSecondsLeft);
    const survivesModule = lifeSecondsLeft
      ? {
          id: "life",
          header: "SURVIVES",
          body: `${survivesShort(lifeSecondsLeft)} left. Miss any one need and it is gone.`,
        }
      : null;
    const storyModule = runner.gone
      ? { id: "memory", header: "IN MEMORY", body: MEMORIAL_COPY.epitaph }
      : { id: "pet", header: RUNNER_THEME.petLabel, body: runner.lastEvent ?? moodLine(mood, "google") };
    // The memorial event line (runner/memorial-line.ts), the Android mirror of the Apple field:
    // only under the flag, after IN MEMORY. A memorial object is ACTIVE like any other (only a
    // rotation retires one), so an announcement reaches it the same way: this module changes with
    // the line and pushRunnerPass adds the ONE notifying message. Flag off: the object is unchanged.
    const memorialLineModule = memorialLineEnabledFor(runner)
      ? { id: "pet", header: RUNNER_THEME.petLabel, body: memorialLineValue(runner) }
      : null;
    const needsModule = runner.gone
      ? null
      : {
          id: "needs",
          header: "NEEDS",
          body: needsUrgencyOrder(needPct, needSecondsLeft)
            .map(
              (i) =>
                `${NEED_LABELS[i]} ${needsMeter(needPct[i] ?? 0)}${
                  needSecondsLeft ? ` ${needShortTime(needSecondsLeft[i] ?? 0)}` : ""
                }`,
            )
            .join("\n"),
        };
    // The live CARE balance, mirroring the Apple carebal header field. Both
    // loyalty-points slots are taken (STATUS + NEEDS), so it rides a text
    // module: modules wrap, nothing truncates. Living pets only (same gate as
    // Apple: a memorial or champion card shows no bank ticker), and only when
    // the caller could actually read the chain.
    const careModule =
      runner.gone || runner.won || !careBalanceIn
        ? null
        : { id: "carebal", header: "CARE BALANCE", body: careBalanceIn };
    // SEASON 2, NO CLAIMS: what replaced the "Collect rewards" link. A statement,
    // not a button, because the push engine does the collecting. Same gate the
    // link had (live distributor, living pet), same wording as the Apple back field.
    const rewardsModule =
      config.modes.rewardsLive && !runner.gone
        ? {
            id: "rewards",
            header: "REWARDS",
            body: "The CARE your pet earns is sent to it automatically, every couple of hours.",
          }
        : null;
    // Care actions. Google Wallet NEVER linkifies text (there is no equivalent
    // of the Apple back-field attributedValue anchor): the ONLY tappable
    // surface on a Google pass is linksModuleData. Same HMAC-signed care URLs
    // the Apple pass carries; a gone pet keeps only its memorial page link.
    const care = (action: string, label: string) => ({
      id: action,
      uri: actionUrl(runner.serial, runner.authToken, action, "google"),
      description: label,
    });
    const linkUris = [
      // CHI SHOT first, gated per pet exactly like the Apple back field.
      ...(gameEnabledFor(runner) ? [{ id: "game", uri: gameUrl(runner.serial), description: `Play ${GAME_TITLE}` }] : []),
      // CHI NIGHT right after it, gated per pet like the Apple back field.
      ...(nightEnabledFor(runner) ? [{ id: "night", uri: nightUrl(runner.serial), description: `Play ${NIGHT_TITLE}` }] : []),
      // PHOTO ALBUM, living pets only, gated like the Apple back field.
      ...(albumEnabledFor(runner) ? [{ id: "album", uri: albumUrl(runner.serial), description: ALBUM_TITLE }] : []),
      ...(runner.gone
        ? []
        : [
            care("feed", "Feed"),
            care("water", "Give water"),
            care("play", "Play"),
            care("toy", "Give a toy"),
            care("explore", "Explore"),
          ]),
      // (The "Collect rewards" link that used to sit here is gone with the claim
      // it triggered. Season 2 pushes rewards to the pet's own account every two
      // hours, so there is nothing to tap; the fact is stated in the rewards text
      // module below instead. Google passes have no linkifiable text, so a link
      // whose only message is "you did not need this" would be the only thing a
      // tap could achieve.)
      {
        id: "pet-page",
        uri: `${config.WEB_APP_URL}/pet/${runner.serial}`,
        description: runner.gone ? "Visit the memorial" : "Open your pet page",
      },
    ];
    return {
      id: this.objectId(runner),
      classId: this.classId(),
      state: "ACTIVE",
      accountId: runner.serial,
      // Display-only field. Must NOT carry PII: the Google save URL is reachable
      // by public serial, so emitting runner.email here would leak it. Use the
      // pet's public designation instead (accountId still keys on the serial).
      accountName: identity,
      // The pet art. Apple embeds the render as the PKPass strip; Google fetches
      // this by URL, so it MUST be public (no auth) and return image/png, or
      // Google silently drops it and the pass shows no art.
      //
      // WIDE render, not the square card. Google's hero slot is roughly 3:1 (its
      // own guidance is 1032x336) and this used to point at card.png, the 1080
      // SQUARE render: Android squeezed a 1:1 image into a 3:1 frame, which is the
      // stretched, cropped, "compressed and sloppy" hero a tester sees. hero.png
      // is the same living scene composed FOR that ratio at 2064x672 (exactly 2x
      // Google's recommendation). card.png is unchanged and still serves the NFT
      // `image` and the email hero, and the Apple strip is untouched.
      //
      // The v= param is the art cache-buster (see artVersion): Google caches by
      // URL, so the version must change when the render meaningfully changes or
      // the pass art freezes at add time. Everything artVersion tracks is on this
      // wide render too (mood, lifecycle, toys, time of day, stage, and the season
      // band figures), so the hero re-fetches exactly when it has something new to
      // show.
      heroImage: {
        sourceUri: {
          uri: `${config.PUBLIC_BASE_URL}/api/runner/${encodeURIComponent(runner.serial)}/hero.png?v=${this.artVersion(runner, statusTheme.status, now)}`,
        },
        contentDescription: {
          defaultValue: { language: "en-US", value: identity },
        },
      },
      loyaltyPoints: {
        label: "STATUS",
        balance: { string: statusTheme.status },
      },
      secondaryLoyaltyPoints: secondary,
      // NO QR CODE (Hunt, 2026-10-09, same ruling as the Apple pass). Explicit
      // null, not an omitted key: objects are refreshed with PATCH, and a PATCH
      // that leaves the key out KEEPS the old barcode (probed on a throwaway
      // object 2026-10-09: omitted -> QR still there, null -> removed). The pet
      // page stays one tap away in the links module.
      barcode: null,
      textModulesData: [
        // NEWS from us, first (same line as the Apple card's NEWS field).
        ...(config.NEWS_TEXT ? [{ id: "news", header: "NEWS", body: config.NEWS_TEXT }] : []),
        // An unarmed pet says so FIRST (setup-nudge.ts): the links below open the website until it is done.
        ...(setupNudge && !runner.gone
          ? [{ id: "setup", header: SETUP_NUDGE_COPY.label, body: SETUP_NUDGE_COPY.value }]
          : []),
        ...(survivesModule ? [survivesModule] : []),
        storyModule,
        ...(memorialLineModule ? [memorialLineModule] : []),
        ...(needsModule ? [needsModule] : []),
        ...(careModule ? [careModule] : []),
        ...(rewardsModule ? [rewardsModule] : []),
        // Last, so the live state reads first; same wording as the Apple back field.
        ...(config.ROBINHOOD_NETWORK === "testnet"
          ? [{ id: "testnet", header: TESTNET_COPY.label, body: TESTNET_COPY.body }]
          : []),
      ],
      linksModuleData: { uris: linkUris },
    };
  }

  private async ensureClass(token: string): Promise<void> {
    if (this.classEnsured) return;
    const id = this.classId();
    const get = await this.walletFetch(`${WALLET_API}/loyaltyClass/${id}`, token);
    if (get.status === 404) {
      const create = await this.walletFetch(`${WALLET_API}/loyaltyClass`, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.loyaltyClass()),
      });
      if (!create.ok) {
        throw new Error(`create runner class failed: ${create.status} ${await create.text()}`);
      }
      logger.info({ classId: id }, "google runner class created");
    } else if (!get.ok) {
      throw new Error(`get runner class failed: ${get.status} ${await get.text()}`);
    }
    this.classEnsured = true;
  }

  // Create-or-refresh the object through the REST API. The exists path PATCHES
  // (never skips): saveUrl runs this right after a claim rotates the authToken,
  // and the object's care links are HMAC-bound to that token, so a skipped
  // refresh would hand the new owner a pass full of dead links.
  private async upsertObject(token: string, runner: Runner, needPct?: number[] | null): Promise<void> {
    if (this.isRetired(this.objectId(runner))) return;
    await this.ensureClass(token);
    const obj = this.loyaltyObject(runner, needPct);
    const id = this.objectId(runner);
    const get = await this.walletFetch(`${WALLET_API}/loyaltyObject/${id}`, token);
    const body = JSON.stringify(obj);
    const patchObject = async (): Promise<void> => {
      const patch = await this.walletFetch(`${WALLET_API}/loyaltyObject/${id}`, token, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!patch.ok) {
        throw new Error(`refresh runner object failed: ${patch.status} ${await patch.text()}`);
      }
    };
    if (get.status === 404) {
      const create = await this.walletFetch(`${WALLET_API}/loyaltyObject`, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (create.status === 409) {
        // GET said 404 and CREATE says it already exists, so between those two calls somebody else
        // created it. That is a normal race, not a failure: mint calls this, and so does the
        // pass-link endpoint, and they overlap on a fresh pet. Treating it as an error threw away a
        // perfectly good object and logged a scary line on every mint. The object exists, so bring
        // it up to date the same way the exists path does. This MUST still patch rather than skip:
        // the loser of the race may be the newer state (a claim rotates the authToken and every
        // care link is HMAC-bound to it, so a skipped refresh hands over a pass full of dead links).
        logger.info({ id }, "google runner object already existed (create raced); patching instead");
        await patchObject();
      } else if (!create.ok) {
        throw new Error(`create runner object failed: ${create.status} ${await create.text()}`);
      } else {
        logger.info({ id }, "google runner object created");
      }
    } else if (get.ok) {
      await patchObject();
    } else {
      throw new Error(`get runner object failed: ${get.status} ${await get.text()}`);
    }
    this.lastSentHash.set(runner.serial, createHash("sha256").update(body).digest("hex"));
  }

  async ensureObject(runner: Runner): Promise<void> {
    if (!this.live) {
      logger.warn({ serial: runner.serial }, "GOOGLE RUNNER STUB: skip ensureObject");
      return;
    }
    const token = await this.accessToken();
    await this.upsertObject(token, runner);
  }

  async patchObject(
    runner: Runner,
    opts: {
      needPct?: number[] | null;
      needSecondsLeft?: number[] | null;
      careBalance?: string | null;
      setupNudge?: boolean;
    } = {},
  ): Promise<void> {
    if (!this.live) {
      logger.warn({ serial: runner.serial }, "GOOGLE RUNNER STUB: skip patchObject");
      return;
    }
    if (this.isRetired(this.objectId(runner))) return;
    const obj = this.loyaltyObject(runner, opts.needPct, opts.needSecondsLeft, opts.careBalance, opts.setupNudge);
    const body = JSON.stringify(obj);
    const hash = createHash("sha256").update(body).digest("hex");
    // Dirty check: skip the round trip when the rendered object is identical to
    // the last one Google accepted for this serial.
    if (this.lastSentHash.get(runner.serial) === hash) return;
    const token = await this.accessToken();
    const id = this.objectId(runner);
    const res = await this.walletFetch(`${WALLET_API}/loyaltyObject/${id}`, token, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    });
    if (res.status === 404) {
      // Right after a rotation the pet's NEW object does not exist yet (nobody has saved it), so
      // the push that follows the rotation creates it instead of failing. upsertObject records
      // the hash itself.
      await this.upsertObject(token, runner, opts.needPct);
      logger.info({ id }, "google runner object created on push (rotated object)");
      return;
    }
    if (!res.ok) {
      throw new Error(`patch runner object failed: ${res.status} ${await res.text()}`);
    }
    this.lastSentHash.set(runner.serial, hash);
    logger.info({ id }, "google runner object patched");
  }

  // High-signal pass notifications (critical fading, death feed, victory,
  // memorial): the Android counterpart of the APNs pass push. Best effort by
  // design: a failure must never break the push path that carries Apple.
  // notify: TEXT_AND_NOTIFY raises an Android notification; plain TEXT only adds the message to the
  // card's details (what the routine pushes have always used). Google allows a few notifying
  // messages per card per day, so only announcements ask for it.
  async addMessage(runner: Runner, header: string, msgBody: string, notify = false): Promise<void> {
    if (!this.live) {
      logger.warn({ serial: runner.serial }, "GOOGLE RUNNER STUB: skip addMessage");
      return;
    }
    if (this.isRetired(this.objectId(runner))) return;
    try {
      const token = await this.accessToken();
      const id = this.objectId(runner);
      const res = await this.walletFetch(`${WALLET_API}/loyaltyObject/${id}/addMessage`, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            id: `m-${Date.now().toString(36)}`,
            header,
            body: msgBody,
            messageType: notify ? "TEXT_AND_NOTIFY" : "TEXT",
          },
        }),
      });
      if (!res.ok) {
        throw new Error(`addMessage failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      logger.warn({ err: String(err), serial: runner.serial }, "google addMessage failed (best effort)");
    }
  }

  // Retire the object a rotation just left behind (ERC-8426: rotation MUST NOT deliver the new
  // links to passes issued before it). Every account that saved this object shares it, a leaked
  // copy or the seller's included, so it is EXPIRED and its care links are REPLACED (a PATCH
  // merges fields, so the arrays must be sent, not omitted) with only the public pet page. The
  // hero art, name and QR stay: it reads as the keepsake the Apple card becomes. Best effort by
  // design, like every Google call on the claim path: security never rests on this, because the
  // old links are already dead (HMAC-bound to the retired authToken). This only stops the card
  // presenting itself as current, and stops it RECEIVING the new links, which it never will now
  // that fresh links live in a different object.
  async retireObject(
    runner: Pick<Runner, "serial" | "gone">,
    oldObjectId: string,
    reason: "transfer" | "reset",
  ): Promise<void> {
    if (!this.live) {
      logger.warn({ serial: runner.serial }, "GOOGLE RUNNER STUB: skip retireObject");
      return;
    }
    this.retiredObjectIds.add(oldObjectId);
    const copy = RETIRED_OBJECT_COPY[reason];
    try {
      const token = await this.accessToken();
      const retire = () => this.walletFetch(`${WALLET_API}/loyaltyObject/${oldObjectId}`, token, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: "EXPIRED",
          loyaltyPoints: { label: "STATUS", balance: { string: copy.status } },
          textModulesData: [{ id: "retired", header: copy.header, body: copy.body }],
          linksModuleData: {
            uris: [
              {
                id: "pet-page",
                uri: `${config.WEB_APP_URL}/pet/${runner.serial}`,
                description: runner.gone ? "Visit the memorial" : "Open the pet page",
              },
            ],
          },
        }),
      });
      // One retry on a transient failure (a network error or a 5xx): if this PATCH never lands, the
      // old card keeps looking live (its links are dead either way).
      let res = await retire().catch(() => null);
      if (!res || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000));
        res = await retire();
      }
      if (res.status === 404) {
        // Nobody ever saved (or even created) the old object: nothing to retire.
        logger.info({ id: oldObjectId }, "google retire: old object never existed");
        return;
      }
      if (!res.ok) {
        throw new Error(`retire runner object failed: ${res.status} ${await res.text()}`);
      }
      logger.info({ id: oldObjectId, reason }, "google runner object retired");
      const msg = await this.walletFetch(`${WALLET_API}/loyaltyObject/${oldObjectId}/addMessage`, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: { id: `m-${Date.now().toString(36)}`, header: copy.header, body: copy.body, messageType: "TEXT" },
        }),
      });
      if (!msg.ok) {
        logger.warn({ id: oldObjectId, status: msg.status }, "google retire: addMessage failed (best effort)");
      }
    } catch (err) {
      logger.warn({ err: String(err), serial: runner.serial, id: oldObjectId }, "google retireObject failed (best effort)");
    }
  }

  // Boot-time configuration probe. One GET against the class endpoint separates
  // the three worlds loudly: 200/404 = issuer id valid (404 just means the
  // class is not created yet), 4xx anything else = MISCONFIGURED (the
  // merchant-id-instead-of-issuer-id trap ran silent for weeks). Result is
  // surfaced on /internal/status.
  async probe(): Promise<GoogleProbeResult> {
    const at = new Date().toISOString();
    if (!this.live) {
      lastProbe = { at, ok: false, detail: "stub (no GOOGLE_SA_KEY_BASE64 / GOOGLE_ISSUER_ID)" };
      return lastProbe;
    }
    try {
      const token = await this.accessToken();
      const res = await this.walletFetch(`${WALLET_API}/loyaltyClass/${this.classId()}`, token);
      if (res.ok) {
        lastProbe = { at, ok: true, detail: "class exists" };
      } else if (res.status === 404) {
        lastProbe = { at, ok: true, detail: "issuer id valid; class not created yet" };
      } else {
        const text = (await res.text()).slice(0, 300);
        lastProbe = { at, ok: false, detail: `REST ${res.status}: ${text}` };
      }
    } catch (err) {
      lastProbe = { at, ok: false, detail: String(err) };
    }
    if (!lastProbe.ok) {
      logger.error(
        { detail: lastProbe.detail },
        "GOOGLE WALLET MISCONFIGURED: REST API unusable (is GOOGLE_ISSUER_ID the numeric Wallet issuer id, not the merchant id?)",
      );
    } else {
      logger.info({ detail: lastProbe.detail }, "google wallet REST probe ok");
    }
    return lastProbe;
  }

  // One-shot backfill: upsert every pet's object through the REST API so the
  // whole population becomes patchable (run after fixing GOOGLE_ISSUER_ID).
  // Sequential on purpose: ~2 calls per pet is a gentle, quota-friendly crawl.
  // Fire-and-forget; progress lands in getGoogleBackfill()/logs.
  startBackfill(runners: Runner[]): { started: boolean; reason?: string } {
    if (!this.live) return { started: false, reason: "google stubbed (no creds)" };
    if (backfillRunning) return { started: false, reason: "already running" };
    backfillRunning = true;
    const state: GoogleBackfillResult = {
      startedAt: new Date().toISOString(),
      total: runners.length,
      done: 0,
      failed: 0,
    };
    lastBackfill = state;
    void (async () => {
      let token = await this.accessToken();
      let minted = Date.now();
      for (const runner of runners) {
        try {
          // Access tokens live 1h; refresh well before that on long crawls.
          if (Date.now() - minted > 45 * 60_000) {
            token = await this.accessToken();
            minted = Date.now();
          }
          await this.upsertObject(token, runner);
          state.done += 1;
        } catch (err) {
          state.failed += 1;
          state.lastError = String(err).slice(0, 300);
        }
      }
      state.finishedAt = new Date().toISOString();
      logger.info(
        { total: state.total, done: state.done, failed: state.failed },
        "google backfill finished",
      );
    })()
      .catch((err) => {
        state.lastError = String(err).slice(0, 300);
        state.finishedAt = new Date().toISOString();
        logger.error({ err: String(err) }, "google backfill crashed");
      })
      .finally(() => {
        backfillRunning = false;
      });
    return { started: true };
  }

  async saveUrl(runner: Runner): Promise<string | null> {
    if (!this.live) return null;
    // Preferred: THIN REFERENCE JWT, not the old fat payload that embedded the
    // full class + object JSON in the URL. Fat save URLs broke Android adds
    // two ways: the URL length varies with the pet's narration and could cross
    // Google's ~1800-char save-link ceiling (generic "couldn't add" errors),
    // and a JWT-embedded class that drifts from the stored class is rejected
    // outright. Upsert through the API, then reference by id: the URL is short
    // and constant-size, and the wallet always renders the freshest object.
    //
    // Fallback: when the REST upsert fails the button must keep working, so we
    // emit the legacy fat JWT (now WITH linksModuleData, so care links are
    // tappable either way). Known failure on this path: GOOGLE_ISSUER_ID set
    // to the alphanumeric MERCHANT id; the Wallet REST API only accepts the
    // NUMERIC issuer id from the Google Wallet console, and 400s every call.
    let payload: Record<string, unknown>;
    try {
      const token = await this.accessToken();
      await this.upsertObject(token, runner);
      payload = {
        loyaltyObjects: [{ id: this.objectId(runner), classId: this.classId() }],
      };
    } catch (err) {
      logger.error(
        { err: String(err), serial: runner.serial },
        "google upsert failed, falling back to FAT save JWT (is GOOGLE_ISSUER_ID the numeric Wallet issuer id, not the merchant id?)",
      );
      // A fat JWT always CREATES the object, so there is no old QR to clear: drop the
      // explicit barcode null rather than send an untested null through the save link.
      const { barcode: _noBarcode, ...fatObject } = this.loyaltyObject(runner);
      payload = {
        loyaltyClasses: [this.loyaltyClass()],
        loyaltyObjects: [fatObject],
      };
    }
    const key = await this.signingKey();
    const claims = {
      iss: this.sa!.client_email,
      aud: "google",
      typ: "savetowallet",
      origins: saveOrigins(),
      payload,
    };
    // iat + exp (Nexory, 2026-10-14): a save link is a bearer link to one object; it should not stay
    // valid forever. 30 days covers the receipt email; the site and pass-link mint fresh ones on demand.
    const jwt = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key);
    return `https://pay.google.com/gp/v/save/${jwt}`;
  }
}

let _runnerGoogle: RunnerGoogleWallet | null = null;
export function getRunnerGoogle(): RunnerGoogleWallet {
  if (!_runnerGoogle) _runnerGoogle = new RunnerGoogleWallet();
  return _runnerGoogle;
}

// TEST SEAM (check scripts only, same `_`-prefixed convention as _setPrivyClientForTests and the
// MockChain setters). The stub posture (GOOGLE_WALLET_STUB) makes every Google call a logged no-op,
// so without an injectable instance a script cannot observe THAT the object was patched after a
// rotation, only that nothing threw. Set from inside the process by an import; nothing on the
// request path can reach it. Passing null restores the real singleton.
export function _setRunnerGoogleForTests(instance: RunnerGoogleWallet | null): void {
  _runnerGoogle = instance;
}
