// Round-2 review probe, kept as a permanent check (npm run release-seat:createdat-probe): what does
// lookupPrivyUserProfile make of every createdAt shape, and does the route's age floor
// (ageMs = createdAt ? now - createdAt : -1; refuse when ageMs < minAgeMs) hold for all of them?
// Only a real creation time 21 minutes ago may pass. Exits 1 on any bypass.
process.env.NODE_ENV ??= "test"; process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://rs:rs@localhost:5432/rs";
process.env.PRIVY_APP_ID = ""; process.env.PRIVY_APP_SECRET = "";
const { config } = await import("../src/config.js");
const { _setPrivyClientForTests, lookupPrivyUserProfile } = await import("../src/services/privy.js");
config.modes.privyLive = true;
const minAgeMs = 20 * 60_000;
const cases: [string, unknown][] = [
  ["undefined (field absent)", undefined], ["null", null], ["empty string", ""], ["string 0", "0"], ["number 0", 0],
  ["string abc", "abc"], ["Invalid Date", new Date("x")], ["ISO 5 min ago", new Date(Date.now() - 5 * 60_000).toISOString()],
  ["Date 5 min ago", new Date(Date.now() - 5 * 60_000)], ["epoch seconds 5 min ago", Math.floor((Date.now() - 5 * 60_000) / 1000)],
  ["epoch ms string 5 min ago", String(Date.now() - 5 * 60_000)], ["future (clock skew +10 min)", new Date(Date.now() + 10 * 60_000)],
  ["Date 21 min ago", new Date(Date.now() - 21 * 60_000)], ["negative number", -5], ["NaN", NaN], ["boolean true", true],
];
let leaks = 0;
for (const [name, raw] of cases) {
  _setPrivyClientForTests({
    verifyAuthToken: async () => ({ userId: "u" }),
    getUser: async () => ({ email: { address: "x@example.com" }, createdAt: raw as never, linkedAccounts: [] }),
  });
  const p = await lookupPrivyUserProfile("u");
  const createdAt = p.ok ? p.createdAt : null;
  const ageMs = createdAt ? Date.now() - createdAt.getTime() : -1;
  const verdict = ageMs < minAgeMs ? "too_young (kept)" : "PASSES FLOOR";
  const shouldPass = name === "Date 21 min ago";
  if (verdict === "PASSES FLOOR" && !shouldPass) leaks += 1;
  console.log(`${verdict.padEnd(18)} ${name.padEnd(30)} parsed=${createdAt ? createdAt.toISOString() : "null"}`);
}
_setPrivyClientForTests(null);
console.log(`\nfloor bypasses by a malformed createdAt: ${leaks}`);
process.exit(leaks === 0 ? 0 : 1);
