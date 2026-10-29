import { createHmac, randomBytes } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { confirmPage } from "./actions.js";
import { careOwnerGuard, valleyRateHit } from "./claim.js";
import { formFor } from "./forms.js";
import { petName } from "./names.js";
import { signTag, valleyPayload, verifyTag } from "./sign.js";
import { stageFor } from "./stage.js";
import { runnerNumber } from "./theme.js";

// CHI VALLEY: the shared farm, served from its own origin (VALLEY_URL). Holders enter from a link on
// their pass with no sign-in, like CHI SHOT and CHI NIGHT, but unlike those games the valley gives a
// pet a lot and an identity, so the link is a CAPABILITY: the same HMAC tag the care links carry
// (sign.ts, keyed by the per-pet authToken peppered with CARE_LINK_SECRET), so it dies on a claim and
// on "Reset my pass links". The link on the pass is STABLE; nothing expiring ever goes into the pass
// (the push gate would push every refresh). At tap time this route takes a FRESH ownerOf read, mints
// a 5 minute join token signed with VALLEY_TOKEN_SECRET and 302s to `${VALLEY_URL}/#join=<token>`.
// The fragment keeps the token out of request logs and Referer. The valley verifies the token, takes
// its own ownerOf read and hands out its own session. Contract: chi-valley valley/HOLDERS.md 1a.

export const VALLEY_TITLE = "CHI VALLEY";
export const VALLEY_TOKEN_PREFIX = "chi-valley-join-v1.";
export const VALLEY_TOKEN_TTL_S = 300;
const VALLEY_SECRET_MIN = 32;

// Parsed once per distinct env value (the env does not change at runtime, but the
// gate check flips it in-process).
let serialsRaw: string | undefined;
let serials: ReadonlySet<string> = new Set();
function valleySerials(): ReadonlySet<string> {
  if (config.VALLEY_SERIALS !== serialsRaw) {
    serialsRaw = config.VALLEY_SERIALS;
    serials = new Set((serialsRaw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  }
  return serials;
}

/** The join-token secret, or null when it is unset or too short to use (then the valley is off). */
export function valleyTokenSecret(): string | null {
  const s = config.VALLEY_TOKEN_SECRET;
  return s && s.length >= VALLEY_SECRET_MIN ? s : null;
}

/**
 * True when this pet's pass carries the CHI VALLEY link and its /valley route answers. LIVING pets
 * only (lots are for real Chis), minted (a tokenId), in the rollout, and only while the join-token
 * secret is configured: without it the route could not sign, so no pass may show the link.
 */
export function valleyEnabledFor(runner: Pick<Runner, "serial" | "gone" | "status" | "tokenId">): boolean {
  if (runner.gone || runner.status !== "ready" || !runner.tokenId) return false;
  if (!valleyTokenSecret()) return false;
  return config.VALLEY_ENABLED || valleySerials().has(runner.serial);
}

export function valleyUrl(serial: string, authToken: string): string {
  return `${config.PUBLIC_BASE_URL}/valley/${serial}?s=${signTag(authToken, valleyPayload(serial))}`;
}

/** The VALLEY_URL origin, for the sprite route's CORS header. */
export function valleyOrigin(): string | null {
  try {
    return new URL(config.VALLEY_URL).origin;
  } catch {
    return null;
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export interface ValleyJoinPayload {
  v: 1;
  aud: "chi-valley";
  serial: string;
  tokenId: string;
  owner: string;
  name: string;
  number: string;
  stage: number;
  form: string | null;
  iat: number;
  exp: number;
  jti: string;
}

/** `b64url(payload) + "." + b64url(HMAC_SHA256(secret, "chi-valley-join-v1." + b64url(payload)))`. */
export function signValleyToken(payload: ValleyJoinPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(VALLEY_TOKEN_PREFIX + body).digest();
  return `${body}.${b64url(sig)}`;
}

export function valleyJoinPayload(runner: Runner, owner: string, now: Date): ValleyJoinPayload {
  const tokenId = runner.tokenId!;
  const stage = stageFor(runner, now);
  const iat = Math.floor(now.getTime() / 1000);
  return {
    v: 1,
    aud: "chi-valley",
    serial: runner.serial,
    tokenId,
    owner: owner.toLowerCase(),
    name: petName(tokenId),
    number: runnerNumber(tokenId, runner.serial),
    stage,
    // Same seed the sprite route draws the form from, so the valley's cache key matches the art.
    form: stage === 4 ? formFor(tokenId).key : null,
    iat,
    exp: iat + VALLEY_TOKEN_TTL_S,
    jti: b64url(randomBytes(16)),
  };
}

// Link preview fetchers (iMessage sends facebookexternalhit plus Twitterbot, the chat apps their own).
// A pasted pass link gets a plain page from them: no chain read, no tap spent, no token signed.
const LINK_PREVIEW_UA =
  /facebookexternalhit|Facebot|Twitterbot|Slackbot|Discordbot|WhatsApp|TelegramBot|LinkedInBot|SkypeUriPreview|Pinterestbot|redditbot|Embedly|vkShare|Googlebot|bingbot|Applebot/i;
export function isLinkPreview(userAgent: string | undefined): boolean {
  return !!userAgent && LINK_PREVIEW_UA.test(userAgent);
}

type Wrapped = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Wrapped) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

export function valleyRouter(ctx: AppContext): Router {
  const r = Router();
  if (!valleyTokenSecret()) {
    logger.warn(
      { set: Boolean(config.VALLEY_TOKEN_SECRET) },
      `valley: VALLEY_TOKEN_SECRET unset or shorter than ${VALLEY_SECRET_MIN} characters; no pass carries the CHI VALLEY link and /valley is a 404`,
    );
  }

  const page = (res: Response, code: number, title: string, body: string, emoji: string) => {
    res.setHeader("Cache-Control", "no-store");
    return res.status(code).type("html").send(confirmPage({ code, title, body, emoji }));
  };

  // Express answers HEAD with the GET handler, which would read the chain, spend the owner's tap
  // window and sign a token nobody sees (link previews and prefetchers send HEAD). GET only.
  r.head("/valley/:serial", (_req, res) => {
    res.setHeader("Allow", "GET");
    res.status(405).end();
  });

  r.get("/valley/:serial", wrap(async (req, res) => {
    const serial = req.params.serial!;
    const runner = await ctx.store.getRunner(serial);
    // 404 unless the pet is in the rollout, so the URL shape cannot reach the valley before then.
    if (!runner || !valleyEnabledFor(runner)) return res.status(404).json({ error: "not found" });
    if (isLinkPreview(req.get("user-agent"))) {
      return page(res, 200, VALLEY_TITLE, "Open this link from your WALLETCHI pass to play.", "🌱");
    }
    if (!verifyTag(runner.authToken, valleyPayload(serial), req.query.s)) {
      return page(res, 403, "Not your pet", "This link is not valid for you.", "🔒");
    }
    const retry = valleyRateHit(serial);
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
      return page(res, 403, "This Chi has a new home", "This Chi moved to a new wallet. Claim it on the WALLETCHI claim page to play.", "🔒");
    }
    // "ok" means the fresh on-chain owner equals the owner of record.
    const secret = valleyTokenSecret()!;
    const token = signValleyToken(valleyJoinPayload(runner, runner.ownerAddress, new Date()), secret);
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, `${config.VALLEY_URL.replace(/\/+$/, "")}/#join=${token}`);
  }));

  return r;
}
