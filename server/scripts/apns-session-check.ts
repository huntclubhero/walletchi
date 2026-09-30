/**
 * APNS SESSION CHECK (launch fix 4: one reused http2 session to Apple)
 *
 * Drives the REAL pushPassUpdate against a local TLS http2 server that plays APNs (self-signed
 * certificate generated here, client certificate required like Apple's). Nothing touches Apple.
 *
 *   1. Two batches in a row share ONE session (one handshake), every token lands 200.
 *   2. A burst of batches on a cold session performs ONE connect.
 *   3. The server sends GOAWAY and closes: the next push reconnects and lands.
 *   4. A stream the server never answers settles as "stream timeout" AND retires the session, so the
 *      push after it opens a fresh session and lands (a silently dead socket is not reused forever).
 *   5. A connect that never completes (a TCP listener that never speaks TLS) fails within the connect
 *      timeout, leaks no session, and a later push to a healthy server works.
 *   6. A non-200 from Apple is reported with Apple's reason, and does not retire the session.
 *   7. The idle close: a session unused for the idle window is closed on our side.
 *
 * Run: npm run apns-session:check
 */
import http2 from "node:http2";
import net from "node:net";
import forge from "node-forge";
import type { AddressInfo } from "node:net";

// One self-signed pair serves as both the fake APNs server certificate and our client (pass)
// certificate. The client does not pass a `ca` (production relies on Node's trust store for Apple),
// so this process disables verification of the SERVER certificate for its own localhost test only.
function selfSigned(): { certPem: string; keyPem: string; p12b64: string; password: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600_000);
  const attrs = [{ name: "commonName", value: "localhost" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const password = "apns-check";
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" });
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    p12b64: forge.util.encode64(forge.asn1.toDer(p12).getBytes()),
    password,
  };
}

const pair = selfSigned();

// The fake APNs. `mode` picks how the NEXT streams are answered.
let mode: "ok" | "stall" | "bad-token" = "ok";
let sessionsSeen = 0;
let streamsSeen = 0;
const serverSessions = new Set<http2.ServerHttp2Session>();
const apns = http2.createSecureServer({
  key: pair.keyPem,
  cert: pair.certPem,
  requestCert: true,
  rejectUnauthorized: false, // our self-signed client cert; presence is asserted below
});
let clientCertPresented = true;
apns.on("session", (s) => {
  sessionsSeen += 1;
  serverSessions.add(s);
  s.on("close", () => serverSessions.delete(s));
  s.on("error", () => {});
});
apns.on("stream", (stream, headers) => {
  streamsSeen += 1;
  const sock = stream.session?.socket as unknown as { getPeerCertificate?: () => { raw?: Buffer } } | undefined;
  if (!sock?.getPeerCertificate?.()?.raw) clientCertPresented = false;
  stream.on("error", () => {});
  if (mode === "stall") return; // never answer
  if (mode === "bad-token") {
    stream.respond({ ":status": 400 });
    stream.end(JSON.stringify({ reason: "BadDeviceToken" }));
    return;
  }
  if (!String(headers[":path"]).startsWith("/3/device/")) {
    stream.respond({ ":status": 404 });
    stream.end();
    return;
  }
  stream.respond({ ":status": 200 });
  stream.end();
});
apns.listen(0, "127.0.0.1");
await new Promise((r) => apns.once("listening", r));
const apnsPort = (apns.address() as AddressInfo).port;

// A listener that accepts TCP and never answers the TLS hello: the black hole.
const holeSockets = new Set<net.Socket>();
const hole = net.createServer((sock) => {
  holeSockets.add(sock);
  sock.on("error", () => {});
  // Read and discard (the TLS hello goes nowhere) so the client closing its end is SEEN here.
  sock.resume();
  sock.on("close", () => holeSockets.delete(sock));
});
hole.listen(0, "127.0.0.1");
await new Promise((r) => hole.once("listening", r));
const holePort = (hole.address() as AddressInfo).port;

process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://apns:apns@localhost:5432/apns";
process.env.PASS_STUB_MODE = "false";
process.env.PASS_CERT_P12_BASE64 = pair.p12b64;
process.env.PASS_CERT_PASSWORD = pair.password;
process.env.APNS_HOST = "127.0.0.1";
process.env.APNS_PORT = String(apnsPort);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.removeAllListeners("warning"); // the TLS-verification-off warning is expected here

const { config } = await import("../src/config.js");
const apnsMod = await import("../src/passes/apns.js");
const { pushPassUpdate, _apnsConnectsForTests, _apnsSessionOpenForTests, _setApnsTimeoutsForTests, _closeApnsSessionForTests } = apnsMod;

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
const allOk = (rs: { ok: boolean }[]) => rs.length > 0 && rs.every((r) => r.ok);

check("setup: the pass certificate is live (not the stub)", config.modes.appleLive === true);
_setApnsTimeoutsForTests({ connectMs: 800, streamMs: 600, idleMs: 60_000 });

