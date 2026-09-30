import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors, { type CorsOptions } from "cors";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { AppContext } from "./context.js";

// Allow localhost dev origins, any *.vercel.app deployment, the production
// playwalletchi.com domain (apex + www + subdomains), and the configured web app
// URL. No-origin requests (curl, server to server, native apps) pass.
function corsOptions(): CorsOptions {
  const allowed = new Set([config.WEB_APP_URL]);
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      try {
        const { hostname, protocol } = new URL(origin);
        const ok =
          allowed.has(origin) ||
          hostname === "localhost" ||
          hostname === "127.0.0.1" ||
          // NOT a blanket *.vercel.app. Anyone can deploy there in a minute, and this API
          // moves real value, so a wildcard hands every attacker a same-origin-readable
          // window into it (no credentials are sent, so this is not session theft, but it
          // does let a hostile page read our endpoints directly rather than proxying).
          // Our own preview deploys are the walletchi-* project prefix.
          //
          // REMOVED (security review): there used to be a
          //   config.NODE_ENV !== "production" && hostname.endsWith(".vercel.app")
          // clause here, which allowed ANY *.vercel.app origin whenever NODE_ENV was not
          // exactly the string "production". The wrong inference was that NODE_ENV reliably
          // says whether this is production: it is `z.string().default("development")`, set
          // only in the Render dashboard and nowhere in this repo, so one unset or misspelled
          // dashboard value silently re-opened the exact blanket wildcard the comment above
          // says we must not have. It was also redundant: the anchored rule immediately below
          // already admits our own preview deploys, which is the only thing it was for.
          // ANCHORED (security review): our preview deploys are walletchi-<hash>.vercel.app.
          // The bare prefix used to match ANY registrable domain starting with
          // "walletchi-" (walletchi-evil.com, walletchi-x.attacker.com), which reopened
          // exactly the same-origin-readable window the comment above closes. Both
          // halves are required: the walletchi- prefix AND the .vercel.app suffix.
          (hostname.startsWith("walletchi-") && hostname.endsWith(".vercel.app")) ||
          hostname === "playwalletchi.com" ||
          hostname.endsWith(".playwalletchi.com") ||
          protocol === "capacitor:" ||
          protocol === "ionic:";
        return cb(null, ok);
      } catch {
        return cb(null, false);
      }
    },
  };
}
import { healthRouter } from "./routes/health.js";
import { runnerRouter } from "./runner/routes.js";
import { runnerAppleWebServiceRouter } from "./runner/apple.js";
import { claimRouter } from "./runner/claim-routes.js";
import { meRouter } from "./runner/me-routes.js";
import { walletPassRouter } from "./runner/wallet-pass-routes.js";
import { holderRouter } from "./runner/holder-routes.js";
import { gasSponsorWebhook } from "./runner/gas-sponsor.js";
import { clientIp } from "./util/client-ip.js";

// Global per-IP rate limit: a GENEROUS fixed window that legit browsing (a few
// requests per page, wallet pass refreshes, polling) never touches, but that
// caps a single IP hammering the RPC-backed endpoints. Private/loopback callers
// are exempt (platform health checks, local dev, the smoke test). In-process
// (one Render instance) with a bounded key map; at the cap, ACTIVE windows are
// never evicted (an attacker cycling spoofed IPs cannot flush everyone else's
// counters): expired windows are pruned, and if the map is still full the new
// key is simply not tracked (fail-open for the overflow key, never a lockout).
//
// TWO BUCKETS PER IP, NOT ONE (launch fix 3). One shared 120/min window counted
// the mint POST together with everything a keeper does right after it: the 2 s
// checkout poll, the pass-link exchange, the .pkpass download, and the Apple
// Wallet device registration and pass refreshes. Those are one IP only on the
// keeper's side of a NAT: a campus, an office, a carrier-grade NAT puts fifty
// keepers behind one address, and the rehearsal showed exactly that (nat run:
// 6 of 50 finished; the other 44 lost their passes to 429s while their pets
// minted anyway). So the keeper-flow routes get their OWN, larger window. They
// are not exempt: the poll is public and serial-keyed (a DB read each), the
// .pkpass render is nine rasters of CPU, and a bucket that still closes at
// forty requests a second per address is the difference between a NAT and a
// flood. The mint POST, the challenge, sign-in, claims and every other route
// stay on the strict window, where one address minting more than twice a
// second is never a keeper.
const RATE_LIMIT_MAX = 120;
// 50 keepers behind one address, each polling every 2 s for up to a minute while
// a burst drains, plus their pass-link, download and registration: ~1,600/min.
// 2,400 leaves headroom for Apple's own refreshes without opening a flood.
const KEEPER_FLOW_LIMIT_MAX = 2_400;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_KEYS = 50_000;
const rateHits = new Map<string, { windowStart: number; count: number }>();
const PRIVATE_IP =
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|fc|fd|fe80)/i;

