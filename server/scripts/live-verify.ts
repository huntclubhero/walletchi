/**
 * WALLETCHI live wallet-loop verification. Drives the REAL production mint path
 * end to end and reports the health of the Google Wallet integration:
 *
 *   challenge -> hashcash solve -> checkout (MINTS A REAL PET) -> pass-link ->
 *   decode googleSaveUrl JWT (thin vs fat fallback, links module) ->
 *   care link GET (must be a side-effect-free interstitial) ->
 *   care link POST (performs one feed; spends 1 CARE from the pet's TBA).
 *
 * BURNS SUPPLY: every run mints one real pet, so the email is a required,
 * explicit argument (one pet per normalized inbox).
 *
 *   npx tsx scripts/live-verify.ts fresh-inbox@halldon.com [apiBaseUrl]
 *
 * Expected after the numeric GOOGLE_ISSUER_ID lands: "THIN JWT: YES".
 * "THIN JWT: NO (fat fallback)" means the REST upsert failed; check
 * /internal/status google.probe.
 */
import { createHash } from "node:crypto";

const EMAIL = process.argv[2];
const API = process.argv[3] ?? "https://api.playwalletchi.com";
if (!EMAIL || !EMAIL.includes("@")) {
  console.error("Usage: npx tsx scripts/live-verify.ts <fresh-email> [apiBaseUrl]");
  console.error("Refusing to run without an explicit email: every run mints a real pet.");
  process.exit(2);
}

function leadingZeroBits(hash: Buffer): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    for (let mask = 0x80; mask > 0; mask >>= 1) {
      if (byte & mask) return bits;
      bits++;
    }
    return bits;
  }
  return bits;
}

function solve(nonce: string, bits: number): number {
  for (let counter = 0; ; counter++) {
    const h = createHash("sha256").update(`${nonce}:${counter}`).digest();
    if (leadingZeroBits(h) >= bits) return counter;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const redact = (u: string) => u.replace(/([?&]s=)[0-9a-f]+/g, "$1REDACTED");
const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

async function main(): Promise<void> {
  const ch = (await (await fetch(`${API}/api/mint/challenge`)).json()) as {
    nonce: string;
    bits: number;
    exp: number;
    sig: string;
    required: boolean;
  };
  console.log(`challenge: bits=${ch.bits} required=${ch.required}`);
  const t0 = Date.now();
  const counter = solve(ch.nonce, ch.bits);
  console.log(`solved in ${Date.now() - t0}ms`);

  // Respect the server-side submit-timing floor (challenge issue -> submit).
  await sleep(12_000);

  const checkoutRes = await fetch(`${API}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: EMAIL,
      elapsedMs: 12_000 + (Date.now() - t0),
      pow: { nonce: ch.nonce, counter, sig: ch.sig, exp: ch.exp, bits: ch.bits },
    }),
  });
  const checkout = (await checkoutRes.json()) as Record<string, unknown>;
  if (!checkoutRes.ok) fail(`checkout blocked ${checkoutRes.status}: ${JSON.stringify(checkout)}`);
  const serial = String(checkout.id ?? checkout.serial);
  console.log(`minted: serial=${serial}`);

  const linkRes = await fetch(`${API}/api/runner/pass-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: serial, mintSession: checkout.mintSession }),
  });
  const link = (await linkRes.json()) as { applePassUrl?: string; googleSaveUrl?: string };
  if (!linkRes.ok) fail(`pass-link ${linkRes.status}: ${JSON.stringify(link)}`);
  console.log(`applePassUrl: ${link.applePassUrl ? "present" : "MISSING"}`);
  if (!link.googleSaveUrl) fail("googleSaveUrl absent (saveUrl threw server-side; check google.probe)");

  const jwt = link.googleSaveUrl!.replace("https://pay.google.com/gp/v/save/", "");
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as {
    payload?: { loyaltyClasses?: unknown[]; loyaltyObjects?: Array<Record<string, unknown>> };
  };
  const ref = payload.payload?.loyaltyObjects?.[0];
  if (!ref) fail("no loyalty object in save JWT");
  const thin = !!ref!.id && !ref!.textModulesData && !payload.payload?.loyaltyClasses;
  console.log(`googleSaveUrl: ${link.googleSaveUrl!.length} chars | THIN JWT: ${thin ? "YES" : "NO (fat fallback)"}`);
  const embeddedLinks = (ref!.linksModuleData as { uris?: Array<{ id: string; uri: string }> } | undefined)?.uris ?? [];
  if (!thin) {
    console.log(`embedded links: ${embeddedLinks.length}`);
    for (const u of embeddedLinks) console.log(`  ${u.id}: ${redact(u.uri)}`);
    if (embeddedLinks.length < 6) fail("fat JWT should embed 6 links (5 care + pet page)");
  }

  // Care link behavior: GET must be a side-effect-free interstitial (a form),
  // POST performs the care. Build the feed link from the embedded object when
  // fat; on the thin path ask the pass-link response object is not available,
  // so fetch the object-free path via the embedded links only when present.
  const feed = embeddedLinks.find((u) => u.id === "feed")?.uri;
  if (feed) {
    const getRes = await fetch(feed);
    const getHtml = await getRes.text();
    const isInterstitial = getRes.ok && /method="post"/i.test(getHtml);
    console.log(`care GET: ${getRes.status} ${isInterstitial ? "interstitial (side-effect free)" : "UNEXPECTED (no post form)"}`);
    if (!isInterstitial) fail("care GET did not return the POST interstitial");
    const postRes = await fetch(feed, { method: "POST" });
    const postHtml = await postRes.text();
    console.log(`care POST: ${postRes.status} ${/WALLETCHI/.test(postHtml) ? "confirm page" : "UNEXPECTED"}`);
    if (!postRes.ok) fail("care POST failed");
  } else {
    console.log("care link check skipped (thin JWT: links live on the stored object)");
  }

  console.log("LIVE VERIFY: PASS");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
