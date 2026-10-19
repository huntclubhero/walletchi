import { config } from "../config.js";
import { maybeStartSoldOutSeason } from "./season-start.js";
import { logger } from "../logger.js";
import type { AppContext } from "../context.js";
import type { Runner } from "../store/types.js";
import type { PetLifeState } from "../chain/types.js";
import { pushPassUpdate } from "../passes/apns.js";
import { getRunnerGoogle } from "./google.js";
import { isQuietHour } from "./quiet.js";
import { decayNeeds } from "./needs.js";
import { stageFor } from "./stage.js";
import { PET_IDLE_EVENTS, EVOLUTION_COPY, MEMORIAL_COPY } from "./theme.js";
import { noteStatusForOpenSea } from "./opensea.js";
import { sendRunnerMemorialEmail } from "./email.js";
import { runnerPassDownloadUrl } from "./pass.js";
import { recordCarePerformed } from "./care-metrics.js";
import {
  getVaultConfig,
  cachedPetNeeds,
  bindingNeedIndex,
  petNeedPctFor,
  petNeedSecondsLeftFor,
  petCareBalanceFor,
  needsSecondsLeft,
  NEED_LABELS,
} from "./season.js";
import { chainNeedsToMeters } from "./needs.js";
import { reminderDue, checkInLine, lastChanceLine, isAlertLine, dueNeeds, withCareReopen, timeLeft } from "./reminders.js";
import { spendWindowFor } from "./care-budget-read.js";
import { setupNudgeFor } from "./setup-nudge.js";
import { adoptUnrecordedPets } from "./adopt.js";

// The idle pet layer: a WALLETCHI card lives between visits. A tick engine (and
// lazy catch-up on read) decays needs, narrates gentle flavor, reflects on-chain
// survival state, and pushes to the lock screen within a strict push budget.

// Pet-appropriate idle flavor. ~35% of ticks produce a gentle line; the rest are
// quiet. rng is injectable so the smoke test can force a line.
export function rollPetFlavor(rng: () => number = Math.random): string | null {
  if (rng() < 0.35) {
    return PET_IDLE_EVENTS[Math.floor(rng() * PET_IDLE_EVENTS.length)] ?? PET_IDLE_EVENTS[0]!;
  }
  return null;
}

type RunnerPatch = Parameters<AppContext["store"]["updateRunner"]>[1];

// High-signal pushes (critical, death feed, victory, memorial) pass a message:
// Apple already notifies via APNs + changeMessage, and the Google side mirrors
// it as a Wallet object message. Routine art/status refreshes omit it.
export interface PassPushMessage {
  header: string;
  body: string;
  /** Google: raise an Android notification (announcements only). */
  notify?: boolean;
}

export async function pushRunnerPass(
  ctx: AppContext,
  serial: string,
  opts: { message?: PassPushMessage } = {},
): Promise<void> {
  try {
    const tokens = await ctx.store.listRunnerPushTokensForSerial(serial);
    const results = await pushPassUpdate(tokens);
    // Prune registrations APNs reports as dead (Nexory, 2026-10-14): 410 Unregistered always, and 400
    // BadDeviceToken only against the production host (a sandbox token is "bad" on production and vice
    // versa, so a misconfigured host must not wipe good devices). Never on 403, 429 or 5xx.
    const production = config.APNS_HOST === "api.push.apple.com";
    for (const r of results ?? []) {
      const dead = r.status === 410 || (production && r.status === 400 && r.reason === "BadDeviceToken");
      if (!dead) continue;
      const n = await ctx.store.deleteRunnerRegistrationsByPushToken(serial, r.token).catch(() => 0);
      if (n) logger.info({ serial, token: r.token.slice(0, 8), status: r.status }, "pruned dead APNs registration");
    }
  } catch (err) {
    logger.error({ err: String(err), serial }, "idle apple push failed");
  }
  try {
    const r = await ctx.store.getRunner(serial);
    if (r) {
      const google = getRunnerGoogle();
      // Mirror the Apple card's combined five-need field (chain-derived when
      // live + alive; null falls back to the DB percents inside the object
      // builder). Both reads share the cached petNeeds fetch. The live CARE
      // balance mirrors the Apple header's carebal field (null omits it), so
      // the Android card refreshes it on the same push cycle.
      const needPct = await petNeedPctFor(ctx, r);
      const needSecondsLeft = await petNeedSecondsLeftFor(ctx, r);
      const careBalance = await petCareBalanceFor(ctx, r);
      const setupNudge = await setupNudgeFor(ctx, r);
      await google.patchObject(r, { needPct, needSecondsLeft, careBalance, setupNudge });
      if (opts.message) await google.addMessage(r, opts.message.header, opts.message.body, opts.message.notify === true);
    }
  } catch (err) {
    logger.error({ err: String(err), serial }, "idle google patch failed");
  }
}

