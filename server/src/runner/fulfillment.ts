import { config } from "../config.js";
import { maybeStartSoldOutSeason } from "./season-start.js";
import { getSeasonGate } from "./season.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import { MintBudgetExhaustedError, type IssueResult, type MintTicket } from "../chain/types.js";
import { MINT_BUSY_PREFIX, mintBusyMessage } from "./mint-budget.js";
import { getRunnerGoogle } from "./google.js";
import { sendRunnerReceiptEmail } from "./email.js";
import { runnerPassDownloadUrl } from "./pass.js";
import { emailHash, normalizeEmail } from "./sybil.js";
import { isPlaceholderEmail } from "./claim.js";

/**
 * Hand back the two anti-Sybil claims a mint reserved, so a keeper whose mint
 * never became a pet can try again. Best-effort and independently guarded: the
 * email release must not be skipped because the identity release threw.
 *
 * Extracted so the failure path and the STUCK-MINT REAPER release on identical
 * terms. They must never drift: a release that exists on one path and not the
 * other is a lockout that only shows up as "it says I already minted".
 */
export async function releaseMintClaims(
  ctx: AppContext,
  runner: { serial: string; email: string; privyUserHash: string | null },
): Promise<void> {
  if (!isPlaceholderEmail(runner.email)) {
    const hash = emailHash(normalizeEmail(runner.email));
    try {
      await ctx.store.releaseEmail(hash);
    } catch (relErr) {
      logger.error({ err: String(relErr), serial: runner.serial }, "email reservation release failed");
    }
    // The browser that minted this inbox gets its mark back too (one Chi per phone must
    // not count a mint that never produced a pet).
    try {
      await ctx.store.releaseDeviceMarkByEmail(hash);
    } catch (relErr) {
      logger.error({ err: String(relErr), serial: runner.serial }, "device mark release failed");
    }
  }
  if (runner.privyUserHash) {
    try {
      await ctx.store.releasePrivyUser(runner.privyUserHash);
    } catch (relErr) {
      logger.error({ err: String(relErr), serial: runner.serial }, "identity reservation release failed");
    }
  }
}

// ---------------------------------------------------------------------------
// THE IN-FLIGHT REGISTER (launch fix 1). Every mint this process is driving, in
// the order it was handed to the relayer, from fulfillRunner's first line until
// the row is ready or failed. Three consumers:
//   - the checkout poll, which tells a keeper "you are number N in line" and a
//     rough wait, both from a Map lookup (no chain read, no DB read);
//   - the stuck-mint reaper, which must never reap a row that is alive in here
//     (under a burst a row can legitimately sit at "minting" longer than the
//     reaper's age cutoff while its transaction waits its turn to mine);
//   - the health line.
// In-process only: one Render instance serves the mint, and a restart empties it,
// which is exactly what recoverInFlightMints rebuilds from the rows.
// ---------------------------------------------------------------------------

interface TrackedMint {
  serial: string;
  startedAt: number;
  submittedAt: number | null; // when the ticket was persisted (the bytes are about to go out)
}
const inFlight = new Map<string, TrackedMint>();

// Observed pace: an exponential moving average of the gap between consecutive
// mints becoming ready. Seeds at one second (a fast chain's block) and follows
// reality within a handful of mints. The ETA shown to a keeper is only ever
// "about N seconds"; it must move with the chain, not with a config number.
let readyGapEwmaMs = 1_000;
let lastReadyAt: number | null = null;
function noteReady(now: number): void {
  if (lastReadyAt !== null) {
    const gap = Math.max(1, now - lastReadyAt);
    readyGapEwmaMs = readyGapEwmaMs * 0.7 + gap * 0.3;
  }
  lastReadyAt = now;
}

export interface MintQueueInfo {
  /** 1-based place among the mints this process is driving (1 = next to land). */
  position: number;
  /** Mints ahead of this one. */
  ahead: number;
  /** Rough seconds until this mint lands, from the observed pace. Rounded UP to 5 s. */
  etaSec: number;
  /** "queued" until the transaction is on the wire, "submitted" after. */
  phase: "queued" | "submitted";
}

