/**
 * ONE-TAP ARMING CHECK: drives the real armOneTap orchestration (src/lib/arming.ts) against fake
 * dependencies, one property per case. No chain, no Privy, no network.
 *
 * Run (web-cub has no test runner; the server's tsx is used):
 *   ../server/node_modules/.bin/tsx scripts/arming-check.mts
 */
import { armOnce, armOneTap, type ArmDeps, type ArmStage } from "../src/lib/arming";

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passes += 1;
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const OWNER = "0x9a7b06e1cb5b25bd9555ec366458b3d63f982d0a";
const DELEGATE_ERR = new Error("refusing to sign a 7702 authorization to an unexpected delegate 0x77021100bd87b7008e5e1989d0eb38555d0d0000");

type Calls = { feed: number; bootstrap: number; grant: number; slept: number; reports: Array<[ArmStage, string]> };

function fake(over: Partial<ArmDeps> = {}): { deps: ArmDeps; calls: Calls } {
  const calls: Calls = { feed: 0, bootstrap: 0, grant: 0, slept: 0, reports: [] };
  const deps: ArmDeps = {
    status: async () => ({ supported: true, active: false }),
    accessToken: async () => "privy-token",
    ownerOnChain: async () => OWNER,
    hatchedOnChain: async () => false,
    isDelegated: async () => false,
    feed: async () => {
      calls.feed += 1;
    },
    bootstrap: async () => {
      calls.bootstrap += 1;
      return true;
    },
    grantAndInstall: async () => {
      calls.grant += 1;
      return true;
    },
    report: (stage, detail) => {
      calls.reports.push([stage, detail]);
    },
    sleep: async (ms) => {
      calls.slept += ms;
    },
    ...over,
  };
  // Wrap overridden counters so every case counts calls the same way.
  const wrapped: ArmDeps = {
    ...deps,
    feed: over.feed
      ? async () => {
          calls.feed += 1;
          return over.feed!();
        }
      : deps.feed,
    bootstrap: over.bootstrap
      ? async () => {
          calls.bootstrap += 1;
          return over.bootstrap!();
        }
      : deps.bootstrap,
    grantAndInstall: over.grantAndInstall
      ? async (t) => {
          calls.grant += 1;
          return over.grantAndInstall!(t);
        }
      : deps.grantAndInstall,
  };
  return { deps: wrapped, calls };
}

console.log("\nmint mode");
{
  const { deps, calls } = fake();
  const r = await armOneTap(deps, { mode: "mint", owner: OWNER.toUpperCase().replace("0X", "0x") });
  check("happy path: one feed (hatch + delegation), then the grant; no bootstrap", r.armed && calls.feed === 1 && calls.bootstrap === 0 && calls.grant === 1, JSON.stringify(r));
  check("and nothing is reported", calls.reports.length === 0);
}
{
  let reads = 0;
  const { deps, calls } = fake({ ownerOnChain: async () => (++reads < 3 ? null : OWNER) });
  const r = await armOneTap(deps, { mode: "mint", owner: OWNER });
  check("the pet not yet visible right after mint: waits, then arms", r.armed && calls.slept === 2000 && calls.feed === 1, `slept ${calls.slept}`);
}
{
  const { deps, calls } = fake({ ownerOnChain: async () => null });
  const r = await armOneTap(deps, { mode: "mint", owner: OWNER, visibleTimeoutMs: 5000 });
  check("never visible: gives up after the timeout, reports not-visible, signs nothing", !r.armed && r.stage === "not-visible" && calls.feed === 0 && calls.reports[0]?.[0] === "not-visible");
}
{
  // PRETZEL'S EXACT FAILURE: every feed dies in our own signer. Must still ARM via the no-hatch path.
  const { deps, calls } = fake({ feed: async () => { throw DELEGATE_ERR; } });
  const r = await armOneTap(deps, { mode: "mint", owner: OWNER });
  check("feed refused 3x (the unexpected-delegate case): falls back to the bootstrap and ARMS", r.armed && calls.feed === 3 && calls.bootstrap === 1 && calls.grant === 1, JSON.stringify(r));
  check("and the feed failure is REPORTED with the real reason", calls.reports.length === 1 && calls.reports[0]![0] === "feed" && calls.reports[0]![1].includes("unexpected delegate"), JSON.stringify(calls.reports));
  check("with backoff between attempts (2s then 4s)", calls.slept === 6000, `slept ${calls.slept}`);
}
{
  let hatchReads = 0;
  const { deps, calls } = fake({
    feed: async () => { throw new Error("status read timed out"); },
    hatchedOnChain: async () => ++hatchReads >= 2, // the first feed DID land
  });
  const r = await armOneTap(deps, { mode: "mint", owner: OWNER });
  check("a feed whose status read failed but that landed is NEVER sent twice", r.armed && calls.feed === 1 && calls.bootstrap === 0, `feeds ${calls.feed}`);
}