export interface IdleReconcileOpts {
  now?: Date;
  rng?: () => number;
}

// The pet card lives between visits: needs decay (already applied by the caller)
// plus gentle pet-flavor narration on the tick schedule, pushed within the same
// budget + quiet hours.
async function petFlavorReconcile(
  ctx: AppContext,
  runner: Runner,
  now: Date,
  rng: () => number,
  minPushMs: number,
): Promise<Runner> {
  const tickMs = config.IDLE_TICK_MINUTES * 60_000;
  const lastTick = runner.lastTickAt ?? runner.createdAt;
  let ticks = Math.floor((now.getTime() - lastTick.getTime()) / tickMs);
  if (ticks <= 0) return runner;
  ticks = Math.min(ticks, config.IDLE_MAX_CATCHUP_TICKS);

  let lastEvent: string | null = null;
  let producedAt: Date | null = null;
  for (let i = 1; i <= ticks; i++) {
    const tickTime = new Date(lastTick.getTime() + i * tickMs);
    if (isQuietHour(tickTime)) continue; // no flavor while the pet sleeps
    const line = rollPetFlavor(rng);
    if (line) {
      lastEvent = line;
      producedAt = tickTime;
    }
  }

  const patch: RunnerPatch = { lastTickAt: new Date(lastTick.getTime() + ticks * tickMs) };
  if (lastEvent != null && lastEvent !== runner.lastEvent) patch.lastEvent = lastEvent;
  if (
    producedAt &&
    (!runner.lastPushAt || now.getTime() - runner.lastPushAt.getTime() >= minPushMs)
  ) {
    await pushRunnerPass(ctx, runner.serial);
    patch.lastPushAt = now;
  }
  return ctx.store.updateRunner(runner.serial, patch);
}

// v2 evolution event: when a pet's DERIVED stage passes the highest stage we
// have celebrated, mark the milestone (persist lastStage), narrate a
// celebratory line, and push it to the lock screen. Evolution is rare and
// momentous, so this push BYPASSES the per-hour budget once, but never quiet
// hours. Only GROWN/PRIME fire an event; the HATCHLING reveal is the hatch's
// own moment. A no-op under flag-off, so today's idle behaviour is unchanged.
export async function maybeEvolve(ctx: AppContext, runner: Runner, now: Date): Promise<Runner> {
  if (!config.TRAITS_V2_ENABLED || !runner.hatched || runner.gone) return runner;
  const newStage = stageFor(runner, now);
  if (newStage < 2 || newStage <= runner.lastStage) return runner;
  const line = EVOLUTION_COPY.eventLine(newStage);
  // DEFER THE CELEBRATION, DO NOT DROP IT. lastStage is the latch that stops
  // this event from firing twice, so persisting it while quiet hours suppressed
  // the push burned the milestone for good: the guard above (newStage <=
  // lastStage) never re-detects, and a pet that grew up overnight never told
  // anyone. Unlike the fade warning, an evolution is a celebration and NOT worth
  // a keeper's sleep, so the right answer is to wait for morning rather than to
  // bypass quiet hours. Holding the latch until the push actually goes out makes
  // the next waking tick re-detect the same stage and celebrate it properly.
  if (isQuietHour(now)) return runner;
  const patch: RunnerPatch = { lastStage: newStage, lastEvent: line, lastPushAt: now };
  const updated = await ctx.store.updateRunner(runner.serial, patch);
  await pushRunnerPass(ctx, runner.serial, {
    message: { header: EVOLUTION_COPY.pushHeader, body: line },
  });
  return updated;
}

