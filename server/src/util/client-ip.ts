import type { Request } from "express";

// Real client IP extraction behind a reverse proxy (Render). One helper so the
// policy lives in exactly one place:
//
//   1. PREFER Express's req.ip. With `trust proxy` set to the REAL hop count
//      (config.TRUST_PROXY_HOPS, verify against Render at wire time), req.ip is
//      the address the PLATFORM's proxy appended to x-forwarded-for, which a
//      direct caller cannot choose: prepending fake public IPs to the header
//      does not move it. Used only when it resolves to a public address.
//   2. FALL BACK to the leftmost non-private x-forwarded-for hop (dev, tests,
//      misconfigured hop counts), then the raw socket address.
//
// HONEST LIMIT: the fallback path is client-influenceable, and even the
// attested IP rotates freely behind residential proxy pools. That is why IP
// (and its /24 subnet) is only ever a RATE-LIMIT signal in the anti-Sybil
// gate, never a sole hard-block, and why the real teeth (PoW, atomic email
// reserve) do not depend on it.

const PRIVATE_V4 =
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;

function isPrivate(ip: string): boolean {
  if (PRIVATE_V4.test(ip)) return true;
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower.startsWith("fc") || // fc00::/7 unique local
    lower.startsWith("fd") ||
    lower.startsWith("fe80") // link local
  );
}

function normalize(raw: string): string {
  let ip = raw.trim();
  // Strip IPv4-mapped IPv6 prefix and a :port suffix on plain v4.
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const v4Port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (v4Port) ip = v4Port[1]!;
  return ip;
}

function looksLikeIp(ip: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-fA-F:]+$/.test(ip);
}

/** Real client IP: platform-attested req.ip first, header/socket fallbacks after. */
export function clientIp(req: Request): string {
  // Attested path: req.ip resolved through the bounded trust-proxy hop count.
  const attested = normalize(req.ip ?? "");
  if (attested && looksLikeIp(attested) && !isPrivate(attested)) return attested;
  // Fallback: leftmost non-private x-forwarded-for hop (best-effort only).
  const header = req.headers["x-forwarded-for"];
  const list = Array.isArray(header) ? header.join(",") : (header ?? "");
  for (const part of list.split(",")) {
    const ip = normalize(part);
    if (ip && looksLikeIp(ip) && !isPrivate(ip)) return ip;
  }
  return normalize(req.socket.remoteAddress ?? "unknown");
}

/** Coarse subnet key: /24 for IPv4, /64 (first 4 hextets) for IPv6. */
export function subnetOf(ip: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").slice(0, 3).join(".") + ".0/24";
  }
  if (ip.includes(":")) {
    // Expand "::" enough to take the first 4 hextets stably.
    const parts = ip.split("::");
    const head = (parts[0] ?? "").split(":").filter(Boolean);
    while (head.length < 4) head.push("0");
    return head.slice(0, 4).join(":") + "::/64";
  }
  return ip;
}

/** Rate-limit key for an IP. IPv6 collapses to its /64: one client usually holds a whole /64, so
 *  keying the full address hands it a fresh bucket per address (Nexory, 2026-10-14). IPv4 is unchanged. */
export function rateKey(ip: string): string {
  return ip.includes(":") ? subnetOf(ip) : ip;
}