/** Where a still-minting serial stands, or null when this process is not driving it. */
export function mintQueueInfo(serial: string): MintQueueInfo | null {
  const mine = inFlight.get(serial);
  if (!mine) return null;
  let ahead = 0;
  for (const t of inFlight.values()) {
    if (t.serial === serial) break;
    ahead += 1;
  }
  const rawEta = (ahead + 1) * readyGapEwmaMs;
  return {
    position: ahead + 1,
    ahead,
    etaSec: Math.max(5, Math.ceil(rawEta / 5_000) * 5),
    phase: mine.submittedAt === null ? "queued" : "submitted",
  };
}

/** Mints this process is driving right now. */
export function mintsInFlightCount(): number {
  return inFlight.size;
}

/** Test hook: the observed pace, for the smoke to assert the ETA moves. */
export function _mintPaceForTests(): { readyGapEwmaMs: number } {
  return { readyGapEwmaMs };
}

/**
 * THE STUCK-MINT REAPER. The failure path releases both claims when a mint FAILS,
 * but that only runs if the process is alive to run it. If the process dies
 * mid-mint (Render restart, deploy, OOM, host eviction) the row is left `status:
 * "minting"` forever while still holding the inbox and the verified identity.
 * The keeper then has no pet, and every retry answers "already_minted" for a
 * reason they cannot see, cannot fix, and did not cause. Nothing swept these.
 *
 * Since launch fix 1 a restart is handled first and precisely by
 * recoverInFlightMints (every "minting" row is re-attached to its transaction or
 * failed on the spot), so this sweep is the backstop for whatever that could not
 * classify. It NEVER touches a row this process is actively driving: under a
 * burst a row can legitimately be older than the cutoff while its transaction
 * waits its turn to mine, and reaping it would release the inbox claim for a pet
 * that is about to exist. Anything else still "minting" after MINT_STUCK_MINUTES
 * is abandoned: mark it failed (failed rows also stop counting against supply)
 * and release both claims on exactly the same terms as the failure path.
 * Idempotent: a row is only reaped once because reaping moves it out of "minting".
 */
export async function reapStuckMints(ctx: AppContext, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - config.MINT_STUCK_MINUTES * 60_000);
  let stuck: Awaited<ReturnType<AppContext["store"]["stuckMintingRunners"]>>;
  try {
    stuck = await ctx.store.stuckMintingRunners(cutoff);
  } catch (err) {
    logger.error({ err: String(err) }, "stuck-mint sweep query failed");
    return 0;
  }
  let reaped = 0;
  for (const runner of stuck) {
    if (inFlight.has(runner.serial)) continue; // alive: its transaction is queued or awaiting its receipt
    try {
      await ctx.store.updateRunner(runner.serial, {
        status: "failed",
        failureReason: "mint did not complete (abandoned: server restart or timeout)",
      });
      await releaseMintClaims(ctx, runner);
      reaped += 1;
      logger.warn(
        { serial: runner.serial, createdAt: runner.createdAt },
        "reaped a stuck mint and released its anti-Sybil claims: this keeper can mint again",
      );
    } catch (err) {
      logger.error({ err: String(err), serial: runner.serial }, "stuck-mint reap failed");
    }
  }
  if (reaped > 0) logger.warn({ reaped }, "stuck-mint sweep released claims");
  return reaped;
}

