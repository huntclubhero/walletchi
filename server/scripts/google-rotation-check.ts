/**
 * GOOGLE OBJECT ROTATION CHECK: the REAL RunnerGoogleWallet (google.ts) against a fake Wallet API.
 *
 * ERC-8426: rotation MUST NOT deliver the new links to passes issued before it. Every account that
 * saved a Google object shares it, so a rotation (a new owner's claim, or the owner's "reset my
 * pass links") moves the pet's links into a NEW object and retires the old one. The route-level
 * checks (rotate-links, gift-pet) drive the handlers with a fake client; this one drives the real
 * client's HTTP so the exact requests Google would receive are asserted:
 *
 *   1. objectId: legacy runner_<serial> until the first rotation, the stored suffix after it.
 *   2. retireObject PATCHes the OLD object: state EXPIRED, the keepsake status and copy, and
 *      linksModuleData REPLACED with only the public pet page (no care link survives), then posts
 *      the message. A 404 (never saved, never created) is quiet; a failure never throws.
 *   3. patchObject on the NEW object that does not exist yet creates it (POST) instead of failing,
 *      and the new object carries care links signed by the rotated token.
 *
 * Run: npx tsx scripts/google-rotation-check.ts
 */
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://g:g@localhost:5432/g";
process.env.GOOGLE_WALLET_STUB = "false";
process.env.GOOGLE_ISSUER_ID = "3388000000000000000";
process.env.GOOGLE_SA_KEY_BASE64 = Buffer.from(
  JSON.stringify({
    client_email: "check@walletchi-check.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }),
).toString("base64");
process.env.PUBLIC_BASE_URL = "https://api.walletchi.test";
process.env.WEB_APP_URL = "https://www.walletchi.test";

const { RunnerGoogleWallet, legacyObjectSuffix, newGoogleObjectSuffix, RETIRED_OBJECT_COPY } = await import(
  "../src/runner/google.js"
);
import type { Runner } from "../src/store/types.js";

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

// ---- a fake Google Wallet REST API --------------------------------------------------------------
type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
// Every full-object create/update body (retire PATCHes carry only `state`).
const fullObjectWrites: Record<string, unknown>[] = [];
const objects = new Map<string, any>();
let failPatches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init.method ?? "GET").toUpperCase();
  const json = (status: number, b: unknown) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  // The token exchange is a form post, not JSON.
  if (url.hostname === "oauth2.googleapis.com") return json(200, { access_token: "tok", expires_in: 3600 });
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const path = url.pathname.replace("/walletobjects/v1", "");
  calls.push({ method, path, body });
  if ((method === "POST" || method === "PATCH") && /^\/loyaltyObject(\/[^/]+)?$/.test(path) && body?.classId) fullObjectWrites.push(body);
  if (path.startsWith("/loyaltyClass")) return method === "GET" ? json(200, {}) : json(200, body);
  const m = /^\/loyaltyObject(?:\/([^/]+))?(\/addMessage)?$/.exec(path);
  if (!m) return json(404, { error: "unknown route" });
  const id = m[1] ? decodeURIComponent(m[1]) : undefined;
  if (m[2]) return objects.has(id!) ? json(200, {}) : json(404, {});
  if (method === "POST") {
    if (objects.has(body.id)) return json(409, {});
    objects.set(body.id, body);
    return json(200, body);
  }
  if (method === "GET") return objects.has(id!) ? json(200, objects.get(id!)) : json(404, {});
  if (method === "PATCH") {
    if (failPatches > 0) {
      failPatches -= 1;
      return json(500, { error: "boom" });
    }
    if (!objects.has(id!)) return json(404, {});
    objects.set(id!, { ...objects.get(id!), ...body });
    return json(200, objects.get(id!));
  }
  return json(405, {});
}) as typeof fetch;

const google = new RunnerGoogleWallet();
check("precondition: the client is LIVE (real HTTP path, not the stub)", google.live === true);