// Survival rank is OFF-CHAIN in the last-pet-standing model (the contract keeps
// no death-order counter; memorialState.rank is always 0). Derive it by
// counting the known pets that died earlier: rank 1 = first to die. Display
// only ("Outlasted N"), so the store's view of prior deaths is the honest
// bounded source (2,000 cap).
async function offchainDeathRank(ctx: AppContext, serial: string, diedAtMs: number | null): Promise<number> {
  const minted = await ctx.store.allMintedRunners();
  const fallen = minted.filter((r) => r.serial !== serial && r.gone);
  if (diedAtMs === null) return fallen.length + 1;
  const earlier = fallen.filter((r) => !r.diedAt || r.diedAt.getTime() <= diedAtMs).length;
  return earlier + 1;
}

// Persist a dead pet's on-chain memorialState onto its row and flip it to the
// memorial. Death is the clock (diedAt = lastCareAt + lifeTtl), permanent. The
// pass then renders real "lived N days / cared X / Outlasted N".
export async function persistMemorial(ctx: AppContext, runner: Runner, tokenId: string): Promise<Runner> {
  let patch: RunnerPatch = { gone: true, critical: false, lastEvent: MEMORIAL_COPY.memorialLine };
  try {
    const m = await ctx.relayer.petMemorial(tokenId);
    const diedAtMs = m.diedAt ? m.diedAt * 1000 : null;
    patch = {
      ...patch,
      bornAt: m.bornAt ? new Date(m.bornAt * 1000) : null,
      diedAt: diedAtMs ? new Date(diedAtMs) : null,
      careCount: m.careCount,
      // The contract returns rank 0 now; the server derives the death order.
      deathRank: m.rank > 0 ? m.rank : await offchainDeathRank(ctx, runner.serial, diedAtMs),
    };
  } catch (err) {
    logger.warn({ err: String(err), serial: runner.serial }, "petMemorial read failed");
  }
  // EXACTLY ONCE (Nexory, 2026-10-14): `runner` was read before several awaits, so concurrent callers
  // (deathwatch, the idle cycle, public page reads) could all see it alive and all send the memorial.
  // The flip is now a conditional update; only the caller that made it sends mail, pushes and nudges.
  if (runner.gone) return ctx.store.updateRunner(runner.serial, patch);
  const flipped = await ctx.store.markRunnerGone(runner.serial, patch);
  if (!flipped) {
    const current = await ctx.store.getRunner(runner.serial);
    return current ?? runner;
  }
  const updated = flipped;
  // Email a memorial pass so the keeper still has the soulbound pass even if the in-place wallet
  // update never reached their device. Best-effort: never blocks the flip.
  if (updated.email) {
    try {
      const google = getRunnerGoogle();
      const googleUrl = google.live ? await google.saveUrl(updated) : null;
      await sendRunnerMemorialEmail(updated, {
        appleUrl: runnerPassDownloadUrl(updated.serial, updated.authToken),
        googleUrl,
        cardUrl: `${config.WEB_APP_URL}/pet/${updated.serial}`,
      });
    } catch (err) {
      logger.warn({ err: String(err), serial: runner.serial }, "memorial email failed (non-blocking)");
    }
  }
  await pushRunnerPass(ctx, runner.serial, {
    message: { header: "In memory", body: "Your pet has passed on. Its pass stays with you as a keepsake." },
  });
  noteStatusForOpenSea(tokenId, "dead"); // nudge marketplace caches on death
  return updated;
}

// The critical fade window, sized against the season's actual life (capped at a
// quarter of lifeTtl so a short demo season is not permanently "fading"; a long
// season gets the full CRITICAL_WINDOW_HOURS). Shared by the reflect loop and
// the care reconcile so "critical" means ONE thing. Fallback keeps the old
// window when the vault config read fails.
async function fadeWindowSecFor(ctx: AppContext): Promise<number> {
  let lifeTtlSeconds = config.CRITICAL_WINDOW_HOURS * 3600 * 4;
  try {
    lifeTtlSeconds = (await getVaultConfig(ctx)).lifeTtlSeconds;
  } catch {
    /* keep the fallback window */
  }
  return Math.min(config.CRITICAL_WINDOW_HOURS * 3600, Math.max(60, Math.floor(lifeTtlSeconds / 4)));
}

