/*
 * WALLETCHI smoke test.
 *
 * Exercises the real request handlers end to end with an in-memory Store and a
 * MockChain relayer (no Postgres, no network). Production wires PrismaStore +
 * viem via src/index.ts; this proves the pet mint -> care -> season -> claim
 * state machine, the Apple web service protocol, the anti-Sybil gate, and pass
 * generation (unsigned stub). Prints PASS/FAIL per step and exits nonzero on
 * any failure.
 */

// Env MUST be set before importing anything that builds config.
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "warn";
process.env.DATABASE_URL ??= "postgres://smoke:smoke@localhost:5432/smoke";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
// Hermetic Privy: real creds in server/.env would flip privyLive on and make
// every checkout demand a live network-verified token. Smoke always runs the
// stub posture (same as the email / pass / Google stubs above). Empty string,
// not delete: dotenv fills deleted vars back in from .env but never overrides
// an existing value, and privyLive needs both to be truthy.
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
// PIN the contract wiring this suite assumes, rather than inheriting whatever the developer's .env
// happens to hold. These are `=` and not `??=` on purpose: two scenarios below assert the OFF state
// of the rewards leg, so simply having REWARDS_DISTRIBUTOR_ADDRESS set locally turned them red while
// nothing about the code had changed. A suite whose result depends on the machine it runs on is
// worse than no suite, because it trains you to explain failures away.
process.env.REWARDS_DISTRIBUTOR_ADDRESS = "";
process.env.PETVAULT_ADDRESS = "";
process.env.CARE_TOKEN_ADDRESS = "";
// Tax economy pins, same reasoning: checks below assert the DARK state of the
// holder pipeline, so a developer's .env must not flip holderRewardsLive on.
process.env.FEE_SPLITTER_ADDRESS = "";
process.env.HOLDER_VAULT_ADDRESS = "";
process.env.FEE_TOKEN_ADDRESS = "";
// Same reasoning for the DEDICATED holder-round poster key: a developer's .env holding a real one
// would derive a poster address at import time and quietly change the posture the poster/clamp
// section drives by hand.
process.env.HOLDER_POSTER_PRIVATE_KEY = "";
// The /internal routes 404 without this, and holder-round health is published there: the whole
// point of the observability fix is that this failure mode can be READ, so the suite reads it.
process.env.INTERNAL_STATUS_TOKEN ??= "smoke-internal-status-token";
// Silent care seals its session keys at rest; a test-only secret lets the smoke
// exercise the seal + the session gate without touching a real deployment key.
process.env.CARE_SESSION_SECRET ??= "smoke-only-care-session-secret-not-a-real-key";
// The tester allowlist is read ONCE at sybil.ts import, so it cannot be flipped at
// runtime the way the other anti-Sybil knobs are. Pin one address here so the
// supply-wall section can prove the bypass is now BOUNDED rather than unlimited.
// Deliberately an address no other section uses, so nothing else changes posture.
process.env.TESTER_ALLOWLIST = "smoke.allowlisted.tester@gmail.com";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { reconcilePet, reconcileOnChainCare, careHatchedThePet } = await import("../src/runner/idle.js");
const { runFinalizePoke, finalizeWatcherArmedFor } = await import("../src/runner/settlement.js");
const { runRewardsPush, runSettlementTail } = await import("../src/runner/push-rewards.js");
const { runDramaPoll, _resetDramaState, milestonesCrossed } = await import("../src/runner/deathwatch.js");
const { getSeasonSnapshot } = await import("../src/runner/season.js");
const { traitsFor, traitAttributes, TOTAL_BASE_COMBOS } = await import("../src/runner/traits.js");
const { stageFor, petVisualFor } = await import("../src/runner/stage.js");
const { signTag, actionPayload, passDownloadCap } = await import("../src/runner/sign.js");
const { moodFor, minNeedSecondsLeft, survivesShort } = await import("../src/runner/needs.js");
const { STATUS_THEMES } = await import("../src/runner/theme.js");
const { _resetClaimState } = await import("../src/runner/claim.js");
const { privateKeyToAccount } = await import("viem/accounts");
import type { AppContext } from "../src/context.js";
import type { AddressInfo } from "node:net";

