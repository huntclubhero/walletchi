import http2 from "node:http2";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { loadPassCertificates } from "./certs.js";

// Apple Wallet pushes are certificate-based (mTLS): the PASS signing cert is the
// APNs client credential. Payload is an empty {}; the device then fetches the
// fresh pass and the changeMessage drives the lock-screen text.

export interface PushOutcome {
  token: string;
  ok: boolean;
  status?: number;
  reason?: string;
}

// ONE SESSION, REUSED (launch fix 4). Every push used to open a fresh http2
// session to Apple: a TCP handshake plus a mutual-TLS handshake (our pass
// certificate is the client credential, so the server verifies it too) per call,
// on the event loop, for a request whose payload is `{}`. Apple documents the
// opposite: keep the connection open and multiplex; connecting per push is the
// pattern they throttle. The session below lives across calls and is replaced
// whenever it errors, closes or receives GOAWAY, and a connect that is already in
// progress is shared, so a burst of pushes on a cold session performs ONE
// handshake.
//
// How a held session can go bad, and what retires it:
//   - Apple closes it (idle, maintenance): arrives as GOAWAY or close, the session
//     is dropped and the next push reconnects. A push racing that GOAWAY fails at
//     request() before any stream exists; those tokens are retried ONCE on a
//     fresh session, because a background push that silently never happens is a
//     pass that silently goes stale. Nothing was sent for them, so no device is
//     ever pushed twice.
//   - The socket dies without a FIN (a NAT or load balancer forgets it): nothing
//     arrives at all, so the stream timeout is the only signal. A stream that
//     stalls for STREAM_TIMEOUT_MS on a connection Apple answers in milliseconds
//     retires the session; the next push reconnects instead of timing out
//     forever on a corpse.
//   - We stop using it: after IDLE_CLOSE_MS without a frame either way the
//     session is closed on our side. One handshake per quiet spell is cheap; a
//     socket nobody has exercised for that long is the one most likely to be
//     silently dead.
//   - The connect itself hangs or fails: the connect is timeout-raced, the
//     half-built session is DESTROYED (not merely closed), and a late "connect"
//     event from it can never install it, so a failed attempt cannot leak a
//     socket. The error listener is attached from the first tick: an http2
//     session with no 'error' listener crashes the process on its first socket
//     error, and a failing connect can emit more than one.
//
// The socket is unref'd whenever no push is in flight, so a held session never
// keeps a script's process alive; it is ref'd for the duration of each batch so
// a script awaiting its pushes is not cut short either.
const CONNECT_TIMEOUT_MS_DEFAULT = 5_000;
const STREAM_TIMEOUT_MS_DEFAULT = 10_000;
const IDLE_CLOSE_MS_DEFAULT = 10 * 60_000;
let CONNECT_TIMEOUT_MS = CONNECT_TIMEOUT_MS_DEFAULT;
let STREAM_TIMEOUT_MS = STREAM_TIMEOUT_MS_DEFAULT;
let IDLE_CLOSE_MS = IDLE_CLOSE_MS_DEFAULT;

let session: http2.ClientHttp2Session | null = null;
let connecting: Promise<http2.ClientHttp2Session> | null = null;
let activeBatches = 0;
let connects = 0; // sessions successfully opened (the check script asserts reuse with it)

function sessionUsable(s: http2.ClientHttp2Session | null): s is http2.ClientHttp2Session {
  return Boolean(s && !s.closed && !s.destroyed);
}

function dropSession(why: string, s: http2.ClientHttp2Session): void {
  if (session === s) {
    session = null;
    logger.info({ why }, "APNs session dropped; the next push reconnects");
  }
  try {
    // Graceful: streams already in flight on it still complete (or time out).
    s.close();
  } catch {
    /* already gone */
  }
}

