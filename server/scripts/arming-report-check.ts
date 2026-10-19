/**
 * ONE-TAP ARMING FAILURE BEACON CHECK: POST /api/pet/:tokenId/arming-report (me-routes.ts).
 * Real handler, in-memory store + MockChain. It must accept a well-formed report (204), refuse a
 * malformed one (400), cap an abusive client per IP (429), and never touch the pet or the chain.
 *
 * Run: npx tsx scripts/arming-report-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://ar:ar@localhost:5432/ar";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";

const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { _resetClaimState } = await import("../src/runner/claim.js");
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

const mock = new MockChain();
const ctx = { store: new InMemoryStore(), relayer: new Relayer(mock) } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = (tokenId: string, body: unknown) =>
  fetch(`${base}/api/pet/${tokenId}/arming-report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

try {
  _resetClaimState();
  const good = {
    surface: "mint",
    stage: "feed",
    detail: "refusing to sign a 7702 authorization to an unexpected delegate 0x77021100...",
    owner: "0x9a7b06e1Cb5B25bD9555eC366458b3d63F982D0a",
  };
  const ok = await post("2", good);
  check("a well-formed report is accepted with 204", ok.status === 204, String(ok.status));

  const badSurface = await post("2", { ...good, surface: "elsewhere" });
  check("an unknown surface is refused (400)", badSurface.status === 400);
  const badStage = await post("2", { ...good, stage: "FEED; drop table" });
  check("a stage outside the tiny alphabet is refused (400)", badStage.status === 400);
  const longDetail = await post("2", { ...good, detail: "x".repeat(501) });
  check("an oversized detail is refused (400)", longDetail.status === 400);
  const badOwner = await post("2", { ...good, owner: "not-an-address" });
  check("a malformed owner is refused (400)", badOwner.status === 400);
  const badId = await post("abc", good);
  check("a non-numeric token id does not match the route (404)", badId.status === 404);

  _resetClaimState();
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await post("2", good)).status;
  check("an abusive client is capped per IP (429)", last === 429, String(last));
} finally {
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
