// Apple Wallet update bookkeeping at the precision each side actually has.
// DB updatedAt carries milliseconds; HTTP dates and our old lastUpdated tags were whole
// seconds. Comparing the two made every check look "changed": Wallet logged "lastUpdated
// tag remained the same" and "Server ignored the if-modified-since header" on every
// refresh, and Apple deprioritizes services that push unchanged passes.

// The lastUpdated tag is opaque to Wallet (it echoes it back as passesUpdatedSince), so it
// carries full milliseconds now.
export function formatUpdatedTag(at: Date): string {
  return String(at.getTime());
}

// Devices registered before this change hold a seconds tag (~1.8e9; a ms tag is ~1.8e12).
// A seconds tag means "seen everything up to the end of that second", which ends the
// refetch loop on the next check instead of matching the same pass forever.
export function parseUpdatedTag(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n < 1e11 ? n * 1000 + 999 : n);
}

// If-Modified-Since is an HTTP date (whole seconds) and Last-Modified is updatedAt cut
// to the second, so compare at the second.
export function notModifiedSince(header: string | undefined, updatedAt: Date): boolean {
  if (!header) return false;
  const since = new Date(header).getTime();
  if (Number.isNaN(since)) return false;
  return since >= Math.floor(updatedAt.getTime() / 1000) * 1000;
}