// The routes a keeper hits AFTER the mint POST, every one of them already gated by
// something stronger than an IP: the poll by an unguessable serial, the pass-link
// by the mint-session token, the .pkpass by its capability segment, the Apple web
// service by the pass's authentication token.
function isKeeperFlow(req: Request): boolean {
  const p = req.path;
  if (req.method === "GET" && p.startsWith("/api/runner/checkout/")) return true;
  if (req.method === "POST" && p === "/api/runner/pass-link") return true;
  if (req.method === "GET" && p.startsWith("/runner-passes/") && p.endsWith(".pkpass")) return true;
  if (p.startsWith("/runner-apple/v1/")) return true;
  return false;
}

function globalRateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "OPTIONS") return next(); // never break CORS preflight
  const ip = clientIp(req);
  if (!ip || ip === "unknown" || PRIVATE_IP.test(ip)) return next();
  const flow = isKeeperFlow(req);
  const key = flow ? `${ip}|flow` : ip;
  const max = flow ? KEEPER_FLOW_LIMIT_MAX : RATE_LIMIT_MAX;
  const now = Date.now();
  const cur = rateHits.get(key);
  if (!cur || now - cur.windowStart >= RATE_LIMIT_WINDOW_MS) {
    if (!cur && rateHits.size >= RATE_LIMIT_MAX_KEYS) {
      for (const [k, v] of rateHits) {
        if (now - v.windowStart >= RATE_LIMIT_WINDOW_MS) rateHits.delete(k);
      }
      if (rateHits.size >= RATE_LIMIT_MAX_KEYS) return next(); // full of ACTIVE windows: do not evict them
    }
    rateHits.set(key, { windowStart: now, count: 1 });
    return next();
  }
  cur.count++;
  if (cur.count > max) {
    const retryAfter = Math.max(1, Math.ceil((cur.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Too many requests. Please slow down a moment.", code: "rate_limited" });
    return;
  }
  next();
}

/** Test hook: which bucket a request lands in, so the smoke can pin the route list. */
export function _rateLimitBucketForTests(method: string, path: string): "keeper-flow" | "strict" {
  return isKeeperFlow({ method, path } as Request) ? "keeper-flow" : "strict";
}

/** Test hook: clear the global rate-limit windows between smoke scenarios. */
export function _resetGlobalRateLimit(): void {
  rateHits.clear();
}

// Build the Express app from a context. Both production and the smoke test call
// this so the exact same request handlers are exercised.
export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  // Render fronts us with a reverse proxy. A BOUNDED hop count (not `true`)
  // makes req.ip the address the platform's proxy appended to x-forwarded-for
  // rather than whatever a client prepended: `true` would trust the whole
  // header and let a direct caller spoof any IP for free. TRUST_PROXY_HOPS
  // must match Render's real hop count (verify at wire time); the anti-Sybil
  // gate reads the result through clientIp(), and IP stays a rate-limit
  // signal only.
  app.set("trust proxy", config.TRUST_PROXY_HOPS);
  app.use(cors(corsOptions()));
  // Baseline security headers for a JSON API (x-powered-by already disabled).
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    // This origin is not only a JSON API: it serves the pass care interstitial and the care confirm
    // page as HTML (runner/actions.ts), and those pages carry a spend capability in the URL. They get
    // the same treatment the web app got. Locked down hard because these pages load nothing external:
    // no scripts from anywhere ('unsafe-inline' covers only the one inline auto-submit), no frames, no
    // plugins, and no base-tag rewriting. `form-action 'self'` matters most here, since the whole page
    // exists to POST a capability back to us and must never be retargeted elsewhere.
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "img-src 'self' data:",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    next();
  });
  app.use(globalRateLimiter);
  // Alchemy Gas Manager sponsorship webhook: HMAC-verifies the RAW request body,
  // so it is mounted with its own raw parser BEFORE the global JSON parser (which
  // would otherwise consume the bytes and break signature verification).
  app.post(
    "/api/gas-sponsorship/webhook",
    express.raw({ type: "*/*", limit: "256kb" }),
    // async now (it does an on-chain authorization read); wrap so a rejection can never escape as an
    // unhandled promise and leave Alchemy waiting on a dead request.
    (req, res) => {
      void Promise.resolve(gasSponsorWebhook(req, res)).catch(() => {
        if (!res.headersSent) res.status(200).json({ approved: false });
      });
    },
  );
  app.use(express.json({ limit: "256kb" }));

  app.get("/", (_req, res) => {
    res.json({ service: "walletchi-server", ok: true });
  });

  app.use(healthRouter(ctx));

  // WALLETCHI pet routes (mint, state, care, passes, metadata, season).
  app.use(runnerRouter(ctx));
  app.use("/runner-apple/v1", runnerAppleWebServiceRouter(ctx));
  // WALLETCHI secondary-market claim (nonce + ownership-verified pass re-issue).
  app.use(claimRouter(ctx));
  // WALLETCHI on-site pet management (Privy sign-in: by-owner + care + pass-link).
  app.use(meRouter(ctx));
  // Wallet Pass Extension (ERC draft, 0xef5f1e71): the gated pass manifest Pet721.passURI resolves to.
  app.use(walletPassRouter(ctx));
  // TAX ECONOMY holder airdrops: proof lookups + the gasless claim relay.
  app.use(holderRouter(ctx));

  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: String(err), stack: err.stack }, "unhandled route error");
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