// Best-effort read of the pet's five need stamps, folded into (i) chain-derived
// meters and (ii) the BINDING need's display label (the need that dies first).
// null on any failure: callers fall back to generic copy and full meters,
// never to WRONG copy.
async function needsSnapshotFor(
  ctx: AppContext,
  tokenId: string,
  nowSec: number,
): Promise<{
  meters: { hunger: number; thirst: number; joy: number };
  bindingLabel: string;
  needAt: readonly number[];
  lifeTtlSeconds: number;
} | null> {
  try {
    const [{ needAt }, cfg] = await Promise.all([
      cachedPetNeeds(ctx, tokenId),
      getVaultConfig(ctx),
    ]);
    if (!needAt.some((t) => t > 0)) return null; // dormant: no timers to project
    const m = chainNeedsToMeters(needAt, cfg.lifeTtlSeconds, nowSec);
    return {
      meters: { hunger: m.hunger, thirst: m.thirst, joy: m.joy },
      bindingLabel: NEED_LABELS[bindingNeedIndex(needAt)]!,
      needAt,
      lifeTtlSeconds: cfg.lifeTtlSeconds,
    };
  } catch {
    return null;
  }
}

// TRUSTLESS CUTOVER reconcile: care() is OWNER-ONLY on-chain now, and the web
// care page (account-abstraction flow) sends the owner's signed care straight
// to the vault, so a care can land WITHOUT touching this server. Left alone the
// DB (and with it the wallet pass) goes stale: the egg never hatches on the
// pass, meters decay to sick/sad, careCount and the leaderboard freeze. When
// the on-chain care is NEWER than what the DB knows, fold its side-effects in:
// hatch, project the FIVE on-chain need stamps into the meters (8.3), sync
// careCount + lastCareAt (the MIN-NEED stamp), narrate, push the pass.
//
// TRUTHFUL CRITICAL (audit 5): a care refreshes ONE need, so it does NOT
// automatically pull a fading pet out of danger. `critical` is RECOMPUTED from
// the pet's post-care secondsLeft against the fade window, never blanket
// cleared, and when the pet is STILL critical the copy names the binding need
// instead of claiming "happy and full". IDEMPOTENT: the persisted
// lastCareAt/careCount advance to the chain's values, so reconciling the same
// care twice is a no-op.
// Did THIS care hatch the pet? THE CHAIN IS THE TRUTH, NOT THE DB. A pet's first care is
// its hatch, and mint-time arming makes that first care from the BROWSER, which the server
// never sees until a reconcile runs. On 2026-09-23 that stale runner.hatched labeled Hunt's
// first pass tap "Your egg hatched!" 30s after the pet had hatched on chain.
//
// Primary rule: `careCountBeforeTx` is the on-chain careCount read right BEFORE this care
// was submitted (chainCareCountOf). Zero means this care is the hatch; anything else means
// the pet was already hatched, whatever the DB says.
// Fallback when that read failed (null): the DB had it unhatched AND the chain's count after
// the care is exactly 1 (reconcileOnChainCare copies the chain's careCount onto `after`).
export function careHatchedThePet(
  before: Runner,
  after: Runner,
  careCountBeforeTx: number | null = null,
): boolean {
  if (careCountBeforeTx !== null) return careCountBeforeTx === 0;
  return !before.hatched && after.hatched && after.careCount === 1;
}

/** The pet's on-chain careCount right now, or null when the read fails (never throws). */
export async function chainCareCountOf(ctx: AppContext, tokenId: string): Promise<number | null> {
  try {
    return (await ctx.relayer.petMemorial(tokenId)).careCount;
  } catch {
    return null;
  }
}