// The row becomes a pet: token + TBA persisted, the Google object provisioned, the
// receipt email sent, the sellout check run. Shared by the live path and restart
// recovery so a recovered mint gets everything a fresh one does.
async function finalizeMint(ctx: AppContext, serial: string, issue: IssueResult): Promise<void> {
  const updated = await ctx.store.updateRunner(serial, {
    tokenId: issue.tokenId,
    tbaAddress: issue.tbaAddress,
    status: "ready",
    issueTxHash: issue.txHash,
  });
  noteReady(Date.now());

  // Provision the Google runner object (best effort; stubbed without creds).
  try {
    await getRunnerGoogle().ensureObject(updated);
  } catch (err) {
    logger.error({ err: String(err), serial }, "google runner ensureObject failed");
  }

  // Email the play link + wallet buttons (best effort; stubbed without Resend).
  try {
    const google = getRunnerGoogle();
    const googleUrl = google.live ? await google.saveUrl(updated) : null;
    // Capability URL to the owner's inbox: the only always-available surface
    // that may carry it (the public state endpoints withhold it once
    // real-value care is on).
    // Pass the start gate so the copy cannot instruct a keeper to feed a pet
    // the vault will refuse. Best effort: a failed read just yields the
    // ordinary wording.
    const gate = await getSeasonGate(ctx).catch(() => null);
    const seasonPending =
      gate?.selloutStartsSeason && gate.startedAt === 0
        ? { minted: gate.minted, maxSupply: gate.maxSupply }
        : null;
    await sendRunnerReceiptEmail(updated, {
      appleUrl: runnerPassDownloadUrl(serial, updated.authToken),
      googleUrl,
      cardUrl: `${config.WEB_APP_URL}/pet/${serial}`,
    }, seasonPending);
  } catch (err) {
    logger.error({ err: String(err), serial }, "runner receipt email failed");
  }

  logger.info(
    { serial, tokenId: issue.tokenId, tx: issue.txHash },
    "runner fulfilled",
  );

  // THE MINT THAT SELLS OUT IS THE ONE THAT STARTS THE SEASON. Best effort and never fatal to a
  // successful mint: the idle cycle re-checks as a backstop, and the vault rejects any start that
  // is not genuinely earned. See season-start.ts.
  try {
    await maybeStartSoldOutSeason(ctx);
  } catch (err) {
    logger.warn({ err: String(err), serial }, "post-mint sellout check failed (idle will retry)");
  }
}

// The mint genuinely failed: the row is marked with a reason that is safe to show
// where it is safe to show it, and BOTH anti-Sybil claims go back so this keeper
// can retry (best-effort; a no-op when the gate never ran). Failed rows also stop
// counting against supply (countRunners). A one-per-identity reserve with no
// release path is a lockout: the keeper has no pet, no way to get one, and
// nothing they can change (they cannot pick a different Privy account for the
// same wallet). Shared with the stuck-mint reaper so the paths can never drift.
async function failMint(ctx: AppContext, runner: Runner, err: unknown): Promise<void> {
  logger.error({ err: String(err), serial: runner.serial }, "runner fulfillment failed");
  // A spent hourly mint budget is the keeper's timing, not a fault: record a reason that is safe
  // to show them verbatim (routes.ts only ever publishes MINT_BUSY_PREFIX reasons), with the wait.
  const failureReason = err instanceof MintBudgetExhaustedError
    ? MINT_BUSY_PREFIX + mintBusyMessage(err.budget, err.retryAfterSec)
    : String(err instanceof Error ? err.message : err);
  try {
    await ctx.store.updateRunner(runner.serial, {
      status: "failed",
      failureReason,
    });
  } catch (updErr) {
    logger.error({ err: String(updErr), serial: runner.serial }, "failed-mint row update failed");
  }
  await releaseMintClaims(ctx, runner);
}

/**
 * Mint a WALLETCHI pet on Robinhood Chain, persist token + TBA, provision the
 * pass, and email the wallet buttons. Idempotent per serial.
 *
 * PIPELINED (launch fix 1): the relayer returns the ticket (hash + nonce) the
 * moment the transaction is signed, BEFORE it is broadcast, and this persists it
 * to the row right then. From that instant a restart can find the transaction
 * again (recoverInFlightMints); before it, a restart proves the transaction never
 * existed. The receipt is awaited by the chain's one watcher, not by a queue slot.
 *
 * `onSettled` fires exactly once, on every exit, so a caller holding a budget
 * admission (routes.ts) can hand it back without knowing how the mint ended.
 */
