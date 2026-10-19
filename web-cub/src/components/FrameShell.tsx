"use client";

import { usePathname } from "next/navigation";
import { BRAND } from "@/lib/brand";

/**
 * The cinematic "frame within a frame": a fixed hairline border, corner LCD labels, a left
 * life-rail (desktop), a scroll-progress bar, plus grain + vignette overlays for depth.
 * Purely decorative and non-interactive (pointer-events: none everywhere).
 *
 * The death-game framing (the "cap -> 1" corner label and the "KEEP IT ALIVE" rail) is hidden
 * on the friendly /how-to onboarding page so it stays purely sunny.
 */
export function FrameShell() {
  const pathname = usePathname();
  const ominous = pathname !== "/how-to";

  return (
    <>
      <div className="wlc-progress-track" aria-hidden>
        <div className="wlc-progress-fill" id="wlc-progress" />
      </div>
      <div className="wlc-grain" aria-hidden />
      <div className="wlc-vignette" aria-hidden />
      <div className="wlc-frame" aria-hidden />
      <div className="wlc-corner wlc-corner-tl" aria-hidden>
        WLC / TESTNET
      </div>
      {ominous && (
        <>
          <div className="wlc-corner wlc-corner-br" aria-hidden>
            {BRAND.supply.toLocaleString("en-US")} &rarr; 1
          </div>
          <div className="wlc-rail" aria-hidden>
            <span className="wlc-rail-dot" />
            <span className="wlc-rail-text">KEEP IT ALIVE</span>
          </div>
        </>
      )}
    </>
  );
}
