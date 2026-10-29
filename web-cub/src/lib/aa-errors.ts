// Pull the LINE THAT MATTERS out of a viem error chain.
//
// Season-1 post-mortem: the care page showed `err.message.slice(0, 160)`, and a
// viem JSON-RPC error's message STARTS with the generic wrapper ("Invalid
// parameters were provided to the RPC method. Double check you have provided
// the correct parameters.") while the actual server verdict ("Sponsorship
// failed: Policy's max count per spender exceeded.") sits in the Details line
// past the cut. Hunt read the generic text back to us for a day; the real
// diagnosis was inside his own error the whole time. Never truncate from the
// front of a viem message again.
//
// viem structure: errors nest via `cause`, each layer may carry `shortMessage`
// (human one-liner) and `details` (the raw server/provider message). The
// deepest `details` is almost always the truth; shortMessage is the fallback.
export function aaErrorDetail(err: unknown): string {
  const seen = new Set<unknown>();
  let details = "";
  let shortMessage = "";
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const c = cur as { details?: unknown; shortMessage?: unknown; cause?: unknown };
    if (typeof c.details === "string" && c.details.trim()) details = c.details.trim();
    if (typeof c.shortMessage === "string" && c.shortMessage.trim()) shortMessage = c.shortMessage.trim();
    cur = c.cause;
  }
  const best =
    details ||
    shortMessage ||
    (err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err ?? {}));
  return best.slice(0, 240);
}
