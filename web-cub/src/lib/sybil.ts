// Anti-Sybil client pieces for the mint form: PoW challenge fetch + solve,
// best-effort device fingerprint, and bot-signal collection. Self-contained on
// purpose (no external SDK: CSP + build simplicity).
//
// HONEST POSTURE (mirrors the server): everything gathered here is an INPUT the
// server re-verifies or rate-limits on. The PoW solution is checked server-side
// against the signed challenge; the fingerprint is a best-effort dedup signal
// that anti-detect browsers spoof freely; bot signals catch naive automation
// only. Nothing here is a client-side "verdict".

import { API_URL } from "./config";

export interface PowChallenge {
  nonce: string;
  bits: number;
  exp: number;
  sig: string;
  required: boolean;
  /** True when the signature also binds the verified Privy identity (see below). */
  bound?: boolean;
  /** The server's submit-timing floor (too_fast fires under this age). The pow
   *  retry path waits it out so a retry can never refuse itself. */
  minElapsedMs?: number;
  /** Mint-time captcha advertisement: when required, render the Turnstile
   *  widget with this site key and send its token as captchaToken. */
  captcha?: { required: boolean; siteKey?: string };
}

export interface PowSolution {
  nonce: string;
  counter: number;
  sig: string;
  exp: number;
  bits: number;
}

/**
 * GET /api/mint/challenge. Null on any failure (the server decides if it minds).
 *
 * SUBJECT BINDING: pass the signed-in Privy access token and the server binds the
 * challenge signature to that verified identity, so one solved challenge cannot be
 * replayed across many mint subjects. On mainnet an UNBOUND challenge is refused
 * outright, so a signed-in caller must send the token. The anonymous call (no
 * token) is still the correct path before sign-in and must keep working: the
 * preimage is unchanged either way, so the solver never sees the difference.
 */