console.log("\nsign-in mode (care page, /me)");
{
  const { deps, calls } = fake({ isDelegated: async () => false });
  const r = await armOneTap(deps, { mode: "signin", owner: OWNER });
  check("undelegated: bootstrap then grant, and it NEVER feeds (no hatch, no clock)", r.armed && calls.feed === 0 && calls.bootstrap === 1 && calls.grant === 1);
}
{
  const { deps, calls } = fake({ isDelegated: async () => true });
  const r = await armOneTap(deps, { mode: "signin", owner: OWNER });
  check("already delegated: grant only, no sponsored op at all", r.armed && calls.feed === 0 && calls.bootstrap === 0 && calls.grant === 1);
}
{
  let grants = 0;
  const { deps, calls } = fake({
    isDelegated: async () => null,
    grantAndInstall: async () => {
      if (++grants === 1) throw new Error("account is not delegated");
      return true;
    },
  });
  const r = await armOneTap(deps, { mode: "signin", owner: OWNER });
  check("unknown delegation: free grant first, bootstrap once on refusal, grant again", r.armed && calls.bootstrap === 1 && calls.grant === 2);
}
{
  const { deps, calls } = fake({ isDelegated: async () => true, grantAndInstall: async () => { throw new Error("createSession refused"); } });
  const r = await armOneTap(deps, { mode: "signin", owner: OWNER });
  check("a CONFIRMED-delegated wallet never gets a second sponsored op when the grant fails", !r.armed && r.stage === "grant" && calls.bootstrap === 0);
  check("and the grant failure is reported", calls.reports[0]?.[0] === "grant" && calls.reports[0]![1].includes("createSession refused"));
}
{
  const { deps, calls } = fake({ bootstrap: async () => false });
  const r = await armOneTap(deps, { mode: "signin", owner: OWNER });
  check("bootstrap did not land: reported, and no grant is attempted", !r.armed && r.stage === "bootstrap" && calls.grant === 0 && calls.reports[0]?.[0] === "bootstrap");
}
{
  const { deps, calls } = fake({ grantAndInstall: async () => false });
  const r = await armOneTap(deps, { mode: "signin", owner: OWNER });
  check("server did not activate the session: reported as install", !r.armed && r.stage === "install" && calls.reports[0]?.[0] === "install");
}
{
  const { deps, calls } = fake({ ownerOnChain: async () => "0x000000000000000000000000000000000000beef" });
  const r = await armOneTap(deps, { mode: "signin", owner: OWNER });
  check("a signed-in wallet that is not the owner signs nothing", !r.armed && r.stage === "not-owner" && calls.bootstrap === 0 && calls.grant === 0);
}

console.log("\nno-op cases");
{
  const { deps, calls } = fake({ status: async () => ({ supported: true, active: true }) });
  const r = await armOneTap(deps, { mode: "mint", owner: OWNER });
  check("already armed: nothing is signed or sent", r.armed && r.stage === "already" && calls.feed + calls.bootstrap + calls.grant === 0);
}
{
  const { deps, calls } = fake({ status: async () => ({ supported: false, active: false }) });
  const r = await armOneTap(deps, { mode: "mint", owner: OWNER });
  check("deployment without silent care: nothing is attempted or reported", !r.armed && r.stage === "unsupported" && calls.feed === 0 && calls.reports.length === 0);
}
{
  const { deps, calls } = fake({ accessToken: async () => null });
  const r = await armOneTap(deps, { mode: "signin", owner: OWNER });
  check("no Privy token: reported, nothing signed", !r.armed && r.stage === "no-token" && calls.bootstrap === 0 && calls.reports[0]?.[0] === "no-token");
}

console.log("\none run per pet across callers (armOnce)");
{
  let runs = 0;
  let release: () => void = () => {};
  const run = () =>
    new Promise<{ armed: boolean; stage: ArmStage }>((resolve) => {
      runs += 1;
      release = () => resolve({ armed: true, stage: "armed" });
    });
  const a = armOnce("2", run);
  const b = armOnce("2", run); // the chrome's self-heal and the care page, same second
  const c = armOnce("3", async () => ({ armed: true, stage: "armed" as ArmStage }));
  release();
  const [ra, rb] = await Promise.all([a, b, c]);
  check("two callers for the same pet share ONE run and its result", runs === 1 && ra.armed && rb.armed && ra === rb);
  const d = await armOnce("2", async () => ({ armed: false, stage: "grant" as ArmStage }));
  check("once it settles, a later call runs fresh", d.stage === "grant");
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
