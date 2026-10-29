import { Router, type Request, type Response } from "express";
import { logPassDiff } from "./pass-diff.js";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { generateRunnerPkpass, assembleRunnerPass, packageRunnerPass } from "./pass.js";
import { stablePassInputs } from "./pass-memory.js";
import { previousAuthTokenFor, previousAuthRotationFor } from "./claim.js";
import { wrap } from "../util/async-handler.js";
import { formatUpdatedTag, notModifiedSince, parseUpdatedTag } from "./pass-time.js";
import { passContentSnapshot, parseSnap, recordVersion, sameContent, noteVersionFetched, META_BUNDLE } from "./pass-gate.js";
import { PASS_DIFF_KEEP } from "./pass-diff.js";

// Constant-time token compare (parity with the HMAC/cap paths in sign.ts).
function tokenEquals(expected: string | null, given: string): boolean {
  if (!expected || expected.length !== given.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Registration input bounds. Apple sends a hex device token and a hex device library id; the
// push token goes straight into the APNs request path, so only path-safe characters are stored.
const PUSH_TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;
const DEVICE_LIBRARY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Apple Wallet Web Service for RUNNER passes. Mounted at /runner-apple/v1 (runner
// passes carry webServiceURL <PUBLIC_BASE_URL>/runner-apple). Deliberately a
// separate router + separate registration store so the legacy card apple web
// service stays byte-identical. Auth: `Authorization: ApplePass <runner.authToken>`.
// After a secondary-market claim rotates the token, the PREVIOUS token is still
// accepted for pass refresh (served a "transferred" keepsake) and unregistration,
// but never for new device registration.
export function runnerAppleWebServiceRouter(ctx: AppContext): Router {
  const r = Router();
  // When each keepsake (serial + retired token) was first served; see the pass GET below.
  const keepsakeServedAt = new Map<string, Date>();

  interface AuthedRunner {
    runner: Runner;
    previous: boolean; // authed with the pre-claim token (transferred pass)
    token: string;
  }

  async function authRunner(
    req: Request,
    res: Response,
    serial: string,
    opts: { allowPrevious?: boolean } = {},
  ): Promise<AuthedRunner | null> {
    const match = /^ApplePass\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!match) {
      res.status(401).end();
      return null;
    }
    const token = match[1]!.trim();
    const runner = await ctx.store.getRunner(serial);
    if (!runner) {
      res.status(401).end();
      return null;
    }
    if (tokenEquals(runner.authToken, token)) return { runner, previous: false, token };
    if (opts.allowPrevious && tokenEquals(previousAuthTokenFor(serial), token)) {
      return { runner, previous: true, token };
    }
    res.status(401).end();
    return null;
  }

  r.post(
    "/devices/:deviceLibraryId/registrations/:passTypeId/:serial",
    wrap(async (req, res) => {
      // Params are definite on a matched route (the wrap erases Express's
      // route-literal inference; see async-handler.ts).
      const { deviceLibraryId, passTypeId, serial } = req.params as {
        deviceLibraryId: string;
        passTypeId: string;
        serial: string;
      };
      // New registrations require the CURRENT token (a claimed-away pass cannot
      // re-attach devices).
      const authed = await authRunner(req, res, serial);
      if (!authed) return;
      const pushToken = req.body?.pushToken;
      if (pushToken === undefined || pushToken === null || pushToken === "") {
        return res.status(400).json({ error: "missing pushToken" });
      }
      if (typeof pushToken !== "string" || !PUSH_TOKEN_RE.test(pushToken)) {
        return res.status(400).json({ error: "invalid pushToken" });
      }
      if (passTypeId !== config.PASS_TYPE_ID) return res.status(400).json({ error: "invalid passTypeId" });
      if (!DEVICE_LIBRARY_ID_RE.test(deviceLibraryId)) {
        return res.status(400).json({ error: "invalid deviceLibraryIdentifier" });
      }

      const already =
        (await ctx.store.listRunnerPushTokensForSerial(serial)).length > 0;
      const stored = await ctx.store.upsertRunnerRegistration({
        deviceLibraryId,
        passTypeId,
        serial,
        pushToken,
      });
      // At the cap a new device is refused, never let in by evicting another (store/types.ts).
      if (stored === "full") {
        logger.warn({ serial, deviceLibraryId }, "runner apple registration refused: device cap reached");
        return res.status(403).json({ error: "registration_limit" });
      }
      logger.info({ serial, deviceLibraryId }, "runner apple device registered");
      res.status(already ? 200 : 201).end();
    }),
  );

  r.delete(
    "/devices/:deviceLibraryId/registrations/:passTypeId/:serial",
    wrap(async (req, res) => {
      const { deviceLibraryId, passTypeId, serial } = req.params as {
        deviceLibraryId: string;
        passTypeId: string;
        serial: string;
      };
      // The previous owner may still unregister their transferred keepsake.
      const authed = await authRunner(req, res, serial, { allowPrevious: true });
      if (!authed) return;
      await ctx.store.deleteRunnerRegistration(deviceLibraryId, passTypeId, serial);
      logger.info({ serial, deviceLibraryId }, "runner apple device unregistered");
      res.status(200).end();
    }),
  );

  r.get(
    "/devices/:deviceLibraryId/registrations/:passTypeId",
    wrap(async (req, res) => {
      const { deviceLibraryId, passTypeId } = req.params as {
        deviceLibraryId: string;
        passTypeId: string;
      };
      const since = parseUpdatedTag(req.query.passesUpdatedSince as string | undefined);
      // A pass counts as updated only when its CONTENT changed (runner/pass-gate.ts), and the tag
      // handed back is the newest change time among the listed serials, so every push the gate
      // sends is listed here and a pass that did not change never is.
      const { serials, lastUpdated } = await ctx.store.listRunnerSerialsForDevice(
        deviceLibraryId,
        passTypeId,
        since,
      );
      if (serials.length === 0) return res.status(204).end();
      res.json({
        serialNumbers: serials,
        lastUpdated: formatUpdatedTag(lastUpdated),
      });
    }),
  );

  r.get("/passes/:passTypeId/:serial", wrap(async (req, res) => {
    const serial = req.params.serial!;
    const authed = await authRunner(req, res, serial, { allowPrevious: true });
    if (!authed) return;

    // A retired token's refresh gets the keepsake: no live state, no care links,
    // and the OLD token (never the rotated one). The copy follows the reason the
    // token was retired: a sale reads TRANSFERRED; an owner-requested link reset
    // reads LINKS RESET (the same owner is holding this card).
    if (authed.previous) {
      const reason = previousAuthRotationFor(serial)?.reason ?? "transfer";
      // The keepsake never changes once made, so it keeps the Last-Modified of its first serve
      // (per serial and retired token, in memory: a restart serves it once more) and answers 304
      // after that, instead of the full unchanged bundle that iOS logs against us.
      const keepsakeKey = `${serial}:${authed.token}:${reason}`;
      const keptAt = keepsakeServedAt.get(keepsakeKey);
      if (keptAt && notModifiedSince(req.headers["if-modified-since"], keptAt)) return res.status(304).end();
      const servedAt = keptAt ?? new Date(Math.floor(Date.now() / 1000) * 1000);
      if (!keptAt) {
        if (keepsakeServedAt.size > 5000) keepsakeServedAt.clear();
        keepsakeServedAt.set(keepsakeKey, servedAt);
      }
      const { buffer } = await generateRunnerPkpass(authed.runner, {
        transferred: true,
        keepsakeReason: reason,
        authTokenOverride: authed.token,
      });
      res.setHeader("Content-Type", "application/vnd.apple.pkpass");
      res.setHeader("Last-Modified", servedAt.toUTCString());
      res.setHeader("X-Walletchi-Pass", reason === "reset" ? "links-reset" : "transferred");
      return res.send(buffer);
    }

    // CONDITIONAL GET ON CONTENT (runner/pass-gate.ts). Last-Modified is the moment this pass's
    // content last changed: the newest version row when the pass we would serve now matches it,
    // otherwise a NEW version written right here (the content moved without a push, e.g. the
    // headcount, or a phone pulled to refresh). Then If-Modified-Since decides 304 versus 200, so
    // an unchanged pass is never sent in full. Rendering before the 304 costs the same reads a 200
    // does (all cached); 304s only follow a pull to refresh or a multi-pass sync.
    //
    // The combined five-need field straight from the vault when live + alive (null falls back to
    // the DB percents inside the assembler). The live CARE balance is read fresh too. ALIVE, CARE
    // and SURVIVES serve their last verified value when a fresh read fails, so a living pet's field
    // set never flickers (runner/pass-memory.ts).
    const runner = authed.runner;
    const kept = await ctx.store.listServedPassSnapshots(serial); // newest first
    const newest = kept[0];
    const ims = req.headers["if-modified-since"];
    const inputs = await stablePassInputs(ctx, runner);
    // CHEAP 304 FIRST: the phone already holds the newest version and every field (colors too)
    // still matches it, so answer without painting the art. An art-only difference then waits for
    // the pass's next real change (or a template bump, pass-gate.ts), which is what it did before
    // this gate too.
    if (newest && notModifiedSince(ims, newest.lastModified)) {
      const quick = await assembleRunnerPass(runner, { ...inputs, fieldsOnly: true });
      if (sameContent(parseSnap(newest.fields), passContentSnapshot(quick.passJson), { fieldsOnly: false })) {
        noteVersionFetched(serial, newest.lastModified);
        return res.status(304).end();
      }
    }
    const assembled = await assembleRunnerPass(runner, inputs);
    const snap = passContentSnapshot(assembled.passJson, assembled.images);
    let lastModified: Date;
    if (newest) {
      const prev = parseSnap(newest.fields);
      if (sameContent(prev, snap)) {
        lastModified = newest.lastModified;
        // A row from before the gate has no bundle hash yet: complete it in place (same key, so its
        // first-write time stays and nothing reads it as a new version).
        if (!(META_BUNDLE in prev)) {
          await ctx.store.putServedPassSnapshot(serial, newest.lastModified, JSON.stringify(snap), PASS_DIFF_KEEP).catch(() => undefined);
        }
      } else {
        lastModified = await recordVersion(ctx, serial, newest, snap);
      }
    } else {
      // No version kept yet (a pass not fetched since versions were kept): its row's updatedAt, as
      // before this gate, so a phone holding the current copy still gets its 304. Only a 200 writes
      // the first version (with exactly the Last-Modified it goes out with, and stamped as appearing
      // then, so the phone that fetches it now is not told about it again on its next sync).
      lastModified = new Date(Math.floor(runner.updatedAt.getTime() / 1000) * 1000);
      if (notModifiedSince(req.headers["if-modified-since"], lastModified)) return res.status(304).end();
      await ctx.store.putServedPassSnapshot(serial, lastModified, JSON.stringify(snap), PASS_DIFF_KEEP, lastModified);
    }
    if (notModifiedSince(ims, lastModified)) {
      noteVersionFetched(serial, lastModified);
      return res.status(304).end();
    }
    const { buffer, signed, passJson } = await packageRunnerPass(runner, assembled);
    noteVersionFetched(serial, lastModified);
    // Observation only and not awaited: the response never waits on the diff log.
    void logPassDiff(ctx, serial, passJson, lastModified, req.headers["if-modified-since"], {
      ims: req.headers["if-modified-since"] ?? null,
      ua: String(req.headers["user-agent"] ?? "").replace(/^.*?(Darwin\/[0-9.]+).*$/, "$1"),
    }, { kept, store: false });
    res.setHeader("Content-Type", "application/vnd.apple.pkpass");
    res.setHeader("Last-Modified", lastModified.toUTCString());
    if (!signed) res.setHeader("X-Walletchi-Pass", "unsigned-stub");
    res.send(buffer);
  }));

  // Apple's spec defines this endpoint as UNAUTHENTICATED, so it stays that way: a device that
  // cannot fetch a pass has no credential to present. That makes it a free write into our hosted
  // log pipeline from anyone on the internet, so bound what a single call can put there. Entries
  // were already capped at 20, but each one was an arbitrary-length caller-controlled string and
  // the body limit is 256kb, so one request could park a quarter megabyte of attacker text in the
  // logs, repeatedly. Truncate each line and strip control characters, which also removes the
  // newline-injection trick for forging extra log lines.
  const MAX_LOG_ENTRIES = 20;
  const MAX_LOG_CHARS = 300;
  r.post("/log", (req, res) => {
    const logs = (req.body?.logs as unknown[]) ?? [];
    if (Array.isArray(logs) && logs.length) {
      const safe = logs
        .slice(0, MAX_LOG_ENTRIES)
        .filter((l): l is string => typeof l === "string")
        // eslint-disable-next-line no-control-regex
        .map((l) => l.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_LOG_CHARS));
      if (safe.length) logger.info({ appleLogs: safe }, "runner apple device log");
    }
    res.status(200).end();
  });

  return r;
}