function connectSession(certs: { signerCertPem: string; signerKeyPem: string }): Promise<http2.ClientHttp2Session> {
  if (sessionUsable(session)) return Promise.resolve(session);
  if (connecting) return connecting;
  const url = `https://${config.APNS_HOST}:${config.APNS_PORT}`;
  connecting = new Promise<http2.ClientHttp2Session>((resolve, reject) => {
    const client = http2.connect(url, {
      cert: certs.signerCertPem,
      key: certs.signerKeyPem,
      // No custom `ca`: Node's default trust store must verify Apple's APNs
      // server certificate. WWDR is our CLIENT cert issuer, not Apple's server
      // chain; passing it here breaks server verification entirely.
    });
    let settled = false;
    // Timeout-race the connect: a black-holed APNs socket must not park the
    // calling care/idle path indefinitely (http2.connect has no default timeout).
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(new Error(`APNs connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);
    client.on("error", (err) => {
      if (!settled) {
        // Before connect: the first error fails this attempt.
        settled = true;
        clearTimeout(timer);
        client.destroy();
        reject(err);
        return;
      }
      // After connect: any error retires the session.
      dropSession(`error: ${String(err)}`, client);
    });
    client.once("connect", () => {
      if (settled) {
        // Lost the race to the timeout or an error: never install it.
        client.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      connects += 1;
      session = client;
      client.on("close", () => dropSession("close", client));
      client.on("goaway", () => dropSession("goaway", client));
      client.setTimeout(IDLE_CLOSE_MS, () => dropSession("idle", client));
      if (activeBatches === 0) client.unref();
      resolve(client);
    });
  }).finally(() => {
    connecting = null;
  });
  return connecting;
}

/** Test hook: is a session currently held open? */
export function _apnsSessionOpenForTests(): boolean {
  return sessionUsable(session);
}

/** Test hook: sessions opened so far (a reused session does not count again). */
export function _apnsConnectsForTests(): number {
  return connects;
}

/** Test hook: shrink the timeouts so the check script runs in seconds. Omitted keys restore defaults. */
export function _setApnsTimeoutsForTests(t: { connectMs?: number; streamMs?: number; idleMs?: number } = {}): void {
  CONNECT_TIMEOUT_MS = t.connectMs ?? CONNECT_TIMEOUT_MS_DEFAULT;
  STREAM_TIMEOUT_MS = t.streamMs ?? STREAM_TIMEOUT_MS_DEFAULT;
  IDLE_CLOSE_MS = t.idleMs ?? IDLE_CLOSE_MS_DEFAULT;
}

/** Test hook: close whatever session is held (the check script's teardown). */
export function _closeApnsSessionForTests(): void {
  if (session) dropSession("test teardown", session);
}

interface BatchResult {
  outcomes: PushOutcome[];
  /** Tokens whose stream could not even be opened (the session was already dead). */
  sessionDead: string[];
}

// One stream per token on the given session. Never rejects: every token settles
// to exactly one outcome, or lands in sessionDead when request() itself threw.
function pushOnSession(client: http2.ClientHttp2Session, pushTokens: string[]): Promise<BatchResult> {
  const outcomes: PushOutcome[] = [];
  const sessionDead: string[] = [];
  return Promise.all(
    pushTokens.map(
      (token) =>
        new Promise<void>((resolve) => {
          let req: http2.ClientHttp2Stream;
          try {
            req = client.request({
              ":method": "POST",
              ":path": `/3/device/${token}`,
              "apns-topic": config.PASS_TYPE_ID,
              "apns-push-type": "background",
              "apns-priority": "5",
              "content-type": "application/json",
            });
          } catch (err) {
            // ERR_HTTP2_GOAWAY_SESSION / ERR_HTTP2_INVALID_SESSION: the session
            // died between the usability check and this call. No stream exists,
            // so nothing was sent; the caller may retry on a fresh session.
            dropSession(`request failed: ${String(err)}`, client);
            sessionDead.push(token);
            resolve();
            return;
          }
          let status = 0;
          let body = "";
          let settled = false;
          const settle = (outcome: PushOutcome) => {
            if (settled) return;
            settled = true;
            outcomes.push(outcome);
            resolve();
          };
          req.on("response", (headers) => {
            status = Number(headers[":status"] ?? 0);
          });
          req.setEncoding("utf8");
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            const ok = status === 200;
            if (!ok) {
              let reason = body;
              try {
                reason = JSON.parse(body).reason ?? body;
              } catch {
                /* keep raw */
              }
              logger.warn({ token, status, reason }, "APNs push non-200");
              settle({ token, ok, status, reason });
            } else {
              settle({ token, ok, status });
            }
          });
          req.on("error", (err) => {
            settle({ token, ok: false, reason: err.message });
            // A stream error that is really the session dying: retire it so the
            // next push reconnects instead of failing on a dead socket forever.
            if (client.closed || client.destroyed) dropSession(`stream error: ${err.message}`, client);
          });
          // Per-stream inactivity timeout: a stalled stream must not hang the
          // whole batch behind Promise.all, and it is the only symptom of a
          // socket that died without telling us, so it retires the session too.
          req.setTimeout(STREAM_TIMEOUT_MS, () => {
            settle({ token, ok: false, reason: "stream timeout" });
            req.close(http2.constants.NGHTTP2_CANCEL);
            dropSession("stream timeout", client);
          });
          req.end(JSON.stringify({}));
        }),
    ),
  ).then(() => ({ outcomes, sessionDead }));
}

export async function pushPassUpdate(
  pushTokens: string[],
): Promise<PushOutcome[]> {
  if (pushTokens.length === 0) return [];
  const certs = loadPassCertificates();

  if (!certs) {
    logger.warn(
      { count: pushTokens.length },
      "APNs STUB: would push pass update to devices (no PASS cert). Set PASS_CERT_P12_BASE64 to send.",
    );
    return pushTokens.map((token) => ({ token, ok: false, reason: "stub" }));
  }

  activeBatches += 1;
  const held: http2.ClientHttp2Session[] = [];
  try {
    const results: PushOutcome[] = [];
    let pending = pushTokens;
    // Attempt 0 may land on a held session that Apple just retired; attempt 1 is
    // on a session opened for this batch. Only tokens that never got a stream
    // are retried.
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
      let client: http2.ClientHttp2Session;
      try {
        client = await connectSession(certs);
      } catch (err) {
        logger.error({ err: String(err) }, "APNs connect failed");
        const reason = `connect: ${err instanceof Error ? err.message : String(err)}`;
        for (const token of pending) results.push({ token, ok: false, reason });
        pending = [];
        break;
      }
      client.ref();
      held.push(client);
      const { outcomes, sessionDead } = await pushOnSession(client, pending);
      results.push(...outcomes);
      pending = sessionDead;
    }
    for (const token of pending) {
      results.push({ token, ok: false, reason: "session closed before the stream opened" });
    }
    const okCount = results.filter((r) => r.ok).length;
    logger.info({ ok: okCount, total: results.length }, "APNs push complete");
    return results;
  } finally {
    activeBatches -= 1;
    if (activeBatches === 0) {
      for (const s of held) {
        if (!s.destroyed) s.unref();
      }
    }
  }
}