export async function reconcileOnChainCare(
  ctx: AppContext,
  runner: Runner,
  tokenId: string,
  state: PetLifeState,
  now: Date,
): Promise<Runner> {
  if (runner.gone || state.lastCareAt <= 0) return runner;
  const dbCareSec = runner.lastCareAt ? Math.floor(runner.lastCareAt.getTime() / 1000) : null;
  const newerByClock = dbCareSec !== null && state.lastCareAt > dbCareSec;
  // register() does NOT set need stamps (a dormant egg has lastCareAt == 0; the
  // early-return above already skips those). Once fed, careCount is the surer
  // signal that a NEW care happened: under five needs a non-weakest-need care
  // does not even move the min stamp, so the clock comparison alone would miss
  // it. Consult the on-chain careCount (memorialState carries it for living
  // pets as well). Best effort: when the read fails, the clock comparison
  // stands and the count falls back to a +1 bump.
  let chainCareCount: number | null = null;
  try {
    chainCareCount = (await ctx.relayer.petMemorial(tokenId)).careCount;
  } catch (err) {
    logger.debug({ err: String(err), serial: runner.serial }, "careCount read failed during care reconcile");
  }
  const newerByCount = chainCareCount !== null && chainCareCount > runner.careCount;
  if (!newerByClock && !newerByCount) return runner;
  // A care just landed (this runs from the tick AND directly from the pass-tap and website
  // care paths): stamp it here so the reminder hold sees every fold, not only the tick's.
  careFoldedAt.set(runner.serial, now.getTime());

  const hatching = !runner.hatched;
  // Meters + the binding need from the chain's five stamps (best effort; the
  // old full-meter behavior is the fallback so a read blip never blanks the card).
  const snap = await needsSnapshotFor(ctx, tokenId, Math.floor(now.getTime() / 1000));
  const meters = snap?.meters ?? { hunger: 100, thirst: 100, joy: 100 };
  // Critical is recomputed from the AUTHORITATIVE post-care deadline: still
  // inside the fade window means still critical (a non-binding care saved nothing).
  const fadeWindowSec = await fadeWindowSecFor(ctx);
  const stillCritical = state.secondsLeft > 0 && state.secondsLeft <= fadeWindowSec;
  // The narration keys on the CHECK-IN threshold (8h), not the 6h fade window: a tap between the
  // two used to say "happy and full" while another need was dying in 7h (bug hunt 2026-10-19).
  const stillDue = state.secondsLeft > 0 && state.secondsLeft <= config.CHECKIN_HOURS * 3600;
  const needLabel = snap?.bindingLabel ?? "care";
  const patch: RunnerPatch = {
    critical: stillCritical,
    lastCareAt: new Date(state.lastCareAt * 1000), // the MIN-NEED stamp: deadline math key
    careCount: chainCareCount ?? runner.careCount + 1,
    hunger: meters.hunger,
    thirst: meters.thirst,
    joy: meters.joy,
    lastEvent: hatching
      ? "Your egg hatched! Say hello to your pet."
      : stillDue
        ? `Your Chi was cared for, but it still needs ${needLabel}: ${timeLeft(state.secondsLeft)} left.`
        : "Your Chi was cared for. It is happy and full.",
  };
  if (hatching) {
    patch.hatched = true;
    patch.lastNeedsAt = now; // start the needs clock at hatch
  }
  // v2 evolution: keep lastStage in step with the derived stage WITHOUT firing
  // a celebration here (maybeEvolve narrates GROWN/PRIME on its own beat; the
  // hatch line above is the hatch's own moment).
  if (config.TRAITS_V2_ENABLED) {
    const merged = { ...runner, ...patch, hatched: true } as Runner;
    patch.lastStage = Math.max(runner.lastStage, hatching ? 1 : stageFor(merged, now));
  }
  // Saved off-server: refresh the Critical badge away, but ONLY when the pet
  // actually left the fade window (a still-critical pet must keep its badge).
  if (runner.critical && !stillCritical) noteStatusForOpenSea(tokenId, "alive");
  const updated = await ctx.store.updateRunner(runner.serial, patch);
  await ctx.store.addRunnerEvent(
    runner.serial,
    "action",
    hatching ? "Egg hatched (cared for on-chain)." : "Cared for on-chain.",
  );
  recordCarePerformed("onchain");
  await pushRunnerPass(ctx, runner.serial);
  return updated;
}

/**
 * Minimum spacing between two fade warnings for the same pet. Quiet hours do not
 * SUPPRESS this push (that was the unwarned-death bug: a 6h fade window inside a
 * 9h silence meant ~17% of pets died having never pinged), they only widen the
 * gap so an overnight fade wakes a keeper two or three times instead of eight.
 * Exported so the spacing rule can be exercised directly against real clock
 * times rather than re-derived in a test.
 */
