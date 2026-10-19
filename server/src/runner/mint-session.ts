import { randomBytes } from "node:crypto";

// Mint-session tokens let the browser that JUST minted a pet fetch that pet's
// capability pass URL, WITHOUT exposing the URL on any public serial-keyed
// endpoint (which would reopen the confused-deputy drain the pass-URL fix
// closed). The token is:
//   - returned ONLY in the POST /api/runner/checkout response (to the minter),
//     never in the serial-keyed poll/state views;
//   - random (192-bit), so it cannot be guessed;
//   - bound to the exact serial it was issued for;
//   - short-lived (a mint session), pruned on issue;
//   - bound to the pet's pass secret AT ISSUE: reusable within the TTL (a minter whose first fetch
//     failed can retry), but dead the moment the authToken rotates. Otherwise a pet minted, sold and
//     claimed within the TTL would hand the minter the BUYER's fresh links (Nexory, 2026-10-15).
// A pet's serial is generated server-side at mint, so an attacker can never
// obtain a token for someone else's pet: minting always makes a fresh pet.

const TTL_MS = 30 * 60 * 1000; // 30 minutes: long enough to finish minting + click.

interface Entry {
  serial: string;
  authToken: string;
  expiresAt: number;
}

const sessions = new Map<string, Entry>();

function prune(now: number): void {
  for (const [token, entry] of sessions) {
    if (entry.expiresAt <= now) sessions.delete(token);
  }
}

/** Issue a fresh mint-session token bound to `serial` and its current `authToken`. */
export function issueMintSession(serial: string, authToken: string): { mintSession: string; expiresAt: string } {
  const now = Date.now();
  prune(now);
  const token = randomBytes(24).toString("hex");
  const expiresAt = now + TTL_MS;
  sessions.set(token, { serial, authToken, expiresAt });
  return { mintSession: token, expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * True when `token` is a live mint-session for exactly `serial` and the pet still carries the
 * authToken it was issued under. Reusable within TTL; a rotation ends it for good.
 */
export function resolveMintSession(token: string | undefined, serial: string, authToken: string): boolean {
  if (!token) return false;
  const entry = sessions.get(token);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  if (entry.serial !== serial) return false;
  if (entry.authToken !== authToken) {
    sessions.delete(token);
    return false;
  }
  return true;
}
