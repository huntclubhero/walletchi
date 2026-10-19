/**
 * CARE BUDGET ROUTE CHECK (GET /api/pet/:tokenId/care-budget, runner/care-budget-read.ts): the
 * website care page asks this before it signs a care. It must never block a care (unknown pet,
 * unreadable limit, slow read all answer verdict "ok"), it must give the smart-care answer when
 * the window is half used and the tapped need was just served, and it must expose nothing but the
 * public on-chain numbers. Real handlers, in-memory store + MockChain.
 *
 * Run: npx tsx scripts/care-budget-route-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://sg:sg@localhost:5432/sg";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";

const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { _resetPetNeedsCache } = await import("../src/runner/season.js");
const { _resetCareBudgetCache } = await import("../src/runner/care-budget-read.js");
// This check exercises the smart-care verdicts, so it runs with the flag ON (default OFF since 2026-10-18).
const { config: cfg } = await import("../src/config.js");
cfg.SMART_CARE_ENABLED = true;
import type { AppContext } from "../src/context.js";
import type { AddressInfo } from "node:net";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const store = new InMemoryStore();
const chain = new MockChain();
const relayer = new Relayer(chain);
const ctx = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function mint(email: string) {
  const co = (await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }).then((r) => r.json())) as { id: string };
  let runner = await store.getRunner(co.id);
  for (let i = 0; i < 60 && runner?.status !== "ready"; i++) {
    await sleep(25);
    runner = await store.getRunner(co.id);
  }
  return runner!;
}

type Budget = Record<string, unknown> & { verdict?: string };
async function budget(tokenId: string, action?: string): Promise<{ status: number; body: Budget; ms: number; cache: string }> {
  _resetPetNeedsCache();
  _resetCareBudgetCache();
  const t0 = Date.now();
  const r = await fetch(`${base}/api/pet/${tokenId}/care-budget${action ? `?action=${encodeURIComponent(action)}` : ""}`);
  return { status: r.status, body: (await r.json()) as Budget, ms: Date.now() - t0, cache: r.headers.get("cache-control") ?? "" };
}

const KEYS = ["verdict", "stalestAction", "stalestLabel", "stalestSecondsLeft", "caresLeft", "dailyCares", "reopensInSeconds", "lifeSecondsLeft"].sort();
const COST = 10n ** 18n;
const H = 3600;

try {
  const pet = await mint("keeper@walletchi.test");
  const tokenId = pet.tokenId!;
  check("the minted pet has a tokenId and an account", !!tokenId && !!pet.tbaAddress, `${tokenId} ${pet.tbaAddress}`);
  const now = Math.floor(Date.now() / 1000);

  console.log("\nunknown pet");
  const unknown = await budget("999999", "feed");
  check("an unknown pet answers 200 with verdict ok", unknown.status === 200 && unknown.body.verdict === "ok", JSON.stringify(unknown.body));
  check("it is no-store", unknown.cache.includes("no-store"));

  console.log("\nlimit unreadable (no spend state)");
  chain.mockSetPetCare(tokenId, now - 2 * H, 3);
  const open = await budget(tokenId, "feed");
  check("verdict ok", open.status === 200 && open.body.verdict === "ok", JSON.stringify(open.body));
  check("caresLeft, dailyCares and reopensInSeconds are null", open.body.caresLeft === null && open.body.dailyCares === null && open.body.reopensInSeconds === null);
  check("it still says how long the pet has", typeof open.body.lifeSecondsLeft === "number" && (open.body.lifeSecondsLeft as number) > 0);
  check("only the public budget fields are returned", JSON.stringify(Object.keys(open.body).sort()) === JSON.stringify(KEYS), Object.keys(open.body).join(","));
  const bogus = await budget(tokenId, "constructor");
  check("an unknown action is ignored (verdict ok)", bogus.body.verdict === "ok");

  console.log("\nhalf-used window, tapped need just served (the pet No. 0038 pattern)");
  // feed served a minute ago, the other four 20 h ago; 12 of 20 cares spent in a window opened 1 h ago
  for (const i of [0, 1, 2, 3, 4]) chain.mockSetPetNeed(tokenId, i, i === 0 ? now - 60 : now - 20 * H);
  chain.spendStates.set(pet.tbaAddress!.toLowerCase(), { dailyCap: 20n * COST, windowStart: now - H, spentInWindow: 12n * COST });
  const fresh = await budget(tokenId, "feed");
  check('a feed just after a feed is held back (verdict "fresh")', fresh.body.verdict === "fresh", JSON.stringify(fresh.body));
  check("it points at the need running out first (water)", fresh.body.stalestAction === "water" && fresh.body.stalestLabel === "Water");
  check("8 of 20 cares left", fresh.body.caresLeft === 8 && fresh.body.dailyCares === 20);
  const reopen = fresh.body.reopensInSeconds as number;
  check("the window reopens in about 23 h", Math.abs(reopen - 23 * H) <= 5, String(reopen));
  const life = fresh.body.lifeSecondsLeft as number;
  // MockChain's lifeTtl is 3 days (the live vault's is 1 day): oldest need 20 h old leaves 52 h
  check("the pet's life is its OLDEST need's time left (what the card shows)", Math.abs(life - 52 * H) <= 5 && life === fresh.body.stalestSecondsLeft, String(life));
  const water = await budget(tokenId, "water");
  check("a care on the need running out is ok", water.body.verdict === "ok", JSON.stringify(water.body));

  console.log("\nslow chain read never stalls the care page");
  const original = chain.petSpendState.bind(chain);
  chain.petSpendState = () => new Promise(() => {}); // never answers
  const slow = await budget(tokenId, "feed");
  check("a hung spend read still answers verdict ok", slow.body.verdict === "ok" && slow.body.caresLeft === null, JSON.stringify(slow.body));
  check("within 2.5 s", slow.ms < 2_500, `${slow.ms} ms`);
  chain.petSpendState = original;

  console.log("\na lapsed pet");
  chain.mockSetPetCare(tokenId, now - 4 * 86_400, 3);
  const dead = await budget(tokenId, "feed");
  check("a lapsed pet answers verdict ok and leaves the answer to the vault", dead.body.verdict === "ok", JSON.stringify(dead.body));
} finally {
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
