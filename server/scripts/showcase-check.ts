/**
 * TESTNET SHOWCASE CHECK
 *
 * Drives the REAL code paths added for the 1,000-mint Testnet Experience against the in-memory store
 * and MockChain (no Postgres, no network):
 *
 *   1. The simulated-fee drip (SHOWCASE_USDG_DRIP): off by default, once per 2h epoch, a failed mint
 *      hands the epoch back, never on mainnet, the swap-rate re-affirm, and one whole fee cycle
 *      (drip -> distribute -> holder vault) through the real runFeeDistribution.
 *   2. The mint budget: a spent hourly budget is refused at checkout with the real wait, and a race
 *      lost after that pre-check is reported to the keeper as the same busy message instead of
 *      "Mint did not complete".
 *   3. /api/chain-config publishes entryDeadline + seasonStart.
 *   4. The boot guard refuses the drip on mainnet and stops calling the drip "no fee source".
 *
 * Run: npx tsx scripts/showcase-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://showcase:showcase@localhost:5432/showcase";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.SHOWCASE_USDG_DRIP = "";
process.env.FEE_SPLITTER_ADDRESS = "";
process.env.HOLDER_VAULT_ADDRESS = "";
process.env.FEE_TOKEN_ADDRESS = "";
process.env.HOLDER_POSTER_PRIVATE_KEY = "";
process.env.TESTER_ALLOWLIST = "";

const { config, evaluateBootGuards } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { runShowcaseUsdgDrip, showcaseDripEpoch, SHOWCASE_DRIP_EPOCH_SECONDS, reaffirmSplitterRate } =
  await import("../src/runner/showcase-drip.js");
const { runFeeDistribution } = await import("../src/runner/tax-rewards.js");
const { mintBusyRetryAfterSec, mintBusyMessage } = await import("../src/runner/mint-budget.js");
const { isMintBudgetExhausted } = await import("../src/chain/robinhood.js");
import type { AppContext } from "../src/context.js";
import type { BootGuardInput } from "../src/config.js";
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
const mock = new MockChain();
const relayer = new Relayer(mock);
const ctx: AppContext = { store, relayer } as unknown as AppContext;

const SPLITTER = "0x5b11775b11775b11775b11775b11775b11775b11";
const FEE_TOKEN = "0xfeefeefeefeefeefeefeefeefeefeefeefeefee0";

// ============================== 1. THE DRIP ==============================
console.log("\n1. simulated-fee drip");
{
  // A FIXED PAST clock, years from the real one: sections 1c and 1d drip on the REAL clock, and a
  // fixed t0 on the day the suite runs made their epoch collide with one reserved here.
  const t0 = Date.UTC(2020, 0, 1, 12, 0, 0);

  const off = await runShowcaseUsdgDrip(ctx, t0);
  check("OFF by default: nothing minted", !off.dripped && off.skipped === "disabled" && mock.showcaseMints.length === 0);

  config.SHOWCASE_USDG_DRIP = true;
  const unwired = await runShowcaseUsdgDrip(ctx, t0);
  check("no splitter / fee token configured: skipped, nothing minted", !unwired.dripped && mock.showcaseMints.length === 0, String(unwired.skipped));

  config.FEE_SPLITTER_ADDRESS = SPLITTER;
  config.FEE_TOKEN_ADDRESS = FEE_TOKEN;
  config.SHOWCASE_USDG_DRIP_AMOUNT = "100";

  const before = await relayer.splitterBalance();
  const first = await runShowcaseUsdgDrip(ctx, t0);
  check("first drip of the epoch mints into the splitter", first.dripped && first.txHash !== null);
  check("amount is SHOWCASE_USDG_DRIP_AMOUNT in raw 6dp units", first.amountRaw === 100_000_000n, first.amountRaw.toString());
  check("the splitter balance rose by exactly that", (await relayer.splitterBalance()) - before === 100_000_000n);
  check("the epoch is the 2h bucket", first.epoch === showcaseDripEpoch(t0) && SHOWCASE_DRIP_EPOCH_SECONDS === 7200);
  const row = store.showcaseDrips.get(`${FEE_TOKEN}:${first.epoch}`);
  check("the ledger row records the tx hash", row?.txHash === first.txHash, JSON.stringify(row));

  const again = await runShowcaseUsdgDrip(ctx, t0 + 30 * 60_000);
  check("same epoch again: NO second mint", !again.dripped && again.skipped === "already dripped this epoch" && mock.showcaseMints.length === 1);

  const next = await runShowcaseUsdgDrip(ctx, t0 + SHOWCASE_DRIP_EPOCH_SECONDS * 1000);
  check("the next epoch drips again", next.dripped && next.epoch === first.epoch! + 1 && mock.showcaseMints.length === 2);

  // A failed mint hands the epoch back so the next cycle retries it.
  const tFail = t0 + 2 * SHOWCASE_DRIP_EPOCH_SECONDS * 1000;
  const realMint = mock.showcaseMintFeeToSplitter.bind(mock);
  mock.showcaseMintFeeToSplitter = async () => {
    throw new Error("rpc down");
  };
  const failed = await runShowcaseUsdgDrip(ctx, tFail);
  mock.showcaseMintFeeToSplitter = realMint;
  check("a failed mint reports it and mints nothing", !failed.dripped && failed.skipped === "mint failed" && mock.showcaseMints.length === 2);
  const retried = await runShowcaseUsdgDrip(ctx, tFail + 60_000);
  check("the SAME epoch is retried and lands on the next cycle", retried.dripped && retried.epoch === failed.epoch && mock.showcaseMints.length === 3);

  config.SHOWCASE_USDG_DRIP_AMOUNT = "not-a-number";
  const bad = await runShowcaseUsdgDrip(ctx, t0 + 3 * SHOWCASE_DRIP_EPOCH_SECONDS * 1000);
  check("an unusable amount mints nothing", !bad.dripped && mock.showcaseMints.length === 3, String(bad.skipped));
  config.SHOWCASE_USDG_DRIP_AMOUNT = "0";
  const zero = await runShowcaseUsdgDrip(ctx, t0 + 3 * SHOWCASE_DRIP_EPOCH_SECONDS * 1000);
  check("amount 0 mints nothing", !zero.dripped && mock.showcaseMints.length === 3);
  config.SHOWCASE_USDG_DRIP_AMOUNT = "100";

  const prevNet = config.ROBINHOOD_NETWORK;
  config.ROBINHOOD_NETWORK = "mainnet";
  const main = await runShowcaseUsdgDrip(ctx, t0 + 4 * SHOWCASE_DRIP_EPOCH_SECONDS * 1000);
  config.ROBINHOOD_NETWORK = prevNet;
  check("never on mainnet, even if the flag slipped past the boot guard", !main.dripped && main.skipped === "mainnet" && mock.showcaseMints.length === 3);
}

// ============================== 1b. SWAP RATE ==============================
console.log("\n1b. splitter swap-rate re-affirm");
{
  const now = Math.floor(Date.now() / 1000);
  const maxAge = 12 * 3600;
  mock.mockSetSplitterRate({ updatedAt: now, maxAge, owner: relayer.address, rate: 10n ** 30n });
  // Section 1 already re-affirmed (its fixed clock is hours past the mock's deploy stamp), so
  // count from here.
  const base = mock.rateReaffirms;
  check("a fresh rate is left alone", !(await reaffirmSplitterRate(ctx, now + 60)) && mock.rateReaffirms === base);

  const aged = now + maxAge / 2 + 60;
  check("past half its life it is re-affirmed", await reaffirmSplitterRate(ctx, aged));
  const st = await relayer.splitterRateState();
  check("with the SAME rate and slippage (never a change of price)", st.rate === 10n ** 30n && st.slippageBps === 300 && mock.rateReaffirms === base + 1);

  mock.mockSetSplitterRate({ updatedAt: now - maxAge, owner: "0x000000000000000000000000000000000000beef" });
  check("not the owner: skipped, never attempted", !(await reaffirmSplitterRate(ctx, now)) && mock.rateReaffirms === base + 1);

  mock.mockSetSplitterRate({ updatedAt: now - maxAge, owner: relayer.address, rate: 0n });
  check("a rate the owner switched OFF (0) is not switched back on", !(await reaffirmSplitterRate(ctx, now)) && mock.rateReaffirms === base + 1);
  mock.mockSetSplitterRate({ rate: 10n ** 30n, updatedAt: now });
}

// ============================== 1c. WHOLE CYCLE ==============================
console.log("\n1c. one full fee cycle: drip -> distribute -> holder vault");
{
  const prevLive = config.modes.holderRewardsLive;
  config.modes.holderRewardsLive = true;
  config.CARE_TOKEN_ADDRESS = "0xca4eca4eca4eca4eca4eca4eca4eca4eca4eca4e";
  config.HOLDER_VAULT_ADDRESS = "0x401de401de401de401de401de401de401de401de";
  // Drain what section 1 left behind so this cycle measures only its own drip.
  if ((await relayer.splitterBalance()) > 0n) await relayer.splitterDistribute();
  const holderBefore = await relayer.holderUnreserved();
  const mintsBefore = mock.showcaseMints.length;

  const res = await runFeeDistribution(ctx);
  const minted = mock.showcaseMints.length - mintsBefore;
  check("the cycle dripped once", minted === 1, `${minted} mints`);
  check("and distributed it in the SAME cycle", res.distributed && (await relayer.splitterBalance()) === 0n);
  check(
    "the holder half reached the holder vault",
    (await relayer.holderUnreserved()) - holderBefore === mock.showcaseMints[mock.showcaseMints.length - 1]! / 2n,
  );

  config.SHOWCASE_USDG_DRIP = false;
  const mintsOff = mock.showcaseMints.length;
  await runFeeDistribution(ctx);
  check("flag off: the same cycle mints nothing (mainnet-shaped path untouched)", mock.showcaseMints.length === mintsOff);
  config.modes.holderRewardsLive = prevLive;
}

// ============================== 1d. THE 2H FEE LEG ==============================
console.log("\n1d. the 2h fee leg (drip + distribute, no round)");
{
  const { runShowcaseFeeLeg } = await import("../src/runner/showcase-drip.js");
  const prevLive = config.modes.holderRewardsLive;
  config.SHOWCASE_USDG_DRIP = true;
  config.modes.holderRewardsLive = true;
  const roundsBefore = await relayer.holderRoundCount();
  const holderBefore = await relayer.holderUnreserved();
  // The fee leg uses the real clock, so start from an epoch section 1c has not already dripped.
  store.showcaseDrips.clear();
  const leg = await runShowcaseFeeLeg(ctx);
  check("the push engine's leg drips AND distributes in one go", leg.dripped && leg.distributed, JSON.stringify(leg));
  check("the holder vault filled this epoch", (await relayer.holderUnreserved()) > holderBefore);
  check("but NO holder round was posted (that stays on the tax cadence)", (await relayer.holderRoundCount()) === roundsBefore);
  const again = await runShowcaseFeeLeg(ctx);
  check("a second run in the same epoch neither drips nor distributes", !again.dripped && !again.distributed, JSON.stringify(again));
  config.SHOWCASE_USDG_DRIP = false;
  const off = await runShowcaseFeeLeg(ctx);
  check("flag off: the leg does nothing", !off.dripped && !off.distributed);
  config.modes.holderRewardsLive = prevLive;
}

// ============================== 1e. CLAIM SIGNER ==============================
console.log("\n1e. holder deliveries can ride the poster's queue");
{
  const realClaim = mock.holderClaim.bind(mock);
  let release: () => void = () => {};
  mock.holderClaim = () =>
    new Promise<{ txHash: string }>((r) => {
      release = () => r({ txHash: "0x01" });
    });
  const a = "0x1111111111111111111111111111111111111111";

  config.HOLDER_CLAIM_SIGNER = "relayer";
  const p1 = relayer.holderClaim(0, a, 1n, []);
  await sleep(10);
  check("default: the relayer queue carries it (mainnet posture unchanged)", relayer.pending === 1 && relayer.posterPending === 0, `${relayer.pending}/${relayer.posterPending}`);
  release();
  await p1;

  config.HOLDER_CLAIM_SIGNER = "poster";
  const p2 = relayer.holderClaim(0, a, 1n, []);
  await sleep(10);
  check("poster: the poster queue carries it and the mint queue stays free", relayer.posterPending === 1 && relayer.pending === 0, `${relayer.pending}/${relayer.posterPending}`);
  release();
  await p2;
  config.HOLDER_CLAIM_SIGNER = "relayer";
  mock.holderClaim = realClaim;
}

// ============================== 2. MINT BUDGET ==============================
console.log("\n2. hourly mint budget");
{
  const now = 1_790_000_000;
  const b = { max: 200, windowSecs: 3600, windowStart: now - 2880, used: 200 };
  check("uncapped (max 0) is never busy", mintBusyRetryAfterSec({ ...b, max: 0 }, now) === null);
  check("under budget is not busy", mintBusyRetryAfterSec({ ...b, used: 199 }, now) === null);
  check("spent budget: the wait is exactly the rest of the window", mintBusyRetryAfterSec(b, now) === 720);
  check("a window that already rolled is fresh, whatever `used` says", mintBusyRetryAfterSec(b, now + 720) === null);
  const msg = mintBusyMessage(b, 720);
  check("the message names the pace and the wait", msg === "Busy hour: the showcase mints 200 an hour, try again in 12 minutes.", msg);
  check("one minute is singular", mintBusyMessage(b, 30).endsWith("try again in 1 minute."));
  check("no em dashes or double hyphens in the keeper-facing text", !/[–—]|--/.test(msg));
  check("the revert is recognised by name", isMintBudgetExhausted(new Error('reverted with the following reason: MintBudgetExhausted()')));
  check("and by raw selector when the ABI has no error defs", isMintBudgetExhausted(new Error("reverted with the following signature: 0xc112cf95")));
  check("other reverts are not mistaken for it", !isMintBudgetExhausted(new Error("EntryWindowClosed()")));
}

const app = createApp(ctx);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
try {
  console.log("\n2b. busy hour at checkout (real handler)");
  {
    const nowSec = Math.floor(Date.now() / 1000);
    mock.mockSetMintBudget({ max: 200, windowSecs: 3600, windowStart: nowSec - 600, used: 200 });
    const res = await fetch(`${base}/api/runner/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "busy-hour@walletchi.test" }),
    });
    const body = (await res.json()) as { error?: string; code?: string; retryAfterSec?: number };
    check("a spent budget is refused with 429 BEFORE anything is minted", res.status === 429 && body.code === "mint_busy", `${res.status} ${JSON.stringify(body)}`);
    check("with the real wait (50 minutes) in the message", body.error === "Busy hour: the showcase mints 200 an hour, try again in 50 minutes.", String(body.error));
    check("and a Retry-After header", Number(res.headers.get("retry-after")) > 2900);
    check("no runner row was created", (await store.countRunners()) === 0);

    // THE RACE: the pre-check read a free budget, the chain then refused. Simulated by blinding the
    // pre-check while the chain's budget is spent.
    const realRead = relayer.mintBudgetState.bind(relayer);
    relayer.mintBudgetState = async () => ({ max: 0, windowSecs: 0, windowStart: 0, used: 0 });
    const raced = (await fetch(`${base}/api/runner/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "race-loser@walletchi.test" }),
    }).then((r) => r.json())) as { id?: string };
    relayer.mintBudgetState = realRead;
    let view: { status?: string; error?: string } = {};
    for (let i = 0; i < 40 && view.status !== "failed"; i++) {
      await sleep(50);
      view = (await fetch(`${base}/api/runner/checkout/${raced.id}`).then((r) => r.json())) as typeof view;
    }
    check("a lost race fails the mint", view.status === "failed", JSON.stringify(view));
    check(
      "and tells the keeper it is a busy hour, not a generic failure",
      typeof view.error === "string" && view.error.startsWith("Busy hour: the showcase mints 200 an hour, try again in "),
      String(view.error),
    );

    // Other failures stay generic: raw revert text must never reach a public endpoint.
    mock.mockSetMintBudget({ max: 0, windowSecs: 0, windowStart: 0, used: 0 });
    // The pre-send simulate is where a raw revert surfaces on the real chain (prepareMint).
    const realPrepare = mock.prepareMint.bind(mock);
    mock.prepareMint = async () => {
      throw new Error("execution reverted: some internal detail 0xdeadbeef");
    };
    const other = (await fetch(`${base}/api/runner/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "other-failure@walletchi.test" }),
    }).then((r) => r.json())) as { id?: string };
    mock.prepareMint = realPrepare;
    let otherView: { status?: string; error?: string } = {};
    for (let i = 0; i < 40 && otherView.status !== "failed"; i++) {
      await sleep(50);
      otherView = (await fetch(`${base}/api/runner/checkout/${other.id}`).then((r) => r.json())) as typeof otherView;
    }
    check("any OTHER failure stays the generic public message", otherView.error === "Mint did not complete. Please try again.", String(otherView.error));

    const ok = await fetch(`${base}/api/runner/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "quiet-hour@walletchi.test" }),
    });
    check("with budget to spare the checkout goes through", ok.status === 200, String(ok.status));
  }

  console.log("\n3. /api/chain-config clock dates");
  {
    const prev = config.modes.survivalLive;
    config.modes.survivalLive = true;
    const cfg = (await fetch(`${base}/api/chain-config`).then((r) => r.json())) as {
      season?: { entryDeadline?: number | null; seasonStart?: number | null; selloutStartsSeason?: boolean };
    };
    config.modes.survivalLive = prev;
    const s = cfg.season;
    check("season.entryDeadline is published", typeof s?.entryDeadline === "number" && s.entryDeadline > 0, JSON.stringify(s));
    check("season.seasonStart is published", typeof s?.seasonStart === "number" && s.seasonStart > 0);
    check("the deadline is after the start (60 days on the mock)", (s?.entryDeadline ?? 0) - (s?.seasonStart ?? 0) === 60 * 86400);
  }
} finally {
  server.close();
}

// ============================== 4. BOOT GUARD ==============================
console.log("\n4. boot guard");
{
  const baseInput: BootGuardInput = {
    NODE_ENV: "production",
    ROBINHOOD_NETWORK: "testnet",
    ANTI_SYBIL_ENABLED: true,
    SYBIL_PEPPER: "a-real-pepper",
    CARE_SESSION_SECRET: "a-care-session-secret-that-is-long-enough-000",
    CARE_LINK_SECRET: "a-care-link-secret-that-is-long-enough-000000",
    SURVIVAL_ENABLED: true,
    REQUIRE_SELF_CUSTODY: false,
    HOLDER_EXCLUDE_ADDRESSES: "0x0000000000000000000000000000000000000001",
    GAS_WEBHOOK_SIGNING_KEY: "k",
    relayerLive: true,
    survivalLive: true,
    holderRewardsLive: true,
    privyLive: true,
    holderPosterConfigured: true,
    holderPosterKeyInvalid: false,
    launchpadHookConfigured: false,
    launchpadPoolIdConfigured: false,
    launchpadPoolIdInvalid: false,
    collectorConfigured: false,
    collectorKeyInvalid: false,
    collectorIsRelayer: false,
    collectorIsPoster: false,
    captchaSecretConfigured: false,
    captchaSiteConfigured: false,
  };
  const noHookMsg = (errs: string[]) => errs.some((e) => e.includes("LAUNCHPAD_HOOK_ADDRESS is unset"));
  const plain = evaluateBootGuards(baseInput);
  check("without the drip, a testnet holder leg with no hook is still called out", noHookMsg(plain.errors));
  const drip = evaluateBootGuards({ ...baseInput, SHOWCASE_USDG_DRIP: true });
  check("with the drip on testnet: no 'nothing feeds the splitter' error, and it boots", !noHookMsg(drip.errors) && drip.fatal === null, String(drip.fatal));
  // A mainnet environment that is otherwise complete, so the drip is the ONLY thing that can refuse.
  const mainnetInput: BootGuardInput = {
    ...baseInput,
    ROBINHOOD_NETWORK: "mainnet",
    REQUIRE_SELF_CUSTODY: true,
    captchaSecretConfigured: true,
    captchaSiteConfigured: true,
  };
  check("control: that mainnet environment boots without the drip", evaluateBootGuards(mainnetInput).fatal === null);
  const mainnet = evaluateBootGuards({ ...mainnetInput, SHOWCASE_USDG_DRIP: true });
  check("the drip on MAINNET refuses to boot", Boolean(mainnet.fatal) && mainnet.fatal!.includes("SHOWCASE_USDG_DRIP"), String(mainnet.fatal));
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