export async function fulfillRunner(
  ctx: AppContext,
  serial: string,
  onSettled?: () => void,
): Promise<void> {
  try {
    const runner = await ctx.store.getRunner(serial);
    if (!runner) {
      logger.error({ serial }, "fulfillRunner: runner not found");
      return;
    }
    if (runner.status === "ready" || runner.tokenId) {
      logger.info({ serial, status: runner.status }, "fulfillRunner: already done; skip");
      return;
    }

    const tracked: TrackedMint = { serial, startedAt: Date.now(), submittedAt: null };
    inFlight.set(serial, tracked);
    try {
      const issue = await ctx.relayer.issueRunner(runner.ownerAddress, async (ticket: MintTicket) => {
        // Persist-before-broadcast. If THIS write fails the relayer does not send
        // (the nonce is handed back), so a row never holds a hash for bytes that
        // went out unrecorded, and never lacks one for bytes that did.
        await ctx.store.updateRunner(serial, { issueTxHash: ticket.txHash, issueNonce: ticket.nonce });
        tracked.submittedAt = Date.now();
      });
      await finalizeMint(ctx, serial, issue);
    } catch (err) {
      await failMint(ctx, runner, err);
    } finally {
      inFlight.delete(serial);
    }
  } finally {
    onSettled?.();
  }
}

/**
 * RESTART RECOVERY (launch fix 1). Runs once at boot, before the API listens and
 * before the reaper's first sweep. Every row still at "minting" is one of two
 * things:
 *   - it carries a ticket (hash + nonce): a previous process signed and, in all
 *     but a microsecond window, broadcast it. Re-attach: the chain's watcher
 *     settles it as mined (finalize: the keeper gets their pet, pass and email
 *     exactly as if nothing happened), still pending (watched, fee-bumped if it
 *     becomes a stuck head) or consumed by another transaction (failed, claims
 *     released). Nothing is broadcast here; the nonce is already ours.
 *   - it carries no ticket: the process died between the row insert and the
 *     signature, so no transaction exists for it anywhere. Fail it NOW and hand
 *     the claims back, rather than making the keeper wait MINT_STUCK_MINUTES for
 *     the age-based reaper.
 * The re-attached rows are driven in the background; this returns as soon as the
 * rows are classified so boot is never held on a chain read.
 */
export async function recoverInFlightMints(
  ctx: AppContext,
  onEachSettled?: (row: Runner) => void,
): Promise<{ reattached: number; failed: number }> {
  let rows: Runner[];
  try {
    rows = await ctx.store.mintingRunners();
  } catch (err) {
    logger.error({ err: String(err) }, "mint recovery: could not list in-flight rows (the reaper will sweep them)");
    return { reattached: 0, failed: 0 };
  }
  let reattached = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.issueTxHash && row.issueNonce !== null && row.issueNonce !== undefined) {
      inFlight.set(row.serial, { serial: row.serial, startedAt: row.createdAt.getTime(), submittedAt: row.updatedAt.getTime() });
      reattached += 1;
      const ticket: MintTicket = { txHash: row.issueTxHash, nonce: row.issueNonce };
      void (async () => {
        try {
          const issue = await ctx.relayer.recoverMint(ticket, row.ownerAddress);
          await finalizeMint(ctx, row.serial, issue);
          logger.warn({ serial: row.serial, tokenId: issue.tokenId, tx: issue.txHash }, "mint recovery: a mint from before the restart landed and is fulfilled");
        } catch (err) {
          await failMint(ctx, row, err);
        } finally {
          inFlight.delete(row.serial);
          onEachSettled?.(row);
        }
      })();
    } else {
      await failMint(ctx, row, new Error("mint did not complete (server restarted before the transaction was signed)"));
      failed += 1;
      onEachSettled?.(row);
    }
  }
  if (reattached || failed) {
    logger.warn({ reattached, failed }, "mint recovery: in-flight rows from before the restart classified");
  }
  return { reattached, failed };
}
