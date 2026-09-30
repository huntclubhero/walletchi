// The care split AS DISPLAYED, in one place so it can never drift across
// surfaces again (it was hardcoded in six components when Hunt amended the
// split and every one had to be hunted down).
//
// Source of truth is the deployed PetVault's bps getters (burnBps /
// rewardsBps / potBps, plus the season-2 gas leg): if a deploy changes the
// split, this file is the ONLY copy stop.
//
// Season-2 ruling (2026-08-30, SEASON2-NO-CLAIMS-SPEC.md): 69% burn /
// 20% player rewards / 10% pot / 1% push gas. The retired season-1 vault
// burned 70% with no gas leg.
export const BURN_PCT = "69%";
export const REWARDS_PCT = "20%";
export const POT_PCT = "10%";
export const GAS_PCT = "1%";
