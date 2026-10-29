/**
 * INTERNAL GIFT MINT CHECK (routes/internal-gift.ts, POST /internal/gift-mint).
 * The ops gift mint now goes through the API's own relayer (A9, 2026-10-20) instead of a laptop
 * signing with the relayer key. This pins: the bearer gate (401 wrong token, 404 token env unset),
 * 400 on a bad email, a dry run that creates no Privy user and mints nothing, a known keeper's
 * pet landing in their EMBEDDED wallet with a row and a by-owner entry at once, an unknown email
 * getting ONE Privy user with an embedded wallet before the mint, an external-only Privy user
 * refused (422, nothing minted), a Privy outage refused (503, nothing minted), a second call for
 * the same email while one is in flight refused (409, one mint), an exhausted mint budget refused
 * (503, no row), and Privy stubbed refused (503). Real handlers, in-memory store + MockChain.
 *
 * Run: npx tsx scripts/gift-mint-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://gm:gm@localhost:5432/gm";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.TESTER_ALLOWLIST = "";
process.env.PUBLIC_BASE_URL = "https://api.walletchi.test";
process.env.PET721_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.INTERNAL_STATUS_TOKEN = "gift-mint-check-token";
process.env.CARE_SESSION_SECRET ??= "gift-mint-check-only-care-session-secret-not-real";

const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { _setPrivyClientForTests } = await import("../src/services/privy.js");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
import type { AppContext } from "../src/context.js";
import type { PrivyUserRecord } from "../src/services/privy.js";
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
const addr = () => privateKeyToAccount(generatePrivateKey()).address.toLowerCase();

// ---- the fake Privy directory ----
type Fake = { id: string; email: string; wallets: Array<{ address: string; walletClientType: string }> };
const dir = new Map<string, Fake>(); // by email
const importCalls: unknown[] = [];
let lookupThrows = false;
let lookupGate: Promise<void> | null = null; // when set, getUserByEmail awaits it (the concurrency case)
const record = (u: Fake): PrivyUserRecord => ({
  id: u.id,
  email: { address: u.email },
  createdAt: new Date(Date.now() - 3_600_000),
  linkedAccounts: [
    { type: "email", address: u.email },
    ...u.wallets.map((w) => ({ type: "wallet", address: w.address, walletClientType: w.walletClientType, chainType: "ethereum" })),
  ],
});
_setPrivyClientForTests({
  verifyAuthToken: async () => {
    throw new Error("not used here");
  },
  getUser: async (userId: string) => {
    const u = [...dir.values()].find((x) => x.id === userId);
    if (!u) throw new Error("unknown privy user");
    return record(u);
  },
  getUserByEmail: async (email: string) => {
    if (lookupGate) await lookupGate;
    if (lookupThrows) throw new Error("privy upstream 503");
    const u = dir.get(email.toLowerCase());
    return u ? record(u) : null;
  },
  importUser: async (input) => {
    importCalls.push(input);
    const email = input.linkedAccounts[0]!.address.toLowerCase();
    const u: Fake = {
      id: `did:privy:new-${dir.size + 1}`,
      email,
      wallets: input.createEthereumWallet ? [{ address: addr(), walletClientType: "privy" }] : [],
    };
    dir.set(email, u);
    return record(u);
  },
});

const store = new InMemoryStore();
const mock = new MockChain();
const relayer = new Relayer(mock);
const ctx = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
(config as { PUBLIC_BASE_URL: string }).PUBLIC_BASE_URL = base;
const cfg = config as unknown as { INTERNAL_STATUS_TOKEN: string; modes: { privyLive: boolean; survivalLive: boolean } };

async function gift(body: unknown, token: string | null = "gift-mint-check-token"): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/internal/gift-mint`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}
const minted = async () => (await relayer.seasonGate()).minted;
const byOwner = async (wallet: string) =>
  (await (await fetch(`${base}/api/pets/by-owner?address=${wallet}`)).json()) as { pets: Array<{ tokenId: string }> };

try {
  console.log("\n1. the gate and the body");
  {
    cfg.modes.survivalLive = true;
    const stubbed = await gift({ email: "a@example.com" });
    check("Privy stubbed: 503 unavailable, nothing minted", stubbed.status === 503 && stubbed.body.code === "unavailable" && (await minted()) === 0, JSON.stringify(stubbed.body));
    cfg.modes.privyLive = true;
    const wrong = await gift({ email: "a@example.com" }, "nope");
    check("wrong bearer: 401", wrong.status === 401);
    const none = await gift({ email: "a@example.com" }, null);
    check("no bearer: 401", none.status === 401);
    const saved = cfg.INTERNAL_STATUS_TOKEN;
    cfg.INTERNAL_STATUS_TOKEN = "";
    const off = await gift({ email: "a@example.com" });
    check("token env unset: 404 (route not discoverable)", off.status === 404);
    cfg.INTERNAL_STATUS_TOKEN = saved;
    for (const bad of [{}, { email: "" }, { email: "not-an-email" }, { email: "x".repeat(260) + "@e.com" }]) {
      const r = await gift(bad);
      check(`bad body ${JSON.stringify(bad).slice(0, 30)}: 400`, r.status === 400 && r.body.code === "bad_request", JSON.stringify(r.body));
    }
    check("nothing minted by the refusals", (await minted()) === 0 && importCalls.length === 0);
  }

  console.log("\n2. dry run creates nothing and mints nothing");
  {
    const r = await gift({ email: "Newcomer@Example.com", dryRun: true });
    check(
      "unknown email: 200 dryRun, wouldCreateUser true, no wallet yet",
      r.status === 200 && r.body.dryRun === true && r.body.userExists === false && r.body.wouldCreateUser === true && r.body.wallet === null,
      JSON.stringify(r.body),
    );
    check("no Privy user was created, nothing minted", importCalls.length === 0 && dir.size === 0 && (await minted()) === 0);
    const keeper = addr();
    dir.set("keeper@example.com", { id: "did:privy:keeper", email: "keeper@example.com", wallets: [{ address: keeper, walletClientType: "privy" }] });
    const r2 = await gift({ email: "keeper@example.com", dryRun: true });
    check("known keeper: 200 dryRun names the embedded wallet", r2.status === 200 && r2.body.userExists === true && r2.body.wallet === keeper, JSON.stringify(r2.body));
    check("still nothing minted", (await minted()) === 0);
  }

  console.log("\n3. a known keeper's gift lands in the embedded wallet, with a row, at once");
  {
    const keeper = dir.get("keeper@example.com")!.wallets[0]!.address;
    const r = await gift({ email: "keeper@example.com" });
    check(
      "201 with tokenId, txHash, wallet, serial",
      r.status === 201 && r.body.tokenId === "1" && typeof r.body.txHash === "string" && r.body.wallet === keeper && typeof r.body.serial === "string" && r.body.privyUserCreated === false,
      JSON.stringify(r.body),
    );
    check("the chain minted exactly one", (await minted()) === 1);
    const row = await store.getRunnerByTokenId("1");
    check(
      "the server row exists now (adopted with a fresh gate), owned by the keeper",
      !!row && row.ownerAddress === keeper && row.status === "ready" && row.serial === r.body.serial,
      JSON.stringify(row && { owner: row.ownerAddress, status: row.status }),
    );
    const seen = await byOwner(keeper);
    check("the keeper's by-owner lists it on the first visit", seen.pets.some((p) => p.tokenId === "1"), JSON.stringify(seen.pets.map((p) => p.tokenId)));
    check("no Privy user was created for an existing keeper", importCalls.length === 0);
  }

  console.log("\n4. an unknown email gets ONE Privy user with an embedded wallet, then the pet");
  {
    const r = await gift({ email: "Newcomer@Example.com" });
    const made = dir.get("newcomer@example.com");
    check(
      "201, privyUserCreated true, wallet = the embedded wallet Privy created",
      r.status === 201 && r.body.privyUserCreated === true && !!made && r.body.wallet === made.wallets[0]!.address,
      JSON.stringify(r.body),
    );
    check(
      "importUser called exactly once, lowercased email, createEthereumWallet true",
      importCalls.length === 1 && JSON.stringify(importCalls[0]).includes('"newcomer@example.com"') && (importCalls[0] as { createEthereumWallet?: boolean }).createEthereumWallet === true,
      JSON.stringify(importCalls[0]),
    );
    check("minted count is 2 and token 2 sits in the new wallet", (await minted()) === 2 && (await store.getRunnerByTokenId("2"))?.ownerAddress === made!.wallets[0]!.address);
    const again = await gift({ email: "newcomer@example.com", allowSecond: true });
    check(
      "a second gift to the same email reuses the user (no second Privy user) and mints token 3",
      again.status === 201 && again.body.privyUserCreated === false && again.body.tokenId === "3" && importCalls.length === 1,
      JSON.stringify(again.body),
    );
  }

  console.log("\n5. refusals that mint nothing");
  {
    const before = await minted();
    dir.set("metamask@example.com", { id: "did:privy:mm", email: "metamask@example.com", wallets: [{ address: addr(), walletClientType: "metamask" }] });
    const ext = await gift({ email: "metamask@example.com" });
    check("external-only Privy user: 422 no_embedded_wallet", ext.status === 422 && ext.body.code === "no_embedded_wallet", JSON.stringify(ext.body));
    const extDry = await gift({ email: "metamask@example.com", dryRun: true });
    check("same on a dry run", extDry.status === 422 && extDry.body.code === "no_embedded_wallet", JSON.stringify(extDry.body));
    lookupThrows = true;
    const down = await gift({ email: "keeper@example.com", allowSecond: true });
    check("Privy unreachable: 503 unavailable", down.status === 503 && down.body.code === "unavailable", JSON.stringify(down.body));
    const downDry = await gift({ email: "keeper@example.com", dryRun: true });
    check("Privy unreachable on a dry run is 503, never would-create", downDry.status === 503 && downDry.body.code === "unavailable", JSON.stringify(downDry.body));
    lookupThrows = false;
    check("nothing minted by any refusal", (await minted()) === before && importCalls.length === 1);
  }

  console.log("\n6. two calls for one email at once: one mint, one 409");
  {
    const before = await minted();
    let open!: () => void;
    lookupGate = new Promise<void>((r) => {
      open = r;
    });
    const first = gift({ email: "keeper@example.com", allowSecond: true });
    await new Promise((r) => setTimeout(r, 30));
    const second = await gift({ email: "keeper@example.com", allowSecond: true });
    check("the second call is refused 409 busy while the first is in flight", second.status === 409 && second.body.code === "busy", JSON.stringify(second.body));
    open();
    lookupGate = null;
    const done = await first;
    check("the first call completes with one mint", done.status === 201 && (await minted()) === before + 1, JSON.stringify(done.body));
    const third = await gift({ email: "keeper@example.com", dryRun: true });
    check("the latch is released afterwards", third.status === 200);
  }

  console.log("\n7. the issuer refusing (budget spent) is a 503 with no row");
  {
    const before = await minted();
    const nowSec = Math.floor(Date.now() / 1000);
    mock.mockSetMintBudget({ max: 1, used: 1, windowStart: nowSec, windowSecs: 3600 });
    const r = await gift({ email: "keeper@example.com", allowSecond: true });
    check("503 unavailable naming the mint failure", r.status === 503 && r.body.code === "unavailable" && /mint failed/.test(String(r.body.error)), JSON.stringify(r.body).slice(0, 200));
    check("nothing minted, no new row, outcome not_minted", (await minted()) === before && r.body.outcome === "not_minted" && !(await store.getRunnerByTokenId(String(before + 1))));
    mock.mockSetMintBudget({ max: 0, used: 0, windowStart: nowSec, windowSecs: 3600 });
  }

  console.log("\n8. one gift per wallet by default (review 86)");
  {
    const before = await minted();
    const keeper = dir.get("keeper@example.com")!.wallets[0]!.address;
    const refused = await gift({ email: "keeper@example.com" });
    check("a wallet that already holds a pet is refused 409 already_has_pet, nothing minted", refused.status === 409 && refused.body.code === "already_has_pet" && Array.isArray(refused.body.pets) && (refused.body.pets as string[]).length > 0 && (await minted()) === before, JSON.stringify(refused.body));
    const dry = await gift({ email: "keeper@example.com", dryRun: true });
    check("the dry run lists the wallet's pets", dry.status === 200 && dry.body.wallet === keeper && Array.isArray(dry.body.pets) && (dry.body.pets as string[]).includes("1"), JSON.stringify(dry.body));
    const allowed = await gift({ email: "keeper@example.com", allowSecond: true });
    check("allowSecond:true gifts another", allowed.status === 201 && (await minted()) === before + 1, JSON.stringify(allowed.body));
  }
  console.log("\n9. a Privy error that echoes the address never carries the email back out");
  {
    _setPrivyClientForTests({
      verifyAuthToken: async () => {
        throw new Error("not used here");
      },
      getUser: async () => {
        throw new Error("not used here");
      },
      getUserByEmail: async () => null,
      importUser: async () => {
        throw new Error('Privy 409: user with email "echo.me@example.com" already exists');
      },
    });
    const r = await gift({ email: "echo.me@example.com" });
    const text = JSON.stringify(r.body);
    check("503 unavailable with privyUserCreated unknown", r.status === 503 && r.body.privyUserCreated === "unknown", text);
    check("the body does not echo the address", !text.includes("echo.me@example.com") && text.includes("<email>"), text);
  }
} finally {
  _setPrivyClientForTests(null);
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