export function criticalPushGapMs(now: Date): number {
  return isQuietHour(now)
    ? config.CRITICAL_QUIET_MIN_GAP_HOURS * 3_600_000
    : Math.floor(3_600_000 / Math.max(1, config.IDLE_MAX_PUSHES_PER_HOUR));
}

// WALLETCHI survival reflection (live season only): keep the pets we hold honest
// against the CLOCK. Death is timer-based and PERMANENT (no revive, no reaping
// step): if a tracked pet's deadline (lastCareAt + lifeTtl) has passed, it is
// dead: memorialize it. CRITICAL/fading now means APPROACHING the deadline:
// within CRITICAL_WINDOW_HOURS of it the pet is flagged critical with an
// escalating "N hours left" ping so the keeper can still save it. A care resets
// the timer and the flag clears on the next reflection.
async function reflectSurvival(ctx: AppContext, runner: Runner, tokenId: string, now: Date): Promise<Runner> {
  let state;
  try {
    state = await ctx.relayer.petState(tokenId);
  } catch (err) {
    logger.warn({ err: String(err), serial: runner.serial }, "petState read failed");
    return runner;
  }
  if (!state.registered) return runner;

  // A registered pet that has NEVER been fed (lastCareAt == 0) is a DORMANT EGG,
  // not a corpse: its life clock only starts on the FIRST feed (the hatch). The
  // vault reports isAlive == false for it purely because it has not hatched yet,
  // which is NOT death (dead/isDead are both false; secondsLeft is 0 only because
  // the timer has not started). Memorializing it here is the "it died the moment
  // I went to feed it" bug: leave the egg be so the keeper can hatch it.
  if (!state.dead && state.lastCareAt <= 0) return runner;

  // The clock says dead: permanent. Memorialize (no grace, no revive).
  if (state.dead || !state.isAlive) return persistMemorial(ctx, runner, tokenId);

  // Fold in any owner-signed on-chain care the server never saw (the AA path)
  // BEFORE the critical/fade math below reads the stale flags.
  runner = await reconcileOnChainCare(ctx, runner, tokenId, state, now);

  // Critical (fading) is the FINAL stretch before the on-chain deadline, sized
  // against the season's actual life (see fadeWindowSecFor). The deadline is
  // the pet's WEAKEST need: petState.secondsLeft already keys on min-need.
  const fadeWindowSec = await fadeWindowSecFor(ctx);

  // REMINDERS (runner/reminders.ts): a daily check-in, then a last chance, each asking for the
  // one tap that serves every need. Decided here, before the critical bookkeeping, because the
  // check-in fires while the pet is still comfortably outside the fade window.
  const quietSpanSec = (((config.IDLE_QUIET_END_HOUR - config.IDLE_QUIET_START_HOUR) % 24) + 24) % 24 * 3600;
  const reminder = reminderDue({
    secondsLeft: state.secondsLeft,
    lastEvent: runner.lastEvent,
    quietNow: isQuietHour(now),
    quietSoon: isQuietHour(new Date(now.getTime() + config.IDLE_TICK_MINUTES * 60_000)),
    quietSpanSec,
    checkInSec: config.CHECKIN_HOURS * 3600,
    lastChanceSec: config.LAST_CHANCE_HOURS * 3600,
  });
  const critical = state.secondsLeft <= fadeWindowSec;
  // REARM HOLD (config.REMINDER_REARM_MINUTES): a care just landed, the keeper is on the card.
  // Hold the reminder; the first tick after the gap sends one, naming what is still due.
  const foldedAt = careFoldedAt.get(runner.serial);
  const holdMinutes = reminder === "last-chance" ? config.LAST_CHANCE_REARM_MINUTES : config.REMINDER_REARM_MINUTES;
  const rearmHeld = reminder !== null && foldedAt !== undefined && now.getTime() - foldedAt < holdMinutes * 60_000;
  if (rearmHeld) logger.debug({ serial: runner.serial, tokenId, reminder }, "care reminder held: a care just landed");
  if (reminder && !rearmHeld) {
    // Name every need inside the check-in window (plus a few hours), most urgent first, so a
    // keeper who taps them all is set for the day. A failed needs read says "all five needs".
    const nowSec = Math.floor(now.getTime() / 1000);
    const snap = await needsSnapshotFor(ctx, tokenId, nowSec);
    const due = snap
      ? dueNeeds(NEED_LABELS, needsSecondsLeft(snap.needAt, snap.lifeTtlSeconds, nowSec), (config.CHECKIN_HOURS + 4) * 3600)
      : [];
    let line = reminder === "checkin" ? checkInLine(state.secondsLeft, due) : lastChanceLine(state.secondsLeft, due);
    // LIMIT-AWARE: with no cares left in the account's 24 h window a tap would be refused, so say
    // when care opens again. Same reminder, same timing, same single push; unreadable = unchanged.
    const limit = await spendWindowFor(ctx, runner.tbaAddress, nowSec);
    if (limit && limit.caresLeft === 0) {
      line = withCareReopen(line, limit.reopensAt - nowSec);
      const deadlineSec = nowSec + state.secondsLeft;
      if (limit.reopensAt > deadlineSec) {
        logger.error(
          {
            serial: runner.serial,
            tokenId,
            reminder,
            now: new Date(nowSec * 1000).toISOString(),
            careReopensAt: new Date(limit.reopensAt * 1000).toISOString(),
            deadline: new Date(deadlineSec * 1000).toISOString(),
          },
          "CARE LIMIT DEATH RISK",
        );
      }
    }
    const header = reminder === "checkin" ? "Your Chi needs you" : "Last chance";
    const updated = await ctx.store.updateRunner(runner.serial, { critical, lastEvent: line, lastPushAt: now });
    // Hunt 2026-10-19: Android keepers get a real notification for both reminders (TEXT_AND_NOTIFY).
    // Until now the Google message was card-only text, so an Android holder was never woken for a
    // dying Chi. Two per cycle, under Google's per-object daily cap.
    await pushRunnerPass(ctx, runner.serial, { message: { header, body: line, notify: true } });
    logger.info({ serial: runner.serial, tokenId, reminder, secondsLeft: state.secondsLeft }, "care reminder sent");
    if (critical) noteStatusForOpenSea(tokenId, "critical");
    return updated;
  }

  // Comfortably alive: clear a stale critical flag if a care pushed the
  // deadline back out.
  if (!critical) {
    if (runner.critical) {
      noteStatusForOpenSea(tokenId, "alive"); // saved: refresh the Critical badge away
      return ctx.store.updateRunner(runner.serial, { critical: false });
    }
    return runner;
  }

  // Inside the fade window with no reminder due this tick: flag the pet critical (its mood, the
  // marketplace badge) WITHOUT another push. The card keeps showing the check-in, and the last
  // chance goes out at LAST_CHANCE_HOURS whatever the hour. This window used to ping every half
  // hour (every three overnight) with a line that changed each time, and every change was a
  // banner: a dying pet buried its own warning in noise.
  if (runner.critical) return runner;
  const updated = await ctx.store.updateRunner(runner.serial, { critical: true });
  noteStatusForOpenSea(tokenId, "critical"); // fading: nudge marketplace caches
  return updated;
}