export async function fetchMintChallenge(privyToken?: string | null): Promise<PowChallenge | null> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (privyToken) headers.Authorization = `Bearer ${privyToken}`;
    const res = await fetch(`${API_URL}/api/mint/challenge`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as PowChallenge;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PoW solver. The search function is fully SELF-CONTAINED (no outer-scope
// references) so its source can be stringified into a Blob Web Worker: the
// 1-3 second search runs off the main thread and never freezes the UI. When
// workers are unavailable (odd CSP), a chunked main-thread loop that yields to
// the event loop every slice does the same work invisibly behind the existing
// "Readying your egg" state.
//
// Search target (must mirror server verifyPow): the smallest counter with
// sha256(nonce + ":" + counter) having >= bits leading zero bits. The message
// is short ASCII (32-hex nonce + counter digits), so a single-block sha256 is
// enough and keeps this dependency-free.
// ---------------------------------------------------------------------------

/**
 * Search [start, end) for a valid counter; -1 when the range has none.
 * SELF-CONTAINED (stringified into the worker): keep every helper inside.
 */
function powSolveRange(nonce: string, bits: number, start: number, end: number): number {
  // SHA-256 round constants + initial state, computed locally (self-contained).
  var K: number[] = [];
  var H0: number[] = [];
  (function () {
    // First 32 fractional bits of the cube/square roots of the first primes
    // (the standard constant-generation trick; validated against node crypto
    // in the smoke suite via the server's identical verify path).
    function frac(x: number): number {
      return ((x - Math.floor(x)) * 4294967296) >>> 0;
    }
    var primes: number[] = [];
    for (var c = 2; primes.length < 64; c++) {
      var isP = true;
      for (var d = 2; d * d <= c; d++) if (c % d === 0) { isP = false; break; }
      if (isP) primes.push(c);
    }
    for (var i = 0; i < 64; i++) K[i] = frac(Math.pow(primes[i]!, 1 / 3));
    for (var k = 0; k < 8; k++) H0[k] = frac(Math.sqrt(primes[k]!));
  })();

  var block = new Uint8Array(64);
  var w = new Int32Array(64);
  var prefixLen = nonce.length + 1;
  for (var pi = 0; pi < nonce.length; pi++) block[pi] = nonce.charCodeAt(pi);
  block[nonce.length] = 58; // ":"

  for (var counter = start; counter < end; counter++) {
    var digits = String(counter);
    var msgLen = prefixLen + digits.length;
    if (msgLen > 55) return -1; // will not fit one block; unreachable in practice
    for (var di = 0; di < digits.length; di++) block[prefixLen + di] = digits.charCodeAt(di);
    block[msgLen] = 0x80;
    for (var zi = msgLen + 1; zi < 62; zi++) block[zi] = 0;
    var bitLen = msgLen * 8;
    block[62] = (bitLen >>> 8) & 0xff;
    block[63] = bitLen & 0xff;

    for (var t = 0; t < 16; t++) {
      w[t] =
        (block[t * 4]! << 24) |
        (block[t * 4 + 1]! << 16) |
        (block[t * 4 + 2]! << 8) |
        block[t * 4 + 3]!;
    }
    for (var t2 = 16; t2 < 64; t2++) {
      var x = w[t2 - 15]!;
      var y = w[t2 - 2]!;
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t2] = (w[t2 - 16]! + s0 + w[t2 - 7]! + s1) | 0;
    }
    var a = H0[0]!, b = H0[1]!, c2 = H0[2]!, d2 = H0[3]!;
    var e = H0[4]!, f = H0[5]!, g = H0[6]!, h = H0[7]!;
    for (var r = 0; r < 64; r++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[r]! + w[r]!) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & b) ^ (a & c2) ^ (b & c2);
      var t22 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d2 + t1) | 0;
      d2 = c2; c2 = b; b = a; a = (t1 + t22) | 0;
    }
    var out = [
      (H0[0]! + a) | 0, (H0[1]! + b) | 0, (H0[2]! + c2) | 0, (H0[3]! + d2) | 0,
      (H0[4]! + e) | 0, (H0[5]! + f) | 0, (H0[6]! + g) | 0, (H0[7]! + h) | 0,
    ];
    var zeros = 0;
    for (var oi = 0; oi < 8 && zeros < bits; oi++) {
      var word = out[oi]! >>> 0;
      if (word === 0) { zeros += 32; continue; }
      var mask = 0x80000000;
      while ((word & mask) === 0 && mask !== 0) { zeros++; mask = mask >>> 1; }
      break;
    }
    if (zeros >= bits) return counter;
  }
  return -1;
}

const CHUNK = 200_000;

function solveInWorker(challenge: PowChallenge): Promise<number> | null {
  if (typeof Worker === "undefined" || typeof Blob === "undefined") return null;
  try {
    const src =
      "var solve = (" +
      powSolveRange.toString() +
      ");\n" +
      "self.onmessage = function (e) {\n" +
      "  var nonce = e.data.nonce, bits = e.data.bits;\n" +
      "  var start = 0;\n" +
      "  for (;;) {\n" +
      `    var c = solve(nonce, bits, start, start + ${CHUNK});\n` +
      "    if (c >= 0) { self.postMessage(c); return; }\n" +
      `    start += ${CHUNK};\n` +
      "    if (start > 1e9) { self.postMessage(-1); return; }\n" +
      "  }\n" +
      "};";
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const worker = new Worker(url);
    return new Promise<number>((resolve, reject) => {
      worker.onmessage = (e) => {
        URL.revokeObjectURL(url);
        worker.terminate();
        const c = e.data as number;
        if (c >= 0) resolve(c);
        else reject(new Error("pow search exhausted"));
      };
      worker.onerror = (err) => {
        URL.revokeObjectURL(url);
        worker.terminate();
        reject(err instanceof ErrorEvent ? new Error(err.message) : new Error("worker error"));
      };
      worker.postMessage({ nonce: challenge.nonce, bits: challenge.bits });
    });
  } catch {
    return null;
  }
}

