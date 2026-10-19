// The ALIVE headcount is on-chain or absent, never a placeholder (Hunt 2026-10-09:
// "make sure the alive count is real and onchain verified not some made up number
// ever"). Pure: a fake relayer stands in for the vault.
import { onchainAliveTally, headcountVerified, HEADCOUNT_MAX_AGE_MS, survivorLine, type SeasonSnapshot } from "../src/runner/season.js";
import type { AppContext } from "../src/context.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` | ${detail}`}`);
}

type St = { registered: boolean; dead: boolean } | "throw";
function ctxWith(states: Record<number, St>): AppContext {
  return {
    relayer: {
      async petState(id: string) {
        const st = states[Number(id)] ?? { registered: false, dead: false };
        if (st === "throw") throw new Error("rpc down");
        return { registered: st.registered, dead: st.dead, lastCareAt: 0, isAlive: !st.dead, secondsLeft: 0 };
      },
    },
  } as unknown as AppContext;
}
async function throws(p: Promise<unknown>): Promise<boolean> {
  try { await p; return false; } catch { return true; }
}

// Today's chain (read 2026-10-09): 12 registered, 1..10 dead, 11 + 12 alive.
const today: Record<number, St> = {};
for (let i = 1; i <= 12; i++) today[i] = { registered: true, dead: i <= 10 };
check("tally matches the chain: 2 alive of 12", (await onchainAliveTally(ctxWith(today), 12)) === 2);
check("tally of an empty season is 0", (await onchainAliveTally(ctxWith({}), 0)) === 0);

const flaky = { ...today, 11: "throw" as const };
check("a failed petState read fails the whole tally (never counted alive)", await throws(onchainAliveTally(ctxWith(flaky), 12)));
const gap = { ...today, 7: { registered: false, dead: false } };
check("an unregistered id inside 1..registeredCount fails the tally", await throws(onchainAliveTally(ctxWith(gap), 12)));
const big: Record<number, St> = {};
for (let i = 1; i <= 45; i++) big[i] = { registered: true, dead: i % 3 === 0 };
check("batched reads cover every id (45 pets, 15 dead)", (await onchainAliveTally(ctxWith(big), 45)) === 30);

const now = Date.now();
const snap = (o: Partial<SeasonSnapshot>): SeasonSnapshot => ({
  aliveCount: 2, registered: 12, hatched: 12, total: 1000, potRaw: 0n, burnedRaw: 0n,
  careTokenDecimals: 18, seasonActive: true, fetchedAt: now, verified: true, verifiedAt: now, ...o,
});
check("fresh verified snapshot shows", headcountVerified(snap({}), now));
check("unverified snapshot hides", !headcountVerified(snap({ verified: false }), now));
check("inactive season hides", !headcountVerified(snap({ seasonActive: false }), now));
check("a verified count older than the max age hides", !headcountVerified(snap({ verifiedAt: now - HEADCOUNT_MAX_AGE_MS - 1 }), now));
check("at boot the pass has NO alive line (was '1,000 / 1,000')", survivorLine() === null, String(survivorLine()));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