// When a care last landed for a serial (reconcileOnChainCare folded a new careCount), so the
// reminder step can hold off re-arming while the keeper is still tapping. In-memory on purpose:
// one instance serves the cards, and a restart costs at most one early reminder.
const careFoldedAt = new Map<string, number>();
/** Test hook. */
export function _resetReminderRearm(): void {
  careFoldedAt.clear();
}

// Advance a pet's idle simulation up to `now`: decay needs, narrate, and push
// within the budget. Safe to call on a schedule AND lazily on read.
export async function reconcilePet(
  ctx: AppContext,
  runner: Runner,
  opts: IdleReconcileOpts = {},
): Promise<Runner> {
  if (!config.IDLE_ENABLED) return runner;
  if (runner.status !== "ready" || !runner.tokenId) return runner;
  const tokenId = runner.tokenId; // narrowed here; safe past later reassigns

  // A memorial is final: no idle/needs processing for a pet that has passed on.
  if (runner.gone) return runner;

  const now = opts.now ?? new Date();
  const rng = opts.rng ?? Math.random;
  const minPushMs = Math.floor(3_600_000 / Math.max(1, config.IDLE_MAX_PUSHES_PER_HOUR));

  // WALLETCHI survival (live season only): reflect the on-chain clock before
  // anything else. Memorializes pets whose life timer lapsed (permanent death)
  // and flags deadline-approaching ones as critical. A gone or critical pet is
  // managed here: no idle flavor over its card.
  if (config.modes.survivalLive) {
    runner = await reflectSurvival(ctx, runner, tokenId, now);
    // A showing reminder owns the card until a care clears it: flavor and need pings must not
    // overwrite it (that would also re-arm the check-in on the next tick).
    if (runner.gone || runner.critical || isAlertLine(runner.lastEvent)) return runner;
  }

  // Pet needs: decay needs for EVERY ready pet (even before its first run) and
  // ping the lock screen (push budget + quiet hours respected).
  const nd = await decayNeeds(ctx, runner, now);
  runner = nd.runner;
  if (
    nd.pushLine &&
    !isQuietHour(now) &&
    (!runner.lastPushAt || now.getTime() - runner.lastPushAt.getTime() >= minPushMs)
  ) {
    await pushRunnerPass(ctx, runner.serial);
    runner = await ctx.store.updateRunner(runner.serial, { lastPushAt: now });
  }

  // Pet-flavor narration only (the runnable game is retired and removed).
  runner = await petFlavorReconcile(ctx, runner, now, rng, minPushMs);
  // v2 evolution gets the last word on the freshest event + a momentous push.
  return maybeEvolve(ctx, runner, now);
}

