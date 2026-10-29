/*
 * BOOT SAFETY CHECK (manual, not part of `npm run smoke`).
 *
 * Simulates real deployment environments by setting process.env and then importing the REAL
 * config.ts and sybil.ts, which is where the boot guards actually run. The point is to answer one
 * question with evidence rather than reasoning: does the CURRENTLY DEPLOYED production
 * environment still boot after the guard hardening?
 *
 * Each case runs in its own child process because config is built once per process at import.
 *
 *   npx tsx scripts/boot-guard-check.ts
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Today's Render production environment, as verified for the security hardening pass.
// GAS_WEBHOOK_SIGNING_KEY and HOLDER_EXCLUDE_ADDRESSES are deliberately absent: they could not be
// verified against the live dashboard, so the guards for them must NOT be fatal here.
const TODAY: Record<string, string> = {
  NODE_ENV: "production",
  ROBINHOOD_NETWORK: "testnet",
  SURVIVAL_ENABLED: "true",
  ANTI_SYBIL_ENABLED: "true",
  SYBIL_PEPPER: "f".repeat(64),
  TESTER_ALLOWLIST: "tester.one@gmail.com,tester.two@gmail.com",
  REQUIRE_SELF_CUSTODY: "true",
  PRIVY_APP_ID: "privy-app-id",
  PRIVY_APP_SECRET: "privy-app-secret",
  DEMO_BYPASS_PAYMENT: "true",
  INTERNAL_STATUS_TOKEN: "internal-status-token",
  CARE_LINK_SECRET: "a-real-care-link-pepper-value",
  CARE_SESSION_SECRET: "a-real-care-session-secret-at-least-32-chars",
  RELAYER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  RUNNER_ISSUER_ADDRESS: "0x1352fE5e29C6e4D513B83cf0eeAD8bCaD2EC5566",
  PETVAULT_ADDRESS: "0xD424f97C0d78bCb29ccc651C75581c68e4642550",
  CARE_TOKEN_ADDRESS: "0x4f1fe5BF3B41A9a1598552FFbe42297ec7075AbC",
  // The tax-economy leg, which the live season runs with. It was missing here, so holderRewardsLive
  // was false in every simulated case and neither the exclusions guard nor the poster guard could
  // ever have fired: the simulation was quietly softer than the deployment it claims to model.
  FEE_SPLITTER_ADDRESS: "0x1573C7cd25aC802D93A0658acDfe6fF06cc33E98",
  HOLDER_VAULT_ADDRESS: "0x9236FdCbFe8ADDe4bAD63e534a8970a5b0bb0871",
  FEE_TOKEN_ADDRESS: "0x43aB1DE041dc9a69c8074BA6b7eAFb67eaeC61aB",
  // The DEDICATED holder-round poster key (mainnet blocker B2), now set in the live environment.
  // A throwaway well-known test key: this simulation only ever derives its ADDRESS.
  HOLDER_POSTER_PRIVATE_KEY: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  // LAUNCHPAD_HOOK_ADDRESS / LAUNCHPAD_POOL_ID / CARE_FEE_COLLECTOR_PRIVATE_KEY are deliberately
  // ABSENT here, because that is the truth on the live deployment: CARE has not launched, so the
  // hook address (which only exists in our own launch receipt) cannot be known yet. The inlet
  // guards must therefore be LOUD BUT NON-FATAL, and the cases below are what pin that.
  DATABASE_URL: "postgres://x:x@localhost:5432/x",
  LOG_LEVEL: "warn",
};

interface Case {
  name: string;
  env: Record<string, string | undefined>;
  expect: "boots" | "refuses";
}

const cases: Case[] = [
  { name: "TODAY'S PRODUCTION ENV (NODE_ENV=production, testnet, real-value care, allowlist non-empty)", env: TODAY, expect: "boots" },
  // The structural fix: the same real-value deployment with NODE_ENV lost or misspelled must
  // still be guarded, and must still boot because it is otherwise correctly configured.
  { name: "today's env with NODE_ENV UNSET (guards must still apply, still boots)", env: { ...TODAY, NODE_ENV: undefined }, expect: "boots" },
  { name: "today's env with NODE_ENV misspelled 'Production'", env: { ...TODAY, NODE_ENV: "Production" }, expect: "boots" },
  // Each value guard must now bite even with NODE_ENV wrong. These used to boot happily.
  { name: "NODE_ENV unset + real value + CARE_LINK_SECRET missing", env: { ...TODAY, NODE_ENV: undefined, CARE_LINK_SECRET: undefined }, expect: "refuses" },
  { name: "NODE_ENV unset + real value + ANTI_SYBIL_ENABLED off", env: { ...TODAY, NODE_ENV: undefined, ANTI_SYBIL_ENABLED: "false" }, expect: "refuses" },
  { name: "NODE_ENV unset + real value + dev SYBIL_PEPPER", env: { ...TODAY, NODE_ENV: undefined, SYBIL_PEPPER: "dev-sybil-pepper-change-me" }, expect: "refuses" },
  { name: "NODE_ENV unset + real value + no relayer (MockChain fallback)", env: { ...TODAY, NODE_ENV: undefined, RELAYER_PRIVATE_KEY: undefined }, expect: "refuses" },
  // TESTER_ALLOWLIST: the whole point of the item-4 design. Testnet keeps booting, mainnet does not.
  { name: "TESTER_ALLOWLIST non-empty on TESTNET real-value season (must still boot)", env: TODAY, expect: "boots" },
  { name: "TESTER_ALLOWLIST non-empty on MAINNET", env: { ...TODAY, ROBINHOOD_NETWORK: "mainnet" }, expect: "refuses" },
  // Same, but with every config.ts mainnet guard satisfied, so the ONLY thing left to refuse is
  // the sybil.ts allowlist guard itself. Without this case the refusal above proves only that
  // something upstream threw first.
  {
    name: "MAINNET, all config guards satisfied, ONLY TESTER_ALLOWLIST non-empty (sybil.ts must refuse)",
    env: { ...TODAY, ROBINHOOD_NETWORK: "mainnet", GAS_WEBHOOK_SIGNING_KEY: "k", HOLDER_EXCLUDE_ADDRESSES: "0xpool" },
    expect: "refuses",
  },
  { name: "MAINNET with an empty allowlist but no self-custody", env: { ...TODAY, ROBINHOOD_NETWORK: "mainnet", TESTER_ALLOWLIST: undefined, REQUIRE_SELF_CUSTODY: "false" }, expect: "refuses" },
  { name: "MAINNET fully configured (allowlist empty, self-custody on, webhook key set, exclusions set)", env: { ...TODAY, ROBINHOOD_NETWORK: "mainnet", TESTER_ALLOWLIST: undefined, GAS_WEBHOOK_SIGNING_KEY: "k", HOLDER_EXCLUDE_ADDRESSES: "0xpool" }, expect: "boots" },
  // HOLDER ROUND POSTER KEY (mainnet blocker B2). The vault gates postRound on a dedicated poster
  // key, so a missing one means the airdrop leg posts nothing. It is deliberately LOUD BUT NEVER
  // FATAL, because refusing would take mint, care, passes and claims down over a rewards-leg
  // misconfiguration that loses nothing while it waits. These two cases are what pin that choice:
  // if either ever flips to "refuses", a poster key typo becomes a total outage.
  { name: "today's env WITHOUT the holder poster key (posting dark, must still boot)", env: { ...TODAY, HOLDER_POSTER_PRIVATE_KEY: undefined }, expect: "boots" },
  { name: "today's env with an UNUSABLE holder poster key (must still boot)", env: { ...TODAY, HOLDER_POSTER_PRIVATE_KEY: "not-a-private-key" }, expect: "boots" },
  {
    name: "MAINNET fully configured but MISSING the holder poster key (loud, still boots)",
    env: { ...TODAY, ROBINHOOD_NETWORK: "mainnet", TESTER_ALLOWLIST: undefined, GAS_WEBHOOK_SIGNING_KEY: "k", HOLDER_EXCLUDE_ADDRESSES: "0xpool", HOLDER_POSTER_PRIVATE_KEY: undefined },
    expect: "boots",
  },
  // LAUNCHPAD CREATOR-FEE INLET. The splitter is the DESTINATION of the trade tax, not its source:
  // the fee accrues to a creator seat inside the launchpad hook and a COLLECTOR has to pull it.
  // With no inlet the splitter receives nothing while every downstream leg reports success, so the
  // guards are loud. They are deliberately NEVER FATAL, for two reasons: the hook address does not
  // exist until we launch the pool (so a fatal guard would make the correct launch ORDER
  // impossible), and nothing is lost while it waits (the fee keeps accruing to the seat and a later
  // claim collects the whole backlog). If any of these four ever flips to "refuses", bringing the
  // server up before the token launches becomes impossible.
  { name: "today's env with NO creator-fee inlet configured (loud, still boots)", env: TODAY, expect: "boots" },
  {
    name: "MAINNET fully configured but MISSING the creator-fee inlet (loud, still boots)",
    env: { ...TODAY, ROBINHOOD_NETWORK: "mainnet", TESTER_ALLOWLIST: undefined, GAS_WEBHOOK_SIGNING_KEY: "k", HOLDER_EXCLUDE_ADDRESSES: "0xpool" },
    expect: "boots",
  },
  {
    // The worst partial state: a hook address READS as configured while nothing can claim from it.
    name: "hook address set but NO collector key (inlet dark, loud, still boots)",
    env: { ...TODAY, LAUNCHPAD_HOOK_ADDRESS: "0x4040404040404040404040404040404040404040", LAUNCHPAD_POOL_ID: `0x${"ab".repeat(32)}` },
    expect: "boots",
  },
  {
    // A malformed pool id is downgraded to unset rather than sent to the chain. Still boots.
    name: "hook address set but a MALFORMED pool id (ignored, loud, still boots)",
    env: {
      ...TODAY,
      LAUNCHPAD_HOOK_ADDRESS: "0x4040404040404040404040404040404040404040",
      LAUNCHPAD_POOL_ID: "0xnot-a-pool-id",
      CARE_FEE_COLLECTOR_PRIVATE_KEY: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    },
    expect: "boots",
  },
  {
    // COLLECTOR == RELAYER. Whoever holds the creator seat can reassign it permanently, so sharing
    // it with the hot mint key means one leak costs the entire trade-tax stream. Loud, and still
    // not fatal: by boot time the seat is already assigned on-chain, so refusing to start cannot
    // unassign it and the fix (hook.updateCreator) needs this process running.
    name: "collector key IS the relayer key (loud, still boots)",
    env: {
      ...TODAY,
      LAUNCHPAD_HOOK_ADDRESS: "0x4040404040404040404040404040404040404040",
      LAUNCHPAD_POOL_ID: `0x${"ab".repeat(32)}`,
      CARE_FEE_COLLECTOR_PRIVATE_KEY: TODAY.RELAYER_PRIVATE_KEY!,
    },
    expect: "boots",
  },
  {
    // The fully-armed inlet: this is the shape launch day should produce.
    name: "creator-fee inlet FULLY configured with a dedicated collector key (boots)",
    env: {
      ...TODAY,
      LAUNCHPAD_HOOK_ADDRESS: "0x4040404040404040404040404040404040404040",
      LAUNCHPAD_POOL_ID: `0x${"ab".repeat(32)}`,
      CARE_FEE_COLLECTOR_PRIVATE_KEY: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    },
    expect: "boots",
  },
  // A plain dev box must stay frictionless.
  // Turnstile captcha (STEP 8C): armed only on the full pair. A half pair is a
  // LOUD boot error, never fatal (the captcha simply stays off), and the full
  // pair must not disturb an otherwise-green boot.
  { name: "captcha SECRET only (half pair: loud, captcha off, still boots)", env: { ...TODAY, TURNSTILE_SECRET_KEY: "ts-secret" }, expect: "boots" },
  { name: "captcha SITE KEY only (half pair: loud, captcha off, still boots)", env: { ...TODAY, TURNSTILE_SITE_KEY: "ts-site" }, expect: "boots" },
  { name: "captcha FULL pair (armed, boots)", env: { ...TODAY, TURNSTILE_SECRET_KEY: "ts-secret", TURNSTILE_SITE_KEY: "ts-site" }, expect: "boots" },
  { name: "plain dev box (no NODE_ENV, no survival, testnet)", env: { NODE_ENV: undefined, ROBINHOOD_NETWORK: "testnet", DATABASE_URL: TODAY.DATABASE_URL!, LOG_LEVEL: "warn" }, expect: "boots" },
];

// The child: import the real modules where the guards live, then report. Written to a real .ts
// file rather than passed via --eval, because tsx compiles --eval as CJS and rejects top-level
// await. Importing sybil.js pulls config.js in as a dependency, so one child covers both.
const selfDir = fileURLToPath(new URL(".", import.meta.url));
const childPath = join(selfDir, "__boot-guard-child.ts");
writeFileSync(
  childPath,
  'import "../src/config.js";\nimport "../src/runner/sybil.js";\nconsole.log("BOOT_OK");\n',
);

// Every config key this simulation controls. Cleared from the inherited env so the developer's
// own shell cannot leak a value into a case that is meant to be missing.
const CONTROLLED = new Set([
  ...Object.keys(TODAY),
  "GAS_WEBHOOK_SIGNING_KEY",
  "HOLDER_EXCLUDE_ADDRESSES",
  // Explicitly controlled even though TODAY sets it, so a case that clears it really does run
  // without a poster key instead of inheriting the developer's own.
  "HOLDER_POSTER_PRIVATE_KEY",
  // The creator-fee inlet, controlled for the OPPOSITE reason: TODAY deliberately leaves these
  // unset, so a developer's .env holding a real hook address or collector key would quietly make
  // every "inlet is dark" case run against a configured inlet and prove nothing.
  "LAUNCHPAD_HOOK_ADDRESS",
  "LAUNCHPAD_POOL_ID",
  "CARE_FEE_COLLECTOR_PRIVATE_KEY",
  "LAUNCHPAD_HOOK_CREATOR_FN",
  "LAUNCHPAD_HOOK_CLAIM_FN",
  // Cleared for the same reason: it selects the CLAIM PATH (claim-to-splitter when set, which is the
  // default, claim-then-forward when empty), so a developer's .env must not decide which path the
  // simulated boots exercise.
  "LAUNCHPAD_HOOK_CLAIM_TO_FN",
  "LAUNCHPAD_MIN_FORWARD_RAW",
]);

let pass = 0;
let fail = 0;
try {
for (const c of cases) {
  // Inherit the real env (npx needs PATH, SystemRoot, APPDATA and friends on Windows), then
  // strip every key this harness controls before applying the case.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !CONTROLLED.has(k)) env[k] = v;
  }
  for (const [k, v] of Object.entries(c.env)) if (v !== undefined) env[k] = v;

  // cwd is scripts/, so `dotenv/config` looks for scripts/.env (which does not exist) instead
  // of server/.env. That keeps the real deployment file out of the simulation.
  const r = spawnSync("npx", ["tsx", childPath], { env, encoding: "utf8", shell: true, cwd: selfDir });
  const out = `${r.stdout}${r.stderr}`;
  const booted = out.includes("BOOT_OK");
  const ok = c.expect === "boots" ? booted : !booted;
  if (ok) {
    pass++;
    console.log(`  PASS  [${c.expect}] ${c.name}`);
    const guardLine = out.split("\n").find((l) => l.includes("[BOOT GUARD]"));
    if (guardLine) console.log(`          warned: ${guardLine.trim().slice(0, 150)}`);
    if (!booted) {
      const refusal = out.split("\n").find((l) => l.includes("Refusing to boot"));
      if (refusal) console.log(`          refused: ${refusal.trim().slice(0, 150)}`);
    }
  } else {
    fail++;
    console.log(`  FAIL  [expected ${c.expect}] ${c.name}`);
    console.log(out.split("\n").slice(0, 12).map((l) => `          ${l}`).join("\n"));
  }
}
} finally {
  rmSync(childPath, { force: true });
}
console.log(`\nBOOT GUARD RESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
