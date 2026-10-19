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
//
// Thresholds live in config (a season-tuning knob, all env-tunable). A pet
// advances by EITHER enough cares OR enough days, whichever lands first, so an
// active keeper evolves through care and a patient one through time.

export type Stage = 0 | 1 | 2 | 3;

const DAY_MS = 86_400_000;

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
  return Math.max(byCares, byAge) as Stage;
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