async function solveOnMainThread(challenge: PowChallenge): Promise<number> {
  // Chunked so the UI stays responsive: yield to the event loop every slice.
  const SLICE = 15_000;
  for (let start = 0; start <= 1e9; start += SLICE) {
    const c = powSolveRange(challenge.nonce, challenge.bits, start, start + SLICE);
    if (c >= 0) return c;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("pow search exhausted");
}

/**
 * Solve the challenge without freezing the UI (worker preferred, chunked
 * main-thread fallback). Resolves to the full solution payload for the mint.
 */
export async function solvePowChallenge(challenge: PowChallenge): Promise<PowSolution> {
  let counter: number;
  const viaWorker = solveInWorker(challenge);
  if (viaWorker) {
    try {
      counter = await viaWorker;
    } catch {
      counter = await solveOnMainThread(challenge);
    }
  } else {
    counter = await solveOnMainThread(challenge);
  }
  return {
    nonce: challenge.nonce,
    counter,
    sig: challenge.sig,
    exp: challenge.exp,
    bits: challenge.bits,
  };
}

// ---------------------------------------------------------------------------
// Fingerprint (best-effort signal, NOT identity). Canvas + WebGL vendor +
// font metrics + hardware/locale hints, hashed to one stable id. Anti-detect
// browsers defeat this by design; it exists to make bulk minting from one
// device cost more, and the server only ever rate-limits on it.
// ---------------------------------------------------------------------------

function canvasComponent(): string {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 220;
    canvas.height = 40;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "no-2d";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#f2a";
    ctx.fillRect(2, 2, 60, 20);
    ctx.fillStyle = "#0a7";
    ctx.font = "13px Arial";
    ctx.fillText("walletchi \u{1F95A}\u{1F43E} den 42", 4, 24);
    ctx.strokeStyle = "rgba(120,40,200,0.6)";
    ctx.beginPath();
    ctx.arc(180, 20, 14, 0.4, 5.1);
    ctx.stroke();
    return canvas.toDataURL();
  } catch {
    return "canvas-err";
  }
}

function webglComponent(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      (canvas.getContext("webgl") as WebGLRenderingContext | null) ??
      (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);
    if (!gl) return "no-webgl";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const renderer = info
      ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return `${vendor}|${renderer}`;
  } catch {
    return "webgl-err";
  }
}

function fontComponent(): string {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return "no-fonts";
    const sample = "mmmWWWlli10@#";
    const widths: string[] = [];
    for (const family of [
      "monospace", "serif", "sans-serif", "Georgia", "Courier New",
      "Comic Sans MS", "Impact", "Trebuchet MS",
    ]) {
      ctx.font = `14px ${family}`;
      widths.push(ctx.measureText(sample).width.toFixed(2));
    }
    return widths.join(",");
  } catch {
    return "fonts-err";
  }
}

async function sha256Hex(text: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // Insecure context fallback: a weak stable hash beats none for a soft signal.
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return `djb2-${(h >>> 0).toString(16)}`;
  }
}

/** Best-effort stable device id (64-hex). Never throws. */
export async function collectFingerprint(): Promise<string> {
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const parts = [
      canvasComponent(),
      webglComponent(),
      fontComponent(),
      String(nav.hardwareConcurrency ?? ""),
      String(nav.deviceMemory ?? ""),
      Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
      `${screen.width}x${screen.height}x${screen.colorDepth}@${window.devicePixelRatio}`,
      (nav.languages ?? []).join(","),
      nav.platform ?? "",
    ];
    return await sha256Hex(parts.join("::"));
  } catch {
    return "fp-unavailable";
  }
}

/** Naive-automation tells. High-confidence ones (webdriver) hard-block server-side. */
export function collectBotSignals(): Record<string, unknown> {
  try {
    const nav = navigator as Navigator & { webdriver?: boolean };
    const signals: Record<string, unknown> = {};
    if (nav.webdriver === true) signals.webdriver = true;
    if (!nav.languages || nav.languages.length === 0) signals.noLanguages = true;
    if (/HeadlessChrome|PhantomJS|SlimerJS|Electron/i.test(nav.userAgent)) signals.headlessUA = true;
    signals.plugins = navigator.plugins?.length ?? 0;
    signals.touch = "ontouchstart" in window;
    return signals;
  } catch {
    return {};
  }
}