let passCount = 0;
let failCount = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passCount++;
    console.log(`  PASS  ${name}`);
  } else {
    failCount++;
    console.log(`  FAIL  ${name} ${detail ? "| " + detail : ""}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const store = new (InMemoryStore as any)();
  const relayer = new (Relayer as any)(new (MockChain as any)());
  const ctx: AppContext = { store, relayer };

  const app = createApp(ctx);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const j = (r: Response) => r.json() as Promise<any>;

  console.log(`\nWALLETCHI smoke test (in-memory store + MockChain) on ${base}\n`);

  // Traits v2 now defaults ON in config, but the pre-v2-block sections assert the
  // v1 render + attribute counts, so pin the flag OFF here (the v2 block below
  // explicitly toggles it on/off and restores). Tests must not depend on a flag's
  // default value.
  config.TRAITS_V2_ENABLED = false;

  try {
    // 1. Health
    const health = await fetch(`${base}/health`).then(j);
    check("health responds ok", health.status === "ok", JSON.stringify(health));
    check(
      "public /health does NOT leak the mode matrix",
      health.modes === undefined && health.relayer === undefined,
      JSON.stringify(health),
    );

    // ==================== WALLETCHI pet mint ====================

    // 16. Runner checkout (email-only, DEMO_BYPASS gated, custodial mint).
    const runnerCheckout = await fetch(`${base}/api/runner/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "runner-buyer@walletchi.test" }),
    }).then(j);
    check("runner checkout returns id", Boolean(runnerCheckout.id), JSON.stringify(runnerCheckout));
    check("runner checkout bypass true", runnerCheckout.bypass === true, String(runnerCheckout.bypass));
    const rSerial: string = runnerCheckout.serial;

    let rStatus: any = null;
    for (let i = 0; i < 40; i++) {
      rStatus = await fetch(`${base}/api/runner/checkout/${rSerial}`).then(j);
      if (rStatus.status === "ready" || rStatus.status === "failed") break;
      await sleep(50);
    }
    check("runner reaches ready", rStatus?.status === "ready", JSON.stringify(rStatus));
    check("runner minted with tokenId", Boolean(rStatus?.tokenId), JSON.stringify({ tokenId: rStatus?.tokenId }));
    check("runner owner is the relayer (custodial)", rStatus?.ownerAddress === relayer.address, `${rStatus?.ownerAddress} vs ${relayer.address}`);
    check("status view flags an email-only pet custodial:true", rStatus?.custodial === true, String(rStatus?.custodial));
    const rTokenId: string = rStatus?.tokenId;

    // 17. Runner state starts as a fresh unhatched egg with full needs.
    const rState0 = await fetch(`${base}/api/runner/${rSerial}`).then(j);
    check("runner state is a fresh egg (needs full, unhatched)", rState0.hunger === 100 && rState0.thirst === 100 && rState0.joy === 100 && rState0.hatched === false, JSON.stringify({ h: rState0.hunger, t: rState0.thirst, j: rState0.joy, hatched: rState0.hatched }));
    check("runner state carries the buyer email is NOT leaked (state has no email)", rState0.email === undefined, "");
    check("runner card email stored on row", (await store.getRunner(rSerial))?.email === "runner-buyer@walletchi.test", "");

    // 18. ERC-721 metadata: WALLETCHI pet, image-only (no animation_url).
    const meta = await fetch(`${base}/metadata/runner/${rTokenId}`).then(j);
    // The NFT is named after the PET, not its serial. The number is preserved in the
    // parenthetical (and as a trait below) so collectors keep it.
    const { petName } = await import("../src/runner/names.js");
    check(
      "metadata name is the pet's own name, with the number kept",
      meta.name === `${petName(rTokenId)} (WALLETCHI #${rTokenId})`,
      meta.name,
    );
    // The old version of this asserted petName(id) !== petName(id + 1), which CANNOT FAIL: the
    // affine map is injective mod SPACE, so adjacent ids differ by construction. It read like a
    // uniqueness proof and proved nothing, while the commit claimed "2,000 ids, zero collisions"
    // with no test anywhere that checked it. Prove the actual claim instead, exhaustively.
    const { NAME_SPACE } = await import("../src/runner/names.js");
    const cap = config.RUNNER_SUPPLY_CAP;
    const everyName = Array.from({ length: cap }, (_, i) => petName(i + 1));
    check(
      `every one of the ${cap} pets in the supply has a DISTINCT name`,
      new Set(everyName).size === cap,
      `${new Set(everyName).size} distinct out of ${cap}`,
    );
    check(
      "the supply fits inside the name space (a supply raise cannot silently break uniqueness)",
      cap <= NAME_SPACE,
      `cap ${cap} vs space ${NAME_SPACE}`,
    );
    check(
      "the pet name is deterministic from tokenId (recomputable without us)",
      petName(rTokenId) === petName(rTokenId) && petName(rTokenId) === everyName[Number(rTokenId) - 1],
      `${petName(rTokenId)}`,
    );
    check(
      "a fractional or junk tokenId degrades to the placeholder, never a broken name",
      petName("1.5") === "A WALLETCHI" && petName("abc") === "A WALLETCHI" && !petName("1.5").includes("undefined"),
      `petName("1.5") = ${petName("1.5")}`,
    );
    check(
      "no pet is named after the racialized pun that shipped in the first name table",
      !everyName.includes("Miso Honey"),
      everyName.filter((n) => n === "Miso Honey").join(","),
    );
    check(
      "Name is a filterable trait",
      meta.attributes?.some((a: any) => a.trait_type === "Name" && a.value === petName(rTokenId)),
      JSON.stringify(meta.attributes?.find((a: any) => a.trait_type === "Name")),
    );
    check("metadata drops animation_url (game retired)", meta.animation_url === undefined, JSON.stringify({ a: meta.animation_url }));
    // 5 state attrs + 8 generative traits + 5 live-status attrs (Name / Status /
    // Days Lived / Care Count / Care Balance; Life Left appears only when the
    // survival vault is live).
    check("metadata has 5 state + 8 traits + 5 live-status attributes (18)", Array.isArray(meta.attributes) && meta.attributes.length === 18, JSON.stringify(meta.attributes?.length));
    check("metadata exposes generative trait attributes (Body + Rarity)", meta.attributes?.some((a: any) => a.trait_type === "Body") && meta.attributes?.some((a: any) => a.trait_type === "Rarity"), JSON.stringify(meta.attributes?.map((a: any) => a.trait_type)));
    check("metadata carries the pet's Care Balance as a numeric stat", meta.attributes?.some((a: any) => a.trait_type === "Care Balance" && a.display_type === "number" && typeof a.value === "number"), JSON.stringify(meta.attributes?.find((a: any) => a.trait_type === "Care Balance")));
    check("numeric attrs use display_type number (marketplace range filters)", meta.attributes?.some((a: any) => a.trait_type === "Care Count" && a.display_type === "number"), "");
    // 18b2. Collection-level metadata (the ERC-7572 contractURI target).
    const coll = await fetch(`${base}/api/collection.json`).then(j);
    check("collection.json serves name + image + external_link", coll.name === "WALLETCHI" && typeof coll.image === "string" && typeof coll.external_link === "string", JSON.stringify(coll));

    // 18c. Public per-tokenId square portrait (pre-mint safe) + serial-keyed variant.
    const portraitById = await fetch(`${base}/api/pet/87/preview.png`);
    const portraitBuf = Buffer.from(await portraitById.arrayBuffer());
    check("public tokenId portrait renders PNG", portraitById.status === 200 && portraitBuf.subarray(1, 4).toString() === "PNG", `status ${portraitById.status}`);
    const portraitBySerial = await fetch(`${base}/api/runner/${rSerial}/portrait.png`);
    check("serial portrait renders PNG", portraitBySerial.status === 200 && Buffer.from(await portraitBySerial.arrayBuffer()).subarray(1, 4).toString() === "PNG", `status ${portraitBySerial.status}`);

    // 18b. The retired game endpoints are REMOVED (hard 404s).
    check("game route removed (404)", (await fetch(`${base}/game/${rSerial}`)).status === 404, "");
    check("run session route removed (404)", (await fetch(`${base}/api/runner/${rSerial}/session`, { method: "POST" })).status === 404, "");
    const runGone = await fetch(`${base}/api/runner/${rSerial}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runToken: "x", score: 1, salmon: 0 }) });
    check("record run route removed (404)", runGone.status === 404, `status ${runGone.status}`);
    const msGone = await fetch(`${base}/api/runner/${rSerial}/milestone`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runToken: "x", distance: 1, salmon: 0 }) });
    check("milestone route removed (404)", msGone.status === 404, `status ${msGone.status}`);
    check("fork route removed (404)", (await fetch(`${base}/api/runner/${rSerial}/fork/a?s=deadbeefdeadbeefdeadbeef`)).status === 404, "");

    // 20. Runner card PNG + downloadable pass (unsigned stub).
    const rCardPng = await fetch(`${base}/api/runner/${rSerial}/card.png`);
    const rCardBuf = Buffer.from(await rCardPng.arrayBuffer());
    check("runner card png renders", rCardBuf.subarray(1, 4).toString() === "PNG", rCardBuf.subarray(0, 8).toString("hex"));
    // 20b. The WIDE Google hero render. Google's heroImage slot is roughly 3:1
    // (its guidance is 1032x336) and it used to be fed the SQUARE card, so Android
    // drew a stretched, cropped pet. Dimensions come straight out of the PNG IHDR
    // (bytes 16..24), so this fails the moment the shape drifts back.
    const pngSize = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
    const rHeroPng = await fetch(`${base}/api/runner/${rSerial}/hero.png`);
    const rHeroBuf = Buffer.from(await rHeroPng.arrayBuffer());
    const heroSize = pngSize(rHeroBuf);
    check(
      "runner hero png renders as image/png",
      rHeroPng.status === 200 &&
        rHeroBuf.subarray(1, 4).toString() === "PNG" &&
        (rHeroPng.headers.get("content-type") ?? "").includes("image/png"),
      `status ${rHeroPng.status} ct ${rHeroPng.headers.get("content-type")}`,
    );
    check(
      "hero png is Google's wide hero shape (2064x672, exactly 2x 1032x336)",
      heroSize.w === 2064 && heroSize.h === 672 && Math.abs(heroSize.w / heroSize.h - 1032 / 336) < 0.01,
      JSON.stringify(heroSize),
    );
    check(
      "the square card render is UNCHANGED at 1080x1080 (Apple strip + NFT image key on it)",
      pngSize(rCardBuf).w === 1080 && pngSize(rCardBuf).h === 1080,
      JSON.stringify(pngSize(rCardBuf)),
    );
    check("hero.png 404s for an unknown serial", (await fetch(`${base}/api/runner/no-such-serial/hero.png`)).status === 404, "");
    // The loyalty object has to POINT at that wide render, and its v= cache-buster
    // has to keep moving: Google caches heroImage BY URL, so a frozen v would
    // serve the same art forever.
    const { getRunnerGoogle: googleForHero } = await import("../src/runner/google.js");
    const heroRow = await store.getRunner(rSerial);
    const heroUri = (googleForHero() as any).loyaltyObject(heroRow).heroImage.sourceUri.uri as string;
    const heroUriMoved = (googleForHero() as any).loyaltyObject({ ...heroRow, toys: (heroRow.toys ?? 0) + 1 })
      .heroImage.sourceUri.uri as string;
    check(
      "google heroImage points at the WIDE hero render, never the square card",
      heroUri.includes(`/api/runner/${rSerial}/hero.png?v=`) && !heroUri.includes("card.png"),
      heroUri,
    );
    check(
      "google hero URL keeps a moving art cache-buster (no frozen Android art)",
      /\/hero\.png\?v=[0-9a-f]{10}$/.test(heroUri) && heroUri !== heroUriMoved,
      `${heroUri} vs ${heroUriMoved}`,
    );
    const rPass = await fetch(`${base}/runner-passes/${rSerial}.pkpass`);
    const rPassBuf = Buffer.from(await rPass.arrayBuffer());
    check("runner pkpass content-type", (rPass.headers.get("content-type") ?? "").includes("application/vnd.apple.pkpass"), "");
    check("runner pkpass is a zip (PK header)", rPassBuf.subarray(0, 2).toString() === "PK", rPassBuf.subarray(0, 2).toString("hex"));
    check("runner pkpass flagged unsigned stub", rPass.headers.get("x-walletchi-pass") === "unsigned-stub");

    // 27. Runner Apple web service (separate mount /runner-apple/v1).
    const rRow = await store.getRunner(rSerial);
    const rAuth = rRow.authToken as string;
    const rReg = await fetch(
      `${base}/runner-apple/v1/devices/dev-runner-1/registrations/${config.PASS_TYPE_ID}/${rSerial}`,
      { method: "POST", headers: { authorization: `ApplePass ${rAuth}`, "content-type": "application/json" }, body: JSON.stringify({ pushToken: "runner-push-1" }) },
    );
    check("runner device registration 201", rReg.status === 201, `status ${rReg.status}`);
    const rRegBad = await fetch(
      `${base}/runner-apple/v1/devices/dev-runner-1/registrations/${config.PASS_TYPE_ID}/${rSerial}`,
      { method: "POST", headers: { authorization: "ApplePass wrong", "content-type": "application/json" }, body: "{}" },
    );
    check("runner device registration bad auth 401", rRegBad.status === 401, `status ${rRegBad.status}`);
    const rSerials = await fetch(`${base}/runner-apple/v1/devices/dev-runner-1/registrations/${config.PASS_TYPE_ID}`).then(j);
    check("runner web service lists the serial", rSerials.serialNumbers?.includes(rSerial), JSON.stringify(rSerials));
    const rWsPass = await fetch(`${base}/runner-apple/v1/passes/${config.PASS_TYPE_ID}/${rSerial}`, { headers: { authorization: `ApplePass ${rAuth}` } });
    check("runner web service returns a pass", rWsPass.status === 200, `status ${rWsPass.status}`);

    // 28. Runner checkout guard + validation.
    config.DEMO_BYPASS_PAYMENT = false;
    const rGuard = await fetch(`${base}/api/runner/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nope@walletchi.test" }),
    });
    config.DEMO_BYPASS_PAYMENT = true;
    check("runner checkout rejected 400 when bypass off", rGuard.status === 400, `status ${rGuard.status}`);
    const rBadEmail = await fetch(`${base}/api/runner/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    check("runner checkout invalid email rejected 400", rBadEmail.status === 400, `status ${rBadEmail.status}`);

    // ================== IDLE PET layer (fake clock, forced rolls) ==================
    // Deterministic config for idle reconciliation.
    config.IDLE_ENABLED = true;
    config.IDLE_MAX_PUSHES_PER_HOUR = 2;
    config.IDLE_QUIET_START_HOUR = 23;
    config.IDLE_QUIET_END_HOUR = 8;
    config.IDLE_MAX_CATCHUP_TICKS = 16;
    const forceFlavor = () => 0.1; // r < 0.35 -> a pet-flavor line
    const resetIdle = (patch: any) =>
      store.updateRunner(rSerial, {
        lastEvent: null,
        lastPushAt: null,
        pendingDigest: 0,
        ...patch,
      });

    // 29. A daytime tick narrates gentle pet flavor and advances the clock.
    config.IDLE_TICK_MINUTES = 10;
    const noon = new Date(2026, 6, 26, 12, 0, 0);
    await resetIdle({ lastTickAt: new Date(noon.getTime() - 10 * 60000) });
    const preIdle = (await store.getRunner(rSerial))!;
    const idleA = await reconcilePet(ctx, preIdle, { now: noon, rng: forceFlavor });
    check("idle tick narrates pet flavor", Boolean(idleA.lastEvent) && /pet/i.test(idleA.lastEvent!), String(idleA.lastEvent));
    check("idle tick never mints salmon (game removed)", idleA.salmon === preIdle.salmon && idleA.idleSalmon === preIdle.idleSalmon, JSON.stringify({ s: idleA.salmon }));
    check("idle advances lastTickAt to now", idleA.lastTickAt?.getTime() === noon.getTime(), String(idleA.lastTickAt));

    // 31. Quiet hours: no flavor narration while the pet sleeps.
    config.IDLE_TICK_MINUTES = 30;
    await resetIdle({ lastTickAt: new Date(2026, 6, 26, 2, 0, 0) });
    const preC = (await store.getRunner(rSerial))!;
    const nowC = new Date(2026, 6, 26, 2, 30, 0); // one tick, still quiet
    const idleC = await reconcilePet(ctx, preC, { now: nowC, rng: forceFlavor });
    check("idle quiet: no narration during quiet hours", idleC.lastEvent === null, String(idleC.lastEvent));
    check("idle quiet: no push during quiet hours", idleC.lastPushAt === null, String(idleC.lastPushAt));

    // 33. Catch-up on read: GET /api/runner/:serial reconciles a sleeping pet.
    config.IDLE_TICK_MINUTES = 45;
    const staleTick = new Date(Date.now() - 3 * 45 * 60000);
    await resetIdle({ lastTickAt: staleTick });
    await fetch(`${base}/api/runner/${rSerial}`).then(j);
    const afterRead = (await store.getRunner(rSerial))!;
    check("idle catch-up on read advanced lastTickAt", (afterRead.lastTickAt?.getTime() ?? 0) > staleTick.getTime(), `${afterRead.lastTickAt?.getTime()} vs ${staleTick.getTime()}`);

    // 34. A second pet (used by the reaper + board sections below).
    const gate = await fetch(`${base}/api/runner/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "gate-pet@walletchi.test" }),
    }).then(j);
    const gSerial: string = gate.serial;
    let gReady: any = null;
    for (let i = 0; i < 40; i++) {
      gReady = await fetch(`${base}/api/runner/checkout/${gSerial}`).then(j);
      if (gReady.status === "ready" || gReady.status === "failed") break;
      await sleep(50);
    }
    check("second pet minted", gReady?.status === "ready" && Boolean(gReady?.tokenId), JSON.stringify({ status: gReady?.status }));

    // ===================== WALLETCHI (virtual-pet care) =====================
    const auth = (await store.getRunner(rSerial))!.authToken;
    await store.updateRunner(rSerial, {
      hatched: false, gone: false, hunger: 40, thirst: 40, joy: 40, toys: 0,
      lastHoneyAt: null, lastWaterAt: null, lastPlayAt: null, lastToyAt: null, lastExploreAt: null,
    });

    // 35. Care links are HMAC-signed: a bad signature is rejected.
    const badSig = await fetch(`${base}/api/runner/${rSerial}/action/feed?s=deadbeefdeadbeefdeadbeef`);
    check("care action bad HMAC rejected 403", badSig.status === 403, `status ${badSig.status}`);

    // 36. LEGACY PASS LINKS: passes already sitting in wallets point at
    // /action/:action. That GET now 302-redirects onto the silent care link
    // (/care/:action), so an old pass picks up one-tap care with no re-add. Still
    // side-effect free: a redirect never touches the pet. redirect is "manual" so
    // fetch does not chase the Location.
    const feedSig = signTag(auth, actionPayload(rSerial, "feed"));
    const feedGet = await fetch(`${base}/api/runner/${rSerial}/action/feed?s=${feedSig}`, { redirect: "manual" });
    check("legacy care GET redirects onto the silent care link", feedGet.status === 0 || (feedGet.status >= 300 && feedGet.status < 400), `status ${feedGet.status} type ${feedGet.type}`);
    check(
      "legacy care GET Location targets /care/ (not the retired relay)",
      feedGet.status === 0 || (feedGet.headers.get("location") ?? "").includes(`/api/runner/${rSerial}/care/feed`),
      `location ${feedGet.headers.get("location")}`,
    );
    check("care GET has no side effects (egg not hatched)", (await store.getRunner(rSerial))!.hatched === false, "");

    // 36b. RETIRED RELAY: care() is OWNER-ONLY on-chain now, so the old POST
    // relay answers 410 Gone with a machine code and NEVER touches the pet or
    // the chain. (The DB side-effects of a care are covered below: the idle
    // reconcile folds an owner-signed on-chain care back into the row.)
    const feedPost = await fetch(`${base}/api/runner/${rSerial}/action/feed?s=${feedSig}`, { method: "POST" });
    const feedPostBody = (await feedPost.json()) as any;
    check("care POST relay retired (410 care_moved)", feedPost.status === 410 && feedPostBody.code === "care_moved", JSON.stringify(feedPostBody));
    check("retired care POST has no side effects (egg not hatched)", (await store.getRunner(rSerial))!.hatched === false, "");

    // 36c. The ERC-4361 challenge + signed relay routes are retired too (the
    // owner-signed proof now lives in the on-chain care itself).
    const chalGone = await fetch(`${base}/api/runner/${rSerial}/action/feed/challenge?address=0x00000000000000000000000000000000000000AA`);
    check("care challenge route retired (410 care_moved)", chalGone.status === 410 && ((await chalGone.json()) as any).code === "care_moved", `status ${chalGone.status}`);
    const signedGone = await fetch(`${base}/api/runner/${rSerial}/action/feed/signed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "m", signature: "0x00" }) });
    check("care signed route retired (410 care_moved)", signedGone.status === 410 && ((await signedGone.json()) as any).code === "care_moved", `status ${signedGone.status}`);

    // 37. An unknown action on the (kept) GET redirect route is rejected 404.
    const unknownAct = await fetch(`${base}/api/runner/${rSerial}/action/dance?s=${signTag(auth, actionPayload(rSerial, "dance"))}`);
    check("unknown action rejected 404", unknownAct.status === 404, `status ${unknownAct.status}`);

    // 37b. SILENT CARE (on-chain scoped session key). The pass care link now lives
    // at /api/runner/:serial/care/:action. The load-bearing property under test is
    // the FALLBACK: with no usable session installed, a tap must land on the
    // proven owner-signed web care page and must never touch the pet.
    {
      const careUrl = `${base}/api/runner/${rSerial}/care/feed?s=${feedSig}`;
      const badCare = await fetch(`${base}/api/runner/${rSerial}/care/feed?s=deadbeefdeadbeefdeadbeef`);
      check("silent care link bad HMAC rejected 403", badCare.status === 403, `status ${badCare.status}`);
      const unknownCare = await fetch(`${base}/api/runner/${rSerial}/care/dance?s=${signTag(auth, actionPayload(rSerial, "dance"))}`);
      check("silent care link unknown action rejected 404", unknownCare.status === 404, `status ${unknownCare.status}`);

      const noSessGet = await fetch(careUrl, { redirect: "manual" });
      const noSessLoc = noSessGet.headers.get("location") ?? "";
      check(
        "no session: care GET falls back to the owner-signed web care page",
        noSessGet.status === 0 || (noSessGet.status >= 300 && noSessGet.status < 400 && noSessLoc.includes(`/care/${rSerial}/feed`)),
        `status ${noSessGet.status} location ${noSessLoc}`,
      );
      const noSessPost = await fetch(careUrl, { method: "POST", redirect: "manual" });
      check(
        "no session: care POST falls back with 303 (never cares)",
        noSessPost.status === 0 || noSessPost.status === 303,
        `status ${noSessPost.status}`,
      );
      check("silent care fallback has no side effects (egg not hatched)", (await store.getRunner(rSerial))!.hatched === false, "");

      // With a session row present the GET serves the auto-submitting interstitial
      // instead (the POST is what performs the care). Season-bound + owner-bound:
      // flipping either invalidates the row and we fall back again.
      const { sealSessionKey, sessionVerdict } = await import("../src/runner/session-care.js");
      const sessRow = (await store.getRunner(rSerial))!;
      const testKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
      const testAddr = privateKeyToAccount(testKey as `0x${string}`).address;
      const prevVault = config.PETVAULT_ADDRESS;
      const prevSilent = config.modes.silentCareLive;
      config.PETVAULT_ADDRESS = "0x90349bF1461F0BADCE9b9d3486cc3Dd991E816e6";
      config.modes.silentCareLive = true;
      const install = {
        serial: rSerial,
        tokenId: sessRow.tokenId ?? "1",
        ownerAddress: sessRow.ownerAddress,
        vaultAddress: config.PETVAULT_ADDRESS,
        publicKey: testAddr.toLowerCase(),
        secretEnc: sealSessionKey(testKey as `0x${string}`),
        context: "0x00aabbcc",
        expiresAt: new Date(Date.now() + 3600_000),
      };
      await store.putCareSession(install);

      // The seal round-trips and is authenticated (a tampered blob must not open).
      const { openSessionKey } = await import("../src/runner/session-care.js");
      check("session key seal round-trips", openSessionKey(install.secretEnc) === testKey, "");
      let tamperRejected = false;
      try {
        const parts = install.secretEnc.split(".");
        parts[4] = Buffer.from("deadbeefdeadbeefdeadbeefdeadbeef", "hex").toString("base64url");
        openSessionKey(parts.join("."));
      } catch {
        tamperRejected = true;
      }
      check("tampered sealed session key is rejected", tamperRejected, "");

      const armedGet = await fetch(careUrl, { redirect: "manual" });
      check("session installed: care GET serves the auto-POST interstitial", armedGet.status === 200, `status ${armedGet.status}`);

      // The cooldown page is the one a brand-new keeper is MOST likely to see: mint-time arming
      // feeds the pet as part of minting, so their first excited tap lands inside the vault's
      // per-pet cooldown. It must read as "hang on" and finish the feed by itself, not as an error.
      {
        const { confirmPage } = await import("../src/runner/actions.js");
        const retryUrl = `/api/runner/${rSerial}/care/feed?s=abc123&src=apple`;
        const page = confirmPage({
          code: 429,
          title: "Almost ready",
          body: "still full",
          emoji: "hourglass",
          countdown: { seconds: 42, retryUrl },
        });
        check("cooldown page renders a live countdown seeded from the chain", /id="cd">42</.test(page), "");
        check(
          "cooldown page re-POSTs the SAME signed link (the keeper's tap still becomes a feed)",
          page.includes(`<form id="retry" method="POST" action="/api/runner/${rSerial}/care/feed?s=abc123&amp;src=apple">`),
          "",
        );
        check("cooldown page ticks down", /left -= 1/.test(page), "");
        // FIVE-NEEDS contract (8.6): the auto-close is GATED behind the absence
        // of a countdown (`if (!cdEl)`), so a countdown/waiting page can never
        // close itself mid-countdown, whatever the AUTOCLOSE value is.
        check(
          "cooldown page does NOT auto-close (it would close mid-countdown)",
          /id="cd"/.test(page) && /if \(!cdEl\) \{\s*if \(AUTOCLOSE > 0\) setTimeout\(closeTab, AUTOCLOSE\);/.test(page),
          "",
        );
        // At the shipped careCooldown = 0 a normal care confirm has no countdown
        // and tidies its own tab away after a beat (var AUTOCLOSE = 4000 for a
        // plain page; the !cdEl gate then fires it).
        const plain = confirmPage({ code: 200, title: "Yum!", body: "ate", emoji: "y" });
        check(
          "a normal care page still auto-closes and has no countdown",
          /var AUTOCLOSE = 4000;/.test(plain) && /if \(AUTOCLOSE > 0\) setTimeout\(closeTab, AUTOCLOSE\);/.test(plain) && !/id="cd"/.test(plain),
          "",
        );
      }
      check("silent care GET still has no side effects", (await store.getRunner(rSerial))!.hatched === false, "");

      // sessionVerdict is the single gate; prove each way it says no.
      const base0 = (await store.getCareSession(rSerial))!;
      check("verdict ok for a live, in-season, owner-matched session", sessionVerdict(base0, { vaultAddress: config.PETVAULT_ADDRESS, ownerAddress: sessRow.ownerAddress }).ok, "");
      check(
        "verdict rejects a session from a previous season (wrong vault)",
        !sessionVerdict(base0, { vaultAddress: "0x000000000000000000000000000000000000dEaD", ownerAddress: sessRow.ownerAddress }).ok,
        "",
      );
      check(
        "verdict rejects a session whose granter no longer owns the pet",
        !sessionVerdict(base0, { vaultAddress: config.PETVAULT_ADDRESS, ownerAddress: "0x000000000000000000000000000000000000dEaD" }).ok,
        "",
      );
      check(
        "verdict rejects a session belonging to a different pet",
        !sessionVerdict(base0, { vaultAddress: config.PETVAULT_ADDRESS, ownerAddress: sessRow.ownerAddress, tokenId: "999999" }).ok,
        "",
      );
      check(
        "verdict rejects an expired session",
        !sessionVerdict({ ...base0, expiresAt: new Date(Date.now() - 1000) }, { vaultAddress: config.PETVAULT_ADDRESS, ownerAddress: sessRow.ownerAddress }).ok,
        "",
      );
      check(
        "verdict rejects a revoked session",
        !sessionVerdict({ ...base0, revokedAt: new Date() }, { vaultAddress: config.PETVAULT_ADDRESS, ownerAddress: sessRow.ownerAddress }).ok,
        "",
      );
      config.modes.silentCareLive = false;
      check(
        "verdict rejects everything when silent care is not configured",
        !sessionVerdict(base0, { vaultAddress: config.PETVAULT_ADDRESS, ownerAddress: sessRow.ownerAddress }).ok,
        "",
      );
      config.modes.silentCareLive = true;

      // Revoking drops it back to the owner-signed fallback immediately.
      await store.revokeCareSession(rSerial, "smoke");
      const revokedGet = await fetch(careUrl, { redirect: "manual" });
      check(
        "revoked session: care GET falls back again",
        revokedGet.status === 0 || (revokedGet.status >= 300 && revokedGet.status < 400),
        `status ${revokedGet.status}`,
      );
      // A re-grant REPLACES the row and clears the revoke, or one-tap care could
      // never be turned back on after a single revoke.
      await store.putCareSession(install);
      const regranted = (await store.getCareSession(rSerial))!;
      check("re-grant clears the revoked state", regranted.revokedAt === null && regranted.useCount === 0, JSON.stringify({ revokedAt: regranted.revokedAt, useCount: regranted.useCount }));

      // The install endpoint is owner-gated: an unauthenticated POST never lands a key.
      const noAuthInstall = await fetch(`${base}/api/pet/${sessRow.tokenId ?? "1"}/care-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey: testKey, publicKey: testAddr, context: "0x00aabbcc", expiresAtSec: Math.floor(Date.now() / 1000) + 3600 }),
      });
      check(
        "care-session install rejects an unauthenticated caller",
        noAuthInstall.status === 401 || noAuthInstall.status === 403 || noAuthInstall.status === 503,
        `status ${noAuthInstall.status}`,
      );
      // A key that does not match its claimed address would fail validation on
      // every later tap, so it is refused at install time.
      const mismatch = await fetch(`${base}/api/pet/${sessRow.tokenId ?? "1"}/care-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionKey: testKey,
          publicKey: "0x000000000000000000000000000000000000dEaD",
          context: "0x00aabbcc",
          expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
          walletAddress: sessRow.ownerAddress,
        }),
      });
      // Assert the SPECIFIC rejection: `status !== 200` would also pass if the request
      // 503d at the stub-auth gate and never reached the mismatch check at all.
      const mismatchBody = (await mismatch.json()) as any;
      check(
        "care-session install refuses a key/address mismatch (400 key_mismatch)",
        mismatch.status === 400 && mismatchBody.code === "key_mismatch",
        `status ${mismatch.status} body ${JSON.stringify(mismatchBody)}`,
      );

      const statusRes = await fetch(`${base}/api/pet/${sessRow.tokenId ?? "1"}/care-session`);
      const statusBody = (await statusRes.json()) as any;
      check("care-session status never leaks the key or context", !JSON.stringify(statusBody).includes(testKey) && !JSON.stringify(statusBody).includes("00aabbcc"), JSON.stringify(statusBody));

      await store.revokeCareSession(rSerial, "smoke cleanup");
      config.PETVAULT_ADDRESS = prevVault;
      config.modes.silentCareLive = prevSilent;
    }

    // 42. Moods from state (egg/hungry/gone) via moodFor.
    const noonW = new Date(2026, 6, 27, 12, 0, 0);
    await store.updateRunner(rSerial, { hatched: true, gone: false, hunger: 10, thirst: 80, joy: 80 });
    const mRow = (await store.getRunner(rSerial))!;
    check("low hunger reads hungry mood", moodFor(mRow, noonW) === "hungry", moodFor(mRow, noonW));
    check("unhatched reads egg mood", moodFor({ ...mRow, hatched: false }, noonW) === "egg", "");
    check("gone reads gone mood", moodFor({ ...mRow, gone: true }, noonW) === "gone", "");

    // 42b. A gone pet renders the memorial keepsake (card + strip) without crashing.
    await store.updateRunner(rSerial, { gone: true });
    const memCard = await fetch(`${base}/api/runner/${rSerial}/card.png`);
    const memBuf = Buffer.from(await memCard.arrayBuffer());
    check("memorial card png renders for a gone pet", memBuf.subarray(1, 4).toString() === "PNG", memBuf.subarray(0, 8).toString("hex"));
    const memPass = await fetch(`${base}/runner-passes/${rSerial}.pkpass`);
    check("memorial pass generates for a gone pet", memPass.status === 200, `status ${memPass.status}`);
    await store.updateRunner(rSerial, { gone: false });

    // 43. Needs decay after hatch (paused pets excepted).
    config.NEED_DECAY_PER_HOUR = 5;
    await store.updateRunner(rSerial, { hatched: true, gone: false, hunger: 100, thirst: 100, joy: 100, lastNeedsAt: new Date(noonW.getTime() - 4 * 3600000), lastTickAt: new Date(noonW.getTime() - 45 * 60000), runs: 1 });
    const decayed = await reconcilePet(ctx, (await store.getRunner(rSerial))!, { now: noonW, rng: () => 0.9 });
    check("needs decay after hatch", decayed.hunger < 100 && decayed.thirst < 100 && decayed.joy < 100, JSON.stringify({ h: decayed.hunger, t: decayed.thirst, j: decayed.joy }));

    // 43b. The idle engine decays needs and narrates pet-appropriate flavor
    // (no salmon/cub brand) and mints NOTHING (the game is removed).
    config.IDLE_TICK_MINUTES = 30;
    config.NEED_DECAY_PER_HOUR = 5;
    const flavorNoon = new Date(2026, 6, 27, 12, 0, 0);
    await store.updateRunner(rSerial, {
      hatched: true, gone: false, hunger: 100, thirst: 100, joy: 100,
      lastEvent: null, lastPushAt: null,
      lastTickAt: new Date(flavorNoon.getTime() - 30 * 60000),
      lastNeedsAt: new Date(flavorNoon.getTime() - 2 * 3600000),
    });
    const preFlavor = (await store.getRunner(rSerial))!;
    const flavored = await reconcilePet(ctx, preFlavor, { now: flavorNoon, rng: () => 0.1 });
    check("idle: no salmon minted (game removed)", flavored.salmon === preFlavor.salmon && flavored.idleSalmon === preFlavor.idleSalmon, JSON.stringify({ s: flavored.salmon, i: flavored.idleSalmon }));
    check("idle: pet flavor narrated (no salmon/cub brand)", Boolean(flavored.lastEvent) && /pet/i.test(flavored.lastEvent!) && !/salmon|cub/i.test(flavored.lastEvent!), String(flavored.lastEvent));
    check("idle: needs still decayed", flavored.hunger < 100, String(flavored.hunger));

    // 44. Season stats endpoint (stubbed off until the vault).
    const season = await fetch(`${base}/api/season/stats`).then(j);
    check("season stats shape + inactive", season.seasonActive === false && typeof season.cubsTotal === "number" && "potDisplay" in season, JSON.stringify(season));

    // 44b. Season board (the one-call Arena payload): pre-season shape is safe.
    const board0 = await fetch(`${base}/api/season/board`).then(j);
    check("board pre-season: inactive + zero fallen", board0.seasonActive === false && board0.survivors?.fallen === 0, JSON.stringify(board0.survivors));
    check("board pre-season: alive mirrors minted count + total is the cap", board0.survivors?.alive === (await store.countRunners()) && board0.survivors?.total === config.RUNNER_SUPPLY_CAP, JSON.stringify(board0.survivors));
    check("board pre-season: pot shape { display, raw }", typeof board0.pot?.display === "string" && typeof board0.pot?.raw === "string", JSON.stringify(board0.pot));
    check("board pre-season: feeds are arrays", Array.isArray(board0.recentDeaths) && Array.isArray(board0.topKeepers), "");
    check("board: no usdValue without a price source", board0.usdValue === undefined, String(board0.usdValue));

    // ================== WALLETCHI survival economy (vault seam, MockChain) ==================
    const mock = relayer.chain as any;

    // 45. The retired relay routes never touched the chain: no vault call so far.
    check("care relay retired: no vault call from the server routes", mock.lastPetCare === null, JSON.stringify(mock.lastPetCare));

    // Turn the season live against MockChain. care() is OWNER-ONLY on-chain now:
    // the web care page (AA flow) sends the owner's signed care straight to the
    // vault, bypassing the server entirely. The idle reconcile MUST fold such an
    // off-server care into the DB (hatch, full meters, careCount, lastCareAt)
    // and push the pass, or the wallet card goes stale.
    config.modes.survivalLive = true;
    await store.updateRunner(rSerial, {
      hatched: false, gone: false, critical: false, hunger: 40, thirst: 40, joy: 40,
      careCount: 0, lastCareAt: null, lastEvent: null, lastPushAt: null,
      lastNeedsAt: null, lastTickAt: new Date(),
    });
    const vTokenId = (await store.getRunner(rSerial))!.tokenId;

    // 45a. DORMANT EGG regression ("egg dies the moment you feed it"): vTokenId is
    // registered on the vault but has NOT been fed yet (careForPet runs below), so
    // it is a dormant egg: lastCareAt 0, not dead, not (yet) alive. Two guards:
    // (a) the mock reports a FAITHFUL dormant-egg petState (this is what regressed:
    // issueRunner used to stamp lastCareAt at mint); (b) the survival reconcile must
    // NOT memorialize it. Without (a) faithful, (b) silently never exercises the bug.
    const eggState = await mock.petState(vTokenId!);
    check(
      "mock: fresh egg is a dormant egg (registered, !dead, !isAlive, lastCareAt 0, secondsLeft 0)",
      eggState.registered && !eggState.dead && !eggState.isAlive && eggState.lastCareAt === 0 && eggState.secondsLeft === 0,
      JSON.stringify(eggState),
    );
    const eggRec = await reconcilePet(ctx, (await store.getRunner(rSerial))!, { now: new Date(), rng: () => 0.9 });
    check(
      "dormant egg is NOT memorialized by the survival reconcile",
      eggRec.gone === false && eggRec.critical === false,
      JSON.stringify({ gone: eggRec.gone, critical: eggRec.critical }),
    );

    await mock.careForPet(vTokenId, 0); // the OWNER cares on-chain (AA path); the server never sees it
    const reconciled = await reconcilePet(ctx, (await store.getRunner(rSerial))!, { now: new Date(), rng: () => 0.9 });
    check("on-chain care reconciles: the egg hatches in the DB/pass", reconciled.hatched === true, JSON.stringify({ hatched: reconciled.hatched }));
    check("on-chain care reconciles: meters restored to full", reconciled.hunger === 100 && reconciled.thirst === 100 && reconciled.joy === 100, JSON.stringify({ h: reconciled.hunger, t: reconciled.thirst, j: reconciled.joy }));
    check("on-chain care reconciles: careCount synced from the vault", reconciled.careCount === 1, String(reconciled.careCount));
    check("on-chain care reconciles: lastCareAt mirrors the chain", reconciled.lastCareAt !== null, String(reconciled.lastCareAt));
    check("on-chain care reconciles: the hatch narrates", /hatched/i.test(reconciled.lastEvent ?? ""), String(reconciled.lastEvent));
    // Idempotency: reconciling the SAME on-chain care again must not double-count.
    const againRec = await reconcilePet(ctx, (await store.getRunner(rSerial))!, { now: new Date(), rng: () => 0.9 });
    check("care reconcile is idempotent (no double count)", againRec.careCount === 1 && againRec.hatched === true, String(againRec.careCount));

    // 46. Death is the clock and PERMANENT (no revive, no reap step): once the
    // life timer lapses, the reconcile memorializes the pet. killPet warps the
    // pet's deadline into the past.
    mock.killPet(vTokenId);
    const deadRec = await reconcilePet(ctx, (await store.getRunner(rSerial))!, { now: new Date() });
    check("reconcile flips a lapsed pet to gone (memorial)", deadRec.gone === true, JSON.stringify({ gone: deadRec.gone }));

    // 47. Season stats go active when survival is live; the alive count is the
    // OFF-CHAIN timer tally (the vault keeps no headcount in last-pet-standing).
    const seasonLive = await fetch(`${base}/api/season/stats`).then(j);
    check("season stats active when survival live", seasonLive.seasonActive === true, JSON.stringify(seasonLive));
    check("season stats cubsAlive is the off-chain timer tally", typeof seasonLive.cubsAlive === "number", String(seasonLive.cubsAlive));

    // 48. Pass front reflects survival state: alive header carries the survivor count;
    // a gone pet's front becomes the memorial (lived days, no meters, no action links).
    const { assembleRunnerPass } = await import("../src/runner/pass.js");
    await store.updateRunner(rSerial, { gone: false });
    const aliveRunner = (await store.getRunner(rSerial))!;
    const alivePass = await assembleRunnerPass(aliveRunner);
    const aliveHeader = (alivePass.passJson.storeCard as any).headerFields.map((f: any) => f.key);
    check("alive pass front shows the survivor-count field", aliveHeader.includes("alive"), JSON.stringify(aliveHeader));
    // 48b. Explicit STATUS field + status-driven ground color, in agreement with
    // the mood the scene art uses (computed the same way, so time-of-day safe).
    const aliveSC = alivePass.passJson.storeCard as any;
    const aliveTheme = STATUS_THEMES[moodFor(aliveRunner, new Date())];
    const statusF = aliveSC.secondaryFields.find((f: any) => f.key === "petstatus");
    check("pass front carries the explicit STATUS field", statusF?.label === "STATUS" && statusF?.value === aliveTheme.status, JSON.stringify(statusF));
    check("pass ground + label colors follow the status", alivePass.passJson.backgroundColor === aliveTheme.background && alivePass.passJson.labelColor === aliveTheme.labelColor, JSON.stringify({ bg: alivePass.passJson.backgroundColor, want: aliveTheme.background }));
    check("pass header keeps the pet number, short label", aliveSC.headerFields[0]?.key === "petno" && aliveSC.headerFields[0]?.label === "NO.", JSON.stringify(aliveSC.headerFields[0]));
    await store.updateRunner(rSerial, { gone: true });
    const goneSC = (await assembleRunnerPass((await store.getRunner(rSerial))!)).passJson.storeCard as any;
    check("memorial front shows LIVED not meters", goneSC.secondaryFields.some((f: any) => f.key === "lived") && !goneSC.secondaryFields.some((f: any) => f.key === "hunger"), JSON.stringify(goneSC.secondaryFields.map((f: any) => f.key)));
    // The pet-page link rides every back since the QR left the pass (e35e3e8); care links must not.
    check("memorial back has no care action links", !goneSC.backFields.some((f: any) => f.attributedValue && f.key !== "petPage"), JSON.stringify(goneSC.backFields.filter((f: any) => f.attributedValue).map((f: any) => f.key)));
    await store.updateRunner(rSerial, { gone: false });
    config.modes.survivalLive = false;

    // 49. Death tick: a pet we hold whose life timer lapsed is DEAD (permanent;
    // there is no grace window and no reap step). The reconcile flips it to the
    // memorial with its on-chain memorialState (careCount, diedAt = deadline)
    // persisted and an OFF-CHAIN death rank derived (the contract keeps none).
    config.modes.survivalLive = true;
    const gTokenId = (await store.getRunner(gSerial))!.tokenId!;
    await store.updateRunner(gSerial, { gone: false });
    await mock.careForPet(gTokenId, 0); // two on-chain cares populate memorial careCount
    await mock.careForPet(gTokenId, 1);
    mock.expirePet(gTokenId, 30); // 30h past its deadline: dead the instant it lapsed
    const reaped = await reconcilePet(ctx, (await store.getRunner(gSerial))!, { now: new Date() });
    check("death tick flips an expired pet to gone", reaped.gone === true, JSON.stringify({ gone: reaped.gone }));
    check("death tick persists careCount from memorialState", reaped.careCount >= 2, String(reaped.careCount));
    check("death tick persists diedAt = the lapsed deadline", reaped.diedAt !== null, String(reaped.diedAt));
    check("death tick derives the off-chain death rank (first to die = 1)", reaped.deathRank === 1, String(reaped.deathRank));
    const reapedSC = (await assembleRunnerPass((await store.getRunner(gSerial))!)).passJson.storeCard as any;
    check("memorial front shows CARED + OUTLASTED from real data", reapedSC.secondaryFields.some((f: any) => f.key === "cared") && reapedSC.auxiliaryFields.some((f: any) => f.key === "outlasted"), JSON.stringify({ s: reapedSC.secondaryFields.map((f: any) => f.key), a: reapedSC.auxiliaryFields.map((f: any) => f.key) }));

    // 49b. The board reflects the death: the fallen pet leads recentDeaths with a
    // real outlasted count, and the living-keeper list excludes it.
    const boardLive = await fetch(`${base}/api/season/board`).then(j);
    check("board live: seasonActive true", boardLive.seasonActive === true, JSON.stringify({ a: boardLive.seasonActive }));
    const bd0 = boardLive.recentDeaths?.[0];
    check("board live: dead pet leads the death feed", bd0?.serial === gSerial && bd0?.tokenId === gTokenId && typeof bd0?.number === "string" && Boolean(bd0?.diedAt), JSON.stringify(bd0));
    check("board live: death feed carries outlasted from the rank", typeof bd0?.outlasted === "number", JSON.stringify(bd0));
    check("board live: keepers exclude the fallen", Array.isArray(boardLive.topKeepers) && !boardLive.topKeepers.some((k: any) => k.serial === gSerial), JSON.stringify(boardLive.topKeepers));

    // 50. CRITICAL now means APPROACHING the deadline (there is no revive once it
    // passes): a pet inside CRITICAL_WINDOW_HOURS of its deadline is NOT dead,
    // it is flagged critical with a fading ping, and the critical mood renders.
    config.CRITICAL_WINDOW_HOURS = 12;
    const graceCo = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "grace-pet@walletchi.test" }) }).then(j);
    const cSerial: string = graceCo.serial;
    let cReady: any = null;
    for (let i = 0; i < 40; i++) { cReady = await fetch(`${base}/api/runner/checkout/${cSerial}`).then(j); if (cReady.status === "ready" || cReady.status === "failed") break; await sleep(50); }
    const cTokenId = (await store.getRunner(cSerial))!.tokenId!;
    await store.updateRunner(cSerial, { hatched: true, gone: false, critical: false, lastPushAt: null });
    // 2h of life left: inside the 12h fade window (mock lifeTtl is 3 days).
    const vaultCfg = await mock.petVaultConfig();
    mock.mockSetPetCare(cTokenId, Math.floor(Date.now() / 1000) - (vaultCfg.lifeTtlSeconds - 2 * 3600), 1);
    const crit = await reconcilePet(ctx, (await store.getRunner(cSerial))!, { now: new Date() });
    check("fading: a deadline-approaching pet is NOT dead", crit.gone === false, JSON.stringify({ gone: crit.gone }));
    check("fading: a deadline-approaching pet is flagged critical", crit.critical === true, String(crit.critical));
    check("fading: the last-chance reminder narrates the hours left and the needs due", /^Last chance: .+ dies in about 2 hours\. Tap .+ now\.$/.test(crit.lastEvent ?? ""), String(crit.lastEvent));
    check("critical mood renders (fading, still alive)", moodFor((await store.getRunner(cSerial))!, new Date()) === "critical", "");

    // 51. Owner-signed on-chain cares reset the life timers; under FIVE NEEDS
    // the deadline keys on the WEAKEST need, so the SAVE is the full ritual:
    // refresh ALL FIVE needs (a single feed would leave the other four still
    // two hours from lapsing and the pet still fading; that no-false-rescue
    // case is pinned in the five-needs section below). The next reconcile folds
    // it in and pulls the pet out of the fade window (clears critical). This is
    // the SAVE, not a revive: death stays permanent.
    for (let a = 0; a < 5; a++) await mock.careForPet(cTokenId, a); // the owner careAlls on-chain (AA path)
    _resetClaimState(); // drop the 5s petNeeds cache so the reconcile sees the fresh stamps
    const saved = await reconcilePet(ctx, (await store.getRunner(cSerial))!, { now: new Date() });
    check("on-chain care saves a fading pet (clears critical)", saved.critical === false, JSON.stringify({ critical: saved.critical }));

    // 52. FINALIZE POKE (last pet standing): the contract is the judge. While a
    // rival is still inside its life window the game is NOT over: isOver() is
    // false, the poke sends nothing, and a direct finalize() reverts GameNotOver.
    const nowS = Math.floor(Date.now() / 1000);
    // Deterministic standing: the saved pet (cTokenId) is the leader (max
    // lastCareAt); a fresh rival cared 1h ago holds the runner-up clock open.
    const rivalCo = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "rival-pet@walletchi.test" }) }).then(j);
    const rivalSerial: string = rivalCo.serial;
    for (let i = 0; i < 40; i++) { const s = await fetch(`${base}/api/runner/checkout/${rivalSerial}`).then(j); if (s.status === "ready" || s.status === "failed") break; await sleep(50); }
    const rivalTokenId = (await store.getRunner(rivalSerial))!.tokenId!;
    mock.mockSetPetCare(cTokenId, nowS - 10, 2); // the leader
    mock.mockSetPetCare(rivalTokenId, nowS - 3600, 1); // the live rival (runner-up)
    await runFinalizePoke(ctx);
    const st1 = await mock.settlementState();
    check("poke: no finalize while a rival is inside its life window", st1.finalized === false, JSON.stringify(st1));
    check("settlementState: the leader (max lastCareAt) is the candidate", st1.candidate === cTokenId, JSON.stringify(st1));
    check("settlementState: winsAt = the runner-up deadline (in the future)", st1.winsAt > nowS, JSON.stringify({ winsAt: st1.winsAt, nowS }));
    let earlyRevert = "";
    try { await relayer.finalizeSeason(); } catch (e) { earlyRevert = String(e); }
    check("finalize before the game is over reverts GameNotOver (contract re-verifies)", /GameNotOver/.test(earlyRevert), earlyRevert);

    // 52b. THE DEADLINE WATCHER. isOver() flips because a deadline passed, not
    // because anything was emitted, so the event-driven equivalent is a timer
    // armed for the published winsAt. The poke arms it on every tick.
    check("finalize watcher arms for the published deadline", finalizeWatcherArmedFor() === st1.winsAt && st1.winsAt > nowS, JSON.stringify({ armed: finalizeWatcherArmedFor(), winsAt: st1.winsAt }));
    // THE INVARIANT THE WHOLE DESIGN RESTS ON: winsAt only ever moves LATER. A
    // fresh care by the runner-up pushes the deadline out, so an armed timer can
    // only ever fire EARLY, and firing early costs one view read rather than gas
    // on a GameNotOver revert. If this ever went the other way, the watcher would
    // sleep straight through the moment it exists to catch.
    mock.mockSetPetCare(rivalTokenId, nowS - 60, 2); // the rival feeds again
    const st1b = await mock.settlementState();
    await runFinalizePoke(ctx);
    check(
      "a fresh care pushes the deadline LATER and the watcher follows it",
      st1b.winsAt > st1.winsAt && finalizeWatcherArmedFor() === st1b.winsAt,
      JSON.stringify({ was: st1.winsAt, now: st1b.winsAt, armed: finalizeWatcherArmedFor() }),
    );

    // 53. The last rival lapses a full life window: isOver() flips true, the poke
    // finalizes, and the whole pot pays the leader's TBA. A second poke is a
    // no-op (isOver() is false once the pot is claimed).
    mock.expirePet(rivalTokenId, 1); // the last rival crosses its deadline
    await runFinalizePoke(ctx);
    const st2 = await mock.settlementState();
    check("poke finalizes once the last rival lapses (winner = the leader)", st2.finalized === true && mock.settlementWinner === cTokenId, JSON.stringify({ f: st2.finalized, w: mock.settlementWinner }));
    check("finalize paid a real prize from the accrued pot", mock.settlementPrize > 0n, String(mock.settlementPrize));
    await runFinalizePoke(ctx);
    check("poke after payout is a no-op (isOver false once claimed)", (await mock.isOver()) === false && mock.settlementWinner === cTokenId, "");
    check("finalize watcher disarms once the season is settled", finalizeWatcherArmedFor() === 0, String(finalizeWatcherArmedFor()));

    // ============ WALLETCHI drama layer (timer deaths + milestones + victory) ============
    const noonDrama = new Date(2026, 6, 27, 14, 0, 0); // 2pm, not quiet hours

    // 54. One poll consumes the REAL Victory event finalize() emitted, sweeps the
    // timers (pets that crossed their deadline become NEW deaths -> memorial),
    // and computes the OFF-CHAIN alive tally for the survivor snapshot.
    _resetDramaState();
    await runDramaPoll(ctx, noonDrama);
    check("drama: timer sweep memorializes a pet that crossed its deadline", (await store.getRunner(rivalSerial))!.gone === true && (await store.getRunner(rivalSerial))!.diedAt !== null, "");
    check("drama: timer sweep memorializes the earlier casualty too", (await store.getRunner(rSerial))!.gone === true, "");
    check("drama: survivor snapshot = off-chain timer tally (only the champion lives)", getSeasonSnapshot().aliveCount === 1, String(getSeasonSnapshot().aliveCount));
    const champ = (await store.getRunner(cSerial))!;
    check("drama: the real Victory event flips our pet to won", champ.won === true, String(champ.won));
    check("drama: Victory persists the real prize paid", champ.wonPrize === mock.settlementPrize.toString() && BigInt(champ.wonPrize) > 0n, champ.wonPrize);
    const champSC = (await assembleRunnerPass(champ)).passJson.storeCard as any;
    const potField = champSC.auxiliaryFields.find((f: any) => f.key === "pot");
    // 8 cares landed this season (hatch + 2 + the five-need SAVE ritual of 5),
    // each potting 0.1 CARE: the champion's card shows the real 0.8 CARE prize.
    check("victory pass front shows WINNER + POT WON (real prize)", champSC.auxiliaryFields.some((f: any) => f.key === "winner") && /0\.8/.test(potField?.value ?? ""), JSON.stringify(champSC.auxiliaryFields.map((f: any) => ({ k: f.key, v: f.value }))));

    // 55. Death-feed: a pet crossing its deadline BETWEEN polls is a NEW death
    // that coalesces into a bounded "N remain" ping to living owners (never a
    // 2000 broadcast). Prime a poll first so the small-population milestones are
    // latched and the ping is the plain coalesced death line.
    const mintPet = async (email: string): Promise<{ serial: string; tokenId: string }> => {
      const co = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }).then(j);
      for (let i = 0; i < 40; i++) { const s = await fetch(`${base}/api/runner/checkout/${co.serial}`).then(j); if (s.status === "ready" || s.status === "failed") break; await sleep(50); }
      const row = (await store.getRunner(co.serial))!;
      return { serial: co.serial, tokenId: row.tokenId! };
    };
    const dA = await mintPet("drama-a@walletchi.test");
    const dB = await mintPet("drama-b@walletchi.test");
    const dC = await mintPet("drama-c@walletchi.test");
    const dD = await mintPet("drama-d@walletchi.test");
    await runDramaPoll(ctx, noonDrama); // prime: latches milestones for 5 alive
    check("drama: off-chain tally counts the fresh pets (5 alive)", getSeasonSnapshot().aliveCount === 5, String(getSeasonSnapshot().aliveCount));
    mock.expirePet(dA.tokenId, 1); // a pet crosses its deadline between polls
    await store.updateRunner(dB.serial, { lastWanderPingAt: null, lastEvent: null });
    await runDramaPoll(ctx, noonDrama);
    check("drama: the timer-crossed pet is a NEW death (memorialized)", (await store.getRunner(dA.serial))!.gone === true, "");
    const pinged = (await store.getRunner(dB.serial))!;
    check("drama: death-feed pinged a living owner with the coalesced count", pinged.lastWanderPingAt !== null && /4 still breathing/i.test(pinged.lastEvent ?? ""), JSON.stringify({ e: pinged.lastEvent }));

    // 56. Survivor milestone: the tally hitting 2 fires the one-time final
    // standoff ping (latched: it can never re-fire).
    mock.expirePet(dB.tokenId, 1);
    mock.expirePet(dC.tokenId, 1);
    await store.updateRunner(dD.serial, { lastWanderPingAt: null, lastEvent: null });
    await runDramaPoll(ctx, noonDrama);
    check("drama: milestone ping at 2 remain (the final standoff)", /two left/i.test((await store.getRunner(dD.serial))!.lastEvent ?? ""), (await store.getRunner(dD.serial))!.lastEvent ?? "");
    // REGRESSION (2026-10-17): the latches live in memory, so every restart re-announced the
    // highest milestone already crossed ("100 still breathing" at 51 alive, ~15 deploys that day).
    // A restart (state reset) followed by a poll with no new deaths must announce nothing.
    _resetDramaState();
    await store.updateRunner(dD.serial, { lastWanderPingAt: null, lastEvent: "untouched" });
    await runDramaPoll(ctx, noonDrama);
    check("drama: a restart never re-announces a milestone already crossed", (await store.getRunner(dD.serial))!.lastEvent === "untouched", (await store.getRunner(dD.serial))!.lastEvent ?? "");
    // REGRESSION: a milestone must describe a colony that actually existed. The
    // old rule was `alive <= m` alone, so a 5-pet season with 4 alive announced
    // "Only 10 pets remain alive" (a threshold it was never above). Owner saw
    // this on a real pass.
    check(
      "milestones: a small season never announces a threshold it was never above",
      milestonesCrossed(4, 5).length === 0 && milestonesCrossed(4, 2000).includes(10),
      JSON.stringify({ small: milestonesCrossed(4, 5), big: milestonesCrossed(4, 2000) }),
    );
    check(
      "milestones: real attrition still fires, and only at crossed thresholds",
      milestonesCrossed(2, 2000).includes(2) &&
        !milestonesCrossed(500, 2000).includes(100) &&
        milestonesCrossed(1, 5).includes(1) &&
        milestonesCrossed(1, 1).length === 0,
      JSON.stringify(milestonesCrossed(2, 2000)),
    );
    check("drama: milestone deaths were memorialized too", (await store.getRunner(dB.serial))!.gone === true && (await store.getRunner(dC.serial))!.gone === true, "");

    // The settled game must not leak into later sections: clear the mock's
    // finalized flag (later care/mint tests assume an open season).
    mock.resetSeasonMock();

    // 57. Generative traits: every one of tokenIds 1..2000 maps to a DISTINCT base
    // trait combo (provable uniqueness by the affine-permutation construction).
    const comboSet = new Set<string>();
    for (let id = 1; id <= 2000; id++) {
      const tr = traitsFor(id);
      comboSet.add(`${tr.body}-${tr.belly}-${tr.eyes}-${tr.cheeks}-${tr.marking}-${tr.accent}`);
    }
    check("traits: 2000 ids -> 2000 unique base combos", comboSet.size === 2000, `distinct=${comboSet.size}`);
    check("trait base space >= 2000", TOTAL_BASE_COMBOS >= 2000, String(TOTAL_BASE_COMBOS));
    check("traits deterministic for a given id", traitsFor(1337).names.body === traitsFor(1337).names.body, "");

    // ============ TRAITS v2 + EVOLUTION (flag-gated; default OFF) ============
    // Everything above ran with TRAITS_V2_ENABLED off. First prove the flag-OFF
    // trait mapping is byte-identical to today (snapshotted literals), then flip
    // the flag ON and exercise v2 uniqueness, the stage math, and the evolution
    // events, then flip it back OFF so later sections are unaffected.
    {
      const savedV2 = config.TRAITS_V2_ENABLED;
      config.modes.survivalLive = false; // deterministic: no vault reads for these pets

      // 57b. Flag OFF: traitsFor for known ids matches the values shipped today.
      config.TRAITS_V2_ENABLED = false;
      const v1Snapshot: Record<number, { body: number; belly: number; eyes: number; cheeks: number; marking: number; accent: number; accessory: number }> = {
        1: { body: 14, belly: 0, eyes: 1, cheeks: 0, marking: 5, accent: 4, accessory: 3 },
        42: { body: 11, belly: 0, eyes: 5, cheeks: 1, marking: 3, accent: 3, accessory: 0 },
        87: { body: 12, belly: 1, eyes: 1, cheeks: 3, marking: 5, accent: 0, accessory: 0 },
        1337: { body: 6, belly: 0, eyes: 4, cheeks: 3, marking: 1, accent: 1, accessory: 0 },
        2000: { body: 9, belly: 0, eyes: 4, cheeks: 1, marking: 1, accent: 1, accessory: 0 },
      };
      let v1Identical = true;
      for (const [id, e] of Object.entries(v1Snapshot)) {
        const t = traitsFor(Number(id));
        if (t.body !== e.body || t.belly !== e.belly || t.eyes !== e.eyes || t.cheeks !== e.cheeks || t.marking !== e.marking || t.accent !== e.accent || t.accessory !== e.accessory) v1Identical = false;
        if (t.pattern !== 0 || t.shape !== 0) v1Identical = false; // v1 draws no pattern/shape
      }
      check("traits v2 flag OFF: traitsFor is byte-identical to today (snapshot)", v1Identical, "");
      check("traits v2 flag OFF: metadata attributes carry no Pattern/Shape", !traitsFor(1).names.pattern || traitsFor(1).names.pattern === "Solid", "");

      // 57c. Flag ON: uniqueness lives in the VISIBLE axes. Enumerate 1..2000 and
      // assert (a) FULL tuples all distinct AND (b) HEAVY tuples (hue, pattern,
      // eyes, shape) all distinct: every pet differs across the room.
      config.TRAITS_V2_ENABLED = true;
      const fullSet = new Set<string>();
      const heavySet = new Set<string>();
      let accessoried = 0;
      for (let id = 1; id <= 2000; id++) {
        const t = traitsFor(id);
        fullSet.add(`${t.body}-${t.belly}-${t.eyes}-${t.cheeks}-${t.marking}-${t.accent}-${t.pattern}-${t.shape}-${t.accessory}`);
        heavySet.add(`${t.body}-${t.pattern}-${t.eyes}-${t.shape}`);
        if (t.accessory !== 0) accessoried++;
      }
      check("traits v2: 2000 ids -> 2000 unique FULL tuples", fullSet.size === 2000, `distinct=${fullSet.size}`);
      check("traits v2: 2000 ids -> 2000 unique HEAVY tuples (hue,pattern,eyes,shape)", heavySet.size === 2000, `distinct=${heavySet.size}`);
      check("traits v2: accessory coverage ~50% (drawn commons + rare tier)", accessoried >= 900 && accessoried <= 1100, `${accessoried}/2000`);
      check("traits v2: metadata gains Pattern + Shape attributes", traitAttributes(1).some((a: any) => a.trait_type === "Pattern") && traitAttributes(1).some((a: any) => a.trait_type === "Shape"), JSON.stringify(traitAttributes(1).map((a: any) => a.trait_type)));

      // 57d. stageFor threshold math (edges). Defaults: GROWN at 10 cares OR 3
      // days, PRIME at 30 cares OR 10 days. A pet advances by EITHER path.
      config.STAGE2_CARES = 10; config.STAGE2_AGE_DAYS = 3; config.STAGE3_CARES = 30; config.STAGE3_AGE_DAYS = 10;
      const nowS2 = new Date(2026, 6, 27, 12, 0, 0);
      const daysAgo = (d: number) => new Date(nowS2.getTime() - d * 86_400_000);
      const mk = (o: Record<string, unknown>) => ({ hatched: true, gone: false, careCount: 0, bornAt: null, createdAt: nowS2, lastStage: 0, ...o } as any);
      check("stage: an egg (unhatched) never evolves (stage 0)", stageFor(mk({ hatched: false }), nowS2) === 0, "");
      check("stage: a fresh hatchling is stage 1", stageFor(mk({ createdAt: nowS2 }), nowS2) === 1, "");
      check("stage: exactly STAGE2_CARES cares -> GROWN (2)", stageFor(mk({ careCount: 10 }), nowS2) === 2, "");
      check("stage: one below STAGE2_CARES stays HATCHLING (1)", stageFor(mk({ careCount: 9 }), nowS2) === 1, "");
      check("stage: exactly STAGE2_AGE_DAYS old -> GROWN (2) with zero cares", stageFor(mk({ createdAt: daysAgo(3) }), nowS2) === 2, "");
      check("stage: exactly STAGE3_CARES cares -> PRIME (3)", stageFor(mk({ careCount: 30 }), nowS2) === 3, "");
      check("stage: exactly STAGE3_AGE_DAYS old -> PRIME (3)", stageFor(mk({ createdAt: daysAgo(10) }), nowS2) === 3, "");
      check("stage: bornAt (vault) wins over createdAt when present", stageFor(mk({ createdAt: daysAgo(30), bornAt: daysAgo(1) }), nowS2) === 1, "");
      check("stage: a gone pet yields no render stage (never evolves)", petVisualFor(mk({ gone: true, careCount: 40 }), nowS2).stage === undefined, "");

      // 57e. Evolution EVENT on a reconcile: force a fresh pet past the PRIME
      // thresholds, reconcile, and assert lastStage persisted + a celebratory
      // lastEvent + a push happened (lastPushAt set, the pattern smoke uses).
      const evoCo = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "evolve-pet@walletchi.test" }) }).then(j);
      const evoSerial: string = evoCo.serial;
      for (let i = 0; i < 40; i++) { const s = await fetch(`${base}/api/runner/checkout/${evoSerial}`).then(j); if (s.status === "ready" || s.status === "failed") break; await sleep(50); }
      const evoNoon = new Date(2026, 6, 27, 12, 0, 0); // not quiet hours
      await store.updateRunner(evoSerial, {
        hatched: true, gone: false, critical: false, careCount: 30, lastStage: 1,
        hunger: 100, thirst: 100, joy: 100,
        lastEvent: null, lastPushAt: null,
        lastNeedsAt: evoNoon, lastTickAt: evoNoon,
      });
      const evolved = await reconcilePet(ctx, (await store.getRunner(evoSerial))!, { now: evoNoon, rng: () => 0.9 });
      check("evolution: reconcile persists the new lastStage (PRIME=3)", evolved.lastStage === 3, String(evolved.lastStage));
      check("evolution: reconcile sets a celebratory lastEvent line", /evolved/i.test(evolved.lastEvent ?? "") && /PRIME/i.test(evolved.lastEvent ?? ""), String(evolved.lastEvent));
      check("evolution: reconcile pushed the momentous update (lastPushAt set)", evolved.lastPushAt !== null, String(evolved.lastPushAt));
      const evoReconcileAgain = await reconcilePet(ctx, (await store.getRunner(evoSerial))!, { now: new Date(evoNoon.getTime() + 60_000), rng: () => 0.9 });
      check("evolution: a settled stage does not re-fire the event", evoReconcileAgain.lastStage === 3, String(evoReconcileAgain.lastStage));

      // 57f. Care-driven stage sync through the ON-CHAIN care reconcile: an
      // owner-signed care that tips the pet over a stage threshold advances
      // lastStage on the next reconcile, with NO spurious evolution celebration
      // (maybeEvolve narrates GROWN/PRIME on its own beat, and a settled
      // lastStage keeps it silent).
      const evoTok = (await store.getRunner(evoSerial))!.tokenId!;
      // One care below GROWN in the DB; the chain has the tipping care (9 -> 10).
      await store.updateRunner(evoSerial, { careCount: config.STAGE2_CARES - 1, lastStage: 1, hatched: true, gone: false, critical: false, lastCareAt: null, lastEvent: null });
      config.modes.survivalLive = true;
      mock.mockSetPetCare(evoTok, Math.floor(Date.now() / 1000), config.STAGE2_CARES);
      const evoCare = await reconcilePet(ctx, (await store.getRunner(evoSerial))!, { now: new Date(), rng: () => 0.9 });
      config.modes.survivalLive = false;
      check("evolution: on-chain care syncs careCount for the stage math", evoCare.careCount === config.STAGE2_CARES, String(evoCare.careCount));
      check("evolution: the reconciled care advanced lastStage to GROWN (2)", evoCare.lastStage === 2, String(evoCare.lastStage));
      check("evolution: no duplicate celebration from the care reconcile", !/evolved/i.test(evoCare.lastEvent ?? ""), String(evoCare.lastEvent));

      config.TRAITS_V2_ENABLED = savedV2;
    }

    config.modes.survivalLive = false;

    // 57g. HATCH TRUTH (2026-09-23): the pass-tap confirm page is the "Your egg hatched!"
    // reveal ONLY for the care that really hatched the pet. Mint-time arming hatches from
    // the BROWSER, so the DB can still read unhatched with careCount 0 when the keeper's
    // first pass tap lands; the chain then holds TWO cares and that tap is NOT the hatch.
    {
      const hco = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "hatch-truth@walletchi.test" }) }).then(j);
      for (let i = 0; i < 40; i++) { const s = await fetch(`${base}/api/runner/checkout/${hco.serial}`).then(j); if (s.status === "ready" || s.status === "failed") break; await sleep(50); }
      const hTok = (await store.getRunner(hco.serial))!.tokenId!;
      const staleDb = { hatched: false, careCount: 0, lastCareAt: null, gone: false, critical: false };
      const nowS = Math.floor(Date.now() / 1000);

      // Hunt's case: browser hatch (care 1) unseen by the server, then the pass tap (care 2).
      await store.updateRunner(hco.serial, staleDb);
      mock.mockSetPetCare(hTok, nowS, 2);
      const tapBefore = (await store.getRunner(hco.serial))!;
      const tapAfter = await reconcileOnChainCare(ctx, tapBefore, hTok, await mock.petState(hTok), new Date());
      check("hatch truth: the reconcile still folds the missed browser hatch in (hatched true, count 2)", tapAfter.hatched === true && tapAfter.careCount === 2, JSON.stringify({ h: tapAfter.hatched, c: tapAfter.careCount }));
      check("hatch truth: a first pass tap AFTER a browser hatch is NOT labeled the hatch", careHatchedThePet(tapBefore, tapAfter) === false, "");

      // A genuine pass-tap hatch (mint-time arming failed, the egg waited): the tap IS care 1.
      await store.updateRunner(hco.serial, staleDb);
      mock.mockSetPetCare(hTok, nowS, 1);
      const realBefore = (await store.getRunner(hco.serial))!;
      const realAfter = await reconcileOnChainCare(ctx, realBefore, hTok, await mock.petState(hTok), new Date());
      check("hatch truth: the care that brings the chain count to 1 IS the hatch", careHatchedThePet(realBefore, realAfter) === true, JSON.stringify({ c: realAfter.careCount }));

      // An already-hatched pet is never re-hatched, whatever the count says.
      check("hatch truth: a pet the DB already knows is hatched never shows the hatch page", careHatchedThePet(realAfter, { ...realAfter, careCount: 1 }) === false, "");
    }

    // ============ WS2 secondary-market claim (nonce + /api/claim + rotation) ============
    _resetClaimState();

    // Two "buyer" wallets (well-known anvil dev keys; never used on a real chain).
    const buyer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const buyer2 = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    // Build the message the way the REAL client does (web-cub/src/lib/wallet.ts): the domain
    // line must name the configured site, because the server binds the signature to this site
    // and this intent. A hardcoded host here would drift from the verifier and quietly stop
    // testing the thing that matters.
    const claimHost = new URL(config.WEB_APP_URL).host;
    const claimMsg = (address: string, nonce: string) =>
      [
        `${claimHost} wants you to prove you own this pet.`,
        "",
        "I own WALLETCHI and I am claiming its wallet pass.",
        "",
        `Address: ${address}`,
        `Nonce: ${nonce}`,
        `Issued At: ${new Date().toISOString()}`,
      ].join("\n");
    const freshNonce = async (): Promise<string> =>
      (await fetch(`${base}/api/claim/nonce`).then(j)).nonce;
    const postClaim = (body: unknown) =>
      fetch(`${base}/api/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // 57b. Live chain config: the seam the browser trusts for the CURRENT
    // season's addresses (anti-stale-bundle). Must mirror config exactly, or
    // the web would sign care into the wrong vault politely.
    {
      const cc = await fetch(`${base}/api/chain-config`).then(j);
      check(
        "chain-config serves the configured vault + tokens",
        cc.chainId === config.robinhood.chainId &&
          (cc.petVault ?? null) === (config.PETVAULT_ADDRESS || null) &&
          (cc.careToken ?? null) === (config.CARE_TOKEN_ADDRESS || null) &&
          (cc.feeToken ?? null) === (config.FEE_TOKEN_ADDRESS || null) &&
          cc.careTokenDecimals === config.CARE_TOKEN_DECIMALS,
        JSON.stringify(cc),
      );
    }

    // 58. Server-issued nonce endpoint.
    const nonceRes = await fetch(`${base}/api/claim/nonce`).then(j);
    check("claim nonce issued (hex + expiry)", /^[0-9a-f]{32}$/.test(nonceRes.nonce ?? "") && Boolean(nonceRes.expiresAt), JSON.stringify(nonceRes));

    // Mint a fresh pet (custodial), then simulate a secondary sale to `buyer`.
    const clCo = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "claim-pet@walletchi.test" }) }).then(j);
    const clSerial: string = clCo.serial;
    for (let i = 0; i < 40; i++) {
      const s = await fetch(`${base}/api/runner/checkout/${clSerial}`).then(j);
      if (s.status === "ready" || s.status === "failed") break;
      await sleep(50);
    }
    const clRow = (await store.getRunner(clSerial))!;
    const clTokenId = clRow.tokenId!;
    const clOldAuth = clRow.authToken;
    mock.setPetOwnerMock(clTokenId, buyer.address);

    // 59. A wallet that does NOT own the pet is rejected not_owner.
    {
      const n = await freshNonce();
      const msg = claimMsg(buyer2.address, n);
      const sig = await buyer2.signMessage({ message: msg });
      const r59 = await postClaim({ method: "wallet", address: buyer2.address, signature: sig, message: msg, tokenId: clTokenId });
      const b59 = (await r59.json()) as any;
      check("claim by non-owner rejected 403 not_owner", r59.status === 403 && b59.code === "not_owner", JSON.stringify(b59));
    }

    // 60. A client-invented nonce (not server-issued) is rejected.
    {
      const msg = claimMsg(buyer.address, "deadbeefdeadbeefdeadbeefdeadbeef");
      const sig = await buyer.signMessage({ message: msg });
      const r60 = await postClaim({ method: "wallet", address: buyer.address, signature: sig, message: msg, tokenId: clTokenId });
      const b60 = (await r60.json()) as any;
      // THE PHISHING PROPERTY. A signature is only usable here if it was made FOR here.
    // Without this, any site could fetch a nonce from us server-to-server, get a holder to
    // sign text that never mentions WALLETCHI, and post it to claim their pass capability.
    {
      const n = await freshNonce();
      const foreign = [
        "cooldrop.example wants you to sign in.",
        "",
        "Sign in to CoolDrop.",
        "",
        `Address: ${buyer.address}`,
        `Nonce: ${n}`,
      ].join("\n");
      const sig = await buyer.signMessage({ message: foreign });
      const r = await postClaim({ method: "wallet", address: buyer.address, signature: sig, message: foreign });
      const b = (await r.json()) as any;
      check(
        "a signature harvested on ANOTHER site cannot claim a pass",
        r.status === 400 && b.code === "bad_message",
        `${r.status} ${JSON.stringify(b)}`,
      );
    }
    // An omitted Address line used to skip the pin check entirely.
    {
      const n = await freshNonce();
      const noAddr = [
        `${claimHost} wants you to prove you own this pet.`,
        "",
        "I own WALLETCHI and I am claiming its wallet pass.",
        "",
        `Nonce: ${n}`,
      ].join("\n");
      const sig = await buyer.signMessage({ message: noAddr });
      const r = await postClaim({ method: "wallet", address: buyer.address, signature: sig, message: noAddr });
      const b = (await r.json()) as any;
      check(
        "a claim message with no Address line is refused",
        r.status === 400 && b.code === "bad_message",
        `${r.status} ${JSON.stringify(b)}`,
      );
    }
    check("claim with a client nonce rejected (server-issued only)", r60.status === 400 && b60.code === "bad_nonce", JSON.stringify(b60));
    }

    // 61. Happy path: owner signs the server nonce, pass re-issued, token rotated.
    let happyMsg = "";
    let happySig = "";
    {
      const n = await freshNonce();
      happyMsg = claimMsg(buyer.address, n);
      happySig = await buyer.signMessage({ message: happyMsg });
      const r61 = await postClaim({ method: "wallet", address: buyer.address, signature: happySig, message: happyMsg, tokenId: clTokenId });
      const b61 = (await r61.json()) as any;
      check("claim happy path 200 ok", r61.status === 200 && b61.ok === true, JSON.stringify(b61));
      check("claim returns serial + runnerNumber + status + applePassUrl", b61.serial === clSerial && Boolean(b61.runnerNumber) && b61.status === "alive" && String(b61.applePassUrl ?? "").includes(".pkpass"), JSON.stringify(b61));
      check("claim omits googleSaveUrl when Google signing is stubbed", !("googleSaveUrl" in b61), JSON.stringify(Object.keys(b61)));
      const after = (await store.getRunner(clSerial))!;
      check("claim rotates the pass authToken", after.authToken !== clOldAuth && after.authToken.length >= 32, "");
      check("claim rebinds owner-of-record to the buyer", after.ownerAddress.toLowerCase() === buyer.address.toLowerCase(), after.ownerAddress);
      check("claim unbinds the seller's email (placeholder)", after.email.endsWith("@wallet.walletchi.local"), after.email);

      // 62. The PREVIOUS owner's HMAC care link is now invalid; the new one works
      // (the GET redirects to the web care page, where the owner signs the care).
      const oldLink = await fetch(`${base}/api/runner/${clSerial}/action/feed?s=${signTag(clOldAuth, actionPayload(clSerial, "feed"))}`);
      check("old owner's care link invalidated after rotation (403)", oldLink.status === 403, `status ${oldLink.status}`);
      const newLink = await fetch(`${base}/api/runner/${clSerial}/action/feed?s=${signTag(after.authToken, actionPayload(clSerial, "feed"))}`, { redirect: "manual" });
      check("new owner's care link redirects to the web care page after claim", newLink.status === 0 || (newLink.status >= 300 && newLink.status < 400), `status ${newLink.status}`);

      // 63. The consumed nonce cannot be replayed.
      const replay = await postClaim({ method: "wallet", address: buyer.address, signature: happySig, message: happyMsg, tokenId: clTokenId });
      const bReplay = (await replay.json()) as any;
      check("consumed nonce cannot be replayed", replay.status === 400 && bReplay.code === "bad_nonce", JSON.stringify(bReplay));

      // 64. Apple web service: the OLD token still refreshes into a TRANSFERRED
      // keepsake (never the rotated token), but cannot register new devices.
      const oldPass = await fetch(`${base}/runner-apple/v1/passes/${config.PASS_TYPE_ID}/${clSerial}`, { headers: { authorization: `ApplePass ${clOldAuth}` } });
      check("old token refresh serves the transferred keepsake", oldPass.status === 200 && oldPass.headers.get("x-walletchi-pass") === "transferred", `status ${oldPass.status}`);
      const oldReg = await fetch(`${base}/runner-apple/v1/devices/dev-claim-1/registrations/${config.PASS_TYPE_ID}/${clSerial}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `ApplePass ${clOldAuth}` },
        body: JSON.stringify({ pushToken: "tok-old-owner" }),
      });
      check("old token cannot register new devices (401)", oldReg.status === 401, `status ${oldReg.status}`);
      const newReg = await fetch(`${base}/runner-apple/v1/devices/dev-claim-2/registrations/${config.PASS_TYPE_ID}/${clSerial}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `ApplePass ${after.authToken}` },
        body: JSON.stringify({ pushToken: "tok-new-owner" }),
      });
      check("new token registers devices (201)", newReg.status === 201, `status ${newReg.status}`);
    }

    // 65. Multi-pet resolution: a signer owning several pets gets the picker list
    // (nonce NOT consumed), then claims one with the same signature.
    {
      const co1 = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "multi-1@walletchi.test" }) }).then(j);
      const co2 = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "multi-2@walletchi.test" }) }).then(j);
      for (let i = 0; i < 40; i++) {
        const a = await fetch(`${base}/api/runner/checkout/${co1.serial}`).then(j);
        const b = await fetch(`${base}/api/runner/checkout/${co2.serial}`).then(j);
        if (a.status === "ready" && b.status === "ready") break;
        await sleep(50);
      }
      const tok1 = (await store.getRunner(co1.serial))!.tokenId!;
      const tok2 = (await store.getRunner(co2.serial))!.tokenId!;
      mock.setPetOwnerMock(tok1, buyer2.address);
      mock.setPetOwnerMock(tok2, buyer2.address);
      const n = await freshNonce();
      const msg = claimMsg(buyer2.address, n);
      const sig = await buyer2.signMessage({ message: msg });
      const rMulti = await postClaim({ method: "wallet", address: buyer2.address, signature: sig, message: msg });
      const bMulti = (await rMulti.json()) as any;
      check("multi-pet claim returns the picker list", rMulti.status === 200 && bMulti.ok === false && bMulti.multiple === true && bMulti.pets?.length === 2, JSON.stringify(bMulti));
      check("picker entries carry tokenId + serial + runnerNumber + status", bMulti.pets?.every((p: any) => p.tokenId && p.serial && p.runnerNumber && p.status), JSON.stringify(bMulti.pets));
      const rPick = await postClaim({ method: "wallet", address: buyer2.address, signature: sig, message: msg, tokenId: tok1 });
      const bPick = (await rPick.json()) as any;
      check("picker re-send with tokenId claims the chosen pet", rPick.status === 200 && bPick.ok === true && bPick.tokenId === tok1, JSON.stringify(bPick));

      // 65b. Buyer-email capture: a wallet claim that supplies an email stores it
      // (lowercased) as the pet's contact instead of the seller-unbinding
      // placeholder, and that address then works on the email re-delivery path.
      // The email is the BUYER's declared contact, so the mixed-case input must
      // land as a plain lowercase (NOT sybil-normalized: dots must survive, or
      // the re-delivery compare would never match what the user types).
      {
        const n2 = await freshNonce();
        const msg2 = claimMsg(buyer2.address, n2);
        const sig2 = await buyer2.signMessage({ message: msg2 });
        const rEm = await postClaim({ method: "wallet", address: buyer2.address, signature: sig2, message: msg2, tokenId: tok2, email: "New.Owner@WALLETCHI.test" });
        const bEm = (await rEm.json()) as any;
        check("claim with buyer email succeeds", rEm.status === 200 && bEm.ok === true && bEm.tokenId === tok2, JSON.stringify(bEm));
        const rowEm = (await store.getRunner(co2.serial))!;
        check("buyer email stored lowercase with dots intact", rowEm.email === "new.owner@walletchi.test", rowEm.email);
        check("claim response carries no emailed flag while email is stubbed", !("emailed" in bEm), JSON.stringify(Object.keys(bEm)));
        const rRedeliver = await postClaim({ method: "email", email: "new.owner@walletchi.test", tokenId: tok2 });
        const bRedeliver = (await rRedeliver.json()) as any;
        check("buyer's email now works on the re-delivery path", rRedeliver.status === 200 && bRedeliver.ok === true && bRedeliver.emailed === true, JSON.stringify(bRedeliver));
      }

      // 65c. A placeholder-shaped email is refused: storing it would silently
      // disable re-delivery for this pet while looking like a saved contact.
      {
        const n3 = await freshNonce();
        const msg3 = claimMsg(buyer2.address, n3);
        const sig3 = await buyer2.signMessage({ message: msg3 });
        const rPh = await postClaim({ method: "wallet", address: buyer2.address, signature: sig3, message: msg3, tokenId: tok2, email: "hax@wallet.walletchi.local" });
        const bPh = (await rPh.json()) as any;
        check("placeholder-shaped claim email refused 400", rPh.status === 400 && bPh.code === "bad_request", JSON.stringify(bPh));
      }
    }

    // 66. Dead pet: soulbound memorial, cannot be claimed.
    {
      const coD = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dead-claim@walletchi.test" }) }).then(j);
      for (let i = 0; i < 40; i++) {
        const s = await fetch(`${base}/api/runner/checkout/${coD.serial}`).then(j);
        if (s.status === "ready" || s.status === "failed") break;
        await sleep(50);
      }
      const tokD = (await store.getRunner(coD.serial))!.tokenId!;
      mock.setPetOwnerMock(tokD, buyer.address);
      mock.killPet(tokD);
      const n = await freshNonce();
      const msg = claimMsg(buyer.address, n);
      const sig = await buyer.signMessage({ message: msg });
      const rDead = await postClaim({ method: "wallet", address: buyer.address, signature: sig, message: msg, tokenId: tokD });
      const bDead = (await rDead.json()) as any;
      check("dead pet claim rejected dead_soulbound", rDead.status === 409 && bDead.code === "dead_soulbound", JSON.stringify(bDead));
    }

    // 67. Email path: re-delivery to the on-file inbox only (no pass URLs in the
    // response, no rotation), and hard-blocked once the pet transfers on-chain.
    {
      const coE = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "email-claim@walletchi.test" }) }).then(j);
      for (let i = 0; i < 40; i++) {
        const s = await fetch(`${base}/api/runner/checkout/${coE.serial}`).then(j);
        if (s.status === "ready" || s.status === "failed") break;
        await sleep(50);
      }
      const rowE = (await store.getRunner(coE.serial))!;
      const tokE = rowE.tokenId!;
      const authE = rowE.authToken;
      const rEmail = await postClaim({ method: "email", email: "email-claim@walletchi.test", tokenId: tokE });
      const bEmail = (await rEmail.json()) as any;
      check("email claim ok + emailed, no pass URLs in the response", rEmail.status === 200 && bEmail.ok === true && bEmail.emailed === true && !bEmail.applePassUrl && !bEmail.googleSaveUrl, JSON.stringify(bEmail));
      check("email claim does NOT rotate the authToken (re-delivery only)", (await store.getRunner(coE.serial))!.authToken === authE, "");
      const rWrong = await postClaim({ method: "email", email: "someone-else@walletchi.test", tokenId: tokE });
      const bWrong = (await rWrong.json()) as any;
      check("email not on file rejected not_owner", rWrong.status === 403 && bWrong.code === "not_owner", JSON.stringify(bWrong));

      // The pet sells on-chain (unclaimed): the minter's email path closes. The
      // old care POST relay is retired outright (ownership is now enforced by
      // the chain itself: care() only accepts the owner's signature).
      mock.setPetOwnerMock(tokE, buyer2.address);
      const rSold = await postClaim({ method: "email", email: "email-claim@walletchi.test", tokenId: tokE });
      const bSold = (await rSold.json()) as any;
      check("email path blocked after an on-chain transfer", rSold.status === 403 && bSold.code === "not_owner", JSON.stringify(bSold));
      const soldLink = await fetch(`${base}/api/runner/${coE.serial}/action/feed?s=${signTag(authE, actionPayload(coE.serial, "feed"))}`, { method: "POST" });
      check("retired care relay answers 410 even for a transferred pet", soldLink.status === 410, `status ${soldLink.status}`);
    }

    // 68. Unknown pet numbers are not_found on both paths.
    {
      const n = await freshNonce();
      const msg = claimMsg(buyer.address, n);
      const sig = await buyer.signMessage({ message: msg });
      const rNo = await postClaim({ method: "wallet", address: buyer.address, signature: sig, message: msg, tokenId: "99999" });
      const bNo = (await rNo.json()) as any;
      check("wallet claim for an unknown pet is not_found", rNo.status === 404 && bNo.code === "not_found", JSON.stringify(bNo));
      const rNoE = await postClaim({ method: "email", email: "x@y.test", tokenId: "99999" });
      check("email claim for an unknown pet is not_found", rNoE.status === 404, `status ${rNoE.status}`);
    }

    // 69. Live-status fields on GET /api/runner/:serial + metadata Status attribute.
    {
      const state69 = await fetch(`${base}/api/runner/${clSerial}`).then(j);
      check("runner state exposes daysLived + careCount", typeof state69.daysLived === "number" && typeof state69.careCount === "number", JSON.stringify({ d: state69.daysLived, c: state69.careCount }));
      check("claimed pet reads custodial:false (self-custody owner)", state69.custodial === false, String(state69.custodial));
      const metaAlive = await fetch(`${base}/metadata/runner/${clTokenId}`).then(j);
      const statusAttr = (metaAlive.attributes as any[]).find((a) => a.trait_type === "Status");
      check("metadata carries a live Status attribute", statusAttr?.value === "Alive", JSON.stringify(statusAttr));
      await store.updateRunner(clSerial, { gone: true });
      const metaDead = await fetch(`${base}/metadata/runner/${clTokenId}`).then(j);
      const deadAttr = (metaDead.attributes as any[]).find((a) => a.trait_type === "Status");
      const lifeLeftAttr = (metaDead.attributes as any[]).find((a) => a.trait_type === "Life Left");
      check("metadata Status flips to Dead (no Life Left on a memorial)", deadAttr?.value === "Dead" && lifeLeftAttr === undefined, JSON.stringify(metaDead.attributes));
      await store.updateRunner(clSerial, { gone: false });
    }

    // ========= Pass-download capability (confused-deputy fix, task 31) =========
    // The .pkpass embeds the already-signed care links, so while real-value care
    // is possible the download REQUIRES an unguessable capability derived from
    // the pet's authToken (rotates with it on a claim). The legacy serial-only
    // URL is fail-secure: it serves only while the survival economy is
    // affirmatively OFF.
    {
      const capRow = (await store.getRunner(rSerial))!;
      const rCap = passDownloadCap(capRow.authToken);

      // 70. Legacy public URL is blocked on EITHER economy-on signal.
      config.modes.survivalLive = true;
      const legacyLive = await fetch(`${base}/runner-passes/${rSerial}.pkpass`);
      check("legacy pass URL blocked when survival live (404)", legacyLive.status === 404, `status ${legacyLive.status}`);
      config.modes.survivalLive = false;
      config.SURVIVAL_ENABLED = true; // flag on, vault env incomplete: still fail-secure
      const legacyIntent = await fetch(`${base}/runner-passes/${rSerial}.pkpass`);
      check("legacy pass URL blocked when SURVIVAL_ENABLED alone (fail-secure 404)", legacyIntent.status === 404, `status ${legacyIntent.status}`);
      config.modes.survivalLive = true;

      // 71. The capability URL serves the pass while the economy is on.
      const capOk = await fetch(`${base}/runner-passes/${rSerial}/${rCap}.pkpass`);
      const capBuf = Buffer.from(await capOk.arrayBuffer());
      check("capability pass URL serves when survival live", capOk.status === 200 && (capOk.headers.get("content-type") ?? "").includes("application/vnd.apple.pkpass"), `status ${capOk.status}`);
      check("capability pass is a zip (PK header)", capBuf.subarray(0, 2).toString() === "PK", capBuf.subarray(0, 2).toString("hex"));

      // 72. Wrong or malformed caps 404 exactly like an unknown serial (opaque).
      const wrongCap = await fetch(`${base}/runner-passes/${rSerial}/${"0".repeat(64)}.pkpass`);
      const shortCap = await fetch(`${base}/runner-passes/${rSerial}/deadbeef.pkpass`);
      const ghostSerial = await fetch(`${base}/runner-passes/no-such-serial/${rCap}.pkpass`);
      check("wrong cap 404", wrongCap.status === 404, `status ${wrongCap.status}`);
      check("malformed cap 404", shortCap.status === 404, `status ${shortCap.status}`);
      check("wrong cap is indistinguishable from an unknown serial", JSON.stringify(await wrongCap.json()) === JSON.stringify(await ghostSerial.json()), "");

      // 73. Public surfaces never carry the cap while the economy is on: state,
      // checkout poll, and metadata are all serial/tokenId-keyed and public.
      const stateOn = await fetch(`${base}/api/runner/${rSerial}`).then(j);
      check("economy-on: public state omits the pass URL", stateOn.applePassUrl === undefined && !stateOn.links?.applePass, JSON.stringify({ a: stateOn.applePassUrl, l: stateOn.links?.applePass }));
      const checkoutOn = await fetch(`${base}/api/runner/checkout/${rSerial}`).then(j);
      check("economy-on: checkout poll omits the pass URL", checkoutOn.applePassUrl === undefined && !checkoutOn.links?.applePass, "");
      const metaOn = await fetch(`${base}/metadata/runner/${rTokenId}`).then(j);
      check("economy-on: metadata never carries the cap", !JSON.stringify(metaOn).includes(rCap), "");
      check("economy-on: public state never carries the cap string", !JSON.stringify(stateOn).includes(rCap), "");

      // 74. The Apple web-service pass fetch (authToken header) is UNCHANGED.
      const wsOn = await fetch(`${base}/runner-apple/v1/passes/${config.PASS_TYPE_ID}/${rSerial}`, { headers: { authorization: `ApplePass ${rAuth}` } });
      check("apple web-service pass fetch still works while survival live", wsOn.status === 200, `status ${wsOn.status}`);

      // 75. Rotation: a wallet claim rotates the cap; the seller's old cap 404s
      // and the claim response carries the NEW owner's capability URL.
      const coCap = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "cap-claim@walletchi.test" }) }).then(j);
      for (let i = 0; i < 40; i++) {
        const s = await fetch(`${base}/api/runner/checkout/${coCap.serial}`).then(j);
        if (s.status === "ready" || s.status === "failed") break;
        await sleep(50);
      }
      const capPet = (await store.getRunner(coCap.serial))!;
      const oldCap = passDownloadCap(capPet.authToken);
      const preClaim = await fetch(`${base}/runner-passes/${capPet.serial}/${oldCap}.pkpass`);
      check("pre-claim: the minter's cap serves", preClaim.status === 200, `status ${preClaim.status}`);
      mock.setPetOwnerMock(capPet.tokenId!, buyer.address);
      {
        const n = await freshNonce();
        const msg = claimMsg(buyer.address, n);
        const sig = await buyer.signMessage({ message: msg });
        const rClaim = await postClaim({ method: "wallet", address: buyer.address, signature: sig, message: msg, tokenId: capPet.tokenId! });
        const bClaim = (await rClaim.json()) as any;
        const newCap = passDownloadCap((await store.getRunner(capPet.serial))!.authToken);
        check("claim 200 with a capability applePassUrl", rClaim.status === 200 && String(bClaim.applePassUrl ?? "").includes(`/runner-passes/${capPet.serial}/${newCap}.pkpass`), JSON.stringify({ url: bClaim.applePassUrl }));
        check("claim rotated the download cap", newCap !== oldCap, "");
        const oldCapAfter = await fetch(`${base}/runner-passes/${capPet.serial}/${oldCap}.pkpass`);
        check("seller's old cap 404s after the claim", oldCapAfter.status === 404, `status ${oldCapAfter.status}`);
        const newCapAfter = await fetch(`${base}/runner-passes/${capPet.serial}/${newCap}.pkpass`);
        check("new owner's cap serves after the claim", newCapAfter.status === 200, `status ${newCapAfter.status}`);
      }

      // 76b. Mint-session pass-link: the checkout POST returns a serial-bound
      // mint-session token (never on the serial-keyed poll); it exchanges for
      // the cap URL while the economy is on; forged / cross-pet tokens are
      // refused. This is how the inline Add-to-Wallet button works on mainnet
      // without exposing the cap on a public endpoint.
      const msCo = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "mint-session@walletchi.test" }) }).then(j);
      check("checkout POST returns a mint-session token", typeof msCo.mintSession === "string" && msCo.mintSession.length >= 32, JSON.stringify({ ms: typeof msCo.mintSession }));
      const msPoll = await fetch(`${base}/api/runner/checkout/${msCo.serial}`).then(j);
      check("checkout poll omits the mint-session token", msPoll.mintSession === undefined, "");
      const msPet = (await store.getRunner(msCo.serial))!;
      const msExpectedCap = passDownloadCap(msPet.authToken);
      const msLink = await fetch(`${base}/api/runner/pass-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: msCo.serial, mintSession: msCo.mintSession }) });
      const msBody = (await msLink.json()) as any;
      check("pass-link returns the cap URL for a valid mint-session (economy on)", msLink.status === 200 && String(msBody.applePassUrl ?? "").includes(`/runner-passes/${msCo.serial}/${msExpectedCap}.pkpass`), JSON.stringify({ s: msLink.status, u: msBody.applePassUrl }));
      const msForged = await fetch(`${base}/api/runner/pass-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: msCo.serial, mintSession: "0".repeat(48) }) });
      check("pass-link 403s a forged mint-session", msForged.status === 403, `status ${msForged.status}`);
      const msWrongPet = await fetch(`${base}/api/runner/pass-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: rSerial, mintSession: msCo.mintSession }) });
      check("pass-link 403s a mint-session bound to a different pet", msWrongPet.status === 403, `status ${msWrongPet.status}`);

      // 76. Demo posture (economy affirmatively off): the legacy public URL
      // serves again, the cap URL also serves, and the public state exposes the
      // capability applePassUrl for the site's Add-to-Wallet button.
      config.modes.survivalLive = false;
      config.SURVIVAL_ENABLED = false;
      const legacyDemo = await fetch(`${base}/runner-passes/${rSerial}.pkpass`);
      check("economy-off: legacy public pass URL still serves (demo unbroken)", legacyDemo.status === 200, `status ${legacyDemo.status}`);
      const capDemo = await fetch(`${base}/runner-passes/${rSerial}/${rCap}.pkpass`);
      check("economy-off: capability URL also serves", capDemo.status === 200, `status ${capDemo.status}`);
      const stateOff = await fetch(`${base}/api/runner/${rSerial}`).then(j);
      check("economy-off: public state exposes the capability applePassUrl", String(stateOff.applePassUrl ?? "").includes(`/runner-passes/${rSerial}/${rCap}.pkpass`), String(stateOff.applePassUrl));
    }

    // ============ ANTI-SYBIL compute wall (flag-gated; default OFF) ============
    // Everything above ran with ANTI_SYBIL_ENABLED off and must stay untouched.
    // This section flips the flag ON, exercises the risk gate end to end with a
    // REAL PoW solve against the same verify path production uses, then flips
    // the flag back OFF so later behavior is unaffected.
    {
      const { leadingZeroBits } = await import("../src/runner/sybil.js");
      const { createHash, createHmac } = await import("node:crypto");

      const savedSybil = {
        enabled: config.ANTI_SYBIL_ENABLED,
        bits: config.POW_DIFFICULTY_BITS,
        minElapsed: config.MINT_MIN_ELAPSED_MS,
        perIp: config.MINTS_PER_IP_PER_DAY,
        perSubnet: config.MINTS_PER_SUBNET_PER_DAY,
        fpCap: config.FINGERPRINT_MINT_CAP,
      };
      config.ANTI_SYBIL_ENABLED = true;
      config.POW_DIFFICULTY_BITS = 8; // fast in-process solve; verify path unchanged
      config.MINT_MIN_ELAPSED_MS = 0; // smoke submits instantly; raised for the too-fast test
      config.MINTS_PER_IP_PER_DAY = 50;
      config.MINTS_PER_SUBNET_PER_DAY = 50;
      config.FINGERPRINT_MINT_CAP = 2;

      function solveCounter(nonce: string, bits: number): number {
        for (let counter = 0; ; counter++) {
          const h = createHash("sha256").update(`${nonce}:${counter}`).digest();
          if (leadingZeroBits(h) >= bits) return counter;
        }
      }
      const solvedPow = async () => {
        const c = await fetch(`${base}/api/mint/challenge`).then(j);
        return { nonce: c.nonce, counter: solveCounter(c.nonce, c.bits), sig: c.sig, exp: c.exp, bits: c.bits };
      };
      const mint = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
        const res = await fetch(`${base}/api/runner/checkout`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        return { res, body: (await res.json()) as any };
      };

      // 77. Challenge issue shape.
      const chal = await fetch(`${base}/api/mint/challenge`).then(j);
      check("sybil: challenge issues nonce + bits + exp + sig + required", /^[0-9a-f]{32}$/.test(chal.nonce ?? "") && chal.bits === 8 && typeof chal.exp === "number" && /^[0-9a-f]{64}$/.test(chal.sig ?? "") && chal.required === true, JSON.stringify(chal));

      // 78 (a). Honest mint: valid PoW + fresh email + clean signals succeeds
      // and completes end to end (reaches ready).
      const happy = await mint({ email: "sybil.keeper@gmail.com", pow: await solvedPow(), fingerprint: "fp-sybil-a", honeypot: "", elapsedMs: 4200, botSignals: {} });
      check("sybil: honest mint (valid PoW, fresh email) accepted", happy.res.status === 200 && Boolean(happy.body.id), JSON.stringify(happy.body));
      let happyState: any = null;
      for (let i = 0; i < 40; i++) {
        happyState = await fetch(`${base}/api/runner/checkout/${happy.body.serial}`).then(j);
        if (happyState.status === "ready" || happyState.status === "failed") break;
        await sleep(50);
      }
      check("sybil: honest mint reaches ready (flag-on e2e)", happyState?.status === "ready" && Boolean(happyState?.tokenId), JSON.stringify({ s: happyState?.status }));

      // 79 (b). Same normalized email again: blocked, kind copy + machine code.
      const dup = await mint({ email: "sybil.keeper@gmail.com", pow: await solvedPow(), fingerprint: "fp-sybil-dup", elapsedMs: 4200 });
      check("sybil: duplicate normalized email blocked (already_minted)", dup.res.status === 403 && dup.body.code === "already_minted", JSON.stringify(dup.body));
      check("sybil: block copy is kind, not revealing internals", /one per keeper/i.test(dup.body.error ?? ""), String(dup.body.error));

      // 80 (c). Gmail dot/plus alias on googlemail.com: same keeper, blocked.
      const alias = await mint({ email: "s.y.b.i.l.keeper+more@googlemail.com", pow: await solvedPow(), fingerprint: "fp-sybil-alias", elapsedMs: 4200 });
      check("sybil: gmail dot/plus alias blocked (already_minted)", alias.res.status === 403 && alias.body.code === "already_minted", JSON.stringify(alias.body));

      // 81 (d). Disposable domain blocked.
      const dispo = await mint({ email: "burner@mailinator.com", pow: await solvedPow(), fingerprint: "fp-sybil-d", elapsedMs: 4200 });
      check("sybil: disposable domain blocked (disposable_email)", dispo.res.status === 403 && dispo.body.code === "disposable_email", JSON.stringify(dispo.body));

      // 82 (e). PoW: missing, corrupted signature, expired, and replayed.
      const noPow = await mint({ email: "no-pow@walletchi.test", fingerprint: "fp-sybil-e", elapsedMs: 4200 });
      check("sybil: missing PoW blocked (pow_required)", noPow.res.status === 403 && noPow.body.code === "pow_required", JSON.stringify(noPow.body));
      const badSigPow = { ...(await solvedPow()), sig: "0".repeat(64) };
      const badSig = await mint({ email: "bad-sig@walletchi.test", pow: badSigPow, elapsedMs: 4200 });
      check("sybil: corrupted PoW signature blocked (pow_invalid)", badSig.res.status === 403 && badSig.body.code === "pow_invalid", JSON.stringify(badSig.body));
      const oldExp = Math.floor(Date.now() / 1000) - 10;
      const oldNonce = "ab".repeat(16);
      const expiredPow = { nonce: oldNonce, counter: solveCounter(oldNonce, 8), sig: createHmac("sha256", config.SYBIL_PEPPER).update(`${oldNonce}|8|${oldExp}`).digest("hex"), exp: oldExp, bits: 8 };
      const expired = await mint({ email: "expired-pow@walletchi.test", pow: expiredPow, elapsedMs: 4200 });
      check("sybil: expired PoW blocked (pow_invalid)", expired.res.status === 403 && expired.body.code === "pow_invalid", JSON.stringify(expired.body));
      const reusable = await solvedPow();
      const first = await mint({ email: "replay-one@walletchi.test", pow: reusable, fingerprint: "fp-sybil-b", elapsedMs: 4200 });
      check("sybil: fresh nonce mints once", first.res.status === 200, JSON.stringify(first.body));
      const replayed = await mint({ email: "replay-two@walletchi.test", pow: reusable, fingerprint: "fp-sybil-c", elapsedMs: 4200 });
      check("sybil: replayed nonce blocked (pow_invalid)", replayed.res.status === 403 && replayed.body.code === "pow_invalid", JSON.stringify(replayed.body));

      // 83 (f). Honeypot filled: a human never sees that field.
      const honey = await mint({ email: "honey-bot@walletchi.test", pow: await solvedPow(), honeypot: "Fluffy", elapsedMs: 4200 });
      check("sybil: honeypot filled blocked (bot_detected)", honey.res.status === 403 && honey.body.code === "bot_detected", JSON.stringify(honey.body));

      // 83b. Automation self-report (navigator.webdriver).
      const wd = await mint({ email: "webdriver-bot@walletchi.test", pow: await solvedPow(), botSignals: { webdriver: true }, elapsedMs: 4200 });
      check("sybil: webdriver automation blocked (bot_detected)", wd.res.status === 403 && wd.body.code === "bot_detected", JSON.stringify(wd.body));

      // 84 (g). Submit faster than a human: server-side floor from the challenge
      // issue time (a direct caller cannot fake it), so a just-issued challenge
      // submitted instantly is too fast.
      config.MINT_MIN_ELAPSED_MS = 1200;
      const fast = await mint({ email: "speedy@walletchi.test", pow: await solvedPow(), elapsedMs: 90 });
      check("sybil: submit-too-fast blocked (too_fast)", fast.res.status === 403 && fast.body.code === "too_fast", JSON.stringify(fast.body));
      config.MINT_MIN_ELAPSED_MS = 0;

      // 85 (h). Velocity caps. ADVISORY BY DEFAULT since adc9634 (the
      // fingerprint is model-level on iOS and carrier NAT shares IPs, so
      // blocking on these only ever refused honest keepers): an over-cap mint
      // SUCCEEDS and the flag rides into the forensics row. With
      // VELOCITY_CAPS_ENFORCED=true the old blocking returns, with a SPLIT code
      // naming which cap bound. Both modes are proven here, enforced first so
      // the blocked attempt cannot disturb the counts the advisory one reads.
      const lastSignal = () => {
        const rows = (store as any).mintSignals as any[];
        return rows[rows.length - 1];
      };
      config.MINTS_PER_IP_PER_DAY = 2;
      config.VELOCITY_CAPS_ENFORCED = true;
      const ipCap = await mint({ email: "ip-capped@walletchi.test", pow: await solvedPow(), fingerprint: "fp-sybil-f", elapsedMs: 4200 });
      check("sybil: over per-IP cap ENFORCED blocks 429 with the split code", ipCap.res.status === 429 && ipCap.body.code === "too_many_ip", JSON.stringify(ipCap.body));
      config.VELOCITY_CAPS_ENFORCED = false;
      const ipAdv = await mint({ email: "ip-advisory@walletchi.test", pow: await solvedPow(), fingerprint: "fp-sybil-f2", elapsedMs: 4200 });
      check("sybil: over per-IP cap ADVISORY mints and flags", ipAdv.res.status === 200 && lastSignal()?.outcome === "minted" && String(lastSignal()?.botFlags ?? "").includes("velocity:ip="), JSON.stringify({ s: ipAdv.res.status, sig: lastSignal() }));
      config.MINTS_PER_IP_PER_DAY = 50;

      // 85b. Per-/24-subnet daily cap: same shape, both modes.
      config.MINTS_PER_SUBNET_PER_DAY = 2;
      config.VELOCITY_CAPS_ENFORCED = true;
      const subCap = await mint({ email: "subnet-capped@walletchi.test", pow: await solvedPow(), fingerprint: "fp-sybil-g", elapsedMs: 4200 });
      check("sybil: over per-subnet cap ENFORCED blocks 429 with the split code", subCap.res.status === 429 && subCap.body.code === "too_many_subnet", JSON.stringify(subCap.body));
      config.VELOCITY_CAPS_ENFORCED = false;
      const subAdv = await mint({ email: "subnet-advisory@walletchi.test", pow: await solvedPow(), fingerprint: "fp-sybil-g2", elapsedMs: 4200 });
      check("sybil: over per-subnet cap ADVISORY mints and flags", subAdv.res.status === 200 && String(lastSignal()?.botFlags ?? "").includes("velocity:subnet="), JSON.stringify({ s: subAdv.res.status, sig: lastSignal() }));
      config.MINTS_PER_SUBNET_PER_DAY = 50;

      // 85c. Repeated identical fingerprint (fp-sybil-a already minted once):
      // same shape, both modes.
      config.FINGERPRINT_MINT_CAP = 1;
      config.VELOCITY_CAPS_ENFORCED = true;
      const fpCap = await mint({ email: "fp-capped@walletchi.test", pow: await solvedPow(), fingerprint: "fp-sybil-a", elapsedMs: 4200 });
      check("sybil: repeated fingerprint ENFORCED blocks 429 with the split code", fpCap.res.status === 429 && fpCap.body.code === "too_many_fingerprint", JSON.stringify(fpCap.body));
      config.VELOCITY_CAPS_ENFORCED = false;
      const fpAdv = await mint({ email: "fp-advisory@walletchi.test", pow: await solvedPow(), fingerprint: "fp-sybil-a", elapsedMs: 4200 });
      check("sybil: repeated fingerprint ADVISORY mints and flags", fpAdv.res.status === 200 && String(lastSignal()?.botFlags ?? "").includes("velocity:fp="), JSON.stringify({ s: fpAdv.res.status, sig: lastSignal() }));
      config.FINGERPRINT_MINT_CAP = 2;

      // 85d. TOCTOU: a parallel burst with ONE email and DISTINCT valid PoW
      // solves must mint exactly once. Two layers close the race: the
      // in-process in-flight fast path and, beneath it, the ATOMIC
      // reserveEmail claim (unique-constraint semantics) that holds even
      // across instances.
      {
        const pows = await Promise.all([solvedPow(), solvedPow(), solvedPow(), solvedPow()]);
        const burst = await Promise.all(
          pows.map((pow, i) =>
            mint({ email: "race.keeper@walletchi.test", pow, fingerprint: `fp-race-${i}`, elapsedMs: 4200 }),
          ),
        );
        const okCount = burst.filter((b) => b.res.status === 200).length;
        const dupCount = burst.filter((b) => b.body.code === "already_minted").length;
        check("sybil: parallel same-email burst mints exactly once", okCount === 1 && dupCount === 3, JSON.stringify(burst.map((b) => ({ s: b.res.status, c: b.body.code }))));
      }

      // 85e. The atomic wall itself: two concurrent reserveEmail calls for one
      // hash yield exactly ONE claim (no await between check and claim in the
      // memory store; unique-constraint insert in Prisma), and a reserved
      // email reads as already minted from then on.
      {
        const rh = "smoke-atomic-reserve-hash";
        const [rA, rB] = await Promise.all([store.reserveEmail(rh), store.reserveEmail(rh)]);
        check("sybil: concurrent reserveEmail claims exactly once", (rA ? 1 : 0) + (rB ? 1 : 0) === 1, JSON.stringify({ rA, rB }));
        check("sybil: a reserved email reads as already minted", (await store.emailAlreadyMinted(rh)) === true, "");
        check("sybil: re-reserving a claimed email stays false", (await store.reserveEmail(rh)) === false, "");
      }

      // 86. Real client IP. Direct connection here, so the attested req.ip
      // path (bounded trust-proxy hops) resolves to a private hop and the
      // helper falls back to the leftmost non-private x-forwarded-for entry;
      // behind Render, req.ip is the platform-appended client and wins.
      const viaProxy = await mint(
        { email: "proxy-hop@walletchi.test", pow: await solvedPow(), fingerprint: "fp-sybil-h", elapsedMs: 4200 },
        { "x-forwarded-for": "10.0.0.9, 203.0.113.7, 127.0.0.1" },
      );
      check("sybil: mint via proxy header accepted", viaProxy.res.status === 200, JSON.stringify(viaProxy.body));
      const signals = (store as any).mintSignals as any[];
      check("sybil: recorded IP is the leftmost non-private XFF hop", signals.some((s) => s.ip === "203.0.113.7" && s.outcome === "minted"), JSON.stringify(signals.map((s) => s.ip)));

      // 87. Forensics: every attempt (blocked or minted) left a MintSignal row.
      // The enforced velocity blocks record their SPLIT codes, so a refusal
      // names its cause without needing a user report to diagnose.
      check(
        "sybil: blocked attempts recorded for forensics (incl. split velocity codes)",
        signals.some((s) => s.outcome === "already_minted") &&
          signals.some((s) => s.outcome === "pow_invalid") &&
          signals.some((s) => s.outcome === "too_many_ip") &&
          signals.some((s) => s.outcome === "too_many_subnet") &&
          signals.some((s) => s.outcome === "too_many_fingerprint"),
        JSON.stringify(signals.map((s) => s.outcome)),
      );
      // 4 clean mints + the 3 advisory over-cap mints from 85/85b/85c.
      check("sybil: successful mints recorded as minted", signals.filter((s) => s.outcome === "minted").length === 7, String(signals.filter((s) => s.outcome === "minted").length));

      // 88. Flag OFF again: mint behaves exactly as today (no PoW, no signals,
      // even a duplicate email sails through). Later sections unaffected.
      config.ANTI_SYBIL_ENABLED = false;
      const offAgain = await mint({ email: "sybil.keeper@gmail.com" });
      check("sybil: flag off restores today's behavior (no gate)", offAgain.res.status === 200 && Boolean(offAgain.body.id), JSON.stringify(offAgain.body));
      const offChal = await fetch(`${base}/api/mint/challenge`).then(j);
      check("sybil: challenge advertises required:false when flag off", offChal.required === false, String(offChal.required));

      config.ANTI_SYBIL_ENABLED = savedSybil.enabled;
      config.POW_DIFFICULTY_BITS = savedSybil.bits;
      config.MINT_MIN_ELAPSED_MS = savedSybil.minElapsed;
      config.MINTS_PER_IP_PER_DAY = savedSybil.perIp;
      config.MINTS_PER_SUBNET_PER_DAY = savedSybil.perSubnet;
      config.FINGERPRINT_MINT_CAP = savedSybil.fpCap;
    }

    // ====== F2/F4 on-site pet endpoints (by-owner + Privy care + pass-link) ======
    // Privy is stubbed here (no creds), so the auth helper takes the asserted
    // walletAddress: demo posture only, and fail-secure below proves the stub
    // path slams shut the moment real-value care is possible.
    {
      const meCo = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me-dashboard@walletchi.test" }) }).then(j);
      for (let i = 0; i < 40; i++) {
        const s = await fetch(`${base}/api/runner/checkout/${meCo.serial}`).then(j);
        if (s.status === "ready" || s.status === "failed") break;
        await sleep(50);
      }
      const mePet = (await store.getRunner(meCo.serial))!;
      const meTok = mePet.tokenId!;
      const postCare = (body: unknown) =>
        fetch(`${base}/api/pet/care`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const postLink = (body: unknown) =>
        fetch(`${base}/api/pet/pass-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

      // 89. by-owner enumeration follows on-chain ownerOf.
      const byRelayer = await fetch(`${base}/api/pets/by-owner?address=${relayer.address}`).then(j);
      check("by-owner: custodial mint listed under the relayer", byRelayer.pets?.some((p: any) => p.serial === meCo.serial && p.tokenId === meTok), JSON.stringify({ n: byRelayer.pets?.length }));
      check("by-owner: rejects a malformed address 400", (await fetch(`${base}/api/pets/by-owner?address=nope`)).status === 400, "");
      const byStranger = await fetch(`${base}/api/pets/by-owner?address=0x00000000000000000000000000000000000000AA`).then(j);
      check("by-owner: unknown wallet owns nothing", Array.isArray(byStranger.pets) && byStranger.pets.length === 0, JSON.stringify(byStranger.pets));
      // by-owner reads THROUGH the shared 60s owner cache now (RPC-amplification
      // fix), so drop the cache to make the simulated transfer visible at once.
      _resetClaimState();
      mock.setPetOwnerMock(meTok, buyer.address);
      const byBuyer = await fetch(`${base}/api/pets/by-owner?address=${buyer.address}`).then(j);
      const byRelayer2 = await fetch(`${base}/api/pets/by-owner?address=${relayer.address}`).then(j);
      const buyerRow = byBuyer.pets?.find((p: any) => p.tokenId === meTok);
      check("by-owner: transfer moves the pet to the buyer's list", Boolean(buyerRow) && !byRelayer2.pets?.some((p: any) => p.tokenId === meTok), JSON.stringify({ buyer: byBuyer.pets?.length }));
      check("by-owner: rows carry meters + status, no pass URLs", buyerRow?.status === "alive" && typeof buyerRow?.hunger === "number" && !JSON.stringify(byBuyer).includes(".pkpass"), JSON.stringify(buyerRow));

      // 90. The dashboard care relay is RETIRED (care() is owner-only on-chain):
      // the endpoint answers 410 with a machine code regardless of auth and
      // never touches the pet or the chain.
      const careGone410 = await postCare({ tokenId: meTok, action: "feed", walletAddress: buyer.address });
      const careGoneBody = (await careGone410.json()) as any;
      check("dashboard care relay retired (410 care_moved)", careGone410.status === 410 && careGoneBody.code === "care_moved", JSON.stringify(careGoneBody));
      check("retired dashboard care has no side effects (egg not hatched)", (await store.getRunner(meCo.serial))!.hatched === false, "");

      // 91. Fail-secure: the stub (asserted-wallet) auth path is refused outright
      // whenever real-value care is possible (pass-link still authenticates).
      config.SURVIVAL_ENABLED = true;
      const linkSecure = await postLink({ tokenId: meTok, walletAddress: buyer.address });
      check("pass-link: stub auth refused 503 when SURVIVAL_ENABLED (fail-secure)", linkSecure.status === 503, `status ${linkSecure.status}`);
      config.SURVIVAL_ENABLED = false;

      // 92. Privy pass-link: owner proof -> capability URL; a changed owner
      // rotates exactly like a claim (seller's pass + links die).
      const preAuth = (await store.getRunner(meCo.serial))!.authToken;
      const linkWrong = await postLink({ tokenId: meTok, walletAddress: buyer2.address });
      check("pass-link: non-owner rejected 403", linkWrong.status === 403, `status ${linkWrong.status}`);
      const linkOk = await postLink({ tokenId: meTok, walletAddress: buyer.address });
      const linkBody = (await linkOk.json()) as any;
      const postRow = (await store.getRunner(meCo.serial))!;
      check("pass-link: owner gets a capability pass URL", linkOk.status === 200 && String(linkBody.applePassUrl ?? "").includes(`/runner-passes/${meCo.serial}/`) && String(linkBody.applePassUrl).endsWith(".pkpass"), JSON.stringify(linkBody));
      check("pass-link: new on-chain owner rotates the authToken (claim parity)", postRow.authToken !== preAuth && postRow.ownerAddress.toLowerCase() === buyer.address.toLowerCase(), "");
      const linkAgain = await postLink({ tokenId: meTok, walletAddress: buyer.address });
      const againRow = (await store.getRunner(meCo.serial))!;
      check("pass-link: same owner re-request does NOT rotate again", linkAgain.status === 200 && againRow.authToken === postRow.authToken, "");
    }

    // ====== Player rewards (SEASON 2, NO CLAIMS): read-only surface + the 410s ======
    // Nobody claims anything any more. The read must still degrade to a warming
    // state when the distributor is dark, the retired claim surfaces must answer
    // kindly (passes already in wallets still carry the collect link), and NOTHING
    // a user can tap may move a token.
    {
      const rwCo = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "rewards-pet@walletchi.test" }) }).then(j);
      for (let i = 0; i < 40; i++) {
        const s = await fetch(`${base}/api/runner/checkout/${rwCo.serial}`).then(j);
        if (s.status === "ready" || s.status === "failed") break;
        await sleep(50);
      }
      const rwTok = (await store.getRunner(rwCo.serial))!.tokenId!;
      // Raw amounts are bigints; plain JSON.stringify throws on them.
      const jb = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
      const postClaim = (body: unknown) =>
        fetch(`${base}/api/pet/${rwTok}/rewards/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

      // 96. Flag OFF: the read returns a clean warming state (never an error).
      const offRead = await fetch(`${base}/api/pet/${rwTok}/rewards`).then(j);
      check("rewards read returns rewardsLive:false cleanly when off", offRead.rewardsLive === false && offRead.claimable === undefined, JSON.stringify(offRead));
      // The claim endpoint is RETIRED in every posture, flag on or off: there is no
      // configuration in which a user claims a reward.
      const offClaim = await postClaim({ walletAddress: relayer.address });
      const offClaimBody = (await offClaim.json()) as any;
      check("rewards claim endpoint is 410 rewards_pushed even while off", offClaim.status === 410 && offClaimBody.code === "rewards_pushed", JSON.stringify(offClaimBody));

      // 97. Flag ON against the mock: the read still shows what is accruing (the
      // pet page needs it), it is just nothing anyone can act on.
      config.modes.rewardsLive = true;
      mock.setRewardsEpochNowMock(5);
      mock.mockSetReward(rwTok, 2, 5n * 10n ** 18n);
      mock.mockSetReward(rwTok, 3, 7n * 10n ** 18n);
      const onRead = await fetch(`${base}/api/pet/${rwTok}/rewards`).then(j);
      check("rewards read live returns a pending list with amounts", onRead.rewardsLive === true && Array.isArray(onRead.claimable) && onRead.claimable.length >= 2 && onRead.claimable.every((c: any) => typeof c.epoch === "number" && typeof c.amount?.whole === "number" && typeof c.amount?.raw === "string"), JSON.stringify(onRead));
      check("rewards read totals the pending whole amount", onRead.totalClaimableWhole >= 12 && typeof onRead.epochNow === "number", JSON.stringify({ total: onRead.totalClaimableWhole, epochNow: onRead.epochNow }));

      // 98. NO CLAIMS: the endpoint is 410 for the OWNER too, and it is inert. The
      // pendings are unchanged afterwards, which is the assertion that matters: a
      // retired endpoint that quietly still spent gas would look identical from the
      // status code alone.
      const beforeQueue = relayer.pending;
      const claimOwner = await postClaim({ walletAddress: relayer.address });
      const claimOwnerBody = (await claimOwner.json()) as any;
      check("rewards claim is 410 for the owner too (no claims, ever)", claimOwner.status === 410 && claimOwnerBody.code === "rewards_pushed", JSON.stringify(claimOwnerBody));
      check("rewards claim without auth is the same 410 (not an auth oracle)", (await postClaim({})).status === 410, "");
      const afterRead = await fetch(`${base}/api/pet/${rwTok}/rewards`).then(j);
      check(
        "the retired claim moved nothing: pendings and the write queue are untouched",
        afterRead.totalClaimableWhole === onRead.totalClaimableWhole && relayer.pending === beforeQueue,
        JSON.stringify({ before: onRead.totalClaimableWhole, after: afterRead.totalClaimableWhole }),
      );

      // 99. The WALLET PASS collect link. Passes already in wallets still carry it,
      // so the GET (the tap) is a friendly page saying the rewards come by
      // themselves, and the POST is the machine-readable 410. Neither spends an RPC
      // call, so the page answers even without a valid signature.
      const rwAuth = (await store.getRunner(rwCo.serial))!.authToken;
      const collectSig = signTag(rwAuth, actionPayload(rwCo.serial, "rewards-collect"));
      const colGet = await fetch(`${base}/api/runner/${rwCo.serial}/rewards/collect?s=${collectSig}`);
      const colGetHtml = await colGet.text();
      check("pass collect GET explains that rewards arrive by themselves", colGet.status === 200 && /come to you now/i.test(colGetHtml) && /every couple of hours/i.test(colGetHtml), colGetHtml.slice(0, 160));
      check("pass collect GET is no longer an auto-POST interstitial", !/method="post"/i.test(colGetHtml), colGetHtml.slice(0, 160));
      const colUnsigned = await fetch(`${base}/api/runner/${rwCo.serial}/rewards/collect`);
      check("pass collect GET answers without spending a signature check or an RPC", colUnsigned.status === 200, `status ${colUnsigned.status}`);
      const colPost = await fetch(`${base}/api/runner/${rwCo.serial}/rewards/collect?s=${collectSig}`, { method: "POST" });
      const colPostBody = (await colPost.json()) as any;
      check("pass collect POST is 410 rewards_pushed", colPost.status === 410 && colPostBody.code === "rewards_pushed", JSON.stringify(colPostBody));
      // And a NEW pass stops offering the button at all: a link whose only job is
      // to say collecting was unnecessary is a phantom feature.
      const rwCard = (await assembleRunnerPass((await store.getRunner(rwCo.serial))!)).passJson.storeCard as any;
      const rwRewardsRow = rwCard.backFields.find((f: any) => f.key === "collect");
      check(
        "pass rewards row states the push and offers nothing to tap",
        Boolean(rwRewardsRow) && rwRewardsRow.attributedValue === undefined && /automatically/i.test(rwRewardsRow.value ?? ""),
        JSON.stringify(rwRewardsRow),
      );

      // 99b. THE PUSH ENGINE (the thing that replaced every claim above). One cycle
      // must: pay a pet that earned an epoch, NEVER pay a dead one, forfeit that
      // dead pet's share to the survivors, and pay the CHAMPION even though its own
      // clock has lapsed (the season-2 immortality carve-out).
      {
        const pushPet = await mintPet("push-alive@walletchi.test");
        const deadPet = await mintPet("push-dead@walletchi.test");
        mock.mockSetReward(pushPet.tokenId, 1, 4n * 10n ** 18n);
        mock.mockSetReward(deadPet.tokenId, 1, 6n * 10n ** 18n);
        mock.killPet(deadPet.tokenId); // earned its share, then let a need lapse
        // The season settled back in test 53 and was reset so later sections saw an
        // open season; put it back into the settled posture with the same champion.
        mock.mockSettleSeason(cTokenId);
        // The champion's own clock lapses after it won. On-chain it stays alive
        // forever (immortal winner); it must therefore be PUSHED, not forfeited.
        mock.expirePet(cTokenId, 1);
        check("champion stays alive after its clock lapses (immortal winner)", (await mock.petState(cTokenId)).dead === false && (await mock.petAlive(cTokenId)) === true, "");

        const cycle = (await runRewardsPush(ctx))!;
        const deadIds = new Set<string>();
        for (const r of await store.allMintedRunners()) {
          if (r.tokenId && (await mock.petState(r.tokenId)).dead) deadIds.add(r.tokenId);
        }
        check(
          "push cycle pays a pet that earned a finished epoch",
          mock.pushedRewards.some((p: any) => p.tokenId === pushPet.tokenId && p.epoch === 1 && p.raw === 4n * 10n ** 18n) && cycle.pushedPets > 0 && cycle.pushedRaw > 0n,
          JSON.stringify({ pushed: cycle.pushedPets, raw: cycle.pushedRaw.toString() }),
        );
        check(
          "push cycle never pays a DEAD pet (any of them)",
          mock.pushedRewards.every((p: any) => !deadIds.has(p.tokenId)) && deadIds.has(deadPet.tokenId),
          JSON.stringify({ dead: [...deadIds], paid: mock.pushedRewards.map((p: any) => p.tokenId) }),
        );
        check(
          "push cycle forfeits the dead pet's unclaimed share to the survivors",
          mock.forfeitedRewards.some((f: any) => f.tokenId === deadPet.tokenId && f.epoch === 1) && cycle.forfeitedPets > 0,
          JSON.stringify({ forfeits: mock.forfeitedRewards, n: cycle.forfeitedPets }),
        );
        check(
          "push cycle pays the immortal champion despite its lapsed clock",
          mock.pushedRewards.some((p: any) => p.tokenId === cTokenId),
          jb(mock.pushedRewards.filter((p: any) => p.tokenId === cTokenId)),
        );
        check("push cycle scanned the finished epochs and read cleanly", cycle.epochsScanned === 5 && cycle.skippedReads === 0, JSON.stringify({ scanned: cycle.epochsScanned, skipped: cycle.skippedReads }));
        // The tail is gated on survivalLive, which is off here, so this cycle did
        // NOT settle anything: the settlement half is proven separately below.
        check("push cycle leaves the settlement tail alone while survival is off", cycle.prizePushed === false && cycle.residualSwept === false, jb(cycle));
        // A second cycle re-reads and finds the same epochs already paid, so it
        // pays nobody twice. This is the idempotence a 2h cron lives or dies on.
        const paidCount = mock.pushedRewards.length;
        const cycle2 = (await runRewardsPush(ctx))!;
        check("a repeat push cycle pays nobody twice", mock.pushedRewards.length === paidCount && cycle2.pushedPets === 0, JSON.stringify({ before: paidCount, after: mock.pushedRewards.length }));
        // The epoch window is a real knob, not decoration: it is the only way to
        // catch up epochs an outage pushed out of range before settlement hands
        // them to the champion, so it has to be honoured without a deploy.
        const prevWindow = config.REWARDS_PUSH_EPOCH_WINDOW;
        config.REWARDS_PUSH_EPOCH_WINDOW = 2;
        check("REWARDS_PUSH_EPOCH_WINDOW bounds how far back a cycle scans", (await runRewardsPush(ctx))!.epochsScanned === 2, "");
        config.REWARDS_PUSH_EPOCH_WINDOW = prevWindow;
      }

      // 99c. THE SETTLEMENT TAIL: the season is already settled (the finalize poke
      // paid the pot back in test 53). The tail retries a prize the care token
      // refused and sweeps the distributor residual to the champion, both
      // permissionlessly, and both exactly once.
      {
        const prevSurvival = config.modes.survivalLive;
        config.modes.survivalLive = true;
        mock.mockDeferPrize(cTokenId, 5n * 10n ** 18n); // finalize()'s transfer was refused
        const tail = await runSettlementTail(ctx);
        check("settlement tail re-pushes the escrowed prize to the winner's TBA", tail.prizePushed === true && mock.prizePushes.some((p: any) => p.tokenId === cTokenId && p.raw === 5n * 10n ** 18n), jb(mock.prizePushes));
        check("settlement tail sweeps the rewards residual to the champion", tail.residualSwept === true && mock.residualSweptTo === cTokenId, JSON.stringify({ to: mock.residualSweptTo }));
        const pushesAfter = mock.prizePushes.length;
        const tail2 = await runSettlementTail(ctx);
        check("settlement tail is idempotent (nothing left to push or sweep)", tail2.prizePushed === false && tail2.residualSwept === false && mock.prizePushes.length === pushesAfter, JSON.stringify(tail2));
        // WIRING: the finalize poke runs the tail on every tick, not only the tick
        // that finalized, so a prize the token refused is retried in minutes rather
        // than at the next 2h push. isOver() is already false here (settled).
        mock.mockDeferPrize(cTokenId, 2n * 10n ** 18n);
        await runFinalizePoke(ctx);
        const lastPush = mock.prizePushes.at(-1)!;
        check("the finalize poke runs the settlement tail on a settled season", mock.prizePushes.length === pushesAfter + 1 && lastPush.raw === 2n * 10n ** 18n, `${lastPush.tokenId}:${lastPush.raw}`);
        // Once the residual is swept, no epoch can pay again (SeasonSettled), and
        // the engine stops rather than burning gas on a certain revert per epoch.
        const settledCycle = (await runRewardsPush(ctx))!;
        check("push cycle stops once the season is settled (SeasonSettled)", settledCycle.pushedPets === 0 && settledCycle.forfeitedPets === 0, jb(settledCycle));
        config.modes.survivalLive = prevSurvival;
      }

      config.modes.rewardsLive = false;
      // Off again: the retired surfaces answer identically (they never consult the flag).
      const colOff = await fetch(`${base}/api/runner/${rwCo.serial}/rewards/collect?s=${collectSig}`, { method: "POST" });
      check("pass collect POST is 410 with rewards off too", colOff.status === 410, `status ${colOff.status}`);
      check("push cycle is a clean no-op when the distributor is dark", (await runRewardsPush(ctx)) === null, "");
      // Same discipline as the drama section: the settled season this block staged
      // must not leak into later ones (care reverts GameOver while it stands).
      mock.resetSeasonMock();
    }

    // ====== Audit hardening: render clamp, claim rate limit, fail-closed guard ======
    {
      // 93. Preview ids outside 1..RUNNER_SUPPLY_CAP are rejected (bounded render
      // key space; in-range ids render exactly as before).
      const overCap = await fetch(`${base}/api/pet/2001/preview.png`);
      check("preview.png rejects tokenId over the supply cap (404)", overCap.status === 404, `status ${overCap.status}`);
      const zeroId = await fetch(`${base}/api/pet/0/preview.png`);
      check("preview.png rejects tokenId 0 (404)", zeroId.status === 404, `status ${zeroId.status}`);
      const inRange = await fetch(`${base}/api/pet/2000/preview.png`);
      check("preview.png still renders the top in-range id", inRange.status === 200, `status ${inRange.status}`);

      // 94. Claim endpoints are rate-limited per IP (generous 20/min fixed window).
      _resetClaimState();
      let flooded: any = null;
      for (let i = 0; i < 21; i++) flooded = await fetch(`${base}/api/claim/nonce`);
      check("claim nonce flood hits the rate limit (429 + Retry-After)", flooded.status === 429 && Boolean(flooded.headers.get("retry-after")), `status ${flooded.status}`);
      _resetClaimState();
      const afterReset = await fetch(`${base}/api/claim/nonce`);
      check("claim rate-limit state clears with the test hook", afterReset.status === 200, `status ${afterReset.status}`);

      // 95. The care-relay fail-closed guard is RETIRED with the relay itself:
      // ownership on a care is now enforced by the chain (care() only accepts
      // the owner's signature), so an ownerOf outage cannot widen anything. The
      // retired route answers 410 regardless of posture.
      const fcRow = (await store.getRunner(rSerial))!;
      config.modes.survivalLive = true;
      const fcLive = await fetch(`${base}/api/runner/${rSerial}/action/feed?s=${signTag(fcRow.authToken, actionPayload(rSerial, "feed"))}`, { method: "POST" });
      check("retired care relay answers 410 while survival live", fcLive.status === 410, `status ${fcLive.status}`);
      config.modes.survivalLive = false;
      _resetClaimState();
    }

    // ====== Google Wallet save prerequisites (hosted logo + origins) ======
    {
      // The loyalty-class programLogo URL must serve a REAL square PNG: Google
      // fetches it at class creation and a 404 fails the whole save flow.
      const logo = await fetch(`${base}/assets/logo.png`);
      const logoBuf = Buffer.from(await logo.arrayBuffer());
      const logoW = logoBuf.length > 24 ? logoBuf.readUInt32BE(16) : 0;
      const logoH = logoBuf.length > 24 ? logoBuf.readUInt32BE(20) : 0;
      check(
        "assets/logo.png serves a PNG (Google programLogo target)",
        logo.status === 200 && (logo.headers.get("content-type") ?? "").includes("image/png") && logoBuf.subarray(1, 4).toString() === "PNG",
        `status ${logo.status}`,
      );
      check("assets/logo.png is square and >= 512px", logoW === logoH && logoW >= 512, `${logoW}x${logoH}`);

      // Save-JWT origins include BOTH the apex and www variants of the web app
      // (Google rejects a save from an origin missing from the allowlist).
      const { saveOrigins } = await import("../src/runner/google.js");
      const savedUrls = { web: config.WEB_APP_URL, pub: config.PUBLIC_BASE_URL };
      config.WEB_APP_URL = "https://playwalletchi.com";
      config.PUBLIC_BASE_URL = "https://api.playwalletchi.com";
      const origins = saveOrigins();
      check(
        "google save origins include apex + www of the web app",
        origins.includes("https://playwalletchi.com") && origins.includes("https://www.playwalletchi.com"),
        JSON.stringify(origins),
      );
      config.WEB_APP_URL = savedUrls.web;
      config.PUBLIC_BASE_URL = savedUrls.pub;
      const localOrigins = saveOrigins();
      check(
        "google save origins add no www variant for localhost",
        !localOrigins.some((o: string) => o.includes("www.localhost")),
        JSON.stringify(localOrigins),
      );
    }

    // ====== Global per-IP rate limiter (generous 120/min; loopback exempt) ======
    {
      const { _resetGlobalRateLimit } = await import("../src/app.js");
      _resetGlobalRateLimit();
      // A public-IP caller (spoofed via XFF; the direct socket is loopback so
      // clientIp falls back to the leftmost public hop) is capped at 120/min.
      let lastStatus = 0;
      for (let i = 0; i < 121; i++) {
        const rl = await fetch(`${base}/api/season/stats`, {
          headers: { "x-forwarded-for": "198.51.100.9" },
        });
        lastStatus = rl.status;
      }
      check("global limiter caps a public IP at 120/min (429)", lastStatus === 429, `status ${lastStatus}`);
      // Loopback (health checks, local dev, this smoke) is exempt: request 122+
      // from the direct socket still serves.
      const exempt = await fetch(`${base}/api/season/stats`);
      check("global limiter exempts loopback callers", exempt.status === 200, `status ${exempt.status}`);
      _resetGlobalRateLimit();
    }

    // ====== FIVE NEEDS (redesign): chain seam, death, naming, card, tap UX ======
    // Each pet now carries FIVE need timestamps (0=FEED 1=WATER 2=PLAY 3=TOY
    // 4=EXPLORE); care refreshes ONLY the targeted need; ANY need unserved a
    // full lifeTtl kills. This section drives the server seam end to end
    // against the five-need mock vault.
    {
      const {
        careAttemptThrottled,
        _careThrottleReset,
        _careInFlight,
        _careDedupReset,
        markCareCharged,
        careRecentlyCharged,
      } = await import("../src/runner/routes.js");
      const { careCooldownSecondsLeft, petNeedPctFor, petNeedSecondsLeftFor, NEED_ACTIONS } = await import("../src/runner/season.js");
      const mock = relayer.chain as any;
      const ttlSec = (await mock.petVaultConfig()).lifeTtlSeconds as number;
      config.modes.survivalLive = true;
      _resetClaimState();

      // (a) HATCH: the first care of ANY actionType fills all five bowls; the
      // reconcile hatches the DB pet and projects full meters from the chain.
      const fa = await mintPet("fiveneeds-a@walletchi.test");
      await store.updateRunner(fa.serial, {
        hatched: false, gone: false, critical: false, careCount: 0, lastCareAt: null,
        lastNeedsAt: null, lastEvent: null, lastPushAt: null, lastTickAt: new Date(),
      });
      await mock.careForPet(fa.tokenId, 2); // hatch via PLAY: any action hatches
      const hatchedFa = await reconcilePet(ctx, (await store.getRunner(fa.serial))!, { now: new Date(), rng: () => 0.9 });
      check("five needs: any-action first care hatches the egg", hatchedFa.hatched === true && hatchedFa.careCount === 1, JSON.stringify({ h: hatchedFa.hatched, c: hatchedFa.careCount }));
      const needsFa = await mock.petNeeds(fa.tokenId);
      check(
        "five needs: hatch stamps all five needs to the same instant",
        needsFa.needAt.every((t: number) => t > 0 && t === needsFa.needAt[0]),
        JSON.stringify(needsFa),
      );
      check(
        "five needs: meters project full from the fresh chain stamps",
        hatchedFa.hunger === 100 && hatchedFa.thirst === 100 && hatchedFa.joy === 100,
        JSON.stringify({ h: hatchedFa.hunger, t: hatchedFa.thirst, j: hatchedFa.joy }),
      );

      // Alive state payload (8.2): per-need countdowns in canonical order +
      // lastActionAt = max(needsOf).
      const stateFa = await fetch(`${base}/api/runner/${fa.serial}`).then(j);
      check(
        "five needs: alive state payload carries 5 per-need countdowns in canonical order",
        Array.isArray(stateFa.needs) &&
          stateFa.needs.length === 5 &&
          stateFa.needs.map((n: any) => n.action).join(",") === "feed,water,play,toy,explore" &&
          stateFa.needs.every((n: any) => typeof n.secondsLeft === "number" && n.secondsLeft > 0),
        JSON.stringify(stateFa.needs),
      );
      check(
        "five needs: state payload exposes lastActionAt = max(needsOf)",
        typeof stateFa.lastActionAt === "number" && stateFa.lastActionAt >= needsFa.needAt[0],
        JSON.stringify({ lastActionAt: stateFa.lastActionAt }),
      );

      // A care refreshes ONLY the targeted need (the other four keep their stamps).
      await sleep(1100); // stamps are second-resolution
      await mock.careForPet(fa.tokenId, 1); // WATER only
      const needsFa2 = await mock.petNeeds(fa.tokenId);
      check(
        "five needs: care resets ONLY the targeted need",
        needsFa2.needAt[1] > needsFa2.needAt[0] && needsFa2.needAt[0] === needsFa.needAt[0] && needsFa2.needAt[3] === needsFa.needAt[3],
        JSON.stringify(needsFa2),
      );
      let badAction = "";
      try {
        await mock.careForPet(fa.tokenId, 5);
      } catch (e) {
        badAction = String(e);
      }
      check("five needs: actionType 5 reverts BadAction (no such need)", /BadAction/.test(badAction), badAction);

      // (d) The COMBINED wallet card (audit #3): Apple SILENTLY DROPS storeCard
      // fields past its per-row limits, so ALL FIVE needs ride ONE compact
      // field (glyph + countdown, MOST URGENT FIRST) beside STATUS on the
      // secondary row, and SURVIVES + the narration share the auxiliary row:
      // 2 + 2 is Apple's whole budget, nothing for it to truncate away. At this
      // point WATER was just re-cared, so it must sort LAST; FEED (oldest
      // stamp, canonical tie-winner) leads.
      _resetClaimState();
      const faRow = (await store.getRunner(fa.serial))!;
      const pctFa = await petNeedPctFor(ctx, faRow);
      const secsFa = await petNeedSecondsLeftFor(ctx, faRow);
      check(
        "five needs: chain-derived per-need percents for a live pet",
        Array.isArray(pctFa) && pctFa!.length === 5 && pctFa!.every((v: number) => v >= 0 && v <= 100),
        JSON.stringify(pctFa),
      );
      check(
        "five needs: chain-derived per-need countdowns for a live pet",
        Array.isArray(secsFa) && secsFa!.length === 5 && secsFa!.every((v: number) => v > 0),
        JSON.stringify(secsFa),
      );
      const d3SC = (await assembleRunnerPass(faRow, { needPct: pctFa, needSecondsLeft: secsFa })).passJson.storeCard as any;
      check(
        "card front: STATUS + SURVIVES only, narration below, and NO five-timer row",
        d3SC.secondaryFields.map((f: any) => f.key).join(",") === "petstatus,life" &&
          d3SC.auxiliaryFields.map((f: any) => f.key).join(",") === "status" &&
          d3SC.secondaryFields.length + d3SC.auxiliaryFields.length === 3 &&
          Array.isArray(d3SC.primaryFields) && d3SC.primaryFields.length === 0,
        JSON.stringify({ s: d3SC.secondaryFields.map((f: any) => f.key), a: d3SC.auxiliaryFields.map((f: any) => f.key) }),
      );
      // The per-need countdown row was REMOVED from the card on purpose: five
      // clocks made the keeper compute the minimum themselves, and only that
      // minimum decides anything. Assert it cannot creep back.
      const cardJson = JSON.stringify(d3SC);
      check(
        "card front: no per-need glyph row (only the one SURVIVES clock decides)",
        !["🍯", "🎾", "🧸", "🧭"].some((g) => cardJson.includes(g)),
        cardJson.slice(0, 200),
      );
      // (d1) SURVIVES: the at-a-glance death countdown. Five needs means the
      // pet dies when the SOONEST timer lapses, so the life clock is the
      // MINIMUM of the five, never an average and never the feed timer alone.
      // Apple gets it as a relative date so the device redraws the countdown
      // itself between pushes; a lapsed or unknowable clock renders nothing at
      // all rather than a wrong one.
      check(
        "survives: the life clock is the MINIMUM of the five need timers",
        minNeedSecondsLeft(secsFa) === Math.min(...secsFa!),
        JSON.stringify({ min: minNeedSecondsLeft(secsFa), secs: secsFa }),
      );
      check(
        "survives: a lapsed or unknowable clock yields null (never a wrong death time)",
        minNeedSecondsLeft([0, 5, 5, 5, 5]) === null &&
          minNeedSecondsLeft(null) === null &&
          minNeedSecondsLeft([10, 10, 10]) === null,
        "",
      );
      check(
        "survives: hour-granular short form rounds DOWN and never flatters",
        survivesShort(59 * 60) === "under 1h" &&
          survivesShort(18 * 3600 + 3599) === "~18h" &&
          survivesShort(3 * 86_400 + 3600) === "~3d",
        JSON.stringify([survivesShort(59 * 60), survivesShort(18 * 3600 + 3599), survivesShort(3 * 86_400 + 3600)]),
      );
      const lifeF = d3SC.secondaryFields.find((f: any) => f.key === "life");
      const lifeAtMs = Date.parse(String(lifeF?.value));
      check(
        "survives: RELATIVE date at the soonest need, on the secondary row, no banner spam",
        lifeF?.label === "SURVIVES" &&
          lifeF?.isRelative === true &&
          lifeF?.dateStyle === "PKDateStyleShort" &&
          lifeF?.timeStyle === "PKDateStyleShort" &&
          lifeF?.changeMessage === undefined &&
          Number.isFinite(lifeAtMs) &&
          Math.abs(lifeAtMs - (Date.now() + Math.min(...secsFa!) * 1000)) < 10_000,
        JSON.stringify(lifeF),
      );
      const d3Pct = (await assembleRunnerPass(faRow, { needPct: pctFa })).passJson.storeCard as any;
      check(
        "card front: without chain countdowns there is no clock and no glyph row",
        !["🍯", "🎾", "🧸", "🧭"].some((g) => JSON.stringify(d3Pct).includes(g)) &&
          !d3Pct.secondaryFields.some((f: any) => f.key === "life"),
        JSON.stringify(d3Pct.secondaryFields.map((f: any) => f.key)),
      );
      check(
        "survives: no chain countdowns means NO life field (percents are not honest time)",
        !d3Pct.auxiliaryFields.some((f: any) => f.key === "life") &&
          d3Pct.auxiliaryFields.map((f: any) => f.key).join(",") === "status",
        JSON.stringify(d3Pct.auxiliaryFields.map((f: any) => f.key)),
      );

      // (d2) CARE BALANCE on the FRONT: the pet's live TBA holdings render
      // number-first ("100 CARE") as the THIRD header field for a living pet.
      // Header is the one spot that cannot collide with the five-needs fix:
      // Apple caps secondary + auxiliary at four total and drops overflow
      // silently, so the secondary row stays STATUS + the ONE combined NEEDS
      // field; headers cap at three and are never dropped (the logo narrows
      // instead), and petno + alive + carebal is exactly three. A failed chain
      // read OMITS the field (null, never a wrong "0 CARE"); a memorial never
      // shows a bank ticker even if a caller passes one. The Google object
      // mirrors it as a "carebal" text module under the same living-pet gate.
      const { petCareBalanceFor } = await import("../src/runner/season.js");
      const balFa = await petCareBalanceFor(ctx, faRow);
      check(
        "care balance: live TBA read renders number-first '<n> CARE'",
        balFa === "100 CARE",
        String(balFa),
      );
      // ALIVE renders only from a verified on-chain headcount, so verify one first.
      const { refreshSeasonSnapshot: refreshForHeader } = await import("../src/runner/season.js");
      await refreshForHeader(ctx, true);
      const balSC = (await assembleRunnerPass(faRow, { needPct: pctFa, needSecondsLeft: secsFa, careBalance: balFa }))
        .passJson.storeCard as any;
      check(
        "care balance: alive front header = NO. + ALIVE + CARE (3 fields, Apple's header cap)",
        balSC.headerFields.map((f: any) => f.key).join(",") === "petno,alive,carebal" &&
          balSC.headerFields[2].label === "CARE" &&
          /^\d[\d,]* CARE$/.test(String(balSC.headerFields[2].value)),
        JSON.stringify(balSC.headerFields),
      );
      check(
        "care balance: NO changeMessage (a raw balance banner is noise); rows unchanged",
        balSC.headerFields[2].changeMessage === undefined &&
          balSC.secondaryFields.map((f: any) => f.key).join(",") === "petstatus,life" &&
          balSC.auxiliaryFields.map((f: any) => f.key).join(",") === "status",
        JSON.stringify({ cm: balSC.headerFields[2].changeMessage, s: balSC.secondaryFields.map((f: any) => f.key) }),
      );
      // Read failure: an uncached TBA whose balance read throws yields null and
      // the assembled front simply has no carebal field.
      const origCareBalanceOf = mock.careBalanceOf.bind(mock);
      mock.careBalanceOf = async () => {
        throw new Error("mock: rpc down");
      };
      const failRow = { ...faRow, tbaAddress: "0x00000000000000000000000000000000000000fa" } as typeof faRow;
      const balFail = await petCareBalanceFor(ctx, failRow);
      mock.careBalanceOf = origCareBalanceOf;
      check("care balance: a failed chain read yields null (omit, never '0 CARE')", balFail === null, String(balFail));
      const failSC = (await assembleRunnerPass(failRow, { needPct: pctFa, needSecondsLeft: secsFa, careBalance: balFail }))
        .passJson.storeCard as any;
      check(
        "care balance: the front omits the field when the read failed",
        !failSC.headerFields.some((f: any) => f.key === "carebal") &&
          failSC.secondaryFields.map((f: any) => f.key).join(",") === "petstatus,life",
        JSON.stringify(failSC.headerFields),
      );
      // Gone pet: never read, never rendered (belt and suspenders: even a
      // caller-passed balance stays off a memorial front).
      const goneBalRow = { ...faRow, gone: true } as typeof faRow;
      check(
        "care balance: a gone pet never reads a balance (null)",
        (await petCareBalanceFor(ctx, goneBalRow)) === null,
        "",
      );
      const goneBalSC = (await assembleRunnerPass(goneBalRow, { careBalance: "100 CARE" })).passJson.storeCard as any;
      check(
        "care balance: a memorial front shows NO care balance even if a caller passes one",
        goneBalSC.headerFields.map((f: any) => f.key).join(",") === "petno" &&
          !JSON.stringify(goneBalSC).includes("100 CARE"),
        JSON.stringify(goneBalSC.headerFields),
      );
      // Google mirror: living pet gets the carebal text module; a memorial does not.
      const { getRunnerGoogle } = await import("../src/runner/google.js");
      const gAliveObj = (getRunnerGoogle() as any).loyaltyObject(faRow, pctFa, secsFa, balFa);
      check(
        "care balance: Google object carries a CARE BALANCE text module for a living pet",
        (gAliveObj.textModulesData as any[]).some((m) => m.id === "carebal" && m.body === "100 CARE"),
        JSON.stringify(gAliveObj.textModulesData),
      );
      const gGoneObj = (getRunnerGoogle() as any).loyaltyObject(goneBalRow, null, null, "100 CARE");
      check(
        "care balance: Google memorial object omits the care balance module",
        !(gGoneObj.textModulesData as any[]).some((m) => m.id === "carebal"),
        JSON.stringify(gGoneObj.textModulesData),
      );
      // Google mirror of SURVIVES. No relative-date field exists there, so the
      // value is hour-granular (and leads the modules); the combined NEEDS
      // points slot is untouched, and a memorial shows no life clock at all.
      const gLife = (gAliveObj.textModulesData as any[])[0];
      check(
        "survives: Google leads with an hour-granular SURVIVES module, NEEDS slot untouched",
        gLife?.id === "life" &&
          gLife?.header === "SURVIVES" &&
          /^(under 1h|~\d+[hd]) left\./.test(String(gLife?.body)) &&
          gAliveObj.secondaryLoyaltyPoints.label === "NEEDS",
        JSON.stringify({ m: gLife, sec: gAliveObj.secondaryLoyaltyPoints }),
      );
      check(
        "survives: a memorial carries no life clock on either card",
        !(gGoneObj.textModulesData as any[]).some((m) => m.id === "life") &&
          !goneBalSC.auxiliaryFields.some((f: any) => f.key === "life") &&
          !goneBalSC.secondaryFields.some((f: any) => f.key === "life"),
        JSON.stringify(gGoneObj.textModulesData),
      );

      // (e) Tap UX: the attempt throttle keys on serial:action, so the honest
      // five-different-needs ritual never throttles while a leaked single-need
      // link still hits the wall.
      _careThrottleReset();
      check(
        "five needs: five DIFFERENT-need attempts never throttle",
        NEED_ACTIONS.every((a: string) => careAttemptThrottled("throttle-pet", a) === false),
        "",
      );
      careAttemptThrottled("throttle-pet", "feed"); // 2nd feed attempt
      careAttemptThrottled("throttle-pet", "feed"); // 3rd
      check(
        "five needs: the 4th SAME-need attempt inside the window throttles (others untouched)",
        careAttemptThrottled("throttle-pet", "feed") === true && careAttemptThrottled("throttle-pet", "water") === false,
        "",
      );
      _careThrottleReset();

      // A tap while a care is IN FLIGHT gets a 200 WAITING page that auto-retries
      // the same signed link (never a 4xx error screen): five back-to-back pass
      // taps land sequentially. Driven through the real POST route with a
      // session installed and the in-flight latch held.
      {
        const { sealSessionKey } = await import("../src/runner/session-care.js");
        const waitRow = (await store.getRunner(fa.serial))!;
        const prevVault = config.PETVAULT_ADDRESS;
        const prevSilent = config.modes.silentCareLive;
        config.PETVAULT_ADDRESS = "0x90349bF1461F0BADCE9b9d3486cc3Dd991E816e6";
        config.modes.silentCareLive = true;
        const wKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
        const wAddr = privateKeyToAccount(wKey as `0x${string}`).address;
        await store.putCareSession({
          serial: waitRow.serial,
          tokenId: waitRow.tokenId ?? "1",
          ownerAddress: waitRow.ownerAddress,
          vaultAddress: config.PETVAULT_ADDRESS,
          publicKey: wAddr.toLowerCase(),
          secretEnc: sealSessionKey(wKey as `0x${string}`),
          context: "0x00aabbcc",
          expiresAt: new Date(Date.now() + 3600_000),
        });
        _careInFlight().set(waitRow.serial, "feed");
        const wSig = signTag(waitRow.authToken, actionPayload(waitRow.serial, "water"));
        const wRes = await fetch(`${base}/api/runner/${waitRow.serial}/care/water?s=${wSig}`, { method: "POST" });
        const wHtml = await wRes.text();
        check(
          "five needs: a tap during an in-flight care gets a 200 WAITING page, not an error",
          wRes.status === 200 && /Care in flight/i.test(wHtml),
          `status ${wRes.status}`,
        );
        check(
          "five needs: the waiting page auto-retries the SAME signed link",
          /id="retry"/.test(wHtml) && wHtml.includes("wt=1") && /id="cd">3</.test(wHtml),
          "",
        );
        // A duplicate tap of the SAME in-flight need still waits (never submits
        // concurrently) and its copy promises the no-double-charge dedup.
        _careInFlight().set(waitRow.serial, "water");
        const dupWait = await fetch(`${base}/api/runner/${waitRow.serial}/care/water?s=${wSig}`, { method: "POST" });
        const dupWaitHtml = await dupWait.text();
        check(
          "no double-charge: a SAME-need tap during its own flight waits and promises a single charge",
          dupWait.status === 200 && /not be charged twice/i.test(dupWaitHtml) && /id="retry"/.test(dupWaitHtml),
          `status ${dupWait.status}`,
        );
        _careInFlight().delete(waitRow.serial);
        await store.revokeCareSession(waitRow.serial, "five-needs smoke cleanup");
        config.PETVAULT_ADDRESS = prevVault;
        config.modes.silentCareLive = prevSilent;
      }

      // HATCH TRUTH through the REAL pass-tap POST (2026-09-23): the DB says UNHATCHED but
      // the chain already holds the mint-time hatch from the browser. The keeper's first
      // pass tap must render the NORMAL care page, not "Your egg hatched!". A pet whose
      // chain count really is 0 still gets the hatch reveal on its first tap.
      {
        const { sealSessionKey, _setSessionCareSubmitterForTests } = await import("../src/runner/session-care.js");
        const htCo = await fetch(`${base}/api/runner/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "hatch-tap@walletchi.test" }) }).then(j);
        for (let i = 0; i < 40; i++) { const s = await fetch(`${base}/api/runner/checkout/${htCo.serial}`).then(j); if (s.status === "ready" || s.status === "failed") break; await sleep(50); }
        const htRow = (await store.getRunner(htCo.serial))!;
        const htTok = htRow.tokenId!;
        const prevVault = config.PETVAULT_ADDRESS;
        const prevSilent = config.modes.silentCareLive;
        config.PETVAULT_ADDRESS = "0x90349bF1461F0BADCE9b9d3486cc3Dd991E816e6";
        config.modes.silentCareLive = true;
        const hKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
        await store.putCareSession({
          serial: htRow.serial,
          tokenId: htTok,
          ownerAddress: htRow.ownerAddress,
          vaultAddress: config.PETVAULT_ADDRESS,
          publicKey: privateKeyToAccount(hKey as `0x${string}`).address.toLowerCase(),
          secretEnc: sealSessionKey(hKey as `0x${string}`),
          context: "0x00aabbcc",
          expiresAt: new Date(Date.now() + 3600_000),
        });
        const staleDb = { hatched: false, careCount: 0, lastCareAt: null, gone: false, critical: false };
        const nowS = Math.floor(Date.now() / 1000);
        const tap = async (action: string) => {
          const sig = signTag(htRow.authToken, actionPayload(htRow.serial, action));
          const r = await fetch(`${base}/api/runner/${htRow.serial}/care/${action}?s=${sig}`, { method: "POST", redirect: "manual" });
          return { status: r.status, html: await r.text() };
        };

        // Browser hatch already on chain (1 care), DB stale; the tap lands care 2.
        _careDedupReset();
        _careThrottleReset();
        await store.updateRunner(htRow.serial, staleDb);
        mock.mockSetPetCare(htTok, nowS - 30, 1);
        _setSessionCareSubmitterForTests(async () => {
          mock.mockSetPetCare(htTok, nowS, 2);
          return { ok: true, txHash: "0x" + "cd".repeat(32) };
        });
        const t1 = await tap("feed");
        check(
          "hatch truth (route): DB unhatched + chain hatched -> the first pass tap renders the NORMAL care page",
          t1.status === 200 && !/Your egg hatched/i.test(t1.html) && /Yum!/.test(t1.html),
          `status ${t1.status} hatchPage=${/Your egg hatched/i.test(t1.html)}`,
        );
        check(
          "hatch truth (route): that tap still folds the hatch into the DB",
          (await store.getRunner(htRow.serial))!.hatched === true,
          "",
        );

        // A genuine pass-tap hatch: the chain holds ZERO cares before the tap.
        _careDedupReset();
        _careThrottleReset();
        await store.updateRunner(htRow.serial, staleDb);
        mock.mockSetPetCare(htTok, 0, 0);
        _setSessionCareSubmitterForTests(async () => {
          mock.mockSetPetCare(htTok, nowS, 1);
          return { ok: true, txHash: "0x" + "ef".repeat(32) };
        });
        const t2 = await tap("water");
        check(
          "hatch truth (route): a tap that IS the first care on chain renders the hatch reveal",
          t2.status === 200 && /Your egg hatched/i.test(t2.html),
          `status ${t2.status}`,
        );

        _setSessionCareSubmitterForTests(null);
        _careDedupReset();
        _careThrottleReset();
        await store.revokeCareSession(htRow.serial, "hatch-truth smoke cleanup");
        config.PETVAULT_ADDRESS = prevVault;
        config.modes.silentCareLive = prevSilent;
      }

      // (f) NO DOUBLE-CHARGE (audit #2): at the shipped careCooldown = 0 the
      // vault accepts the SAME need twice back to back, so the server is the
      // ONLY dedup layer. Once a care for (pet, need) is charged, a duplicate
      // tap of the same signed link (including the waiting page's wt-marked
      // auto-retry) must serve the 200 dedup page and NEVER reach submission;
      // a different need on the same pet must pass the dedup gate untouched.
      // Before the per-need charge stamp existed, the wt retry below re-entered
      // the normal submission path and spent careCost a second time.
      {
        _careDedupReset();
        check("no double-charge: nothing charged, nothing deduped", careRecentlyCharged("dedup-pet", "feed") === false, "");
        markCareCharged("dedup-pet", "feed");
        check("no double-charge: a charged (pet, need) is deduped inside the window", careRecentlyCharged("dedup-pet", "feed") === true, "");
        check("no double-charge: dedup keys on the NEED (water on the same pet stays chargeable)", careRecentlyCharged("dedup-pet", "water") === false, "");
        check("no double-charge: dedup keys on the PET (feed on another pet stays chargeable)", careRecentlyCharged("dedup-pet-2", "feed") === false, "");

        // Through the REAL route: stamp fa's FEED as just charged, then re-POST
        // the same signed link in the waiting-retry shape (wt=3). The dedup
        // page must answer BEFORE the session/ownership/submission machinery
        // (200 with the not-charged-again copy + next-need guidance), which is
        // exactly the property that fails on a double-charge.
        const dupRow = (await store.getRunner(fa.serial))!;
        markCareCharged(dupRow.serial, "feed");
        const dSig = signTag(dupRow.authToken, actionPayload(dupRow.serial, "feed"));
        const dupRes = await fetch(`${base}/api/runner/${dupRow.serial}/care/feed?s=${dSig}&wt=3`, {
          method: "POST",
          redirect: "manual",
        });
        const dupHtml = await dupRes.text();
        check(
          "no double-charge: a duplicate tap of a just-charged need serves the 200 dedup page (no second charge)",
          dupRes.status === 200 && /not charged again/i.test(dupHtml),
          `status ${dupRes.status}`,
        );
        check(
          "no double-charge: the dedup page is a plain confirm, no next-need menu",
          !/Next:/.test(dupHtml),
          "",
        );
        // A DIFFERENT need on the same pet passes the dedup gate and proceeds
        // down the normal path (here: 303 fallback to the owner-signed care
        // page, since no session is installed). It must never see the dedup page.
        const oSig = signTag(dupRow.authToken, actionPayload(dupRow.serial, "water"));
        const otherRes = await fetch(`${base}/api/runner/${dupRow.serial}/care/water?s=${oSig}`, {
          method: "POST",
          redirect: "manual",
        });
        const otherLoc = otherRes.headers.get("location") ?? "";
        check(
          "no double-charge: a DIFFERENT need is NOT deduped (proceeds past the gate)",
          otherRes.status === 0 || (otherRes.status === 303 && otherLoc.includes(`/care/${dupRow.serial}/water`)),
          `status ${otherRes.status} location ${otherLoc}`,
        );
        _careDedupReset();
        _careThrottleReset();
      }

      // (h ii) Cooldown readyAt is PER NEED: under the mock's nonzero cooldown
      // (30s) the just-refreshed need waits the full window while a need cared
      // 25s ago is nearly ready. Dead code at the shipped cooldown = 0, but the
      // math must be right.
      {
        _resetClaimState();
        const nowSecH = Math.floor(Date.now() / 1000);
        mock.mockSetPetCare(fa.tokenId, nowSecH - 25, 1); // all five cared 25s ago
        mock.mockSetPetNeed(fa.tokenId, 1, nowSecH); // WATER just refreshed
        const feedWait = await careCooldownSecondsLeft(ctx, fa.tokenId, "feed");
        const waterWait = await careCooldownSecondsLeft(ctx, fa.tokenId, "water");
        check(
          "five needs: cooldown readyAt keys on the TARGETED need's own stamp",
          feedWait >= 1 && feedWait <= 5 && waterWait >= 28 && waterWait <= 30,
          JSON.stringify({ feedWait, waterWait }),
        );
      }

      // (b) SINGLE-NEED DEATH: one lapsed need kills even with the other four
      // fresh; the sweep memorializes; the dead state payload omits the needs
      // array (frozen stamps must not show phantom hours); the memorial card
      // carries no need meters.
      _resetClaimState();
      const fb = await mintPet("fiveneeds-b@walletchi.test");
      await store.updateRunner(fb.serial, { hatched: true, gone: false, critical: false, careCount: 1 });
      const nowSecB = Math.floor(Date.now() / 1000);
      mock.mockSetPetCare(fb.tokenId, nowSecB, 1); // all five fresh...
      mock.mockSetPetNeed(fb.tokenId, 3, nowSecB - ttlSec - 3600); // ...but TOY lapsed a full window
      const stB = await mock.petState(fb.tokenId);
      check("five needs: ONE lapsed need kills (dead with four needs fresh)", stB.dead === true && stB.isAlive === false, JSON.stringify(stB));
      const recB = await reconcilePet(ctx, (await store.getRunner(fb.serial))!, { now: new Date() });
      check(
        "five needs: the sweep memorializes a single-need death (diedAt = weakest need + lifeTtl)",
        recB.gone === true && recB.diedAt !== null,
        JSON.stringify({ gone: recB.gone, diedAt: recB.diedAt }),
      );
      const stateFb = await fetch(`${base}/api/runner/${fb.serial}`).then(j);
      check(
        "five needs: dead pet state omits the needs array + lastActionAt",
        stateFb.gone === true && stateFb.needs === undefined && stateFb.lastActionAt === undefined,
        JSON.stringify({ gone: stateFb.gone, needs: stateFb.needs }),
      );
      const memSC = (await assembleRunnerPass((await store.getRunner(fb.serial))!)).passJson.storeCard as any;
      check(
        "five needs: memorial card carries no need meters",
        !memSC.secondaryFields.some((f: any) => String(f.key).startsWith("need")) &&
          !memSC.auxiliaryFields.some((f: any) => String(f.key).startsWith("need")),
        JSON.stringify(memSC.secondaryFields.map((f: any) => f.key)),
      );

      // (c) CRITICAL NAMING: the fade ping names the BINDING need (the one that
      // dies first), so the keeper knows which bowl to fill.
      _resetClaimState();
      config.CRITICAL_WINDOW_HOURS = 12;
      const fc = await mintPet("fiveneeds-c@walletchi.test");
      await store.updateRunner(fc.serial, {
        hatched: true, gone: false, critical: false, careCount: 1, lastPushAt: null, lastEvent: null,
      });
      const nowSecC = Math.floor(Date.now() / 1000);
      mock.mockSetPetCare(fc.tokenId, nowSecC, 1); // four needs fresh...
      mock.mockSetPetNeed(fc.tokenId, 1, nowSecC - (ttlSec - 2 * 3600)); // ...WATER lapses in 2h
      const recC = await reconcilePet(ctx, (await store.getRunner(fc.serial))!, { now: new Date() });
      check(
        "five needs: water lapsing in 2h sends the last chance naming water, and only water",
        recC.critical === true && /^Last chance: .+ Tap Water now\.$/.test(recC.lastEvent ?? ""),
        String(recC.lastEvent),
      );

      // (g) NO FALSE RESCUE (audit 5): a care on a NON-binding need leaves the
      // pet exactly as endangered; the reconcile keeps critical set and the
      // copy names the still-binding need instead of claiming happy-and-full.
      await sleep(1100);
      await mock.careForPet(fc.tokenId, 0); // FEED: not the binding need
      _resetClaimState(); // the reconcile must see the fresh stamps, not the 5s cache
      const recG = await reconcilePet(ctx, (await store.getRunner(fc.serial))!, { now: new Date() });
      check(
        "five needs: a non-binding care leaves the pet critical (no false rescue)",
        recG.critical === true,
        JSON.stringify({ critical: recG.critical }),
      );
      check(
        "five needs: after a non-binding care the card still warns (last chance), never happy-and-full",
        /^Last chance:/.test(recG.lastEvent ?? "") && !/happy and full/i.test(recG.lastEvent ?? ""),
        String(recG.lastEvent),
      );

      config.modes.survivalLive = false;
      _resetClaimState();
    }

    // ====== 40. TAX ECONOMY (holder airdrops + fee distribution) ======
    // Dark-state degradation over HTTP, the Merkle construction the contract
    // verifies, the pro-rata snapshot math, and the mock-chain fee flow.
    {
      const { buildHolderTree, holderLeaf, allocateProRata, runFeeDistribution, holderDenyList } =
        await import("../src/runner/tax-rewards.js");

      // The deny-list must ALWAYS exclude the burn address (holds ~70% of all CARE) and the zero
      // address, so a griefed live pet sent to burn can never capture a holder round (re-audit
      // finding 3). Both are lowercased in the set.
      const deny = holderDenyList();
      check(
        "holder deny-list excludes the burn + zero addresses",
        deny.has("0x000000000000000000000000000000000000dead") &&
          deny.has("0x0000000000000000000000000000000000000000"),
        JSON.stringify([...deny]),
      );

      check("holder pipeline is dark in smoke", config.modes.holderRewardsLive === false);
      const dead = "0x000000000000000000000000000000000000dEaD";
      const dark = await fetch(`${base}/api/holder-rewards/${dead}`);
      const darkBody: any = await dark.json();
      check(
        "holder rewards read degrades when dark",
        dark.status === 200 && darkBody.holderRewardsLive === false && Array.isArray(darkBody.rounds) && darkBody.rounds.length === 0,
        JSON.stringify(darkBody),
      );
      const bad = await fetch(`${base}/api/holder-rewards/not-an-address`);
      check("holder rewards rejects an invalid address", bad.status === 400, `status ${bad.status}`);
      // NO CLAIM, ALWAYS AIRDROPS (Hunt 2026-08-31): the holder claim relay is
      // retired. The endpoint answers 410 rewards_pushed regardless of pipeline
      // state (dark or live), because there is nothing to claim: the 2h push
      // engine airdrops every leaf.
      const retiredClaim = await fetch(`${base}/api/holder-rewards/${dead}/claim`, { method: "POST" });
      const retiredClaimBody: any = await retiredClaim.json();
      check(
        "holder claim relay is retired (410 rewards_pushed)",
        retiredClaim.status === 410 && retiredClaimBody.code === "rewards_pushed",
        JSON.stringify(retiredClaimBody),
      );
      const noop = await runFeeDistribution(ctx);
      check("fee distribution is a no-op when dark", !noop.distributed && !noop.roundPosted);

      // Merkle construction mirrors HolderMerkleVault.sol.
      const a1 = "0x1111111111111111111111111111111111111111";
      const a2 = "0x2222222222222222222222222222222222222222";
      const a3 = "0x3333333333333333333333333333333333333333";
      const single = buildHolderTree(0, [{ account: a1, amount: 5n }]);
      check(
        "single-leaf tree: root == leaf, empty proof",
        single.root === holderLeaf(0, a1, 5n) && single.leaves[0]!.proof.length === 0,
      );
      const tree = buildHolderTree(7, [
        { account: a1, amount: 30n },
        { account: a2, amount: 70n },
        { account: a3, amount: 11n },
      ]);
      const { keccak256, concatHex } = await import("viem");
      const pair = (x: `0x${string}`, y: `0x${string}`) =>
        BigInt(x) < BigInt(y) ? keccak256(concatHex([x, y])) : keccak256(concatHex([y, x]));
      const verifies = tree.leaves.every((l) => {
        let node = holderLeaf(7, l.account, l.amount) as `0x${string}`;
        for (const sib of l.proof) node = pair(node, sib as `0x${string}`);
        return node === tree.root;
      });
      check("every multi-leaf proof replays to the root", verifies);
      check("roundId binds the leaf", holderLeaf(1, a1, 5n) !== holderLeaf(2, a1, 5n));

      // Pro-rata allocation: the LIVE-PET gate is an allowlist (only eligible
      // addresses count), floor math, dust stays. a3 is NOT eligible here.
      const balances = new Map<string, bigint>([
        [a1, 100n],
        [a2, 200n],
        [a3, 500n], // not in the eligible set -> excluded
      ]);
      const eligible = new Set([a1.toLowerCase(), a2.toLowerCase()]);
      const alloc = allocateProRata(100n, balances, eligible);
      const gotA1 = alloc.find((x) => x.account.toLowerCase() === a1)?.amount;
      const gotA2 = alloc.find((x) => x.account.toLowerCase() === a2)?.amount;
      const gotA3 = alloc.find((x) => x.account.toLowerCase() === a3);
      check(
        "pro-rata keeps only live-pet-eligible holders and splits by balance",
        gotA1 === 33n && gotA2 === 66n && gotA3 === undefined,
        JSON.stringify(alloc.map((x) => `${x.account}:${x.amount}`)),
      );

      // Mock-chain fee flow: splitter halves into the holder vault; postRound
      // requires the expected roundId; a (round, account) claims exactly once.
      const mock = relayer.chain as any;
      mock.mockSetSplitterBalance(1000n);
      await relayer.splitterDistribute();
      check("mock splitter distributes half to holder vault", (await relayer.holderUnreserved()) === 500n);
      let wrongId = false;
      try {
        await relayer.holderPostRound(9, tree.root, 400n); // expects id 0
      } catch {
        wrongId = true;
      }
      check("holder postRound rejects a wrong expected roundId", wrongId);
      await relayer.holderPostRound(0, tree.root, 400n);
      check(
        "holder round reserves its total",
        (await relayer.holderUnreserved()) === 100n && (await relayer.holderRoundCount()) === 1,
      );
      await relayer.holderClaim(0, a1, 1n, []);
      check("holder claim marks claimed", (await relayer.holderClaimed(0, a1)) === true);
      let dup = false;
      try {
        await relayer.holderClaim(0, a1, 1n, []);
      } catch {
        dup = true;
      }
      check("duplicate holder claim rejected", dup);

      // FIX (server review, HIGH): the unauthenticated claim relay endpoint is
      // deduped while a claim for an address is in flight (no duplicate tx ever
      // reaches the write queue) and carries its own per-IP/per-address rate
      // limit. Exercised LIVE against the mock: flip the mode flag, persist the
      // round's proofs the way the 4x/day job does, and count actual relayer
      // claim submissions through a counting wrapper.
      {
        const { beginHolderClaimFlight, endHolderClaimFlight } =
          await import("../src/runner/tax-rewards.js");
        config.modes.holderRewardsLive = true;
        await store.putHolderRound(
          { id: 0, root: tree.root, total: "111", token: "0x9999999999999999999999999999999999999999", txHash: null },
          [
            { roundId: 0, account: a2, amount: "70", proof: JSON.stringify([]) },
            { roundId: 0, account: a3, amount: "11", proof: JSON.stringify([]) },
          ],
        );
        // NO CLAIM, ALWAYS AIRDROPS (Hunt 2026-08-31): the user-facing holder claim
        // relay is retired even with the pipeline LIVE. It answers 410 and touches
        // no chain, no matter the address or in-flight state. The flight guards
        // (beginHolderClaimFlight) stay because the push engine still uses them, but
        // they are no longer reachable from an HTTP claim. Delivery is proven by the
        // push-engine coverage below, not by an endpoint relay.
        void beginHolderClaimFlight; // still exported + used by pushHolderRewards
        void endHolderClaimFlight;
        const liveRetired = await fetch(`${base}/api/holder-rewards/${a2}/claim`, { method: "POST" });
        const liveRetiredBody: any = await liveRetired.json();
        check(
          "holder claim relay is retired even when the pipeline is live (410)",
          liveRetired.status === 410 && liveRetiredBody.code === "rewards_pushed" &&
            (await relayer.holderClaimed(0, a2)) === false, // and it moved nothing
          `status ${liveRetired.status} ${JSON.stringify(liveRetiredBody)}`,
        );
        _resetClaimState();

        // (e) SEASON 2, NO CLAIMS: the holder leg of the 2h push. a3 still holds an
        // unclaimed leaf in round 0 and has never come to ask for it. The engine
        // must find it and deliver it WITHOUT the holder doing anything, because an
        // unclaimed round is released back on-chain once its grace elapses: "nobody
        // came to ask" is a deadline, not a resting state.
        {
          const { pushHolderRewards } = await import("../src/runner/tax-rewards.js");
          check("holder push precondition: a3's leaf is still unclaimed", (await relayer.holderClaimed(0, a3)) === false, "");
          const holderPush = await pushHolderRewards(ctx);
          check(
            "holder push delivers an unclaimed airdrop nobody asked for",
            holderPush.pushed >= 1 && (await relayer.holderClaimed(0, a3)) === true,
            JSON.stringify(holderPush),
          );
          // Idempotent: the second cycle reads holderClaimed=true and sends nothing.
          const holderPush2 = await pushHolderRewards(ctx);
          check("a repeat holder push sends nothing (already delivered)", holderPush2.pushed === 0, JSON.stringify(holderPush2));
          // And it never fights the still-live claim endpoint: a leaf whose account
          // has a claim in flight is left for that claim, not double-submitted.
          // A FRESH address on purpose: a1..a4 have all been claimed or rate-limited
          // by the tests above, and an already-spent leaf would make this pass for
          // the wrong reason (nothing to push looks exactly like correctly skipped).
          const a5 = "0x5555555555555555555555555555555555555555";
          const { beginHolderClaimFlight: beginF, endHolderClaimFlight: endF } =
            await import("../src/runner/tax-rewards.js");
          await store.putHolderRound(
            { id: 0, root: tree.root, total: "111", token: "0x9999999999999999999999999999999999999999", txHash: null },
            [{ roundId: 0, account: a5, amount: "30", proof: JSON.stringify([]) }],
          );
          check("holder push precondition: a5 is fresh and unclaimed", (await relayer.holderClaimed(0, a5)) === false, "");
          check("holder push flight hook acquires a5's slot", beginF(a5) === true);
          const holderPush3 = await pushHolderRewards(ctx);
          check(
            "holder push skips an account whose claim is already in flight",
            holderPush3.pushed === 0 && (await relayer.holderClaimed(0, a5)) === false,
            JSON.stringify(holderPush3),
          );
          endF(a5);
          const holderPush4 = await pushHolderRewards(ctx);
          check(
            "holder push delivers once the flight clears",
            holderPush4.pushed === 1 && (await relayer.holderClaimed(0, a5)) === true,
            JSON.stringify(holderPush4),
          );
        }
        config.modes.holderRewardsLive = false;
        check("holder push is a no-op while the holder leg is dark", (await (await import("../src/runner/tax-rewards.js")).pushHolderRewards(ctx)).pushed === 0, "");
      }

      // ====== 40b. MAINNET BLOCKER B2: the DEDICATED poster key + the round cap ======
      //
      // The hardened HolderMerkleVault gates postRound on a poster address that is deliberately
      // NOT the relayer, and it now FAILS CLOSED on the per-round cap (maxRoundTotal == 0 reverts
      // RoundCapNotArmed, total > cap reverts OverRoundCap). A server that signed rounds with the
      // relayer and never read the cap had two ways to go permanently dark while looking healthy,
      // because the only signal was a logger.warn inside a 4x/day background job.
      //
      // Everything below runs against the mock, which mirrors the contract's revert ladder, and
      // drives the failure modes deliberately through hooks.
      {
        const {
          runFeeDistribution: runFees,
          getHolderRoundHealth,
          _resetHolderRoundHealth,
          verifyHolderPoster,
        } = await import("../src/runner/tax-rewards.js");
        const mock = relayer.chain as any;

        // Save every knob this block moves; the suite continues afterwards.
        const prevCareToken = config.CARE_TOKEN_ADDRESS;
        const prevFeeToken = config.FEE_TOKEN_ADDRESS;
        const prevPoster = config.holderPosterAddress;
        const prevMinRound = config.HOLDER_MIN_ROUND_RAW;

        const posterAddr = "0x5555555555555555555555555555555555555555";
        const rotatedPoster = "0x8888888888888888888888888888888888888888";
        const holderAddr = "0x7777777777777777777777777777777777777777";
        config.CARE_TOKEN_ADDRESS = "0x1010101010101010101010101010101010101010";
        config.FEE_TOKEN_ADDRESS = "0x2020202020202020202020202020202020202020";
        config.HOLDER_MIN_ROUND_RAW = undefined;
        config.holderPosterAddress = posterAddr;
        config.modes.holderRewardsLive = true;
        config.modes.holderPostingLive = true;
        mock.mockSetPosterKeyAddress(posterAddr);
        mock.mockSetOnChainPoster(posterAddr);
        mock.mockSetPostingPaused(false);
        _resetHolderRoundHealth();

        check(
          "the poster key is a DIFFERENT address from the relayer (the contract requires it)",
          relayer.holderPosterAddress === posterAddr &&
            relayer.holderPosterAddress!.toLowerCase() !== relayer.address.toLowerCase(),
          `${relayer.holderPosterAddress} vs ${relayer.address}`,
        );

        // One eligible holder: a LIVE pet whose owner holds CARE. The care stamp is far in the
        // future on purpose, because earlier sections warp the mock clock forward and a real-now
        // stamp could read as a lapsed (dead) pet depending on how much time was advanced.
        const mintedRows = (await store.allMintedRunners()).filter((r: { tokenId: string | null }) => r.tokenId);
        const petId = mintedRows[0]!.tokenId as string;
        mock.mockSetPetCare(petId, Math.floor(Date.now() / 1000) + 3650 * 86400, 3);
        mock.setPetOwnerMock(petId, holderAddr);
        mock.mockSetHolderBalance(holderAddr, 1000n);

        // --- the clamp: unreserved (250) is 2.5x the cap (100) ---
        mock.mockSetMaxRoundTotal(100n);
        mock.mockSetHolderUnreserved(250n);
        const clamped1 = await runFees(ctx);
        check(
          "a round total above the vault cap is CLAMPED to the cap instead of reverting",
          clamped1.roundPosted === true && clamped1.total === "100" && clamped1.clamped === true,
          JSON.stringify(clamped1),
        );
        check(
          "the clamped remainder is carried forward, not lost",
          clamped1.carryForward === "150" && (await relayer.holderUnreserved()) === 150n,
          `carry ${clamped1.carryForward} unreserved ${await relayer.holderUnreserved()}`,
        );
        // THE REGRESSION THAT MATTERS: without the clamp this second cycle allocates 150 against a
        // cap of 100, reverts OverRoundCap, reserves nothing, and every later cycle reverts too
        // while the unreserved balance only grows. Posting the carry-forward is what proves the
        // pipeline is self-healing rather than permanently stuck.
        const clamped2 = await runFees(ctx);
        check(
          "the NEXT cycle posts the carried-forward remainder rather than reverting forever",
          clamped2.roundPosted === true && clamped2.total === "100" && (await relayer.holderUnreserved()) === 50n,
          JSON.stringify(clamped2),
        );
        // The signer assertion: the mock records who signed, and the relayer signing this is
        // exactly the bug (it would revert NotPoster on-chain).
        check(
          "round posting is signed by the POSTER key, never by the relayer",
          mock.lastPostRoundSigner?.toLowerCase() === posterAddr.toLowerCase() &&
            mock.lastPostRoundSigner?.toLowerCase() !== relayer.address.toLowerCase(),
          `signer ${mock.lastPostRoundSigner} relayer ${relayer.address}`,
        );
        // A sub-cap balance is posted whole (the clamp is a ceiling, not a fixed size).
        const under = await runFees(ctx);
        check(
          "an unreserved balance below the cap posts in full and is not clamped",
          under.roundPosted === true && under.total === "50" && !under.clamped,
          JSON.stringify(under),
        );

        // --- the mismatch: the vault's poster rotated away from our key ---
        mock.mockSetHolderUnreserved(500n);
        mock.mockSetOnChainPoster(rotatedPoster);
        const mismatch = await runFees(ctx);
        check(
          "a poster/on-chain mismatch is DETECTED and no round is attempted",
          mismatch.roundPosted === false && /poster mismatch/i.test(mismatch.skipReason ?? ""),
          JSON.stringify(mismatch),
        );
        {
          const h = getHolderRoundHealth();
          check(
            "holder health names BOTH addresses on a mismatch",
            h.posterMatchesOnChain === false &&
              h.onChainPoster?.toLowerCase() === rotatedPoster.toLowerCase() &&
              h.posterAddress === posterAddr,
            JSON.stringify({ match: h.posterMatchesOnChain, onChain: h.onChainPoster, ours: h.posterAddress }),
          );
        }
        // The BOOT assertion sees the same mismatch, and clears when they agree again.
        _resetHolderRoundHealth();
        await verifyHolderPoster(ctx);
        check(
          "the boot assertion flags a poster/on-chain mismatch",
          getHolderRoundHealth().posterMatchesOnChain === false,
        );
        mock.mockSetOnChainPoster(posterAddr);
        _resetHolderRoundHealth();
        await verifyHolderPoster(ctx);
        check(
          "the boot assertion passes when the poster key IS the on-chain poster",
          getHolderRoundHealth().posterMatchesOnChain === true,
        );
        // AN UNREADABLE RPC IS NOT A VERDICT. The assertion runs before app.listen, so a cold or
        // flaky node must leave it undecided and let the server come up, never throw and never
        // conclude "mismatch" from a failed read.
        {
          _resetHolderRoundHealth();
          const realPosterRead = relayer.holderPoster.bind(relayer);
          (relayer as any).holderPoster = () => Promise.reject(new Error("simulated RPC failure"));
          let threw = false;
          try {
            await verifyHolderPoster(ctx);
          } catch {
            threw = true;
          }
          const h = getHolderRoundHealth();
          check(
            "an unreadable RPC leaves the poster check UNDECIDED and never blocks boot",
            !threw && h.posterMatchesOnChain === null && (h.posterCheckError ?? "").includes("simulated RPC failure"),
            JSON.stringify({ threw, match: h.posterMatchesOnChain, err: h.posterCheckError }),
          );
          delete (relayer as any).holderPoster;
          check("the poster read is restored after the failure test", (await realPosterRead()) === posterAddr);
          _resetHolderRoundHealth();
          await verifyHolderPoster(ctx);
        }

        // --- fail-closed cap + emergency stop are reported as themselves ---
        mock.mockSetMaxRoundTotal(0n);
        const unarmed = await runFees(ctx);
        check(
          "an UNARMED round cap fails closed with a named reason instead of an opaque revert",
          unarmed.roundPosted === false && /UNARMED/i.test(unarmed.skipReason ?? ""),
          JSON.stringify(unarmed),
        );
        mock.mockSetMaxRoundTotal(100n);
        mock.mockSetPostingPaused(true);
        const paused = await runFees(ctx);
        check(
          "an owner posting PAUSE is reported as a pause, not as a failure",
          paused.roundPosted === false && /paused/i.test(paused.skipReason ?? ""),
          JSON.stringify(paused),
        );
        mock.mockSetPostingPaused(false);

        // --- no poster key at all: posting dark, everything else untouched ---
        config.holderPosterAddress = null;
        config.modes.holderPostingLive = false;
        const dark = await runFees(ctx);
        check(
          "with no poster key the job skips posting and says why",
          dark.roundPosted === false && /HOLDER_POSTER_PRIVATE_KEY/.test(dark.skipReason ?? ""),
          JSON.stringify(dark),
        );
        check(
          "the holder leg's READ + CLAIM surfaces stay live when only posting is dark",
          config.modes.holderRewardsLive === true,
        );
        {
          // The chain layer refuses too, with an actionable sentence rather than a NotPoster revert.
          mock.mockSetPosterKeyAddress(null);
          let posterless = "";
          try {
            await relayer.holderPostRound(await relayer.holderRoundCount(), "0x" + "11".repeat(32), 1n);
          } catch (err) {
            posterless = String(err);
          }
          check(
            "the chain layer refuses to post without a poster key (it never falls back to the relayer)",
            /HOLDER_POSTER_PRIVATE_KEY/.test(posterless),
            posterless,
          );
          mock.mockSetPosterKeyAddress(posterAddr);
        }

        // --- observability: /internal/status publishes the whole picture ---
        config.holderPosterAddress = posterAddr;
        config.modes.holderPostingLive = true;
        // One healthy round first, so the status block below is asserting a real recorded attempt
        // and not the empty state.
        const healthy = await runFees(ctx);
        check("posting recovers as soon as the poster key is right again", healthy.roundPosted === true, JSON.stringify(healthy));
        {
          const token = config.INTERNAL_STATUS_TOKEN;
          const unauthorized = await fetch(`${base}/internal/status`);
          check("internal status requires the bearer", unauthorized.status === 401, `status ${unauthorized.status}`);
          const statusRes = await fetch(`${base}/internal/status`, {
            headers: { authorization: `Bearer ${token}` },
          });
          const status: any = await statusRes.json();
          check(
            "internal status publishes holder-round health (the signal this failure mode lacked)",
            statusRes.status === 200 &&
              status.holderRounds?.posterConfigured === true &&
              status.holderRounds?.posterAddress === posterAddr &&
              typeof status.holderRounds?.roundsPosted === "number",
            JSON.stringify(status.holderRounds),
          );
          check(
            "internal status reports the last round attempt and the unreserved balance",
            status.holderRounds?.lastAttempt?.ok === true &&
              typeof status.holderRounds?.unreservedRaw === "string" &&
              status.holderRounds?.maxRoundTotalRaw === "100",
            JSON.stringify(status.holderRounds?.lastAttempt),
          );
          check(
            "the stub matrix calls out round posting separately from holder rewards",
            typeof status.modes?.holderRoundPosting === "string" &&
              status.modes.holderRoundPosting.startsWith("LIVE"),
            String(status.modes?.holderRoundPosting),
          );
          check(
            "internal status publishes the POSTER's own gas balance (a separate signer has a separate tank)",
            typeof status.holderRounds?.posterBalanceEth === "number" &&
              status.holderRounds?.posterGasLow === false,
            JSON.stringify({ eth: status.holderRounds?.posterBalanceEth, low: status.holderRounds?.posterGasLow }),
          );
          // The unfunded-poster case: a brand new dedicated key starts with no gas at all, which
          // stalls every round for a reason no key check would ever surface.
          mock.mockSetPosterBalanceWei(0n);
          const dryStatus: any = await fetch(`${base}/internal/status`, {
            headers: { authorization: `Bearer ${token}` },
          }).then((r: Response) => r.json());
          check(
            "an unfunded poster key is flagged as low on gas",
            dryStatus.holderRounds?.posterBalanceEth === 0 && dryStatus.holderRounds?.posterGasLow === true,
            JSON.stringify({ eth: dryStatus.holderRounds?.posterBalanceEth, low: dryStatus.holderRounds?.posterGasLow }),
          );
          mock.mockSetPosterBalanceWei(10n ** 18n);
        }

        // ====== 40b2. THE 2026-10-28 OVERLAP: one instance must never overwrite a posted round ======
        //
        // Two overlapping deploys both ran the boot round job for round 87. A posted it; B replaced
        // the stored tree with its own (the store upserted) and its own post reverted
        // UnexpectedRoundId, so every claim for 87 reverted BadProof every 2 h after. Each guard is
        // driven here against the mock, which mirrors the vault's expectedRoundId check.
        {
          const { HolderRoundConflictError } = await import("../src/store/types.js");
          const { pushHolderRewards } = await import("../src/runner/tax-rewards.js");
          const rootA = "0x" + "a1".repeat(32);
          const rootB = "0x" + "b2".repeat(32);
          const leaf = (roundId: number, amount = "1") => [{ roundId, account: holderAddr, amount, proof: "[]" }];
          const feeToken = config.FEE_TOKEN_ADDRESS!;

          // (1) the store refuses a different root for a stored round id.
          const probeId = 9_000;
          await store.putHolderRound({ id: probeId, root: rootA, total: "1", token: feeToken, txHash: "0xabc" }, leaf(probeId));
          let conflict: unknown = null;
          try {
            await store.putHolderRound({ id: probeId, root: rootB, total: "1", token: feeToken, txHash: null }, leaf(probeId, "2"));
          } catch (err) {
            conflict = err;
          }
          check(
            "putHolderRound REFUSES to replace a stored round with a different root (fails loud)",
            conflict instanceof HolderRoundConflictError && (await store.holderRound(probeId))?.root === rootA,
            String(conflict),
          );
          await store.putHolderRound({ id: probeId, root: rootA, total: "1", token: feeToken, txHash: null }, leaf(probeId, "3"));
          check(
            "the same root is idempotent and never erases a recorded txHash",
            (await store.holderRound(probeId))?.txHash === "0xabc",
          );
          check(
            "deleteUnpostedHolderRound never removes a round recorded as posted",
            (await store.deleteUnpostedHolderRound(probeId, rootA)) === false && (await store.holderRound(probeId)) !== null,
          );

          // (2) the lease: while another instance holds it, this one posts nothing.
          mock.mockSetHolderUnreserved(40n);
          const countBeforeLease = await relayer.holderRoundCount();
          check("the other instance takes the round lease", (await store.tryAcquireJobLease("holder-round", "other-instance", 60_000)) === true);
          const blocked = await runFees(ctx);
          check(
            "with the round lease held elsewhere, no snapshot and no post",
            blocked.roundPosted === false && /lease/.test(blocked.skipReason ?? "") && (await relayer.holderRoundCount()) === countBeforeLease,
            JSON.stringify(blocked),
          );
          await store.releaseJobLease("holder-round", "other-instance");
          check("an expired lease is taken over", (await store.tryAcquireJobLease("holder-round", "stale", -1)) === true && (await store.tryAcquireJobLease("holder-round", "fresh", 60_000)) === true);
          await store.releaseJobLease("holder-round", "fresh");

          // (3) a FRESH unposted tree from another run at the next id is left alone (it may be an
          // old build mid-post), and a STALE one is replaced once the chain proves the id is free.
          const nextId = await relayer.holderRoundCount();
          await store.putHolderRound({ id: nextId, root: rootB, total: "40", token: feeToken, txHash: null }, leaf(nextId, "40"));
          const fresh = await runFees(ctx);
          check(
            "a fresh unposted tree from another run is NOT replaced and nothing is posted",
            fresh.roundPosted === false && /fresh unposted tree/.test(fresh.skipReason ?? "") &&
              (await store.holderRound(nextId))?.root === rootB && (await relayer.holderRoundCount()) === nextId,
            JSON.stringify(fresh),
          );
          store._backdateHolderRound(nextId, new Date(Date.now() - 60 * 60_000));
          const stale = await runFees(ctx);
          const staleStored = await store.holderRound(nextId);
          check(
            "a stale unposted tree is replaced, posted, and the stored root IS the on-chain root",
            stale.roundPosted === true && stale.roundId === nextId && staleStored?.root !== rootB &&
              staleStored?.root.toLowerCase() === (await relayer.holderRoundRoot(nextId)) && !!staleStored?.txHash,
            JSON.stringify(stale),
          );

          // (4) THE RACE ITSELF: another poster lands a different root at our id first, so our post
          // reverts UnexpectedRoundId. Our tree must not be left behind as that round's proofs.
          const realPost = relayer.holderPostRound.bind(relayer);
          mock.mockSetHolderUnreserved(30n);
          const raceId = await relayer.holderRoundCount();
          (relayer as any).holderPostRound = async (id: number, _root: string, total: bigint) => {
            await realPost(id, rootA, total); // instance A wins
            return realPost(id, _root, total); // ours: reverts UnexpectedRoundId
          };
          const lost = await runFees(ctx);
          delete (relayer as any).holderPostRound;
          check(
            "a post that loses the race (UnexpectedRoundId) does NOT keep its tree",
            lost.roundPosted === false && (await store.holderRound(raceId)) === null &&
              (await relayer.holderRoundRoot(raceId)) === rootA.toLowerCase(),
            JSON.stringify({ lost, stored: await store.holderRound(raceId) }),
          );

          // (5) a post that LANDED but whose receipt wait failed keeps its tree (deleting a tree
          // that is on-chain is what strands a round's funds).
          mock.mockSetHolderUnreserved(20n);
          const landedId = await relayer.holderRoundCount();
          (relayer as any).holderPostRound = async (id: number, root: string, total: bigint) => {
            await realPost(id, root, total);
            throw new Error("timed out waiting for the receipt");
          };
          const landed = await runFees(ctx);
          delete (relayer as any).holderPostRound;
          check(
            "a post that landed but errored keeps its stored tree (root matches the chain)",
            landed.roundPosted === false && (await store.holderRound(landedId))?.root.toLowerCase() === (await relayer.holderRoundRoot(landedId)),
            JSON.stringify(landed),
          );

          // (6) an old build overwrites the stored tree right after our post: the posted tree is put back.
          mock.mockSetHolderUnreserved(10n);
          const restoreId = await relayer.holderRoundCount();
          (relayer as any).holderPostRound = async (id: number, root: string, total: bigint) => {
            const out = await realPost(id, root, total);
            await store.putHolderRound({ id, root: rootB, total: "10", token: feeToken, txHash: null }, leaf(id, "10"), { replaceRoot: root });
            return out;
          };
          const restored = await runFees(ctx);
          delete (relayer as any).holderPostRound;
          check(
            "a stored tree overwritten after our post is RESTORED to the posted tree",
            restored.roundPosted === true && (await store.holderRound(restoreId))?.root.toLowerCase() === (await relayer.holderRoundRoot(restoreId)),
            JSON.stringify(restored),
          );

          // (7) DELIVERY: the round-87 state (stored root differs from the chain) is skipped with ONE
          // warn per cycle and zero claim() calls, and it shows on /internal/status.
          const splitId = landedId; // posted on-chain; force the store out of agreement with it
          const chainRoot = (await relayer.holderRoundRoot(splitId))!;
          await store.putHolderRound(
            { id: splitId, root: rootB, total: "20", token: feeToken, txHash: null },
            [
              { roundId: splitId, account: holderAddr, amount: "5", proof: "[]" },
              { roundId: splitId, account: "0x6666666666666666666666666666666666666666", amount: "5", proof: "[]" },
            ],
            { replaceRoot: chainRoot },
          );
          const claimCalls: number[] = [];
          const realClaim = relayer.holderClaim.bind(relayer);
          (relayer as any).holderClaim = (roundId: number, ...rest: [string, bigint, string[]]) => {
            claimCalls.push(roundId);
            return realClaim(roundId, ...rest);
          };
          const { logger } = await import("../src/logger.js");
          const realWarn = logger.warn.bind(logger);
          const warnLines: string[] = [];
          (logger as any).warn = (...a: unknown[]) => {
            warnLines.push(String(a.find((x) => typeof x === "string") ?? ""));
            return (realWarn as (...x: unknown[]) => void)(...a);
          };
          await pushHolderRewards(ctx);
          await pushHolderRewards(ctx);
          (logger as any).warn = realWarn;
          delete (relayer as any).holderClaim;
          check(
            "a round whose stored root differs from the chain gets ZERO claim() calls",
            !claimCalls.includes(splitId),
            JSON.stringify(claimCalls),
          );
          check(
            "and ONE warn line per cycle, not one per leaf",
            warnLines.filter((w) => /stored root differs/.test(w)).length === 2 && !warnLines.some((w) => /claim relay failed/.test(w)),
            JSON.stringify(warnLines),
          );
          check(
            "holder health names the mismatched round (rootMismatchRounds)",
            getHolderRoundHealth().rootMismatchRounds.includes(splitId),
            JSON.stringify(getHolderRoundHealth().rootMismatchRounds),
          );
          const st: any = await fetch(`${base}/internal/status`, {
            headers: { authorization: `Bearer ${config.INTERNAL_STATUS_TOKEN}` },
          }).then((r: Response) => r.json());
          check(
            "/internal/status holderRounds.rootMismatchRounds lists it",
            Array.isArray(st.holderRounds?.rootMismatchRounds) && st.holderRounds.rootMismatchRounds.includes(splitId),
            JSON.stringify(st.holderRounds?.rootMismatchRounds),
          );

          // (8) the near-empty round floor (HOLDER_MIN_ROUND_RAW): below it nothing posts and the
          // balance stays unreserved for the next round.
          config.HOLDER_MIN_ROUND_RAW = "1000000";
          mock.mockSetHolderUnreserved(999_999n);
          const roundsBeforeMin = await relayer.holderRoundCount();
          const tiny = await runFees(ctx);
          check(
            "a round below HOLDER_MIN_ROUND_RAW is skipped and the money stays unreserved",
            tiny.roundPosted === false && /HOLDER_MIN_ROUND_RAW/.test(tiny.skipReason ?? "") &&
              (await relayer.holderRoundCount()) === roundsBeforeMin && (await relayer.holderUnreserved()) === 999_999n,
            JSON.stringify(tiny),
          );
          config.HOLDER_MIN_ROUND_RAW = undefined;
          // The probe round never existed on-chain; drop it so later sections see the real set.
          store.holderRounds.delete(probeId);
          store.holderLeaves.delete(probeId);
        }

        // Restore the suite's baseline posture.
        mock.mockSetHolderBalance(holderAddr, 0n);
        mock.mockSetHolderUnreserved(0n);
        mock.mockSetMaxRoundTotal(10n ** 30n);
        config.CARE_TOKEN_ADDRESS = prevCareToken;
        config.FEE_TOKEN_ADDRESS = prevFeeToken;
        config.HOLDER_MIN_ROUND_RAW = prevMinRound;
        config.holderPosterAddress = prevPoster;
        config.modes.holderRewardsLive = false;
        config.modes.holderPostingLive = false;
        _resetHolderRoundHealth();
      }

      // ====== 40c. MAINNET BLOCKER: the LAUNCHPAD CREATOR-FEE INLET ======
      //
      // THE BLOCKER. CARE launches on letscash.fun, whose pool-level trade tax ACCRUES to a
      // "creator" seat inside the hook: claimable only by hook.claim(poolId) FROM THE CURRENT
      // CREATOR, reassignable only by hook.updateCreator(poolId, addr) FROM THE CURRENT CREATOR.
      // The deploy script used to instruct the operator to point that seat at the CareFeeSplitter,
      // which can call NEITHER (no low-level call, no delegatecall, no receive, no fallback), so
      // following our own checklist would have destroyed the entire revenue stream permanently.
      //
      // The fix is a COLLECTOR account that holds the seat, plus this job that claims and forwards.
      // Everything below runs against the mock, which models the hook's PULL + current-creator-only
      // semantics, and drives each failure mode deliberately.
      {
        const {
          runLaunchpadFeeInlet,
          getLaunchpadInletHealth,
          _resetLaunchpadInletHealth,
          verifyLaunchpadCollector,
        } = await import("../src/runner/launchpad-inlet.js");
        const mock = relayer.chain as any;

        // Save every knob this block moves.
        const prevFeeToken = config.FEE_TOKEN_ADDRESS;
        const prevSplitter = config.FEE_SPLITTER_ADDRESS;
        const prevHook = config.LAUNCHPAD_HOOK_ADDRESS;
        const prevPoolId = config.LAUNCHPAD_POOL_ID;
        const prevCollector = config.careFeeCollectorAddress;
        const prevMinForward = config.LAUNCHPAD_MIN_FORWARD_RAW;

        // Built rather than hand-typed so every one is exactly 20 bytes: an address that is a
        // character short would make these comparisons pass for the wrong reason.
        const collectorAddr = `0xc011ec70${"00".repeat(15)}01`;
        const strangerAddr = `0x${"99".repeat(20)}`;
        const splitterAddr = `0x${"30".repeat(20)}`;

        // --- the DARK state first: unconfigured must be a SILENT no-op, never an error loop ---
        // This is today's posture and testnet's posture, and it runs 4x/day forever, so it has to
        // be quiet. It also has to SAY WHY, which is the difference from the old silent failures.
        _resetLaunchpadInletHealth();
        config.modes.launchpadInletLive = false;
        config.LAUNCHPAD_HOOK_ADDRESS = null;
        const darkInlet = await runLaunchpadFeeInlet(ctx);
        check(
          "an unconfigured creator-fee inlet is a NO-OP that names its own reason",
          darkInlet.claimed === false &&
            darkInlet.forwarded === false &&
            /LAUNCHPAD_HOOK_ADDRESS/.test(darkInlet.skipReason ?? ""),
          JSON.stringify(darkInlet),
        );
        check(
          "the dark reason is published, so an empty splitter is explainable",
          /LAUNCHPAD_HOOK_ADDRESS/.test(getLaunchpadInletHealth().lastSkipReason ?? ""),
          String(getLaunchpadInletHealth().lastSkipReason),
        );
        // And the boot assertion must not touch the chain at all when the inlet is off.
        {
          let creatorReads = 0;
          const realRead = relayer.launchpadPoolConfig.bind(relayer);
          (relayer as any).launchpadPoolConfig = () => {
            creatorReads++;
            return realRead();
          };
          await verifyLaunchpadCollector(ctx);
          check("the boot check is inert when the inlet is unconfigured", creatorReads === 0, `reads ${creatorReads}`);
          delete (relayer as any).launchpadPoolConfig;
        }

        // --- arm the inlet ---
        config.FEE_TOKEN_ADDRESS = "0x2020202020202020202020202020202020202020";
        config.FEE_SPLITTER_ADDRESS = splitterAddr;
        config.LAUNCHPAD_HOOK_ADDRESS = "0x4040404040404040404040404040404040404040";
        config.LAUNCHPAD_POOL_ID = `0x${"ab".repeat(32)}`;
        config.LAUNCHPAD_MIN_FORWARD_RAW = undefined;
        config.careFeeCollectorAddress = collectorAddr;
        config.modes.launchpadInletLive = true;
        mock.mockSetCollectorKeyAddress(collectorAddr);
        mock.mockSetOnChainCreator(collectorAddr);
        mock.mockSetCollectorFeeToken(0n);
        mock.mockSetSplitterBalance(0n);
        _resetLaunchpadInletHealth();

        check(
          "the collector is a DIFFERENT address from the relayer and from the poster",
          relayer.careFeeCollectorAddress === collectorAddr &&
            relayer.careFeeCollectorAddress!.toLowerCase() !== relayer.address.toLowerCase() &&
            relayer.careFeeCollectorAddress!.toLowerCase() !== (relayer.holderPosterAddress ?? "").toLowerCase(),
          `${relayer.careFeeCollectorAddress} vs relayer ${relayer.address} vs poster ${relayer.holderPosterAddress}`,
        );

        // --- the happy path: a trade accrues to the seat, we claim it and forward it ---
        mock.mockAccrueLaunchpadFee(1_000_000n); // 1 USDG at 6dp
        const claimRun = await runLaunchpadFeeInlet(ctx);
        check(
          "the inlet CLAIMS the accrued creator fee and FORWARDS it to the splitter",
          claimRun.claimed === true &&
            claimRun.claimedRaw === "1000000" &&
            claimRun.forwarded === true &&
            claimRun.forwardedRaw === "1000000",
          JSON.stringify(claimRun),
        );
        check(
          "the forwarded fee lands on the splitter, which is what distribute() then splits",
          (await relayer.splitterBalance()) === 1_000_000n &&
            (await relayer.collectorFeeTokenBalance()) === 0n,
          `splitter ${await relayer.splitterBalance()} collector ${await relayer.collectorFeeTokenBalance()}`,
        );
        check(
          "the claim is signed by the COLLECTOR key, never by the relayer",
          mock.lastLaunchpadClaimSigner?.toLowerCase() === collectorAddr &&
            mock.lastLaunchpadClaimSigner?.toLowerCase() !== relayer.address.toLowerCase(),
          `signer ${mock.lastLaunchpadClaimSigner} relayer ${relayer.address}`,
        );

        // --- THE GUARD THAT MATTERS: we do not hold the seat, so we never blind-send ---
        mock.mockSetOnChainCreator(strangerAddr);
        mock.mockAccrueLaunchpadFee(500_000n);
        const mismatch = await runLaunchpadFeeInlet(ctx);
        check(
          "a creator-seat mismatch is DETECTED and NO claim is attempted",
          mismatch.claimed === false && /creator mismatch/i.test(mismatch.skipReason ?? ""),
          JSON.stringify(mismatch),
        );
        {
          const h = getLaunchpadInletHealth();
          check(
            "inlet health names BOTH addresses on a seat mismatch",
            h.creatorMatchesCollector === false &&
              h.onChainCreator?.toLowerCase() === strangerAddr.toLowerCase() &&
              h.collectorAddress === collectorAddr,
            JSON.stringify({ match: h.creatorMatchesCollector, onChain: h.onChainCreator, ours: h.collectorAddress }),
          );
        }
        // THE REGRESSION THAT MATTERS MOST: pointing the seat at the SPLITTER is the one-way
        // mistake the deploy script used to instruct. The inlet must refuse and must not silently
        // treat the splitter as "close enough" because it is our own contract.
        mock.mockSetOnChainCreator(splitterAddr);
        const seatOnSplitter = await runLaunchpadFeeInlet(ctx);
        check(
          "a creator seat pointed at the SPLITTER is refused, not treated as ours",
          seatOnSplitter.claimed === false && /creator mismatch/i.test(seatOnSplitter.skipReason ?? ""),
          JSON.stringify(seatOnSplitter),
        );
        // The boot assertion sees the same thing, and clears when the seat is ours again.
        _resetLaunchpadInletHealth();
        await verifyLaunchpadCollector(ctx);
        check(
          "the boot assertion flags a creator-seat mismatch",
          getLaunchpadInletHealth().creatorMatchesCollector === false,
        );
        mock.mockSetOnChainCreator(collectorAddr);
        _resetLaunchpadInletHealth();
        await verifyLaunchpadCollector(ctx);
        check(
          "the boot assertion passes when the collector IS the on-chain creator",
          getLaunchpadInletHealth().creatorMatchesCollector === true,
        );

        // ====== THE SHAPE OF THE READ ITSELF ======
        //
        // The seat used to be read with creator(bytes32), a selector that exists in NEITHER deployed
        // hook, and the answer was decoded with getAddress(result as string). The real read is
        // poolConfigs(bytes32), which returns a FIVE-VALUE tuple that viem hands back as an ARRAY, so
        // the old code would have thrown on every cycle even after the signature was corrected: two
        // independent bugs, either of which alone kills the entire trade-tax revenue stream.
        {
          const { decodeLaunchpadPoolConfig } = await import("../src/chain/robinhood.js");
          const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // the real mainnet USDG, 6dp
          const nativeQuoteAddr = `0x${"00".repeat(20)}`;

          const tuple = decodeLaunchpadPoolConfig([collectorAddr, 9000, 30000, true, usdg], "poolConfigs");
          check(
            "the poolConfigs TUPLE decodes element 0 as the creator (getAddress on the array used to throw)",
            tuple.creator.toLowerCase() === collectorAddr.toLowerCase() &&
              tuple.exists === true &&
              tuple.quote?.toLowerCase() === usdg.toLowerCase(),
            JSON.stringify(tuple),
          );
          check(
            "the 3% tier decodes as 2.7% creator / 0.3% platform (creatorFeeBps 9000, feeRate 30000)",
            tuple.creatorFeeBps === 9000 && tuple.feeRate === 30000,
            JSON.stringify({ bps: tuple.creatorFeeBps, rate: tuple.feeRate }),
          );
          const asBigints = decodeLaunchpadPoolConfig(
            [collectorAddr, 9000n, 30000n, false, nativeQuoteAddr],
            "poolConfigs",
          );
          check(
            "the numeric fields decode whether they arrive as numbers or as bigints",
            asBigints.creatorFeeBps === 9000 && asBigints.feeRate === 30000 && asBigints.exists === false,
            JSON.stringify(asBigints),
          );
          const named = decodeLaunchpadPoolConfig(
            { creator: collectorAddr, creatorFeeBps: 9000, feeRate: 30000, exists: true, quote: usdg },
            "poolConfigs",
          );
          check(
            "a named-component struct return decodes to the same row",
            named.creator.toLowerCase() === collectorAddr.toLowerCase() && named.quote?.toLowerCase() === usdg.toLowerCase(),
            JSON.stringify(named),
          );
          // TOLERANCE, NOT TRUST: a future hook that returns only the seat still reads, but every
          // other field stays UNKNOWN, which the quote guard below then refuses to send on.
          const bare = decodeLaunchpadPoolConfig(collectorAddr, "creator");
          check(
            "a bare-address return still yields the seat, with everything else UNKNOWN (never assumed)",
            bare.creator.toLowerCase() === collectorAddr.toLowerCase() &&
              bare.quote === null &&
              bare.exists === null &&
              bare.creatorFeeBps === null,
            JSON.stringify(bare),
          );
          let decodeErr = "";
          try {
            decodeLaunchpadPoolConfig(42n, "poolConfigs");
          } catch (err) {
            decodeErr = String(err);
          }
          check(
            "an undecodable return names the REAL signature instead of failing as getAddress noise",
            /poolConfigs\(bytes32/.test(decodeErr),
            decodeErr,
          );
          check(
            "the DEFAULT creator read is poolConfigs, never the nonexistent creator(bytes32)",
            /poolConfigs\(bytes32/.test(config.LAUNCHPAD_HOOK_CREATOR_FN) &&
              !/function\s+creator\s*\(/.test(config.LAUNCHPAD_HOOK_CREATOR_FN),
            config.LAUNCHPAD_HOOK_CREATOR_FN,
          );
        }

        // ====== THE QUOTE-ASSET TRAP (would have silently lost ALL revenue) ======
        //
        // Every observed launch on this launchpad in the last ~600k blocks was quoted in NATIVE ETH
        // (84 of 84 across 29 hours), while this entire pipeline assumes USDG: 6 decimals, an ERC-20
        // forward, and a CareFeeSplitter with no receive() and no fallback. On an ETH-quoted pool the
        // hook pays with .call{value:}, the forward moves nothing, and the splitter cannot take
        // delivery at all. The inlet must therefore REFUSE, and refuse without sending anything:
        // "claimed === false" alone would also be true of a claim that simply reverted, so every
        // send is counted.
        {
          let sends = 0;
          const realClaim = relayer.launchpadClaim.bind(relayer);
          const realClaimTo = relayer.launchpadClaimToSplitter.bind(relayer);
          const realForward = relayer.collectorForwardToSplitter.bind(relayer);
          (relayer as any).launchpadClaim = () => {
            sends++;
            return realClaim();
          };
          (relayer as any).launchpadClaimToSplitter = () => {
            sends++;
            return realClaimTo();
          };
          (relayer as any).collectorForwardToSplitter = (amount: bigint) => {
            sends++;
            return realForward(amount);
          };

          _resetLaunchpadInletHealth();
          mock.mockSetSplitterBalance(0n);
          mock.mockSetCollectorFeeToken(0n);
          mock.mockSetLaunchpadAccrued(1_000_000n);
          mock.mockSetPoolQuote(`0x${"00".repeat(20)}`); // address(0) = a NATIVE ETH pool
          const nativePool = await runLaunchpadFeeInlet(ctx);
          const splitterAfterNative = await relayer.splitterBalance();
          check(
            "a NATIVE-ETH-quoted pool is REFUSED: no claim, no transfer, the fee stays accrued",
            nativePool.claimed === false &&
              nativePool.forwarded === false &&
              sends === 0 &&
              /quote asset/i.test(nativePool.skipReason ?? "") &&
              /NATIVE ETH/.test(nativePool.skipReason ?? "") &&
              splitterAfterNative === 0n,
            `${JSON.stringify(nativePool)} sends ${sends} splitter ${splitterAfterNative}`,
          );
          {
            const h = getLaunchpadInletHealth();
            check(
              "the quote refusal publishes BOTH sides of the comparison",
              h.quoteMatchesFeeToken === false &&
                h.onChainQuote === `0x${"00".repeat(20)}` &&
                h.poolExists === true,
              JSON.stringify({ match: h.quoteMatchesFeeToken, quote: h.onChainQuote, feeToken: config.FEE_TOKEN_ADDRESS }),
            );
          }
          // Some OTHER ERC-20 is refused for exactly the same reason: our decimals, our forward and
          // our splitter are all built for one token.
          mock.mockSetPoolQuote(`0x${"77".repeat(20)}`);
          const wrongToken = await runLaunchpadFeeInlet(ctx);
          check(
            "a pool quoted in some OTHER token is refused too, not just the native case",
            wrongToken.claimed === false && sends === 0 && /quote asset/i.test(wrongToken.skipReason ?? ""),
            `${JSON.stringify(wrongToken)} sends ${sends}`,
          );
          // UNKNOWN IS NOT A PASS. A hook shape that does not report a quote leaves us unable to
          // prove the asset, and this guard exists precisely to make blind-claiming impossible.
          mock.mockSetPoolQuote(null);
          const unknownQuote = await runLaunchpadFeeInlet(ctx);
          check(
            "an UNKNOWN quote asset is refused rather than assumed safe",
            unknownQuote.claimed === false &&
              sends === 0 &&
              getLaunchpadInletHealth().quoteMatchesFeeToken === null,
            `${JSON.stringify(unknownQuote)} sends ${sends}`,
          );
          // A pool id the hook has never registered: the seat comparison would otherwise run against
          // a default-zero struct.
          mock.mockSetPoolQuote(undefined);
          mock.mockSetPoolExists(false);
          const phantom = await runLaunchpadFeeInlet(ctx);
          check(
            "a pool the hook has never registered (exists = false) is refused before anything is sent",
            phantom.claimed === false && sends === 0 && /exists = false/.test(phantom.skipReason ?? ""),
            `${JSON.stringify(phantom)} sends ${sends}`,
          );
          // ...and with a registered, USDG-quoted, ours pool, the SAME accrual claims normally. That
          // is what proves the guards above refused for their stated reason and not by accident.
          mock.mockSetPoolExists(true);
          const good = await runLaunchpadFeeInlet(ctx);
          check(
            "the same accrual DOES claim once the pool is registered, ours and USDG-quoted",
            good.claimed === true && good.forwarded === true && good.forwardedRaw === "1000000" && sends > 0,
            `${JSON.stringify(good)} sends ${sends}`,
          );
          delete (relayer as any).launchpadClaim;
          delete (relayer as any).launchpadClaimToSplitter;
          delete (relayer as any).collectorForwardToSplitter;
        }

        // ====== CLAIM STRAIGHT TO THE SPLITTER (the default path) ======
        //
        // claim(bytes32,address) is present in the live hook's runtime bytecode, so the collector can
        // pay the splitter in ONE transaction. That deletes the forward step: one fewer send, one
        // fewer failure mode, and the collector EOA never custodies revenue at all. The fallback is
        // kept for a hook that only offers claim(bytes32), and the choice is config-driven and
        // logged, never inferred from a revert (a revert is indistinguishable from a quiet pool).
        {
          let forwards = 0;
          const realForward = relayer.collectorForwardToSplitter.bind(relayer);
          (relayer as any).collectorForwardToSplitter = (amount: bigint) => {
            forwards++;
            return realForward(amount);
          };
          _resetLaunchpadInletHealth();
          mock.mockSetSplitterBalance(0n);
          mock.mockSetCollectorFeeToken(0n);
          mock.mockSetLaunchpadAccrued(1_200_000n);
          const direct = await runLaunchpadFeeInlet(ctx);
          const collectorAfterDirect = await relayer.collectorFeeTokenBalance();
          const splitterAfterDirect = await relayer.splitterBalance();
          check(
            "with claim(bytes32,address) available the inlet claims STRAIGHT to the splitter, in one tx",
            direct.claimPath === "claim-to-splitter" &&
              direct.claimed === true &&
              direct.claimedToSplitter === true &&
              direct.forwarded === true &&
              direct.forwardedRaw === "1200000" &&
              forwards === 0 &&
              mock.lastClaimToRecipient?.toLowerCase() === splitterAddr.toLowerCase(),
            `${JSON.stringify(direct)} forwards ${forwards} to ${mock.lastClaimToRecipient}`,
          );
          check(
            "the collector EOA never custodies the revenue on the default path",
            collectorAfterDirect === 0n && splitterAfterDirect === 1_200_000n,
            `collector ${collectorAfterDirect} splitter ${splitterAfterDirect}`,
          );
          {
            const h = getLaunchpadInletHealth();
            check(
              "health names the chosen path and counts the one-tx claim as money arriving",
              h.claimPath === "claim-to-splitter" &&
                h.lastForwardTxHash === h.lastClaimTxHash &&
                h.totalForwardedRaw === "1200000",
              JSON.stringify({ path: h.claimPath, claim: h.lastClaimTxHash, forward: h.lastForwardTxHash, total: h.totalForwardedRaw }),
            );
          }
          // THE FALLBACK: a V1 hook that only offers claim(bytes32). Same guards, same destination,
          // two transactions instead of one.
          config.modes.launchpadClaimToSplitter = false;
          _resetLaunchpadInletHealth();
          mock.mockSetSplitterBalance(0n);
          mock.mockSetLaunchpadAccrued(900_000n);
          const fallback = await runLaunchpadFeeInlet(ctx);
          const splitterAfterFallback = await relayer.splitterBalance();
          check(
            "clearing the two-arg claim falls back to claim-then-forward: two txs, same destination",
            fallback.claimPath === "claim-then-forward" &&
              fallback.claimed === true &&
              fallback.claimedToSplitter === undefined &&
              fallback.forwarded === true &&
              fallback.forwardedRaw === "900000" &&
              forwards === 1 &&
              mock.lastClaimToRecipient === null &&
              splitterAfterFallback === 900_000n,
            `${JSON.stringify(fallback)} forwards ${forwards} splitter ${splitterAfterFallback}`,
          );
          config.modes.launchpadClaimToSplitter = true;
          delete (relayer as any).collectorForwardToSplitter;
        }

        // AN UNREADABLE RPC IS NOT PERMISSION TO SEND. A failed creator() read must skip, not
        // guess, and must never conclude "mismatch" or "match" from a failure.
        {
          const realCreator = relayer.launchpadCreator.bind(relayer);
          (relayer as any).launchpadPoolConfig = () => Promise.reject(new Error("simulated RPC failure"));
          let claims = 0;
          const realClaim = relayer.launchpadClaim.bind(relayer);
          const realClaimTo = relayer.launchpadClaimToSplitter.bind(relayer);
          (relayer as any).launchpadClaim = () => {
            claims++;
            return realClaim();
          };
          (relayer as any).launchpadClaimToSplitter = () => {
            claims++;
            return realClaimTo();
          };
          const blind = await runLaunchpadFeeInlet(ctx);
          check(
            "an unreadable poolConfigs() SKIPS instead of blind-sending a claim",
            blind.claimed === false && claims === 0 && /poolConfigs\(\)/.test(blind.skipReason ?? ""),
            `${JSON.stringify(blind)} claims ${claims}`,
          );
          check(
            "the seat verdict stays UNDECIDED after a failed read",
            getLaunchpadInletHealth().creatorMatchesCollector === null,
            String(getLaunchpadInletHealth().creatorMatchesCollector),
          );
          // The boot check must also survive it without throwing (it runs before app.listen).
          let threw = false;
          try {
            await verifyLaunchpadCollector(ctx);
          } catch {
            threw = true;
          }
          check("an unreadable RPC never blocks boot", !threw);
          delete (relayer as any).launchpadPoolConfig;
          delete (relayer as any).launchpadClaim;
          delete (relayer as any).launchpadClaimToSplitter;
          check("the creator read is restored after the failure test", (await realCreator()) === collectorAddr);
        }

        // --- SELF-HEALING: a claim that landed but never got forwarded is completed later ---
        // This is why the forward sweeps the WHOLE collector balance rather than just this run's
        // delta: money must never be stranded on a hot key by a one-off RPC blip.
        _resetLaunchpadInletHealth();
        mock.mockSetSplitterBalance(0n);
        // Drain the seat first: this case is specifically "the claim finds nothing, and the forward
        // must still run", so leaving the mismatch test's accrual in place would hide the point.
        mock.mockSetLaunchpadAccrued(0n);
        mock.mockSetCollectorFeeToken(750_000n); // left over from an earlier failed forward
        const stranded = await runLaunchpadFeeInlet(ctx); // nothing accrued: the claim will revert
        check(
          "a failed claim does NOT stop the forward: stranded money is swept anyway",
          stranded.claimed === false &&
            stranded.forwarded === true &&
            stranded.forwardedRaw === "750000" &&
            (await relayer.splitterBalance()) === 750_000n,
          JSON.stringify(stranded),
        );

        // --- a lone claim revert is NORMAL (a quiet pool) and must not read as a fault ---
        _resetLaunchpadInletHealth();
        mock.mockSetCollectorFeeToken(0n);
        const quiet = await runLaunchpadFeeInlet(ctx);
        check(
          "a quiet pool (nothing accrued) is recorded, not treated as a crisis",
          quiet.claimed === false &&
            quiet.forwarded === false &&
            getLaunchpadInletHealth().consecutiveClaimFailures === 1,
          JSON.stringify(quiet),
        );
        // ...but a RUN of them is: the counter is what tells a quiet market from a broken inlet.
        await runLaunchpadFeeInlet(ctx);
        await runLaunchpadFeeInlet(ctx);
        await runLaunchpadFeeInlet(ctx);
        check(
          "consecutive claim failures accumulate so a broken inlet is distinguishable from a quiet one",
          getLaunchpadInletHealth().consecutiveClaimFailures === 4,
          String(getLaunchpadInletHealth().consecutiveClaimFailures),
        );

        // --- the dust floor ---
        mock.mockSetCollectorFeeToken(5n);
        config.LAUNCHPAD_MIN_FORWARD_RAW = "1000";
        const dust = await runLaunchpadFeeInlet(ctx);
        check(
          "a dust balance below LAUNCHPAD_MIN_FORWARD_RAW is held for the next cycle, not forwarded",
          dust.forwarded === false && /below LAUNCHPAD_MIN_FORWARD_RAW/.test(dust.skipReason ?? ""),
          JSON.stringify(dust),
        );
        config.LAUNCHPAD_MIN_FORWARD_RAW = undefined;
        mock.mockSetCollectorFeeToken(0n);

        // --- no collector key at all: the chain layer refuses with an actionable sentence ---
        {
          mock.mockSetCollectorKeyAddress(null);
          let keyless = "";
          try {
            await relayer.launchpadClaim();
          } catch (err) {
            keyless = String(err);
          }
          check(
            "the chain layer refuses to claim without a collector key (it never falls back to the relayer)",
            /CARE_FEE_COLLECTOR_PRIVATE_KEY/.test(keyless),
            keyless,
          );
          mock.mockSetCollectorKeyAddress(collectorAddr);
        }

        // --- ORDERING: the inlet runs BEFORE the splitter poke, in the same cycle ---
        // If it ran after, every cycle would distribute the PREVIOUS cycle's revenue and the newest
        // claim would sit idle for six hours. Proven by running the real fee-distribution entry
        // point with an accrued fee and no pre-existing splitter balance.
        {
          const { runFeeDistribution: runFees } = await import("../src/runner/tax-rewards.js");
          mock.mockSetSplitterBalance(0n);
          mock.mockSetHolderUnreserved(0n);
          mock.mockAccrueLaunchpadFee(2_000_000n);
          const prevHolderLive = config.modes.holderRewardsLive;
          config.modes.holderRewardsLive = true;
          config.modes.holderPostingLive = false; // keep this block off the round-posting path
          const cycle = await runFees(ctx);
          check(
            "one cycle claims the creator fee AND distributes it (the inlet runs first)",
            cycle.distributed === true && (await relayer.holderUnreserved()) === 1_000_000n,
            `${JSON.stringify(cycle)} unreserved ${await relayer.holderUnreserved()}`,
          );
          config.modes.holderRewardsLive = prevHolderLive;
          mock.mockSetHolderUnreserved(0n);
        }

        // --- observability: /internal/status publishes the whole inlet picture ---
        {
          const token = config.INTERNAL_STATUS_TOKEN;
          const status: any = await fetch(`${base}/internal/status`, {
            headers: { authorization: `Bearer ${token}` },
          }).then((r: Response) => r.json());
          check(
            "internal status publishes creator-fee inlet health (the signal an empty splitter lacked)",
            status.launchpadInlet?.inletLive === true &&
              status.launchpadInlet?.collectorAddress === collectorAddr &&
              status.launchpadInlet?.hookAddress === config.LAUNCHPAD_HOOK_ADDRESS &&
              typeof status.launchpadInlet?.totalForwardedRaw === "string",
            JSON.stringify(status.launchpadInlet),
          );
          check(
            "internal status reports the last inlet attempt and the collector's own gas balance",
            status.launchpadInlet?.lastAttempt !== null &&
              typeof status.launchpadInlet?.collectorBalanceEth === "number" &&
              status.launchpadInlet?.collectorGasLow === false,
            JSON.stringify({
              attempt: status.launchpadInlet?.lastAttempt,
              eth: status.launchpadInlet?.collectorBalanceEth,
            }),
          );
          check(
            "the stub matrix calls the inlet out separately from the splitter it feeds",
            typeof status.modes?.launchpadFeeInlet === "string" &&
              status.modes.launchpadFeeInlet.startsWith("LIVE"),
            String(status.modes?.launchpadFeeInlet),
          );
          // A third dedicated signer is a third gas tank nobody tops up by habit.
          mock.mockSetCollectorBalanceWei(0n);
          const dryStatus: any = await fetch(`${base}/internal/status`, {
            headers: { authorization: `Bearer ${token}` },
          }).then((r: Response) => r.json());
          check(
            "an unfunded collector key is flagged as low on gas",
            dryStatus.launchpadInlet?.collectorBalanceEth === 0 &&
              dryStatus.launchpadInlet?.collectorGasLow === true,
            JSON.stringify({
              eth: dryStatus.launchpadInlet?.collectorBalanceEth,
              low: dryStatus.launchpadInlet?.collectorGasLow,
            }),
          );
          mock.mockSetCollectorBalanceWei(10n ** 18n);
        }

        // Restore the suite's baseline posture.
        mock.mockSetCollectorFeeToken(0n);
        mock.mockSetSplitterBalance(0n);
        mock.mockSetOnChainCreator(collectorAddr);
        mock.mockSetPoolQuote(undefined); // back to "quoted in whatever FEE_TOKEN_ADDRESS is"
        mock.mockSetPoolExists(true);
        config.FEE_TOKEN_ADDRESS = prevFeeToken;
        config.FEE_SPLITTER_ADDRESS = prevSplitter;
        config.LAUNCHPAD_HOOK_ADDRESS = prevHook;
        config.LAUNCHPAD_POOL_ID = prevPoolId;
        config.LAUNCHPAD_MIN_FORWARD_RAW = prevMinForward;
        config.careFeeCollectorAddress = prevCollector;
        config.modes.launchpadInletLive = false;
        _resetLaunchpadInletHealth();
      }
    }

    // ====== 41. CORS allowlist anchoring (server review, MED) ======
    // The walletchi- preview rule must be ANCHORED to .vercel.app: the bare
    // prefix matched any registrable domain starting with "walletchi-"
    // (confirmed live with walletchi-evil.com before the fix). The cors
    // middleware reflects an allowed Origin into access-control-allow-origin
    // and omits the header for a rejected one.
    {
      const cors = (origin: string) =>
        fetch(`${base}/health`, { headers: { Origin: origin } }).then(
          (r) => r.headers.get("access-control-allow-origin"),
        );
      check("CORS rejects walletchi-evil.com (prefix rule anchored)", (await cors("https://walletchi-evil.com")) === null);
      check(
        "CORS rejects walletchi- prefix on an attacker subdomain",
        (await cors("https://walletchi-x.attacker.com")) === null,
      );
      const preview = await cors("https://walletchi-abc123.vercel.app");
      check("CORS allows walletchi preview deploys on vercel.app", preview === "https://walletchi-abc123.vercel.app", String(preview));
      const prod = await cors("https://www.playwalletchi.com");
      check("CORS allows the production domain", prod === "https://www.playwalletchi.com", String(prod));
      check("CORS allows the apex production domain", (await cors("https://playwalletchi.com")) === "https://playwalletchi.com");

      // THE REGRESSION THAT MATTERS. There used to be a second clause here:
      //   config.NODE_ENV !== "production" && hostname.endsWith(".vercel.app")
      // which allowed ANY vercel.app origin whenever NODE_ENV was not exactly "production".
      // NODE_ENV defaults to "development" and is set only in the Render dashboard, so one
      // unset or misspelled value re-opened a blanket wildcard on an API that moves real
      // value. This suite runs with NODE_ENV=test, which is precisely the state that used to
      // fail open, so these two cases FAIL against the old code and pass against the new.
      check(
        "CORS rejects an arbitrary vercel.app host (no NODE_ENV-gated wildcard)",
        (await cors("https://totally-unrelated.vercel.app")) === null,
      );
      check(
        "CORS rejects an attacker vercel.app host that merely contains walletchi",
        (await cors("https://evil-walletchi.vercel.app")) === null,
      );
      check("smoke runs with NODE_ENV != production (so the above proves the fail-open is gone)", config.NODE_ENV !== "production", config.NODE_ENV);
    }

    // ====== 42. Boot guards are keyed on real value, not on NODE_ENV ======
    // evaluateBootGuards is a PURE function of the environment precisely so these branches can
    // be exercised. Inline in build() they were only ever observable in whichever branch this
    // suite's own env happened to take, which for checks whose whole job is to refuse a BAD
    // environment meant the interesting branches were never tested at all.
    {
      const { evaluateBootGuards } = await import("../src/config.js");
      // A well-formed real-value deployment: everything a live season is required to have.
      const good = {
        NODE_ENV: "production",
        // Widened on purpose: the override helper below flips this to "mainnet" in several cases.
        ROBINHOOD_NETWORK: "testnet" as "mainnet" | "testnet",
        ANTI_SYBIL_ENABLED: true,
        SYBIL_PEPPER: "a-real-unique-pepper-value-not-the-committed-default",
        CARE_SESSION_SECRET: "a-long-enough-care-session-secret-value-here",
        CARE_LINK_SECRET: "a-real-care-link-pepper",
        SURVIVAL_ENABLED: true,
        REQUIRE_SELF_CUSTODY: true,
        HOLDER_EXCLUDE_ADDRESSES: "0xpool",
        GAS_WEBHOOK_SIGNING_KEY: "a-real-webhook-signing-key",
        relayerLive: true,
        survivalLive: true,
        holderRewardsLive: true,
        privyLive: true,
        holderPosterConfigured: true,
        holderPosterKeyInvalid: false,
        // The launchpad creator-fee inlet: the SOURCE of everything the splitter distributes. A
        // "fully configured real-value deployment" now includes something that actually claims the
        // trade tax, because without it every downstream leg reports success while distributing
        // nothing.
        launchpadHookConfigured: true,
        launchpadPoolIdConfigured: true,
        launchpadPoolIdInvalid: false,
        collectorConfigured: true,
        collectorKeyInvalid: false,
        collectorIsRelayer: false,
        collectorIsPoster: false,
        // Turnstile captcha: a matched pair (here: both off) is the quiet state.
        captchaSecretConfigured: false,
        captchaSiteConfigured: false,
      };
      const g = (over: Partial<typeof good>) => evaluateBootGuards({ ...good, ...over });

      // Captcha half-pair: LOUD (one error naming the missing half), never fatal;
      // any matched pair is silent.
      check(
        "boot guards: captcha secret without site key is a loud non-fatal error",
        g({ captchaSecretConfigured: true }).fatal === null &&
          g({ captchaSecretConfigured: true }).errors.some((e) => e.includes("TURNSTILE_SITE_KEY is not")),
        g({ captchaSecretConfigured: true }).errors.join(" | "),
      );
      check(
        "boot guards: captcha site key without secret is a loud non-fatal error",
        g({ captchaSiteConfigured: true }).fatal === null &&
          g({ captchaSiteConfigured: true }).errors.some((e) => e.includes("TURNSTILE_SECRET_KEY is not")),
        g({ captchaSiteConfigured: true }).errors.join(" | "),
      );
      check(
        "boot guards: a full captcha pair adds no boot noise",
        g({ captchaSecretConfigured: true, captchaSiteConfigured: true }).errors.length === 0,
        g({ captchaSecretConfigured: true, captchaSiteConfigured: true }).errors.join(" | "),
      );

      check("boot guards: a fully configured real-value deployment boots", g({}).fatal === null, String(g({}).fatal));
      check("boot guards: a fully configured real-value deployment logs no errors", g({}).errors.length === 0, g({}).errors.join(" | "));

      // THE STRUCTURAL FIX: enforcement no longer depends on NODE_ENV being right.
      check(
        "boot guards: enforced when NODE_ENV is unset/wrong but real value is at stake",
        g({ NODE_ENV: "development" }).enforced === true,
      );
      check(
        "boot guards: enforced on mainnet even when NODE_ENV is unset/wrong",
        g({ NODE_ENV: "development", SURVIVAL_ENABLED: false, survivalLive: false, ROBINHOOD_NETWORK: "mainnet" }).enforced === true,
      );
      check(
        "boot guards: still enforced when NODE_ENV=production and no value is at stake (superset, nothing lost)",
        g({ SURVIVAL_ENABLED: false, survivalLive: false, holderRewardsLive: false }).enforced === true,
      );
      check(
        "boot guards: inert for a plain dev/test box (no mainnet, no real value, no NODE_ENV=production)",
        g({ NODE_ENV: "test", SURVIVAL_ENABLED: false, survivalLive: false, holderRewardsLive: false }).enforced === false,
      );

      // Each value-protecting guard now fires on a NON-production NODE_ENV.
      const devReal = { NODE_ENV: "development" };
      check(
        "boot guards: CARE_LINK_SECRET required on real value even when NODE_ENV is not production",
        (g({ ...devReal, CARE_LINK_SECRET: undefined }).fatal ?? "").includes("CARE_LINK_SECRET"),
      );
      check(
        "boot guards: ANTI_SYBIL_ENABLED required on real value even when NODE_ENV is not production",
        (g({ ...devReal, ANTI_SYBIL_ENABLED: false }).fatal ?? "").includes("ANTI_SYBIL_ENABLED"),
      );
      check(
        "boot guards: dev SYBIL_PEPPER default refused even when NODE_ENV is not production",
        (g({ ...devReal, SYBIL_PEPPER: "dev-sybil-pepper-change-me" }).fatal ?? "").includes("SYBIL_PEPPER"),
      );
      check(
        "boot guards: short CARE_SESSION_SECRET refused even when NODE_ENV is not production",
        (g({ ...devReal, CARE_SESSION_SECRET: "too-short" }).fatal ?? "").includes("CARE_SESSION_SECRET"),
      );
      check(
        "boot guards: mainnet without Privy + self-custody refused even when NODE_ENV is not production",
        (g({ ...devReal, ROBINHOOD_NETWORK: "mainnet", REQUIRE_SELF_CUSTODY: false }).fatal ?? "").includes("self-custody"),
      );

      // NEW GUARD: never run a real-value season against the in-memory MockChain.
      check(
        "boot guards: real value + no live relayer (MockChain fallback) refuses to boot",
        (g({ relayerLive: false }).fatal ?? "").includes("MockChain"),
      );
      // NEW GUARD: half-configured season is a loud ERROR, never a refusal (it is a supported
      // fail-secure transitional state; throwing would strand a launch sequence).
      {
        const v = g({ survivalLive: false, relayerLive: true });
        check("boot guards: SURVIVAL_ENABLED without survivalLive logs an error", v.errors.some((e) => e.includes("survivalLive=false")));
        check("boot guards: SURVIVAL_ENABLED without survivalLive does NOT refuse to boot", v.fatal === null, String(v.fatal));
      }
      // NEW GUARD: holder exclusions. Testnet logs, mainnet refuses.
      {
        const t = g({ HOLDER_EXCLUDE_ADDRESSES: undefined });
        check("boot guards: empty HOLDER_EXCLUDE_ADDRESSES logs an error on testnet", t.errors.some((e) => e.includes("HOLDER_EXCLUDE_ADDRESSES")));
        check("boot guards: empty HOLDER_EXCLUDE_ADDRESSES does NOT refuse on testnet", t.fatal === null, String(t.fatal));
        const m = g({ HOLDER_EXCLUDE_ADDRESSES: undefined, ROBINHOOD_NETWORK: "mainnet" });
        check("boot guards: empty HOLDER_EXCLUDE_ADDRESSES REFUSES on mainnet", (m.fatal ?? "").includes("HOLDER_EXCLUDE_ADDRESSES"));
      }
      // NEW GUARD (mainnet blocker B2): the DEDICATED holder-round poster key. The hardened vault
      // gates postRound on a poster that is never the relayer, so a missing key means every round
      // reverts NotPoster. It is LOUD but never fatal, on mainnet as well as testnet: refusing
      // would take the whole server down for a rewards leg that loses nothing while it waits (the
      // fees stay unreserved in the vault and post once the key lands), which is not true of the
      // exclusions guard above, where the loss is permanent.
      {
        const t = g({ holderPosterConfigured: false });
        check(
          "boot guards: missing HOLDER_POSTER_PRIVATE_KEY logs an error when holder rewards are live",
          t.errors.some((e) => e.includes("HOLDER_POSTER_PRIVATE_KEY")),
          t.errors.join(" | "),
        );
        check("boot guards: missing HOLDER_POSTER_PRIVATE_KEY does NOT refuse to boot", t.fatal === null, String(t.fatal));
        const m = g({ holderPosterConfigured: false, ROBINHOOD_NETWORK: "mainnet" });
        check(
          "boot guards: missing HOLDER_POSTER_PRIVATE_KEY does NOT refuse on MAINNET either (recoverable, unlike lost funds)",
          m.fatal === null && m.errors.some((e) => e.includes("HOLDER_POSTER_PRIVATE_KEY")),
          `${String(m.fatal)} | ${m.errors.join(" | ")}`,
        );
        const bad = g({ holderPosterConfigured: false, holderPosterKeyInvalid: true });
        check(
          "boot guards: an UNUSABLE poster key is called out as unusable, not as missing",
          bad.errors.some((e) => e.includes("NOT a usable private key")),
          bad.errors.join(" | "),
        );
        check(
          "boot guards: a configured poster key produces no poster error",
          g({}).errors.every((e) => !e.includes("HOLDER_POSTER_PRIVATE_KEY")),
          g({}).errors.join(" | "),
        );
        // The guard is scoped to the leg that needs it: no holder rewards, no complaint.
        check(
          "boot guards: no poster complaint when the holder leg is not live at all",
          g({ holderPosterConfigured: false, holderRewardsLive: false }).errors.every(
            (e) => !e.includes("HOLDER_POSTER_PRIVATE_KEY"),
          ),
        );
      }
      // NEW GUARD: gas webhook signing key. Testnet logs (today's season has it unset and MUST
      // keep booting, since the webhook approving is what lets keepers feed pets); mainnet refuses.
      {
        const t = g({ GAS_WEBHOOK_SIGNING_KEY: undefined });
        check("boot guards: missing GAS_WEBHOOK_SIGNING_KEY logs an error on testnet", t.errors.some((e) => e.includes("GAS_WEBHOOK_SIGNING_KEY")));
        check("boot guards: missing GAS_WEBHOOK_SIGNING_KEY does NOT refuse on testnet", t.fatal === null, String(t.fatal));
        const m = g({ GAS_WEBHOOK_SIGNING_KEY: undefined, ROBINHOOD_NETWORK: "mainnet" });
        check("boot guards: missing GAS_WEBHOOK_SIGNING_KEY REFUSES on mainnet", (m.fatal ?? "").includes("GAS_WEBHOOK_SIGNING_KEY"));
      }

      // TODAY'S PRODUCTION ENVIRONMENT, exactly as deployed on Render, must still boot.
      // NODE_ENV=production, testnet, real-value care live, anti-Sybil on with a real pepper,
      // self-custody + Privy live, and GAS_WEBHOOK_SIGNING_KEY unverifiable/unset. If this ever
      // goes red, the live site would refuse to start on the next deploy.
      {
        const today = g({
          NODE_ENV: "production",
          ROBINHOOD_NETWORK: "testnet",
          GAS_WEBHOOK_SIGNING_KEY: undefined,
          HOLDER_EXCLUDE_ADDRESSES: undefined,
        });
        check("boot guards: TODAY'S production env still boots (no fatal)", today.fatal === null, String(today.fatal));
        check(
          "boot guards: TODAY'S production env warns about the gas webhook key instead of refusing",
          today.errors.some((e) => e.includes("GAS_WEBHOOK_SIGNING_KEY")),
          today.errors.join(" | "),
        );
        check(
          "boot guards: TODAY'S production env warns about holder exclusions instead of refusing",
          today.errors.some((e) => e.includes("HOLDER_EXCLUDE_ADDRESSES")),
          today.errors.join(" | "),
        );
        // The same env on MAINNET must refuse, so the hardening actually bites where it counts.
        const onMainnet = g({
          NODE_ENV: "production",
          ROBINHOOD_NETWORK: "mainnet",
          GAS_WEBHOOK_SIGNING_KEY: undefined,
          HOLDER_EXCLUDE_ADDRESSES: undefined,
        });
        check("boot guards: that same env on MAINNET refuses to boot", onMainnet.fatal !== null, String(onMainnet.fatal));
      }
    }

    // ====== 43. Privy stub verification fails CLOSED ======
    // verifyPrivyToken used to return { ok: true, method: "bypass" } when Privy was
    // unconfigured. Both call sites gate on config.modes.privyLive first, so this is a no-op
    // today, but a function named verifyPrivyToken answering "verified" for an unconfigured
    // deployment is one future `if (auth.ok)` away from an auth bypass.
    {
      const { verifyPrivyToken } = await import("../src/services/privy.js");
      check("privy is stubbed in smoke (precondition)", config.modes.privyLive === false);
      const v = await verifyPrivyToken("any-token-at-all");
      check("verifyPrivyToken fails CLOSED when Privy is unconfigured", v.ok === false, JSON.stringify(v));
      check("verifyPrivyToken still reports the bypass posture for diagnostics", v.method === "bypass", v.method);
    }

    // ====== 44. THE SUPPLY WALL KEYS ON THE VERIFIED PRIVY IDENTITY ======
    //
    // The hole this section pins shut: on the self-custody path the one-per-keeper
    // wall keyed on an EMAIL STRING, and a wallet-only Privy login attests no email
    // at all. The route then kept the caller's own field, and finally synthesized
    // `<wallet>@wallet.walletchi.local`, which is unique per attacker-generated key
    // BY CONSTRUCTION. So every gate that keys on email (normalizeEmail, emailHash,
    // emailAlreadyMinted, reserveEmail) counted one attacker with N free self-signed
    // EOAs as N distinct keepers, and the whole 2,000 supply was reachable for the
    // cost of the proof-of-work alone.
    //
    // Runs LAST, and with the real Privy client injected (config.modes.privyLive is
    // flipped on), because it is the only way to exercise the branch that guards the
    // supply. Everything is restored at the end.
    {
      const { _setPrivyClientForTests } = await import("../src/services/privy.js");
      const {
        issuePowChallenge,
        verifyPow,
        evaluateMintGate,
        subjectTag,
        leadingZeroBits: zeroBits,
        emailHash: hashEmail,
        normalizeEmail: normEmail,
        _setTurnstileTransportForTests,
      } = await import("../src/runner/sybil.js");
      const { createHash: sha } = await import("node:crypto");

      const saved = {
        antiSybil: config.ANTI_SYBIL_ENABLED,
        bits: config.POW_DIFFICULTY_BITS,
        minElapsed: config.MINT_MIN_ELAPSED_MS,
        perIp: config.MINTS_PER_IP_PER_DAY,
        perSubnet: config.MINTS_PER_SUBNET_PER_DAY,
        fpCap: config.FINGERPRINT_MINT_CAP,
        privyLive: config.modes.privyLive,
        requireSelfCustody: config.REQUIRE_SELF_CUSTODY,
        survival: config.SURVIVAL_ENABLED,
        survivalLive: config.modes.survivalLive,
        bindRequired: config.POW_REQUIRE_SUBJECT_BINDING,
        testerCap: config.TESTER_ALLOWLIST_MINT_CAP,
      };
      // TODAY'S TESTNET POSTURE, exactly: anti-Sybil on, live Privy, self-custody
      // mandatory, real-value care, a non-empty tester allowlist. If a normal mint
      // stops working under these, the live season stops working.
      config.ANTI_SYBIL_ENABLED = true;
      config.POW_DIFFICULTY_BITS = 8; // fast in-process solve; verify path unchanged
      config.MINT_MIN_ELAPSED_MS = 0;
      config.MINTS_PER_IP_PER_DAY = 500; // every mint below shares one loopback IP
      config.MINTS_PER_SUBNET_PER_DAY = 500;
      config.FINGERPRINT_MINT_CAP = 500;
      config.modes.privyLive = true;
      config.REQUIRE_SELF_CUSTODY = true;

      // A fake Privy directory. verifyAuthToken accepts "session:<userId>" for a
      // known user and throws otherwise, exactly like a bad token upstream.
      type FakeUser = { email: string | null; wallets: string[]; emailLookupFails?: boolean };
      const privyDir = new Map<string, FakeUser>();
      const getUserCalls = new Map<string, number>();
      _setPrivyClientForTests({
        verifyAuthToken: async (token: string) => {
          const userId = token.startsWith("session:") ? token.slice("session:".length) : "";
          if (!privyDir.has(userId)) throw new Error("invalid privy token");
          return { userId };
        },
        getUser: async (userId: string) => {
          const u = privyDir.get(userId);
          if (!u) throw new Error("unknown privy user");
          const n = (getUserCalls.get(userId) ?? 0) + 1;
          getUserCalls.set(userId, n);
          // The wallet read happens first, the email read second, so failing from
          // the second call on models a Privy blip mid-mint rather than a user
          // who simply has no email: two different facts, two different answers.
          if (u.emailLookupFails && n > 1) throw new Error("privy upstream 503");
          return {
            email: u.email ? { address: u.email } : undefined,
            linkedAccounts: u.wallets.map((w) => ({ type: "wallet", address: w })),
          };
        },
      });

      const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
      const solveFor = (nonce: string, bits: number): number => {
        for (let counter = 0; ; counter++) {
          if (zeroBits(sha("sha256").update(`${nonce}:${counter}`).digest()) >= bits) return counter;
        }
      };
      // Fetch a challenge the way a signed-in client should: with its Privy token,
      // so the challenge signature binds this identity.
      const powFor = async (token?: string) => {
        const res = await fetch(`${base}/api/mint/challenge`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        const c = (await res.json()) as any;
        return { nonce: c.nonce, counter: solveFor(c.nonce, c.bits), sig: c.sig, exp: c.exp, bits: c.bits };
      };
      const mintAs = async (
        token: string,
        walletAddress: string,
        extra: Record<string, unknown> = {},
        powOverride?: unknown,
      ) => {
        const res = await fetch(`${base}/api/runner/checkout`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            privyToken: token,
            walletAddress,
            pow: powOverride ?? (await powFor(token)),
            elapsedMs: 4200,
            ...extra,
          }),
        });
        return { res, body: (await res.json()) as any };
      };
      const settle = async (serial: string) => {
        let s: any = null;
        for (let i = 0; i < 40; i++) {
          s = await fetch(`${base}/api/runner/checkout/${serial}`).then(j);
          if (s.status === "ready" || s.status === "failed") break;
          await sleep(50);
        }
        return s;
      };

      // 44a. TODAY'S NORMAL MINT still works end to end: signed in, wallet linked,
      // email attested by Privy, pet lands in the keeper's own wallet and reaches
      // ready. This is the regression guard for the live testnet season.
      const w1 = wallet(0xa11);
      privyDir.set("did:privy:keeper-one", { email: "keeper.one@walletchi.test", wallets: [w1] });
      const m1 = await mintAs("session:did:privy:keeper-one", w1);
      check("identity wall: an honest verified mint (attested email) is accepted", m1.res.status === 200 && Boolean(m1.body.id), JSON.stringify(m1.body));
      check("identity wall: the pet mints to the keeper's own wallet (self-custody)", String(m1.body.ownerAddress).toLowerCase() === w1, String(m1.body.ownerAddress));
      const m1State = await settle(m1.body.serial);
      check("identity wall: the honest verified mint reaches ready (live-posture e2e)", m1State?.status === "ready" && Boolean(m1State?.tokenId), JSON.stringify({ s: m1State?.status }));

      // 44b. THE EXPLOIT, DIRECTLY: the same verified identity comes back with a
      // different caller-supplied email and a second linked wallet. Before the fix
      // this minted, because the caller's string survived and keyed every gate.
      const w1b = wallet(0xa12);
      privyDir.set("did:privy:keeper-one", { email: "keeper.one@walletchi.test", wallets: [w1, w1b] });
      const m2 = await mintAs("session:did:privy:keeper-one", w1b, { email: "brand-new-inbox@walletchi.test" });
      check("identity wall: same identity + a DIFFERENT caller-supplied email is refused", m2.res.status === 403 && m2.body.code === "already_minted", JSON.stringify(m2.body));

      // 44c. The sharper version: the identity's ATTESTED email changes, so the
      // email wall genuinely cannot fire and only the identity reserve is left.
      privyDir.set("did:privy:keeper-one", { email: "keeper.one.moved@walletchi.test", wallets: [w1] });
      const m3 = await mintAs("session:did:privy:keeper-one", w1);
      check("identity wall: same identity with a FRESH attested inbox is still refused", m3.res.status === 403 && m3.body.code === "already_minted", JSON.stringify(m3.body));
      const movedHash = hashEmail(normEmail("keeper.one.moved@walletchi.test"));
      check("identity wall: the refused mint rolled its email reservation back (no stranded inbox)", (await store.emailAlreadyMinted(movedHash)) === false, "");
      const w2 = wallet(0xa20);
      privyDir.set("did:privy:keeper-two", { email: "keeper.one.moved@walletchi.test", wallets: [w2] });
      const m4 = await mintAs("session:did:privy:keeper-two", w2);
      check("identity wall: the rolled-back inbox is still mintable by a different identity", m4.res.status === 200, JSON.stringify(m4.body));

      // 44d. THE SYBIL RUN ITSELF: wallet-only Privy logins attest no email. Each
      // one used to synthesize a unique <wallet>@wallet.walletchi.local and mint.
      const attackerWallets = [wallet(0xb00), wallet(0xb01), wallet(0xb02)];
      const supplyBefore = await store.countRunners();
      let walletOnlyMinted = 0;
      let walletOnlyRefused = 0;
      for (let i = 0; i < attackerWallets.length; i++) {
        const wx = attackerWallets[i]!;
        privyDir.set(`did:privy:wallet-only-${i}`, { email: null, wallets: [wx] });
        const r = await mintAs(`session:did:privy:wallet-only-${i}`, wx, {
          email: `attacker.choice.${i}@walletchi.test`,
        });
        if (r.res.status === 200) walletOnlyMinted++;
        if (r.res.status === 403 && r.body.code === "verified_email_required") walletOnlyRefused++;
      }
      check("identity wall: a verified session with NO attested email is refused on the self-custody path", walletOnlyMinted === 0 && walletOnlyRefused === 3, JSON.stringify({ walletOnlyMinted, walletOnlyRefused }));
      check("identity wall: the wallet-only Sybil run consumed no supply at all", (await store.countRunners()) === supplyBefore, JSON.stringify({ supplyBefore, now: await store.countRunners() }));
      const attackerRows = (await store.allMintedRunners()).filter(
        (r: any) =>
          attackerWallets.includes(String(r.ownerAddress).toLowerCase()) ||
          attackerWallets.some((w) => String(r.email).startsWith(w)),
      );
      check("identity wall: no pet exists on a synthesized <wallet>@wallet.walletchi.local identity", attackerRows.length === 0, JSON.stringify(attackerRows.map((r: any) => r.email)));

      // 44e. A Privy OUTAGE is a retry, not a refusal and not a fallback. The old
      // code collapsed "no email" and "could not ask" into one null and fell back
      // to the caller's string for both.
      const w4 = wallet(0xa40);
      privyDir.set("did:privy:flaky", { email: "flaky@walletchi.test", wallets: [w4], emailLookupFails: true });
      const m5 = await mintAs("session:did:privy:flaky", w4);
      check("identity wall: a Privy email-lookup outage answers 503 retry, never a fallback email", m5.res.status === 503 && m5.body.code === "verification_unavailable", JSON.stringify(m5.body));

      // 44f. An unverifiable token cannot mint at all under REQUIRE_SELF_CUSTODY.
      const m6 = await mintAs("session:did:privy:does-not-exist", wallet(0xa50), {}, await powFor());
      check("identity wall: an unverifiable Privy token cannot mint (self_custody_required)", m6.res.status === 403 && m6.body.code === "self_custody_required", JSON.stringify(m6.body));

      // 44g. PROOF-OF-WORK IS BOUND TO THE SUBJECT. Unbound, a solved challenge was
      // a bearer token any identity could spend, so the compute could be farmed in
      // whatever context was cheapest and redeemed against a different keeper.
      const subjA = subjectTag("did:privy:pow-a");
      const subjB = subjectTag("did:privy:pow-b");
      const chA = issuePowChallenge(subjA);
      const solA = { nonce: chA.nonce, counter: solveFor(chA.nonce, chA.bits), sig: chA.sig, exp: chA.exp, bits: chA.bits };
      check("pow binding: a challenge issued for one subject does NOT verify for another", verifyPow(solA, subjB).ok === false, "");
      const vA = verifyPow(solA, subjA);
      check("pow binding: it verifies for the subject it was issued to", vA.ok === true && vA.boundToSubject === true, JSON.stringify(vA));
      // Over HTTP: identity A's bound challenge, redeemed by identity B.
      const w7 = wallet(0xa70);
      const w8 = wallet(0xa80);
      privyDir.set("did:privy:pow-holder", { email: "pow.holder@walletchi.test", wallets: [w7] });
      privyDir.set("did:privy:pow-thief", { email: "pow.thief@walletchi.test", wallets: [w8] });
      const holderPow = await powFor("session:did:privy:pow-holder");
      const stolen = await mintAs("session:did:privy:pow-thief", w8, {}, holderPow);
      check("pow binding: a challenge bound to one signed-in keeper is refused for another (pow_invalid)", stolen.res.status === 403 && stolen.body.code === "pow_invalid", JSON.stringify(stolen.body));
      // The compatibility case (today's client asks before it holds a token) and
      // the mainnet posture that closes it.
      const chU = issuePowChallenge();
      const solU = { nonce: chU.nonce, counter: solveFor(chU.nonce, chU.bits), sig: chU.sig, exp: chU.exp, bits: chU.bits };
      check("pow binding: an UNBOUND challenge still works for a verified subject while binding is optional", verifyPow(solU, subjA).ok === true, "");
      config.POW_REQUIRE_SUBJECT_BINDING = true;
      const chU2 = issuePowChallenge();
      const solU2 = { nonce: chU2.nonce, counter: solveFor(chU2.nonce, chU2.bits), sig: chU2.sig, exp: chU2.exp, bits: chU2.bits };
      const vU2 = verifyPow(solU2, subjA);
      check("pow binding: an UNBOUND challenge is REFUSED for a verified subject when binding is required (mainnet posture)", vU2.ok === false && vU2.reason === "unbound", JSON.stringify(vU2));
      const chU3 = issuePowChallenge();
      const solU3 = { nonce: chU3.nonce, counter: solveFor(chU3.nonce, chU3.bits), sig: chU3.sig, exp: chU3.exp, bits: chU3.bits };
      check("pow binding: binding-required does not touch a mint with no verified identity", verifyPow(solU3, "").ok === true, "");
      config.POW_REQUIRE_SUBJECT_BINDING = saved.bindRequired;

      // 44h. VELOCITY CAPS FAIL CLOSED WHERE VALUE IS AT STAKE. They used to log
      // and wave the mint through on ANY store error, and an attacker can cause
      // that error: hammer the endpoint until the counting reads time out and
      // every cap silently stops existing, exactly during the burst.
      {
        const inner = new (InMemoryStore as any)();
        const failing: any = {
          emailAlreadyMinted: (h: string) => inner.emailAlreadyMinted(h),
          countMintedByEmailHash: (h: string) => inner.countMintedByEmailHash(h),
          countByIpSince: async () => {
            throw new Error("velocity store unavailable");
          },
          countBySubnetSince: (s: string, d: Date) => inner.countBySubnetSince(s, d),
          countByFingerprintSince: (f: string, d: Date) => inner.countByFingerprintSince(f, d),
          reserveEmail: (h: string) => inner.reserveEmail(h),
          releaseEmail: (h: string) => inner.releaseEmail(h),
          reservePrivyUser: (h: string) => inner.reservePrivyUser(h),
        };
        const gateWith = async (email: string, subject: string) => {
          const ch = issuePowChallenge(subject);
          return evaluateMintGate(failing, {
            email,
            ip: "203.0.113.44",
            subnet: "203.0.113",
            subject,
            pow: { nonce: ch.nonce, counter: solveFor(ch.nonce, ch.bits), sig: ch.sig, exp: ch.exp, bits: ch.bits },
          });
        };
        // Fail-closed only exists while the caps actually BLOCK: under the
        // advisory default (adc9634) a failed read costs an attacker nothing,
        // so refusing on it would just turn a store blip into refused honest
        // mints. Enforcement ON + real value = the attacker-can-cause-this case.
        config.SURVIVAL_ENABLED = true; // real value at stake
        config.VELOCITY_CAPS_ENFORCED = true;
        const closed = await gateWith("velocity.closed@walletchi.test", subjectTag("did:privy:vel-1"));
        check("velocity caps: a store error REFUSES the mint when ENFORCED and real value is at stake", closed.ok === false && closed.code === "sybil_blocked", JSON.stringify(closed));
        config.VELOCITY_CAPS_ENFORCED = false;
        const advisoryOpen = await gateWith("velocity.advisory@walletchi.test", subjectTag("did:privy:vel-3"));
        check("velocity caps: the same store error fails OPEN under the advisory default, even with value at stake", advisoryOpen.ok === true, JSON.stringify(advisoryOpen));
        config.SURVIVAL_ENABLED = false;
        config.modes.survivalLive = false;
        const opened = await gateWith("velocity.open@walletchi.test", subjectTag("did:privy:vel-2"));
        check("velocity caps: the same store error still fails OPEN on a value-free deploy", opened.ok === true, JSON.stringify(opened));
      }

      // 44h2. MINT-TIME CAPTCHA (Turnstile, STEP 8C). An EXPLICIT challenge like
      // PoW, so when armed it BLOCKS (the advisory law is about fuzzy signals an
      // honest keeper cannot change; a captcha is completable by anyone on any
      // device). Off by default: with captchaLive false everything here is
      // byte-identical to today, token or no token.
      {
        const cInner = new (InMemoryStore as any)();
        const gate = async (email: string, subject: string, captchaToken?: string) => {
          const ch = issuePowChallenge(subject);
          return evaluateMintGate(cInner, {
            email,
            ip: "203.0.113.77",
            subnet: "203.0.113",
            subject,
            ...(captchaToken !== undefined ? { captchaToken } : {}),
            pow: { nonce: ch.nonce, counter: solveFor(ch.nonce, ch.bits), sig: ch.sig, exp: ch.exp, bits: ch.bits },
          });
        };
        let transportCalls = 0;

        // OFF (the default): a stray token is ignored and no verify call is made.
        _setTurnstileTransportForTests(async () => {
          transportCalls++;
          return { success: false };
        });
        config.modes.captchaLive = false;
        const offR = await gate("captcha.off@walletchi.test", subjectTag("did:privy:cap-0"), "stray-token");
        check("captcha off: mint passes and siteverify is never called", offR.ok === true && transportCalls === 0, JSON.stringify({ ok: offR.ok, transportCalls }));

        // ARMED: no token = refused before any verify call.
        config.modes.captchaLive = true;
        const noTok = await gate("captcha.none@walletchi.test", subjectTag("did:privy:cap-1"));
        check("captcha armed: missing token refused (captcha_required, no verify call)", noTok.ok === false && noTok.code === "captcha_required" && transportCalls === 0, JSON.stringify(noTok));

        // ARMED: Cloudflare says no = refused.
        const badTok = await gate("captcha.bad@walletchi.test", subjectTag("did:privy:cap-2"), "bad-token");
        check("captcha armed: rejected token refused (captcha_invalid)", badTok.ok === false && badTok.code === "captcha_invalid" && transportCalls === 1, JSON.stringify(badTok));

        // ARMED: Cloudflare says yes = mint proceeds, and the verify call
        // carried the token and the client IP.
        let seenForm: URLSearchParams | null = null;
        _setTurnstileTransportForTests(async (form) => {
          seenForm = form;
          return { success: true };
        });
        const okTok = await gate("captcha.ok@walletchi.test", subjectTag("did:privy:cap-3"), "good-token");
        check(
          "captcha armed: verified token mints, siteverify saw token + remoteip",
          okTok.ok === true && seenForm !== null && (seenForm as unknown as URLSearchParams).get("response") === "good-token" && (seenForm as unknown as URLSearchParams).get("remoteip") === "203.0.113.77",
          JSON.stringify({ ok: okTok.ok, form: seenForm ? String(seenForm) : null }),
        );

        // OUTAGE (transport throws): fails CLOSED only where real value is at
        // stake, exactly the velocity posture: an outage is not a verdict.
        _setTurnstileTransportForTests(async () => {
          throw new Error("siteverify unreachable");
        });
        config.SURVIVAL_ENABLED = true;
        const outageClosed = await gate("captcha.outage@walletchi.test", subjectTag("did:privy:cap-4"), "any-token");
        check("captcha outage: fails CLOSED with real value at stake", outageClosed.ok === false && outageClosed.code === "sybil_blocked", JSON.stringify(outageClosed));
        config.SURVIVAL_ENABLED = false;
        config.modes.survivalLive = false;
        const outageOpen = await gate("captcha.outage2@walletchi.test", subjectTag("did:privy:cap-5"), "any-token");
        check("captcha outage: fails OPEN on a value-free deploy", outageOpen.ok === true, JSON.stringify(outageOpen));

        config.modes.captchaLive = false;
        _setTurnstileTransportForTests(null);
      }

      // 44i. THE TESTER ALLOWLIST stays a working tool but is no longer unlimited.
      config.TESTER_ALLOWLIST_MINT_CAP = 2;
      const w9 = wallet(0xa90);
      privyDir.set("did:privy:tester", { email: "smoke.allowlisted.tester@gmail.com", wallets: [w9] });
      const t1 = await mintAs("session:did:privy:tester", w9);
      const t1State = await settle(t1.body.serial);
      const t2 = await mintAs("session:did:privy:tester", w9);
      const t3 = await mintAs("session:did:privy:tester", w9);
      check("tester allowlist: an allowlisted tester still mints repeatedly (today's testnet tool intact)", t1.res.status === 200 && t2.res.status === 200 && t1State?.status === "ready", JSON.stringify({ t1: t1.res.status, t2: t2.res.status, s: t1State?.status }));
      check("tester allowlist: the bypass is BOUNDED by TESTER_ALLOWLIST_MINT_CAP", t3.res.status === 429 && t3.body.code === "too_many", JSON.stringify(t3.body));
      config.TESTER_ALLOWLIST_MINT_CAP = saved.testerCap;

      // 44j. The identity reserve is atomic and releasable, exactly like the email
      // reserve it sits beside (same unique-constraint / has-then-add pattern).
      {
        const sh = "smoke-atomic-identity-hash";
        const [rA, rB] = await Promise.all([store.reservePrivyUser(sh), store.reservePrivyUser(sh)]);
        check("identity reserve: two concurrent claims for one identity land exactly once", (rA ? 1 : 0) + (rB ? 1 : 0) === 1, JSON.stringify({ rA, rB }));
        check("identity reserve: re-claiming a held identity stays false", (await store.reservePrivyUser(sh)) === false, "");
        await store.releasePrivyUser(sh);
        check("identity reserve: release lets a failed mint's keeper claim again", (await store.reservePrivyUser(sh)) === true, "");
      }

      _setPrivyClientForTests(null);
      config.ANTI_SYBIL_ENABLED = saved.antiSybil;
      config.POW_DIFFICULTY_BITS = saved.bits;
      config.MINT_MIN_ELAPSED_MS = saved.minElapsed;
      config.MINTS_PER_IP_PER_DAY = saved.perIp;
      config.MINTS_PER_SUBNET_PER_DAY = saved.perSubnet;
      config.FINGERPRINT_MINT_CAP = saved.fpCap;
      config.modes.privyLive = saved.privyLive;
      config.REQUIRE_SELF_CUSTODY = saved.requireSelfCustody;
      config.SURVIVAL_ENABLED = saved.survival;
      config.modes.survivalLive = saved.survivalLive;
    }

    // ============ STUCK-TX POLICY (STEP 8C): pure logic, fake transport ============
    // A stuck tx used to park waitForTransactionReceipt forever and freeze the
    // whole signer queue behind it. Every branch of the replacement policy is
    // driven here without a chain.
    {
      const { sendWithStuckTxPolicy, StuckTxError } = await import("../src/chain/stuck-tx.js");
      const OPTS = { waitMs: 50, maxBumps: 2 };
      // BigInt-safe detail printer: fee overrides are bigints and JSON.stringify throws on those.
      const jb = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
      const FEES = { maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n };
      const timeoutErr = () => Object.assign(new Error("Timed out"), { name: "WaitForTransactionReceiptTimeoutError" });

      // Read-RPC plumbing: unset READ_RPC_URL means the read client IS the write client.
      check("read RPC defaults to the write RPC when READ_RPC_URL is unset", config.robinhood.readRpcUrl === config.robinhood.rpcUrl, JSON.stringify({ read: config.robinhood.readRpcUrl, write: config.robinhood.rpcUrl }));

      // (a) Happy path: one send with the pinned nonce and estimated fees.
      {
        const sends: any[] = [];
        const r = await sendWithStuckTxPolicy("happy", {
          send: async (ov) => { sends.push(ov); return "0xaaa"; },
          waitReceipt: async () => ({ status: "success", transactionHash: "0xaaa" }),
          pendingNonce: async () => 7,
          minedNonce: async () => 7,
          fees: async () => ({ ...FEES }),
        }, OPTS);
        check("stuck-tx happy path: one send, pinned nonce, estimated fees", (r as any).transactionHash === "0xaaa" && sends.length === 1 && sends[0].nonce === 7 && sends[0].maxFeePerGas === 1000n, jb(sends));
      }

      // (b) Stuck then replaced: first wait times out, replacement carries the
      // SAME nonce and a >=25% fee bump, and its receipt is returned.
      {
        const sends: any[] = [];
        let waits = 0;
        const r = await sendWithStuckTxPolicy("bump", {
          send: async (ov) => { sends.push(ov); return sends.length === 1 ? "0xold" : "0xnew"; },
          waitReceipt: async (hash) => {
            waits++;
            if (hash === "0xold") throw timeoutErr();
            return { status: "success", transactionHash: hash };
          },
          pendingNonce: async () => 3,
          minedNonce: async () => 3,
          fees: async () => ({ ...FEES }),
        }, OPTS);
        check(
          "stuck-tx bump: same nonce, fees raised 25%, replacement receipt returned",
          (r as any).transactionHash === "0xnew" && sends.length === 2 && sends[1].nonce === 3 && sends[1].maxFeePerGas === 1250n && sends[1].maxPriorityFeePerGas === 125n,
          jb({ sends, waits }),
        );
      }

      // (c) The race we won: the ORIGINAL mines while the bump is being prepared;
      // the resend is refused nonce-too-low and the original's receipt is recovered.
      {
        let minedYet = false;
        const r = await sendWithStuckTxPolicy("race", {
          send: async (ov) => {
            if (ov.maxFeePerGas > FEES.maxFeePerGas) { minedYet = true; throw new Error("nonce too low"); }
            return "0xoriginal";
          },
          waitReceipt: async (hash, timeoutMs) => {
            if (minedYet && hash === "0xoriginal") return { status: "success", transactionHash: hash };
            throw timeoutErr();
          },
          pendingNonce: async () => 5,
          minedNonce: async () => (minedYet ? 6 : 5),
          fees: async () => ({ ...FEES }),
        }, OPTS);
        check("stuck-tx race: original mined during the bump, its receipt is recovered", (r as any).transactionHash === "0xoriginal", jb(r));
      }

      // (d) Exhausted: nothing ever mines; every attempt is made, then the loud
      // greppable StuckTxError names the label, nonce and every hash.
      {
        const sends: any[] = [];
        let thrown: unknown = null;
        try {
          await sendWithStuckTxPolicy("exhausted", {
            send: async (ov) => { sends.push(ov); return `0xh${sends.length}`; },
            waitReceipt: async () => { throw timeoutErr(); },
            pendingNonce: async () => 9,
            minedNonce: async () => 9,
            fees: async () => ({ ...FEES }),
          }, OPTS);
        } catch (err) {
          thrown = err;
        }
        check(
          "stuck-tx exhausted: original + maxBumps sends, then StuckTxError names everything",
          thrown instanceof StuckTxError && sends.length === 3 && String(thrown).includes("STUCK TX") && String(thrown).includes("nonce 9") && String(thrown).includes("0xh3"),
          jb({ sends: sends.length, thrown: String(thrown) }),
        );
      }

      // (e) A tiny testnet fee still bumps: integer floor cannot produce a
      // replacement the node would refuse as not-better.
      {
        const sends: any[] = [];
        await sendWithStuckTxPolicy("tinyfee", {
          send: async (ov) => { sends.push(ov); return sends.length === 1 ? "0xt1" : "0xt2"; },
          waitReceipt: async (hash) => {
            if (hash === "0xt1") throw timeoutErr();
            return { status: "success", transactionHash: hash };
          },
          pendingNonce: async () => 1,
          minedNonce: async () => 1,
          fees: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
        }, OPTS);
        check("stuck-tx bump on tiny fees still strictly increases", sends.length === 2 && sends[1].maxFeePerGas > 2n && sends[1].maxPriorityFeePerGas > 1n, jb(sends));
      }
    }

    // ============ WRITE PIPELINE (launch fix 1): pure logic, fake transport ============
    // The pipelined relayer: local nonce counter, one receipt watcher per account,
    // "stuck" judged at the head only. Every branch is driven against a fake node
    // whose mined nonce and receipts the test moves by hand.
    {
      const { WritePipeline } = await import("../src/chain/pipeline.js");
      const { StuckTxError } = await import("../src/chain/stuck-tx.js");
      const OPTS = { waitMs: 60, maxBumps: 2, pollMs: 10, unknownHashTicks: 4, feeCacheMs: 0 };
      const FEES = { maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n };
      const jb = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // A fake node: the test owns the pending and mined counts and the receipt table.
      const fakeNode = () => {
        const st = {
          pending: 5,
          mined: 5,
          receipts: new Map<string, { status: string; transactionHash: string }>(),
          broadcasts: [] as string[],
          receiptThrows: false,
          broadcastThrows: false,
        };
        const deps = {
          pendingNonce: async () => st.pending,
          minedNonce: async () => st.mined,
          receipt: async (hash: string) => {
            if (st.receiptThrows) throw new Error("rpc down");
            return st.receipts.get(hash) ?? null;
          },
          fees: async () => ({ ...FEES }),
          broadcastRaw: async (raw: string) => {
            if (st.broadcastThrows) throw new Error("broadcast refused");
            st.broadcasts.push(raw);
            return `hash-of-${raw}`;
          },
        };
        const mine = (hash: string, nonce: number) => {
          st.receipts.set(hash, { status: "success", transactionHash: hash });
          st.mined = Math.max(st.mined, nonce + 1);
        };
        return { st, deps, mine };
      };
      // A local signer: hash and raw derive from the nonce and fee so replacements differ.
      const localSigner = (label: string) => {
        const signs: any[] = [];
        const sign = async (ov: any) => {
          signs.push(ov);
          const raw = `raw-${label}-${ov.nonce}-${ov.maxFeePerGas}`;
          return { hash: `hash-of-${raw}`, raw };
        };
        return { signs, sign };
      };

      // (a) Three mints submitted back to back share one watcher, take consecutive
      // nonces from the counter (seeded from the node's pending count) and settle
      // in order; the queue never waited for a receipt between them.
      {
        const node = fakeNode();
        const p = new WritePipeline("t", node.deps, OPTS);
        const handles = [] as any[];
        for (let i = 0; i < 3; i++) {
          const { sign } = localSigner("a");
          handles.push(await p.submit("mint", sign, async (ov) => { const s = await sign(ov); await node.deps.broadcastRaw(s.raw); return s; }));
        }
        check("pipeline: consecutive nonces from the local counter, seeded from pending", handles.map((h) => h.nonce).join(",") === "5,6,7" && p.nextNonce === 8, jb({ nonces: handles.map((h) => h.nonce), next: p.nextNonce }));
        check("pipeline: every submit broadcast without awaiting a receipt", node.st.broadcasts.length === 3 && p.unmined === 3, jb({ b: node.st.broadcasts.length, unmined: p.unmined }));
        const settled: number[] = [];
        for (const h of handles) void h.receipt.then(() => settled.push(h.nonce));
        node.mine(handles[0].hash, 5);
        node.mine(handles[1].hash, 6);
        await wait(40);
        check("pipeline: the mined nonces settle in order, the unmined one waits", settled.join(",") === "5,6" && p.unmined === 1, jb({ settled, unmined: p.unmined }));
        node.mine(handles[2].hash, 7);
        const r = await handles[2].receipt;
        check("pipeline: the last one settles with its own receipt and the watcher drains", r.transactionHash === handles[2].hash && p.unmined === 0, jb({ r, unmined: p.unmined }));
      }

      // (b) Persist-before-broadcast: a throwing beforeBroadcast means NO broadcast and
      // the nonce is handed straight back (the next submit reuses it, no node read).
      {
        const node = fakeNode();
        const p = new WritePipeline("t", node.deps, OPTS);
        const { sign } = localSigner("b");
        let thrown: unknown = null;
        try {
          await p.submit("mint", sign, sign, async () => { throw new Error("db down"); });
        } catch (err) { thrown = err; }
        check("pipeline: a failed persist stops the broadcast and hands the nonce back", String(thrown).includes("db down") && node.st.broadcasts.length === 0 && p.nextNonce === 5 && p.unmined === 0, jb({ thrown: String(thrown), b: node.st.broadcasts.length, next: p.nextNonce }));
        const seen: any[] = [];
        const h = await p.submit("mint", sign, sign, async (t) => { seen.push(t); });
        check("pipeline: beforeBroadcast sees the ticket (hash + nonce) before the bytes go out, then the same nonce is used", seen[0]?.nonce === 5 && seen[0]?.hash === h.hash && node.st.broadcasts.length === 1, jb({ seen, h: h.hash }));
        node.mine(h.hash, 5);
        await h.receipt;
      }

      // (c) A broadcast that throws is ambiguous (the node may have kept it): the counter
      // is dropped and re-read from the node's pending count before the next write.
      {
        const node = fakeNode();
        const p = new WritePipeline("t", node.deps, OPTS);
        const { sign } = localSigner("c");
        node.st.broadcastThrows = true;
        let thrown: unknown = null;
        try { await p.submit("mint", sign, sign); } catch (err) { thrown = err; }
        check("pipeline: a failed broadcast drops the counter for a resync", String(thrown).includes("broadcast refused") && p.nextNonce === null, jb({ thrown: String(thrown), next: p.nextNonce }));
        node.st.broadcastThrows = false;
        node.st.pending = 6; // the node DID keep it
        const h = await p.submit("mint", sign, sign);
        check("pipeline: the resync skips the nonce the node kept", h.nonce === 6, jb(h.nonce));
        node.mine(h.hash, 6);
        await h.receipt;
      }

      // (d) The nonce mined under a hash we never sent (replaced from outside, or a gap we
      // filled after a restart): a sustained definite miss is the terminal verdict.
      {
        const node = fakeNode();
        const p = new WritePipeline("t", node.deps, OPTS);
        const { sign } = localSigner("d");
        const h = await p.submit("mint", sign, sign);
        node.st.mined = 6; // mined, but no receipt for OUR hash ever appears
        let thrown: unknown = null;
        try { await h.receipt; } catch (err) { thrown = err; }
        check("pipeline: a mined nonce with no receipt for our hash fails as 'did not send'", String(thrown).includes("did not send") && p.unmined === 0, String(thrown));
      }

      // (e) A receipt read that THROWS (RPC blip) is not evidence of anything: the write
      // settles normally once the node answers again, well past the unknown-hash budget.
      {
        const node = fakeNode();
        const p = new WritePipeline("t", node.deps, OPTS);
        const { sign } = localSigner("e");
        const h = await p.submit("mint", sign, sign);
        node.st.receiptThrows = true;
        node.st.mined = 6;
        await wait(OPTS.pollMs * (OPTS.unknownHashTicks + 4));
        check("pipeline: transport errors on the receipt read never count as a miss", p.unmined === 1, jb(p.unmined));
        node.st.receiptThrows = false;
        node.st.receipts.set(h.hash, { status: "success", transactionHash: h.hash });
        const r = await h.receipt;
        check("pipeline: and the write settles once the node answers", r.transactionHash === h.hash, jb(r));
      }

      // (f) A stuck head: first the ORIGINAL bytes are re-broadcast (free, cannot
      // double-spend), then the same nonce is replaced with +25% fees; the replacement's
      // receipt is the one returned. Entries behind the head are never RE-SIGNED, but their
      // original bytes go out again after the head each time (an Arbitrum-style sequencer
      // drops the whole tail when one nonce in the middle is lost).
      {
        const node = fakeNode();
        const p = new WritePipeline("t", node.deps, OPTS);
        const head = localSigner("f0");
        const behind = localSigner("f1");
        const resends: any[] = [];
        const resend = (s: { sign: (ov: any) => Promise<any> }) => async (ov: any) => { resends.push(ov); const x = await s.sign(ov); await node.deps.broadcastRaw(x.raw); return x; };
        const h0 = await p.submit("mint", head.sign, resend(head));
        const h1 = await p.submit("mint", behind.sign, resend(behind));
        await wait(OPTS.waitMs + OPTS.pollMs * 4);
        check("pipeline: an unmined head is first re-broadcast with the same bytes", node.st.broadcasts.filter((b) => b === `raw-f0-5-1000`).length === 2 && resends.length === 0, jb({ broadcasts: node.st.broadcasts, resends: resends.length }));
        const headAgain = node.st.broadcasts.lastIndexOf(`raw-f0-5-1000`);
        const tailAgain = node.st.broadcasts.lastIndexOf(`raw-f1-6-1000`);
        check("pipeline: the tail's original bytes go out again right after the head, in nonce order, unsigned", node.st.broadcasts.filter((b) => b === `raw-f1-6-1000`).length === 2 && tailAgain > headAgain && behind.signs.length === 1, jb({ broadcasts: node.st.broadcasts }));
        await wait(OPTS.waitMs + OPTS.pollMs * 4);
        check("pipeline: then replaced on the SAME nonce with fees up 25%, and only the head", resends.length === 1 && resends[0].nonce === 5 && resends[0].maxFeePerGas === 1250n && behind.signs.length === 1, jb({ resends, behindSigns: behind.signs.length }));
        check("pipeline: after the replacement the tail goes out again behind it", node.st.broadcasts.lastIndexOf(`raw-f1-6-1000`) > node.st.broadcasts.indexOf(`raw-f0-5-1250`) && node.st.broadcasts.indexOf(`raw-f0-5-1250`) >= 0, jb({ broadcasts: node.st.broadcasts }));
        const replacement = `hash-of-raw-f0-5-1250`;
        node.mine(replacement, 5);
        node.mine(h1.hash, 6);
        const [r0, r1] = await Promise.all([h0.receipt, h1.receipt]);
        check("pipeline: the replacement's receipt is returned and the one behind settles untouched", r0.transactionHash === replacement && r1.transactionHash === h1.hash && p.unmined === 0, jb({ r0, r1 }));
      }

      // (g) Exhausted head: after maxBumps replacements it fails with the greppable
      // StuckTxError, and the counter is dropped for a resync (whatever sits under that
      // nonce in the mempool is no longer ours to reason about).
      {
        const node = fakeNode();
        const p = new WritePipeline("t", node.deps, { ...OPTS, waitMs: 20 });
        const s = localSigner("g");
        const resend = async (ov: any) => { const x = await s.sign(ov); await node.deps.broadcastRaw(x.raw); return x; };
        const h = await p.submit("mint", s.sign, resend);
        let thrown: unknown = null;
        try { await h.receipt; } catch (err) { thrown = err; }
        check("pipeline: an exhausted head throws StuckTxError naming every hash and drops the counter", thrown instanceof StuckTxError && String(thrown).includes("nonce 5") && s.signs.length === 3 && p.nextNonce === null, jb({ thrown: String(thrown).slice(0, 80), signs: s.signs.length, next: p.nextNonce }));
      }

      // (h) Restart recovery: a ticket read back from a row (nonce + hash only, no raw
      // bytes) attaches to the watcher and settles when the node shows it mined.
      {
        const node = fakeNode();
        const p = new WritePipeline("t", node.deps, OPTS);
        const s = localSigner("h");
        const resend = async (ov: any) => { const x = await s.sign(ov); await node.deps.broadcastRaw(x.raw); return x; };
        const h = p.attach({ label: "mint", nonce: 3, hash: "hash-from-before" }, resend);
        check("pipeline: attach registers a write from a previous process", p.unmined === 1 && h.nonce === 3, jb({ unmined: p.unmined }));
        node.st.receipts.set("hash-from-before", { status: "success", transactionHash: "hash-from-before" });
        node.st.mined = 5; // already past nonce 3
        const r = await h.receipt;
        check("pipeline: a recovered ticket settles with its receipt", r.transactionHash === "hash-from-before" && p.unmined === 0, jb(r));
        // A recovered ticket that never reached the node: no raw bytes to re-broadcast, so
        // the head policy re-signs it from the row (the resend closure) with bumped fees.
        const h2 = p.attach({ label: "mint", nonce: 5, hash: "never-broadcast" }, resend, { ...FEES });
        await wait(OPTS.waitMs + OPTS.pollMs * 4);
        check("pipeline: a recovered, unmined head is re-signed from the row and broadcast", s.signs.length === 1 && s.signs[0].nonce === 5 && node.st.broadcasts.length === 1, jb({ signs: s.signs, b: node.st.broadcasts }));
        node.mine(`hash-of-raw-h-5-1250`, 5);
        const r2 = await h2.receipt;
        check("pipeline: and settles with the replacement's receipt", r2.transactionHash === `hash-of-raw-h-5-1250`, jb(r2));
      }
    }

    // ============ RESTART RECOVERY + THE IN-FLIGHT REGISTER (launch fix 1) ============
    // A process that dies mid-burst leaves rows at "minting". At boot every one of
    // them is re-attached to its persisted transaction or failed on the spot; the
    // age-based reaper never touches a row the live process is driving; and the
    // checkout poll reports a keeper's place in line while they wait.
    {
      const { recoverInFlightMints, reapStuckMints, fulfillRunner, mintQueueInfo, mintsInFlightCount } = await import("../src/runner/fulfillment.js");
      const { emailHash, normalizeEmail } = await import("../src/runner/sybil.js");
      const mock = (relayer as any).chain as InstanceType<typeof MockChain>;
      const row = (serial: string, email: string, extra: Record<string, unknown> = {}) =>
        store.createRunner({
          serial, tokenId: null, tbaAddress: null, ownerAddress: relayer.address, email,
          bestScore: 0, salmon: 0, runs: 0, authToken: `tok-${serial}`, status: "minting",
          issueTxHash: null, issueNonce: null, failureReason: null, idleSalmon: 0, lastTickAt: null,
          privyUserHash: null, ...extra,
        } as never);
      const reserved = (email: string) => store.emailAlreadyMinted(emailHash(normalizeEmail(email)));

      // (a) A ticket the chain knows (signed + broadcast before the crash): the keeper gets their pet.
      const prepared = await mock.prepareMint(relayer.address);
      const ticket = await mock.submitMint(prepared);
      await store.reserveEmail(emailHash(normalizeEmail("rec-a@walletchi.test")));
      await row("rec-a", "rec-a@walletchi.test", { issueTxHash: ticket.txHash, issueNonce: ticket.nonce });
      // (b) A ticket the chain never saw (persisted, then the crash beat the broadcast, and a later
      //     write filled the nonce): the terminal "not ours" verdict fails it and frees the inbox.
      await store.reserveEmail(emailHash(normalizeEmail("rec-b@walletchi.test")));
      await row("rec-b", "rec-b@walletchi.test", { issueTxHash: "0xdeadbeef", issueNonce: 999_999 });
      // (c) No ticket at all (the crash beat the signature): nothing exists on any chain. Fail now.
      await store.reserveEmail(emailHash(normalizeEmail("rec-c@walletchi.test")));
      await row("rec-c", "rec-c@walletchi.test");

      const verdict = await recoverInFlightMints(ctx);
      check("recovery classifies every minting row at boot: 2 re-attached, 1 failed outright", verdict.reattached === 2 && verdict.failed === 1, JSON.stringify(verdict));
      const c = await store.getRunner("rec-c");
      check("recovery: a row with no ticket is failed immediately and its inbox claim released", c?.status === "failed" && !(await reserved("rec-c@walletchi.test")), JSON.stringify({ status: c?.status, reason: c?.failureReason }));
      for (let i = 0; i < 40 && ((await store.getRunner("rec-a"))?.status === "minting" || (await store.getRunner("rec-b"))?.status === "minting"); i++) await sleep(25);
      const a = await store.getRunner("rec-a");
      check("recovery: a broadcast ticket is settled and FULFILLED (token, TBA, ready), inbox claim kept", a?.status === "ready" && Boolean(a?.tokenId) && Boolean(a?.tbaAddress) && a?.issueTxHash === ticket.txHash && (await reserved("rec-a@walletchi.test")), JSON.stringify({ status: a?.status, tokenId: a?.tokenId }));
      const b = await store.getRunner("rec-b");
      check("recovery: a ticket the chain does not know fails cleanly and releases the inbox claim", b?.status === "failed" && !(await reserved("rec-b@walletchi.test")), JSON.stringify({ status: b?.status, reason: b?.failureReason?.slice(0, 60) }));
      check("recovery: the in-flight register is empty once every recovered row settled", mintsInFlightCount() === 0, String(mintsInFlightCount()));

      // (d) The reaper skips a row the live process is driving, however old the row looks.
      mock.mockSetBlockTimeMs(400);
      await store.reserveEmail(emailHash(normalizeEmail("live-d@walletchi.test")));
      await row("live-d", "live-d@walletchi.test");
      await store.updateRunner("live-d", { createdAt: new Date(Date.now() - (config.MINT_STUCK_MINUTES + 5) * 60_000) } as never);
      const driving = fulfillRunner(ctx, "live-d");
      await sleep(50);
      const info = mintQueueInfo("live-d");
      check("poll: a minting row reports its place in line (position 1, submitted, an ETA)", info?.position === 1 && info?.ahead === 0 && info?.phase === "submitted" && (info?.etaSec ?? 0) >= 5, JSON.stringify(info));
      const reaped = await reapStuckMints(ctx);
      const dRow = await store.getRunner("live-d");
      check("reaper: a row older than the cutoff but alive in this process is NOT reaped", reaped === 0 && dRow?.status === "minting" && (await reserved("live-d@walletchi.test")), JSON.stringify({ reaped, status: dRow?.status }));
      await driving;
      const dDone = await store.getRunner("live-d");
      check("and it lands as ready once its block arrives; the register forgets it", dDone?.status === "ready" && mintQueueInfo("live-d") === null, JSON.stringify({ status: dDone?.status }));
      mock.mockSetBlockTimeMs(0);

      // (e) The persisted ticket lands on the row BEFORE the broadcast: a fresh mint driven by
      //     fulfillRunner shows hash + nonce on its row while still minting.
      mock.mockSetBlockTimeMs(300);
      await row("live-e", "live-e@walletchi.test");
      const eDrive = fulfillRunner(ctx, "live-e");
      await sleep(50);
      const eRow = await store.getRunner("live-e");
      check("fulfillment persists the ticket (hash + nonce) while the mint is still in flight", eRow?.status === "minting" && typeof eRow?.issueTxHash === "string" && typeof eRow?.issueNonce === "number", JSON.stringify({ hash: eRow?.issueTxHash?.slice(0, 10), nonce: eRow?.issueNonce, status: eRow?.status }));
      await eDrive;
      mock.mockSetBlockTimeMs(0);
      check("and the same hash is the one the receipt confirms", (await store.getRunner("live-e"))?.issueTxHash === eRow?.issueTxHash && (await store.getRunner("live-e"))?.status === "ready", "");
    }

    // ============ BUDGET ADMISSION COUNTS IN-FLIGHT MINTS (launch fix 2) ============
    // The chain's `used` moves at mining; the checkout must refuse against
    // used + admitted, in the same tick as the decision, and hand every slot back.
    {
      const { admitMint, mintsAdmitted, _resetMintAdmissionForTests } = await import("../src/runner/mint-budget.js");
      _resetMintAdmissionForTests();
      const nowSec = Math.floor(Date.now() / 1000);
      const budget = { max: 3, windowSecs: 3600, windowStart: nowSec - 100, used: 1 };
      // Pure: 1 used + 2 admitted fills a budget of 3; the third is refused with the window's wait.
      const a = admitMint(budget, nowSec);
      const b = admitMint(budget, nowSec);
      const c = admitMint(budget, nowSec);
      check("admission: used + admitted fills the budget; the next keeper is refused at checkout with the wait", a.ok && b.ok && !c.ok && (c.ok ? 0 : c.retryAfterSec) === 3500 && mintsAdmitted() === 2, JSON.stringify({ c, admitted: mintsAdmitted() }));
      if (a.ok) { a.admission.release(); a.admission.release(); }
      check("admission: a released slot admits the next keeper, and a double release is a no-op", mintsAdmitted() === 1 && admitMint(budget, nowSec).ok, String(mintsAdmitted()));
      // A rolled-over window is fresh whatever `used` says (mirrors PetIssuer._consumeMintBudget).
      _resetMintAdmissionForTests();
      const rolled = admitMint({ max: 1, windowSecs: 60, windowStart: nowSec - 120, used: 1 }, nowSec);
      check("admission: a rolled-over window admits despite a spent `used`", rolled.ok, JSON.stringify(rolled));
      // Null / uncapped budgets admit but still count (the count is the truth about in-flight mints).
      _resetMintAdmissionForTests();
      const un = admitMint(null, nowSec);
      check("admission: an unreadable budget admits and still counts", un.ok && mintsAdmitted() === 1, String(mintsAdmitted()));
      _resetMintAdmissionForTests();

      // End to end over HTTP: a burst of 3 against a budget of 2 with mints still in flight.
      // The old pre-check read `used` (0) and admitted all three; one then failed after polling.
      const mock = (relayer as any).chain as InstanceType<typeof MockChain>;
      mock.mockSetMintBudget({ max: 2, windowSecs: 3600, windowStart: nowSec, used: 0 });
      mock.mockSetBlockTimeMs(400);
      const burst = await Promise.all([1, 2, 3].map((i) =>
        fetch(`${base}/api/runner/checkout`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: `admit-${i}@walletchi.test` }),
        }).then(async (r) => ({ status: r.status, body: await r.json() as any })),
      ));
      const okCount = burst.filter((r) => r.status === 200).length;
      const busy = burst.filter((r) => r.status === 429 && r.body.code === "mint_busy");
      check("checkout refuses the keeper past the line BEFORE polling (2 admitted, 1 mint_busy at checkout)", okCount === 2 && busy.length === 1 && /Busy hour/.test(busy[0]?.body.error ?? ""), JSON.stringify(burst.map((r) => [r.status, r.body.code ?? r.body.status])));
      check("checkout: the in-flight slots are held while the two mints wait for their block", mintsAdmitted() === 2, String(mintsAdmitted()));
      const ids = burst.filter((r) => r.status === 200).map((r) => r.body.serial as string);
      for (let i = 0; i < 60 && (await Promise.all(ids.map((id) => store.getRunner(id)))).some((r) => r?.status === "minting"); i++) await sleep(25);
      const rows = await Promise.all(ids.map((id) => store.getRunner(id)));
      check("checkout: both admitted mints land and every slot is handed back", rows.every((r) => r?.status === "ready") && mintsAdmitted() === 0, JSON.stringify({ statuses: rows.map((r) => r?.status), admitted: mintsAdmitted() }));
      mock.mockSetBlockTimeMs(0);
      mock.mockSetMintBudget({ max: 0, windowSecs: 0, windowStart: 0, used: 0 });
    }

    // ============ TWO RATE-LIMIT BUCKETS PER IP (launch fix 3) ============
    // The keeper-flow routes (poll, pass-link, .pkpass, Apple web service) count
    // in their own, larger window; the mint POST and everything else stay strict.
    {
      const { _rateLimitBucketForTests, _resetGlobalRateLimit } = await import("../src/app.js");
      const bucket = _rateLimitBucketForTests;
      check(
        "limiter: the keeper-flow routes land in the keeper-flow bucket",
        bucket("GET", "/api/runner/checkout/abc") === "keeper-flow" &&
          bucket("POST", "/api/runner/pass-link") === "keeper-flow" &&
          bucket("GET", "/runner-passes/abc/cap.pkpass") === "keeper-flow" &&
          bucket("GET", "/runner-passes/abc.pkpass") === "keeper-flow" &&
          bucket("POST", "/runner-apple/v1/devices/d/registrations/pass.type/abc") === "keeper-flow" &&
          bucket("GET", "/runner-apple/v1/passes/pass.type/abc") === "keeper-flow",
        "",
      );
      check(
        "limiter: the mint POST, the challenge, claims, sign-in routes and care stay strict",
        bucket("POST", "/api/runner/checkout") === "strict" &&
          bucket("GET", "/api/mint/challenge") === "strict" &&
          bucket("POST", "/api/claim") === "strict" &&
          bucket("GET", "/api/pets/by-owner") === "strict" &&
          bucket("POST", "/api/pet/1/care-session") === "strict" &&
          bucket("POST", "/api/runner/abc/care/feed") === "strict" &&
          bucket("GET", "/api/runner/abc") === "strict",
        "",
      );
      // Over HTTP from ONE public address: 150 polls do not touch the strict window,
      // and the mint POST is still refused past 120 on its own window.
      _resetGlobalRateLimit();
      const ip = { "x-forwarded-for": "11.99.0.1" };
      let pollOk = 0;
      for (let i = 0; i < 150; i++) {
        const r = await fetch(`${base}/api/runner/checkout/no-such-serial`, { headers: ip });
        if (r.status === 404) pollOk += 1;
      }
      check("limiter: 150 polls from one address are all answered (404, not 429)", pollOk === 150, String(pollOk));
      let strictHits = 0;
      let strict429 = 0;
      for (let i = 0; i < 125; i++) {
        const r = await fetch(`${base}/api/chain-config`, { headers: ip });
        if (r.status === 200) strictHits += 1;
        if (r.status === 429) strict429 += 1;
      }
      check("limiter: the strict window still closes at 120 for the same address", strictHits === 120 && strict429 === 5, JSON.stringify({ strictHits, strict429 }));
      const pollAfter = await fetch(`${base}/api/runner/checkout/no-such-serial`, { headers: ip });
      check("limiter: a closed strict window does not close the keeper-flow one", pollAfter.status === 404, String(pollAfter.status));
      _resetGlobalRateLimit();
    }

    // ============ CHEAP WINS (launch fix 4): token cache, async seal ============
    {
      // Google: one token exchange serves every call until near expiry; a burst on a
      // cold cache shares ONE in-flight exchange; an expired token is refreshed.
      const { RunnerGoogleWallet } = await import("../src/runner/google.js");
      const g = new RunnerGoogleWallet() as any;
      let exchanges = 0;
      let ttl = 3600;
      g.exchangeToken = async () => {
        exchanges += 1;
        await sleep(5);
        const token = `tok-${exchanges}`;
        g.tokenCache = { token, expiresAtMs: Date.now() + ttl * 1000 };
        return token;
      };
      const burst = await Promise.all([g.accessToken(), g.accessToken(), g.accessToken()]);
      check("google: a cold burst performs ONE token exchange, shared by every caller", exchanges === 1 && burst.every((t: string) => t === "tok-1"), JSON.stringify({ exchanges, burst }));
      const again = await g.accessToken();
      check("google: a warm cache answers without an exchange", exchanges === 1 && again === "tok-1", String(exchanges));
      g.tokenCache = { token: "tok-1", expiresAtMs: Date.now() + 30_000 }; // inside the 60 s early-refresh band
      ttl = 3600;
      const refreshed = await g.accessToken();
      check("google: a token within a minute of expiry is refreshed early", exchanges === 2 && refreshed === "tok-2", JSON.stringify({ exchanges, refreshed }));

      // A 401 from the Wallet API retires the cached token, but only THAT token: a newer one that
      // already replaced it stays. fetch is swapped for this block only (no network).
      const realFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
        g.tokenCache = { token: "tok-2", expiresAtMs: Date.now() + 3_600_000 };
        const stale = await g.walletFetch("https://walletobjects.test/x", "tok-1");
        check("google: a 401 for an OLD token leaves the newer cached token alone", stale.status === 401 && g.tokenCache?.token === "tok-2", JSON.stringify(g.tokenCache));
        await g.walletFetch("https://walletobjects.test/x", "tok-2");
        check("google: a 401 for the cached token drops it (the next call exchanges)", g.tokenCache === null, JSON.stringify(g.tokenCache));
        const next = await g.accessToken();
        check("google: after the 401 the next call performs a fresh exchange", exchanges === 3 && next === "tok-3", JSON.stringify({ exchanges, next }));

        // The REAL exchange (only fetch is faked): an answer without access_token is refused and
        // caches nothing, and the expiry is stamped from BEFORE the request, so a slow exchange
        // never overstates the token's life.
        const { generateKeyPairSync } = await import("node:crypto");
        const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        const real = new RunnerGoogleWallet() as any;
        real.sa = { client_email: "smoke@walletchi.test", private_key: pem };
        globalThis.fetch = (async () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 })) as typeof fetch;
        let refusedMissing = false;
        try {
          await real.accessToken();
        } catch (err) {
          refusedMissing = /without an access_token/.test(String(err));
        }
        check("google: an exchange answer without access_token is refused and caches nothing", refusedMissing && real.tokenCache === null, String(refusedMissing));
        globalThis.fetch = (async () => {
          await sleep(300);
          return new Response(JSON.stringify({ access_token: "tok-real", expires_in: 3600 }), { status: 200 });
        }) as typeof fetch;
        const before = Date.now();
        const tok = await real.accessToken();
        check("google: the expiry is measured from before the exchange request (a 300 ms exchange does not extend it)", tok === "tok-real" && real.tokenCache.expiresAtMs <= before + 3_600_000 + 50, JSON.stringify({ over: real.tokenCache.expiresAtMs - (before + 3_600_000) }));
      } finally {
        globalThis.fetch = realFetch;
      }

      // "session care rejected" carries the error text (2026-10-29), with every URL cut to its
      // origin: an RPC or bundler URL has its key in the path, a pass link its tag in the query.
      {
        const { logSafeDetail } = await import("../src/runner/session-care.js");
        const raw =
          'HTTP request failed. URL: https://api.g.alchemy.com/v2/SECRETKEY123?x=1 Request body: {"a":1} ' +
          "see https://walletchi.example/runner/care/abc?s=deadbeefdeadbeef AA23 reverted";
        const safe = logSafeDetail(raw);
        check(
          "session care rejection detail keeps the error text but no URL path, key or tag",
          safe.includes("AA23 reverted") && safe.includes("https://api.g.alchemy.com") &&
            !safe.includes("SECRETKEY123") && !safe.includes("deadbeef") && !safe.includes("/runner/care"),
          safe,
        );
        check("and it is capped at 300 characters", logSafeDetail("x".repeat(1_000)).length === 300);
        const { readFileSync } = await import("node:fs");
        const careSrc = readFileSync(new URL("../src/runner/session-care.ts", import.meta.url), "utf8");
        check(
          "the 'session care rejected' log line includes the detail",
          /detail: res\.ok \? undefined : logSafeDetail\(res\.detail\),\s*\},\s*"session care rejected"/.test(careSrc),
        );
      }

      // Session seal: the async variant produces the same format the sync one opens, and
      // the reverse, so rows sealed before this change open on the request path after it.
      const { sealSessionKey, sealSessionKeyAsync, openSessionKey, openSessionKeyAsync } = await import("../src/runner/session-care.js");
      const key = ("0x" + "ab".repeat(32)) as `0x${string}`;
      const sealedAsync = await sealSessionKeyAsync(key);
      const sealedSync = sealSessionKey(key);
      check("seal: async seal opens with the sync opener and the reverse (same format, same KDF)", openSessionKey(sealedAsync) === key && (await openSessionKeyAsync(sealedSync)) === key && sealedAsync.startsWith("v1."), "");
      // The install path must not block the loop for the KDF: a timer set just before the
      // async seal fires while it runs (it would be held back behind a synchronous scrypt).
      let fired = 0;
      const t = setTimeout(() => { fired += 1; }, 1);
      const seals = await Promise.all(Array.from({ length: 6 }, () => sealSessionKeyAsync(key)));
      clearTimeout(t);
      check("seal: six concurrent async seals succeed", seals.every((s) => openSessionKey(s) === key), "");
      check("seal: the event loop kept turning during the async KDF (a 1 ms timer fired)", fired === 1, String(fired));
    }

  } finally {
    server.close();
  }

  console.log(`\nRESULT: ${passCount} passed, ${failCount} failed\n`);
  if (failCount > 0) process.exit(1);
}

run().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
