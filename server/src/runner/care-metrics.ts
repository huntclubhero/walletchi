// In-memory care-engagement counters by wallet source (the src tag on care
// links: apple / google / untagged). Answers "did Android care recover after
// the wallet fix?" straight from /internal/status, no log spelunking. Resets
// on restart by design: this is a testing-season pulse, not analytics.

export interface CareSourceCounts {
  opened: number; // GET: the interstitial was served
  performed: number; // POST: the care actually ran
}

const bySrc = new Map<string, CareSourceCounts>();
let since = new Date().toISOString();

// The `src` tag rides the care link as a QUERY PARAM, so it is caller-controlled.
// Fold anything we did not emit ourselves into one bucket: an unbounded key space
// on a caller-supplied string is a slow memory leak, and the counters only exist
// to answer "apple vs google vs neither". The `session:` prefix marks a silent
// pass-tap care (no website, no signature) as opposed to an owner-signed one.
const KNOWN_SRC = new Set(["apple", "google", "untagged", "livefire"]);

function normalize(src: string): string {
  const silent = src.startsWith("session:");
  const raw = silent ? src.slice("session:".length) : src;
  const tag = KNOWN_SRC.has(raw) ? raw : "other";
  return silent ? `session:${tag}` : tag;
}

function bucket(src: string): CareSourceCounts {
  const key = normalize(src);
  let b = bySrc.get(key);
  if (!b) {
    b = { opened: 0, performed: 0 };
    bySrc.set(key, b);
  }
  return b;
}

export function recordCareOpened(src: string): void {
  bucket(src).opened += 1;
}

export function recordCarePerformed(src: string): void {
  bucket(src).performed += 1;
}

export function getCareMetrics(): { since: string; bySrc: Record<string, CareSourceCounts> } {
  return { since, bySrc: Object.fromEntries(bySrc) };
}

/** Test hook. */
export function _resetCareMetrics(): void {
  bySrc.clear();
  since = new Date().toISOString();
}
