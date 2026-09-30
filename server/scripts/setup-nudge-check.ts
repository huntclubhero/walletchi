/**
 * UNARMED-PASS NUDGE CHECK (runner/setup-nudge.ts): a pet minted a while ago whose one-tap care
 * never armed must say "Tap any action to finish setup" on its pass, on both platforms, and must
 * stop saying it once armed. Real handlers, in-memory store + MockChain.
 *
 * Run: npx tsx scripts/setup-nudge-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://sn:sn@localhost:5432/sn";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.PETVAULT_ADDRESS = "0x2222222222222222222222222222222222222222";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { needsSetupNudge, setupNudgeFor, SETUP_NUDGE_COPY } = await import("../src/runner/setup-nudge.js");
const { assembleRunnerPass, runnerPassDownloadUrl } = await import("../src/runner/pass.js");
const { getRunnerGoogle } = await import("../src/runner/google.js");
const AdmZip = (await import("adm-zip")).default;
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
const mock = new MockChain();
const relayer = new Relayer(mock);
const ctx = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.PUBLIC_BASE_URL = base;
(config as { PUBLIC_BASE_URL: string }).PUBLIC_BASE_URL = base;

const KEEPER = "0x9a7b06e1cb5b25bd9555ec366458b3d63f982d0a";

try {
  // A self-custody pet (owner = the keeper, not the relayer), minted through the real checkout.
  const co = (await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pretzel@walletchi.test" }),
  }).then((r) => r.json())) as { id: string };
  let runner = await store.getRunner(co.id);
  for (let i = 0; i < 60 && runner?.status !== "ready"; i++) {
    await sleep(25);
    runner = await store.getRunner(co.id);
  }
  runner = await store.updateRunner(co.id, { ownerAddress: KEEPER });
  const minutesAgo = (m: number) => new Date(runner!.createdAt.getTime() + m * 60_000);

  config.modes.silentCareLive = true;
  const rule = (now: Date, session: Parameters<typeof needsSetupNudge>[1] = null, r = runner!) =>
    needsSetupNudge(r, session, { now, relayerAddress: relayer.address, graceMinutes: 10 });

  console.log("\nthe rule");
  check("unarmed, 11 minutes after mint: nudge", rule(minutesAgo(11)));
  check("unarmed, 5 minutes after mint (mint-time arming may still be running): no nudge", !rule(minutesAgo(5)));
  const active = {
    serial: runner!.serial, tokenId: runner!.tokenId!, ownerAddress: KEEPER, vaultAddress: config.PETVAULT_ADDRESS!,
    publicKey: "0x1", secretEnc: "x", context: "0x", expiresAt: minutesAgo(60 * 24 * 30),
    revokedAt: null, revokedReason: null, lastUsedAt: null, useCount: 0, createdAt: new Date(), updatedAt: new Date(),
  };
  check("armed (an active session): no nudge", !rule(minutesAgo(11), active));
  check("an EXPIRED session counts as unarmed: nudge", rule(minutesAgo(60 * 24 * 31), active));
  check("a revoked session counts as unarmed: nudge", rule(minutesAgo(11), { ...active, revokedAt: new Date() }));
  check("a custodial pet (held by the relayer) can never arm: no nudge", !rule(minutesAgo(11), null, { ...runner!, ownerAddress: relayer.address }));
  check("a memorial: no nudge", !rule(minutesAgo(11), null, { ...runner!, gone: true }));
  check("the champion: no nudge", !rule(minutesAgo(11), null, { ...runner!, won: true }));
  config.modes.silentCareLive = false;
  check("a deployment without silent care: no nudge", !rule(minutesAgo(11)));
  config.modes.silentCareLive = true;

  console.log("\nthe Apple pass");
  const withNudge = await assembleRunnerPass(runner!, { setupNudge: true });
  const back = (withNudge.passJson as { storeCard?: { backFields?: Array<{ key: string; value: string }> } }).storeCard?.backFields ?? [];
  check("the FINISH SETUP field is the FIRST back field", back[0]?.key === "setup" && back[0]?.value === SETUP_NUDGE_COPY.value, back[0]?.key);
  check("it says to tap any action", SETUP_NUDGE_COPY.value.startsWith("Tap any action to finish setup"));
  check("no em dashes or double hyphens in the copy", !/[–—]|--/.test(SETUP_NUDGE_COPY.value + SETUP_NUDGE_COPY.label));
  const without = await assembleRunnerPass(runner!, {});
  const back2 = (without.passJson as { storeCard?: { backFields?: Array<{ key: string }> } }).storeCard?.backFields ?? [];
  check("without the flag the field is absent", !back2.some((f) => f.key === "setup"));

  console.log("\nthe Google object");
  const google = getRunnerGoogle() as unknown as { loyaltyObject: (...a: unknown[]) => { textModulesData: Array<{ id: string; body: string }> } };
  const gObj = google.loyaltyObject(runner!, null, null, null, true);
  check("the setup module is the FIRST text module", gObj.textModulesData[0]?.id === "setup" && gObj.textModulesData[0]?.body === SETUP_NUDGE_COPY.value);
  const gObj2 = google.loyaltyObject(runner!, null, null, null, false);
  check("without the flag the module is absent", !gObj2.textModulesData.some((m) => m.id === "setup"));

  console.log("\nthe served pass (route level)");
  config.SETUP_NUDGE_MINUTES = 0; // this pet was minted milliseconds ago
  const url = runnerPassDownloadUrl(runner!.serial, runner!.authToken);
  const readBack = async () => {
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const pass = JSON.parse(new AdmZip(buf).readAsText("pass.json")) as { storeCard?: { backFields?: Array<{ key: string }> } };
    return pass.storeCard?.backFields ?? [];
  };
  check("setupNudgeFor reads the store: unarmed pet -> true", await setupNudgeFor(ctx, runner!));
  const served = await readBack();
  check("the downloaded .pkpass carries FINISH SETUP first", served[0]?.key === "setup", served[0]?.key);
  await store.putCareSession({
    serial: runner!.serial, tokenId: runner!.tokenId!, ownerAddress: KEEPER, vaultAddress: config.PETVAULT_ADDRESS!,
    publicKey: "0x1", secretEnc: "x", context: "0x", expiresAt: new Date(Date.now() + 86_400_000),
  });
  check("once a session is installed setupNudgeFor is false", !(await setupNudgeFor(ctx, runner!)));
  const armed = await readBack();
  check("and the next served .pkpass no longer carries it", !armed.some((f) => f.key === "setup"));
} finally {
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
