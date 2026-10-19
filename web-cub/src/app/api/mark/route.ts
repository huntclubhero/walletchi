import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

// DEVICE MARK (one Chi per phone, 2026-10-18). A random first-party cookie per browser,
// set by THIS site (playwalletchi.com on Vercel) so Safari keeps it for about a year;
// a cookie set by the API host would be capped at seven days by ITP. The value is random,
// never derived from the device, so two neighbours on the same phone model can never
// collide the way the fingerprint did. HttpOnly: page scripts cannot read it, so the
// mint form asks this route for it and sends it with the checkout, where the API gate
// stores only a peppered hash. No mark is never a refusal.
export const dynamic = "force-dynamic";

const COOKIE = "wchi_mark";
const MAX_AGE = 400 * 24 * 3600; // Chrome's cap; Safari honours ~400 days for first-party set via HTTP
const RE = /^[0-9a-f]{32,64}$/;

export async function GET(req: Request) {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const existing = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(COOKIE + "="))
    ?.slice(COOKIE.length + 1);
  const mark = existing && RE.test(existing) ? existing : randomBytes(32).toString("hex");
  const res = NextResponse.json({ mark }, { headers: { "cache-control": "no-store" } });
  // Re-set every time: refreshes the expiry so an active keeper's mark never lapses.
  res.cookies.set(COOKIE, mark, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
  return res;
}
