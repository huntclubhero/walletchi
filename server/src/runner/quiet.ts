import { config } from "../config.js";

// Quiet hours: the pet sleeps, needs pause, and NON-URGENT pushes are suppressed.
// Shared by the idle engine and the pet needs layer so neither imports the other.
//
// The fade warning deliberately does NOT consult this gate (see reflectSurvival):
// the quiet window is 9h and the fade window is 6h, so gating the warning here
// let a pet burn its entire save window against a muted channel and die without
// ever pinging. Quiet hours govern FLAVOUR, not survival.

// Hour-of-day (0..23) as it reads in `tz`. `Date#getHours` resolves in SERVER
// local time, which is UTC in a container with no TZ set, so the configured
// window silently applied to the wrong nine hours of the keeper's day. Resolving
// against an explicit zone makes 23:00-08:00 mean 23:00-08:00 where the keepers
// are. Never throws: a runtime with no ICU data for the zone falls back to
// server local rather than taking the whole idle engine down with it.
function hourInZone(d: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(d);
    const raw = parts.find((p) => p.type === "hour")?.value;
    const h = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    // h23 yields 0..23, but guard the modulo anyway: some ICU builds emit "24"
    // for midnight under h24, and an out-of-range hour would skew the window.
    return Number.isFinite(h) ? ((h % 24) + 24) % 24 : d.getHours();
  } catch {
    return d.getHours();
  }
}

// Exported so boot validation can prove the configured zone actually resolves on
// this runtime instead of silently degrading to UTC for the life of the process.
export function quietZoneResolves(tz: string = config.QUIET_TZ): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(
      new Date(),
    );
    return true;
  } catch {
    return false;
  }
}

export function isQuietHour(d: Date): boolean {
  const h = hourInZone(d, config.QUIET_TZ);
  const start = config.IDLE_QUIET_START_HOUR;
  const end = config.IDLE_QUIET_END_HOUR;
  // The window may wrap midnight (e.g. 23..8).
  return start <= end ? h >= start && h < end : h >= start || h < end;
}
