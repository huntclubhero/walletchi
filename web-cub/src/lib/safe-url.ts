/**
 * Only let an https: (or wallet-pass) URL reach an href or src.
 *
 * NOT an XSS fix: React 19 blocks javascript: URLs in production, and this app has no HTML sink.
 * The gap this closes is different. Every "Add to Apple Wallet" button, pass link and image URL on
 * this site comes straight out of API JSON. If that API is ever compromised or simply buggy, it can
 * point a button carrying OUR branding, on OUR origin, at any destination it likes. That is a
 * phishing pivot with our credibility attached, and it costs one function to remove.
 *
 * Returns undefined for anything it does not recognise, so a caller can render nothing rather than
 * render a link somewhere unexpected.
 */
const SAFE_PROTOCOLS = new Set(["https:", "web+walletchi:"]);

export function safeUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  // Relative paths stay on this origin, so they cannot be a cross-origin pivot.
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const u = new URL(value);
    return SAFE_PROTOCOLS.has(u.protocol) ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}