try {
  // 1. reuse across batches
  const a = await pushPassUpdate(["tok-a1", "tok-a2", "tok-a3"]);
  const b = await pushPassUpdate(["tok-b1", "tok-b2"]);
  check("reuse: two batches land every token", allOk(a) && allOk(b) && a.length === 3 && b.length === 2, JSON.stringify({ a: a.map((r) => r.status), b: b.map((r) => r.status) }));
  check("reuse: the two batches shared ONE session (one handshake)", _apnsConnectsForTests() === 1 && sessionsSeen === 1, JSON.stringify({ connects: _apnsConnectsForTests(), sessionsSeen }));
  check("reuse: the client certificate was presented on the session (mTLS)", clientCertPresented);
  check("reuse: the session is held open between batches", _apnsSessionOpenForTests());

  // 2. cold burst shares one connect
  _closeApnsSessionForTests();
  await sleep(50);
  const connectsBefore = _apnsConnectsForTests();
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => pushPassUpdate([`tok-burst-${i}`])));
  check("cold burst: eight concurrent batches all land", burst.every(allOk), "");
  check("cold burst: ONE connect served all eight", _apnsConnectsForTests() - connectsBefore === 1, String(_apnsConnectsForTests() - connectsBefore));

  // 3. server GOAWAY + close: next push reconnects
  const beforeGoaway = _apnsConnectsForTests();
  for (const s of serverSessions) {
    s.goaway(http2.constants.NGHTTP2_NO_ERROR);
    s.close();
  }
  await sleep(100);
  check("goaway: the dropped session is no longer held", !_apnsSessionOpenForTests());
  const afterGoaway = await pushPassUpdate(["tok-goaway"]);
  check("goaway: the next push reconnects and lands", allOk(afterGoaway) && _apnsConnectsForTests() === beforeGoaway + 1, JSON.stringify({ afterGoaway, connects: _apnsConnectsForTests() }));

  // 4. a stalled stream retires the session
  mode = "stall";
  const stalled = await pushPassUpdate(["tok-stall"]);
  check("stall: an unanswered stream settles as a stream timeout", stalled.length === 1 && !stalled[0]!.ok && stalled[0]!.reason === "stream timeout", JSON.stringify(stalled));
  check("stall: the stalled session is retired", !_apnsSessionOpenForTests());
  mode = "ok";
  const beforeRecover = _apnsConnectsForTests();
  const recovered = await pushPassUpdate(["tok-after-stall"]);
  check("stall: the next push opens a fresh session and lands", allOk(recovered) && _apnsConnectsForTests() === beforeRecover + 1, JSON.stringify({ recovered, connects: _apnsConnectsForTests() - beforeRecover }));

  // 6. non-200 keeps the session
  mode = "bad-token";
  const before400 = _apnsConnectsForTests();
  const bad = await pushPassUpdate(["tok-bad"]);
  check("non-200: Apple's reason is reported", bad.length === 1 && !bad[0]!.ok && bad[0]!.status === 400 && bad[0]!.reason === "BadDeviceToken", JSON.stringify(bad));
  mode = "ok";
  const after400 = await pushPassUpdate(["tok-after-400"]);
  check("non-200: the session survives a per-token rejection (no reconnect)", allOk(after400) && _apnsConnectsForTests() === before400, String(_apnsConnectsForTests() - before400));

  // 5. black-holed connect
  _closeApnsSessionForTests();
  await sleep(50);
  (config as { APNS_PORT: number }).APNS_PORT = holePort;
  const t0 = Date.now();
  const holed = await pushPassUpdate(["tok-hole-1", "tok-hole-2"]);
  const took = Date.now() - t0;
  check("black hole: the connect fails within the connect timeout", took < 3_000 && holed.length === 2 && holed.every((r) => !r.ok && String(r.reason).startsWith("connect:")), JSON.stringify({ took, holed }));
  check("black hole: no session is left installed", !_apnsSessionOpenForTests());
  await sleep(300);
  check("black hole: the half-open socket was destroyed", holeSockets.size === 0, String(holeSockets.size));
  (config as { APNS_PORT: number }).APNS_PORT = apnsPort;
  const healed = await pushPassUpdate(["tok-healed"]);
  check("black hole: a later push to a healthy APNs lands", allOk(healed), JSON.stringify(healed));

  // 7. idle close
  _closeApnsSessionForTests();
  await sleep(50);
  _setApnsTimeoutsForTests({ connectMs: 800, streamMs: 600, idleMs: 300 });
  const beforeIdle = _apnsConnectsForTests();
  const warm = await pushPassUpdate(["tok-idle-1"]);
  check("idle: a push lands on a fresh session", allOk(warm) && _apnsConnectsForTests() === beforeIdle + 1);
  await sleep(700);
  check("idle: the session is closed after the idle window", !_apnsSessionOpenForTests());
  const afterIdle = await pushPassUpdate(["tok-idle-2"]);
  check("idle: the next push reconnects and lands", allOk(afterIdle) && _apnsConnectsForTests() === beforeIdle + 2);
} finally {
  _setApnsTimeoutsForTests();
  _closeApnsSessionForTests();
  for (const s of serverSessions) s.destroy();
  for (const s of holeSockets) s.destroy();
  apns.close();
  hole.close();
}

console.log(`\napns-session check: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
