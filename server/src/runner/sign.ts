import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

// Card Play action + fork links are HMAC-signed with a key derived from the pass
// authToken (a secret unique to each card), so only the links embedded in the
// owner's pass validate. A truncated hex tag is plenty for a per-card,
// cooldown-limited action.

// WHY THE LINKS ARE NOT KEYED ON THE authToken DIRECTLY.
//
// The care link is a bearer capability that SPENDS: whoever holds it can make the
// server feed that pet, and force-feeding drains the pet's stake. The authToken
// also lives in the Runner table. Keying the links straight off it meant a
// READ-ONLY database leak was full capability theft: an attacker with a DB dump
// alone could mint a valid `?s=` for every pet, POST the public care endpoint, and
// drive our own server as an oracle to drain the whole collection. They would never
// need a private key or any write access, and encryption at rest would not help,
// because the capability is what spends, not the key.
//
// Peppering with a server-only secret splits those two facts apart. The DB now
// yields nothing on its own, and the env secret yields nothing on its own; forging
// a link needs BOTH, which is already full compromise. Rotation still works for
// free, because the pepper is applied over the authToken and a claim rotates that.
//
// Unset (dev, smoke) it falls back to the raw token, which is byte-identical to the
// old behaviour so nothing local changes. Set it in any deployment that can spend.
function linkKey(authToken: string): string {
  const pepper = config.CARE_LINK_SECRET;
  if (!pepper) return authToken;
  return createHmac("sha256", pepper).update(authToken).digest("hex");
}

export function signTag(authToken: string, payload: string): string {
  return createHmac("sha256", linkKey(authToken)).update(payload).digest("hex").slice(0, 24);
}

export function verifyTag(authToken: string, payload: string, sig: unknown): boolean {
  if (typeof sig !== "string" || sig.length !== 24) return false;
  const expected = signTag(authToken, payload);
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Pass-download capability: the .pkpass EMBEDS the already-signed care links, so
// downloading it must require a secret whenever real-value care is possible. The
// capability is derived from the per-pet authToken (never the raw token itself:
// that stays the Apple web-service auth header) so it rotates automatically when
// a secondary-market claim rotates the token. Derived at request time: no schema
// change, no migration. 64 hex chars (256 bits).
const PASS_DOWNLOAD_CONTEXT = "pkpass-download-v1";

export function passDownloadCap(authToken: string): string {
  // Same reasoning as signTag: with a DB dump alone an attacker could otherwise
  // download every pet's .pkpass, which embeds that pet's already-signed care links.
  return createHmac("sha256", linkKey(authToken)).update(PASS_DOWNLOAD_CONTEXT).digest("hex");
}

export function verifyPassDownloadCap(authToken: string, cap: unknown): boolean {
  if (typeof cap !== "string" || cap.length !== 64) return false;
  const expected = passDownloadCap(authToken);
  try {
    return timingSafeEqual(Buffer.from(cap), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function actionPayload(serial: string, action: string): string {
  return `${serial}:action:${action}`;
}

// The CHI VALLEY pass link (runner/valley.ts). Same key as the care links, so it dies on a claim
// and on "Reset my pass links".
export function valleyPayload(serial: string): string {
  return `${serial}:valley`;
}

// The CHI CHAT pass link (runner/chat.ts): the tap that opens the room. Same key, so it dies on a
// claim and on "Reset my pass links".
export function chatPayload(serial: string): string {
  return `${serial}:chat`;
}

// The CHI CHAT room cookie the tap sets. A DIFFERENT payload from the link's, so the cookie value
// cannot be turned back into a pass link, and the same key, so a claim or reset signs everyone out.
export function chatSessionPayload(serial: string): string {
  return `${serial}:chat-session`;
}

export function forkPayload(serial: string, forkId: string, choice: string): string {
  return `${serial}:fork:${forkId}:${choice}`;
}
