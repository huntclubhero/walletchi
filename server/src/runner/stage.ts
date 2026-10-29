import { config } from "../config.js";
import type { Runner } from "../store/types.js";

// WALLETCHI evolution: four visual stages the pet grows through as it is loved
// and ages. Stage is DERIVED (no oracle trust) from the runner row + the clock,
// so it is safe to compute anywhere and cannot be forged by a marketplace read.
//
//   0 EGG        un-hatched
//   1 HATCHLING  first care .. below the GROWN thresholds
//   2 GROWN      STAGE2_CARES cares OR STAGE2_AGE_DAYS days lived
//   3 PRIME      STAGE3_CARES cares OR STAGE3_AGE_DAYS days lived
//   4 FINAL FORM STAGE4_CARES cares OR STAGE4_AGE_DAYS days lived, once FORMS_ENABLED
//                and the pet's rollout day has come (forms.ts draws it)
//
// Thresholds live in config (a season-tuning knob, all env-tunable). A pet
// advances by EITHER enough cares OR enough days, whichever lands first, so an
// active keeper evolves through care and a patient one through time.

export type Stage = 0 | 1 | 2 | 3 | 4;

const DAY_MS = 86_400_000;

// FINAL FORM rollout. Switched on by FORMS_ENABLED; then each pet gets its own
// day in the first FORMS_ROLLOUT_DAYS days after FORMS_START (a stable hash of
// its id picks the day), so the collection evolves over a week or two instead
// of all at once on deploy. No start date = the day the flag flips counts as
// day zero for every pet (rollout days still spread them from then on).
function formDay(seed: string): number {
  let x = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    x ^= seed.charCodeAt(i);
    x = Math.imul(x, 16777619) >>> 0;
  }
  return x >>> 0;
}
export function formUnlocked(runner: Pick<Runner, "tokenId" | "serial">, now: Date): boolean {
  if (!config.FORMS_ENABLED) return false;
  // An allowlist (FORMS_SERIALS) narrows the flip to named cards: Hunt's first, then everyone.
  const only = (config.FORMS_SERIALS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (only.length > 0) return only.includes(runner.serial); // the named cards now, nobody else
  const days = Math.max(0, config.FORMS_ROLLOUT_DAYS);
  if (days === 0) return true;
  const start = config.FORMS_START ? Date.parse(config.FORMS_START) : NaN;
  if (!Number.isFinite(start)) return true;
  const slot = formDay(runner.tokenId ?? runner.serial) % days;
  return now.getTime() >= start + slot * DAY_MS;
}

// Days since the pet was born. bornAt is the vault registration instant when the
// season is live; createdAt is the fallback so age always resolves.
export function ageDaysOf(runner: Runner, now: Date): number {
  const bornMs = (runner.bornAt ?? runner.createdAt).getTime();
  return Math.max(0, (now.getTime() - bornMs) / DAY_MS);
}

export function stageFor(runner: Runner, now: Date): Stage {
  if (!runner.hatched) return 0;
  const cares = runner.careCount;
  const days = ageDaysOf(runner, now);
  const byCares = cares >= config.STAGE3_CARES ? 3 : cares >= config.STAGE2_CARES ? 2 : 1;
  const byAge = days >= config.STAGE3_AGE_DAYS ? 3 : days >= config.STAGE2_AGE_DAYS ? 2 : 1;
  const base = Math.max(byCares, byAge) as Stage;
  // Legacy keepers (FORMS_LEGACY_MAX_TOKEN): the launch-week pets evolve as soon as they are PRIME.
  const tokenNo = Number(runner.tokenId ?? 0);
  const legacy = config.FORMS_LEGACY_MAX_TOKEN > 0 && tokenNo > 0 && tokenNo <= config.FORMS_LEGACY_MAX_TOKEN;
  const ripe = legacy || cares >= config.STAGE4_CARES || days >= config.STAGE4_AGE_DAYS;
  // ONCE EVOLVED, STAYS EVOLVED. lastStage is the celebration latch maybeEvolve persists; a pet
  // that has shown its form keeps it even if the rollout gate would say "not yet" (seen on
  // 2026-10-19 when the flip moved from the FORMS_SERIALS test to the dated rollout: without
  // this, Hunt's card would have slid back to PRIME until its rollout day). FORMS_ENABLED=false
  // still reverts everyone: that is the rollback switch.
  const latched = config.FORMS_ENABLED && runner.lastStage >= 4;
  if (base === 3 && (latched || (ripe && formUnlocked(runner, now)))) return 4;
  return base;
}

// The render inputs the pet's stage contributes: its size/flourish stage and,
// for a brand-new hatchling, the cracked eggshell cap it wears on day one. Under
// flag-off (or a memorial) it returns no stage, so the renderer draws today's
// GROWN-size silhouette exactly.
export function petVisualFor(runner: Runner, now: Date): { stage?: Stage; shellCap: boolean } {
  if (!config.TRAITS_V2_ENABLED || runner.gone) return { stage: undefined, shellCap: false };
  const stage = stageFor(runner, now);
  const shellCap = stage === 1 && ageDaysOf(runner, now) < 1;
  return { stage, shellCap };
}