// The scheduled engine: every IDLE_TICK_MINUTES, reconcile every ready pet. Prod
// bootstrap (index.ts) starts it; the smoke test drives reconcilePet directly.
export function startIdleEngine(ctx: AppContext): { stop: () => void } {
  if (!config.IDLE_ENABLED) {
    logger.warn("IDLE ENGINE OFF (IDLE_ENABLED=false)");
    return { stop: () => {} };
  }
  const intervalMs = config.IDLE_TICK_MINUTES * 60_000;
  logger.info({ everyMinutes: config.IDLE_TICK_MINUTES, bootTickSeconds: config.IDLE_BOOT_TICK_SECONDS }, "idle pet engine started");
  const timer = setInterval(() => void runCycle(ctx), intervalMs);
  timer.unref?.();
  // BOOT TICK: a deploy must not delay an overdue reminder by up to a whole interval. One cycle
  // shortly after boot (after the pass refresh has had a moment), then the regular cadence.
  let bootTimer: NodeJS.Timeout | null = null;
  if (config.IDLE_BOOT_TICK_SECONDS > 0) {
    bootTimer = setTimeout(() => {
      logger.info("idle boot tick");
      void runCycle(ctx);
    }, config.IDLE_BOOT_TICK_SECONDS * 1000);
    bootTimer.unref?.();
  }
  return {
    stop: () => {
      clearInterval(timer);
      if (bootTimer) clearTimeout(bootTimer);
    },
  };
}

// One cycle at a time: the boot tick and the interval must never walk the roster together.
let cycleRunning = false;
async function runCycle(ctx: AppContext): Promise<void> {
  if (cycleRunning) {
    logger.warn("idle cycle skipped: the previous cycle is still running");
    return;
  }
  cycleRunning = true;
  try {
    await runCycleBody(ctx);
  } finally {
    cycleRunning = false;
  }
}

async function runCycleBody(ctx: AppContext): Promise<void> {
  await maybeStartSoldOutSeason(ctx);
  // An on-chain pet with no server row (minted outside the site) joins the roster here, so
  // reminders, passes and the dashboard treat it like any other pet. See adopt.ts.
  try {
    const adopted = await adoptUnrecordedPets(ctx);
    if (adopted > 0) logger.warn({ adopted }, "idle cycle adopted unrecorded pets");
  } catch (err) {
    logger.error({ err: String(err) }, "adoption sweep failed");
  }
  try {
    const pets = await ctx.store.readyRunners(2000);
    for (const pet of pets) {
      try {
        await reconcilePet(ctx, pet, { now: new Date() });
      } catch (err) {
        logger.error({ err: String(err), serial: pet.serial }, "idle reconcile failed");
      }
    }
  } catch (err) {
    logger.error({ err: String(err) }, "idle cycle failed");
  }
}