const serial = "0b6f6a1e-1111-4222-8333-944455556666";
const runner = {
  serial,
  googleObjectId: null,
  tokenId: "7",
  authToken: "a".repeat(48),
  gone: false,
  won: false,
  hatched: true,
  critical: false,
  toys: 0,
  hunger: 80,
  thirst: 80,
  joy: 80,
  lastEvent: null,
  bornAt: null,
  diedAt: null,
  careCount: 0,
  deathRank: 0,
  lastStage: 0,
  lastCareAt: new Date(),
  lastNeedsAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Runner;

try {
  // ------------------------------------------------------------------ 1. object ids
  console.log("\n1. object ids");
  const legacyId = google.objectId(runner);
  check("a never-rotated pet keeps the legacy id (cards saved before the fix keep updating)", legacyId === `3388000000000000000.${legacyObjectSuffix(serial)}`, legacyId);
  const suffix = newGoogleObjectSuffix(serial);
  check("a rotation suffix is the legacy id plus 16 random hex", new RegExp(`^${legacyObjectSuffix(serial)}_[0-9a-f]{16}$`).test(suffix), suffix);
  check("and two rotations never collide", newGoogleObjectSuffix(serial) !== suffix);
  const rotated = { ...runner, googleObjectId: suffix, authToken: "b".repeat(48) } as Runner;
  const newId = google.objectId(rotated);
  check("after rotation the pet's object is the stored suffix", newId === `3388000000000000000.${suffix}`, newId);
  check("and the suffix carries nothing derived from the pass secret", !suffix.includes("a".repeat(8)) && !suffix.includes("b".repeat(8)));

  // The holder saved the legacy object before the rotation.
  await google.ensureObject(runner);
  check("precondition: the legacy object exists with live care links", Boolean(objects.get(legacyId)?.linksModuleData?.uris?.some((u: any) => /care/.test(u.uri) || u.id === "feed")), JSON.stringify(objects.get(legacyId)?.linksModuleData?.uris?.map((u: any) => u.id)));

  // ------------------------------------------------------------------ 2. retire the old object
  console.log("\n2. retire the old object");
  calls.length = 0;
  await google.retireObject(runner, legacyId, "reset");
  const retirePatch = calls.find((c) => c.method === "PATCH" && c.path === `/loyaltyObject/${legacyId}`);
  check("the OLD object was PATCHed", Boolean(retirePatch));
  check("to state EXPIRED", retirePatch?.body?.state === "EXPIRED", retirePatch?.body?.state);
  check("with the keepsake status", retirePatch?.body?.loyaltyPoints?.balance?.string === RETIRED_OBJECT_COPY.reset.status);
  check("with the keepsake copy as the only text module", retirePatch?.body?.textModulesData?.length === 1 && retirePatch.body.textModulesData[0].body === RETIRED_OBJECT_COPY.reset.body);
  const links = retirePatch?.body?.linksModuleData?.uris ?? [];
  check("and the links REPLACED with only the public pet page (a PATCH merges, so the array is sent)", links.length === 1 && links[0].id === "pet-page" && links[0].uri === `https://www.walletchi.test/pet/${serial}`, JSON.stringify(links));
  const stored = objects.get(legacyId);
  check("so the saved object now holds no care link at all", !JSON.stringify(stored.linksModuleData).includes("/care") && stored.linksModuleData.uris.length === 1);
  check("and it never received the NEW token's links", !JSON.stringify(stored).includes("b".repeat(48)));
  check("a message was posted to the old object", calls.some((c) => c.method === "POST" && c.path === `/loyaltyObject/${legacyId}/addMessage` && c.body?.message?.header === RETIRED_OBJECT_COPY.reset.header));

  calls.length = 0;
  let threw = false;
  try {
    await google.retireObject(runner, "3388000000000000000.runner_never_saved", "transfer");
  } catch {
    threw = true;
  }
  check("retiring an object that never existed (404) is quiet", !threw && !calls.some((c) => c.path.endsWith("/addMessage")));
  // One transient failure is retried (Nexory, 2026-10-15): otherwise the old card keeps looking live.
  objects.set(legacyId, { ...objects.get(legacyId), state: "ACTIVE" });
  calls.length = 0;
  failPatches = 1;
  await google.retireObject(runner, legacyId, "transfer");
  const retirePatches = calls.filter((c) => c.method === "PATCH" && c.path.endsWith(legacyId)).length;
  check("a 5xx while retiring is retried once and the retire lands", retirePatches === 2 && objects.get(legacyId)?.state === "EXPIRED", `${retirePatches} PATCHes, ${objects.get(legacyId)?.state}`);
  failPatches = 2;
  threw = false;
  try {
    await google.retireObject(runner, legacyId, "transfer");
  } catch {
    threw = true;
  }
  check("a Google failure while retiring never throws into the claim path", !threw);

  // ------------------------------------------------------------------ 3. the new object
  console.log("\n3. the new object");
  calls.length = 0;
  await google.patchObject(rotated);
  check("the push to the NEW (not yet created) object created it instead of failing", objects.has(newId) && calls.some((c) => c.method === "POST" && c.path === "/loyaltyObject"), calls.map((c) => `${c.method} ${c.path}`).join(", "));
  const fresh = objects.get(newId);
  check("the new object is ACTIVE", fresh?.state === "ACTIVE");
  check("and its care links are signed by the rotated token, not the old one", JSON.stringify(fresh.linksModuleData).length > 0 && !JSON.stringify(fresh).includes("a".repeat(48)));
  check("no write after the rotation touched the old object's links", !calls.some((c) => c.path === `/loyaltyObject/${legacyId}`));
  calls.length = 0;
  await google.patchObject({ ...rotated, lastEvent: "a new narration line" } as Runner);
  check("later pushes PATCH the new object in place", calls.some((c) => c.method === "PATCH" && c.path === `/loyaltyObject/${newId}`) && !calls.some((c) => c.path === `/loyaltyObject/${legacyId}`));
  calls.length = 0;
  await google.patchObject({ ...runner, lastEvent: "a stale push that read the row before the rotation" } as Runner);
  await google.addMessage(runner, "stale", "a stale message");
  check("a STALE push (runner read before the rotation) cannot write the retired object back to life", !calls.some((c) => c.path.startsWith(`/loyaltyObject/${legacyId}`)) && objects.get(legacyId).state === "EXPIRED", calls.map((c) => `${c.method} ${c.path}`).join(", ") || "no writes");
} finally {
  globalThis.fetch = realFetch;
}

// NO QR on the Google card (Hunt, 2026-10-09). PATCH keeps any key it omits, so the
// body must carry an explicit `barcode: null` or existing cards keep their old QR.
check("google: object writes happened (precondition)", fullObjectWrites.length > 0, String(fullObjectWrites.length));
check(
  "google: every create/update sends barcode: null (clears the QR on existing cards)",
  fullObjectWrites.every((b) => "barcode" in b && b.barcode === null),
  JSON.stringify(fullObjectWrites.map((b) => b.barcode)),
);

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
if (failures > 0) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
