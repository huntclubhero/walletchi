"use client";

import { useCallback, useEffect, useState } from "react";
import { getPetRewards, type PetRewards } from "@/lib/api";
import type { PrivySessionInfo } from "./PrivyGate";

/**
 * Per-pet player-rewards panel for the /me dashboard, PUSH edition (season-2
 * no-claims law: SEASON2-NO-CLAIMS-SPEC.md). The distributor shares 20% of
 * every care into per-epoch pools and the game DELIVERS each living pet's
 * slice straight into its own account: on every care it makes, and on the
 * push cycle that sweeps finished epochs every couple of hours. There is
 * nothing to claim and no button here on purpose; this panel only reports
 * what has accrued and is on its way.
 *
 * Degrades gracefully: while the distributor is not live the read comes back
 * rewardsLive:false and this renders a gentle "warming up" note, never an
 * error and never a phantom balance.
 */
export function RewardsPanel({
  pet,
}: {
  pet: { tokenId?: string; serial?: string };
  session: PrivySessionInfo;
}) {
  const tokenId = pet.tokenId;
  const [rewards, setRewards] = useState<PetRewards | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!tokenId) {
      setLoaded(true);
      return;
    }
    const r = await getPetRewards(tokenId);
    setRewards(r);
    setLoaded(true);
  }, [tokenId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Nothing to show until the first read resolves (avoids a flash of the wrong state).
  if (!tokenId || !loaded) return null;

  // Warming / degraded: the distributor is not live (or the den was unreachable).
  if (!rewards || rewards.rewardsLive !== true) {
    return (
      <div className="mt-4 rounded-2xl p-3" style={{ background: "var(--color-lav-soft)" }}>
        <div className="text-sm font-bold" style={{ color: "var(--color-ink)" }}>
          <span aria-hidden>🎁 </span>Rewards are not running right now
        </div>
        <p className="mt-1 text-xs" style={{ color: "var(--color-ink-soft)" }}>
          When they are, a living pet&apos;s share of the care pool lands in its own account by
          itself. Nothing to claim.
        </p>
      </div>
    );
  }

  const earned = rewards.totalClaimableWhole ?? 0;
  const hasRewards = (rewards.claimable?.length ?? 0) > 0;
  const earnedLabel = earned >= 1 ? earned.toLocaleString() : "a little";

  return (
    <div
      className="mt-4 rounded-2xl p-3"
      style={{
        background: hasRewards ? "var(--color-teal-soft)" : "var(--color-sky-3)",
      }}
    >
      {hasRewards ? (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-bold" style={{ color: "var(--color-ink)" }}>
              <span aria-hidden>🎁 </span>Rewards on the way
            </span>
            <span className="display" style={{ fontSize: "1.15rem", color: "var(--color-teal-deep)" }}>
              {earnedLabel} test CARE
            </span>
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--color-ink-soft)" }}>
            Your share of the care pool. It is delivered straight into your pet&apos;s own
            account: with every care you make, and by the reward run every couple of hours.
            Nothing to claim, nothing to sign. Only a living pet collects, and whatever a
            fallen pet leaves behind goes to the survivors.
          </p>
        </>
      ) : (
        <div>
          <div className="text-sm font-bold" style={{ color: "var(--color-ink)" }}>
            <span aria-hidden>🌱 </span>No rewards waiting
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--color-ink-soft)" }}>
            Keep caring for your pet: active keepers share the care pool, and its share is
            delivered to it automatically.
          </p>
        </div>
      )}
    </div>
  );
}
