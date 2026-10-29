import { createPublicClient, http, type Address, type Hex } from "viem";
import { robinhoodChain } from "./chain";
import { fetchLiveChainConfig, liveVaultAddress } from "./chain-config";
import { getCareSessionStatus, installCareSession, reportArming } from "./api";
import { bootstrapDelegation, isDelegated, sponsoredCare, type AaSigner } from "./aa";
import { grantCareSession } from "./session";
import { aaErrorDetail } from "./aa-errors";

// ONE-TAP ARMING, shared by every place an owner is signed in: the mint page (right after the pet is
// minted), the care page a pass tap lands on, and /me. The promise is that a keeper is sent to a
// website at most once. So a pet that is not armed must get armed the first time its owner is signed
// in ANYWHERE, not only in the one window right after mint.
//
// THE 2026-09-23 FAILURE THIS EXISTS FOR ("Pretzel", pet 2). Mint-time arming ran exactly once, a
// second after the mint landed, and died inside our own 7702 signer: Alchemy had moved fresh wallets
// to a newer SemiModularAccount7702 delegate (0x77021100...), our allowlist knew only the old one, and
// the signer refused ("unexpected delegate"). Fixed in 5def341. But the failure also exposed three
// gaps that would turn the NEXT arming failure, whatever its cause, into the same dead end:
//   1. NOTHING RETRIED. Arming had one shot, at mint. This module is also run on every later owner
//      sign-in (the care page a pass tap lands on, /me), so an unarmed pet heals itself.
//   2. NOTHING WAS REPORTED. The error went to console.error on the keeper's phone and nowhere else,
//      so the server logs showed only an absence. Every failure is now beaconed to the server with its
//      stage and the real error detail.
//   3. MINT TIMING WAS A RACE. The first feed is simulated by Alchemy against its own node before any
//      sponsorship is asked for, one second after the mint. Mint mode now waits until the pet is
//      visible to this wallet and retries the feed (a refused simulation costs nothing), re-reading
//      the chain between attempts so a feed that DID land is never sent twice.
// SIGN-IN MODE NEVER HATCHES. It delegates the wallet with the harmless sponsored
// setCarer(tokenId, address(0), 0) the webhook funds in any season, then grants the session.
// Hatching starts the pet's 24h clock, so it only happens when a keeper asked to act: the mint
// (Hunt's "alive the moment it lands" trade) or a care tap.

export type ArmMode = "mint" | "signin";
export type ArmSurface = "mint" | "care" | "me";
export type ArmStage =
  | "armed"
  | "already"
  | "unsupported"
  | "no-token"
  | "not-visible"
  | "not-owner"
  | "feed"
  | "bootstrap"
  | "grant"
  | "install";

export interface ArmResult {
  armed: boolean;
  stage: ArmStage;
  detail?: string;
}

/** Everything armOneTap touches, injected so the orchestration can be tested without a chain. */
export interface ArmDeps {
  /** The server's view: can this deployment arm at all, and is this pet already armed? */
  status(): Promise<{ supported: boolean; active: boolean } | null>;
  accessToken(): Promise<string | null>;
  /** ownerOf(tokenId) on chain, lowercased; null when the token is not visible (yet) or unreadable. */
  ownerOnChain(): Promise<string | null>;
  /** Has the pet been cared for at least once (hatched)? null = unknown. */
  hatchedOnChain(): Promise<boolean | null>;
  isDelegated(): Promise<boolean | null>;
  /** One sponsored care (delegates the wallet AND hatches the pet). Throws on failure. */
  feed(): Promise<void>;
  /** The no-hatch delegation bootstrap. false = not landed. */
  bootstrap(): Promise<boolean>;
  /** Grant the scoped session and install it on the server. true = active. Throws on failure. */
  grantAndInstall(accessToken: string): Promise<boolean>;
  report(stage: ArmStage, detail: string): void;
  sleep(ms: number): Promise<void>;
}

export interface ArmOptions {
  mode: ArmMode;
  owner: string;
  /** How long to wait for the owner read to resolve to this wallet (mint 45s, sign-in 8s). */
  visibleTimeoutMs?: number;
  /** Mint mode: sponsored feed attempts before falling back to the no-hatch bootstrap. */
  feedAttempts?: number;
}

export async function armOneTap(deps: ArmDeps, opts: ArmOptions): Promise<ArmResult> {
  const owner = opts.owner.toLowerCase();
  const fail = (stage: ArmStage, detail: string): ArmResult => {
    deps.report(stage, detail);
    return { armed: false, stage, detail };
  };

  const st = await deps.status();
  if (st && !st.supported) return { armed: false, stage: "unsupported" };
  if (st?.active) return { armed: true, stage: "already" };

  const token = await deps.accessToken();
  if (!token) return fail("no-token", "no Privy access token");

  // The pet must be visible, and owned by this wallet, before anything is signed. At mint that means
  // waiting out node lag. On a later sign-in (the care page, the account page) a single read used to
  // decide it, but a read that fails to RESOLVE (a public-RPC blip, a lagging replica, a 429) comes
  // back null exactly like a missing pet, and was reported as "not visible after 0ms" while the pet
  // was plainly there: the 2026-10-13 launch logs show a keeper hitting that twice from the card
  // within a minute of a successful mint. So an UNRESOLVED read now gets a short grace on every
  // surface. A read that resolves to ANOTHER wallet still fails at once on sign-in (nothing to arm,
  // and the server would refuse the install anyway); at mint it keeps waiting, as before.
  const deadline =
    opts.mode === "mint" ? (opts.visibleTimeoutMs ?? 45_000) : (opts.visibleTimeoutMs ?? 8_000);
  let waited = 0;
  let seenOwner = await deps.ownerOnChain();
  while (seenOwner !== owner && waited < deadline) {
    if (seenOwner !== null && opts.mode !== "mint") break;
    await deps.sleep(1000);
    waited += 1000;
    seenOwner = await deps.ownerOnChain();
  }
  if (seenOwner === null) return fail("not-visible", `pet not visible on chain after ${waited}ms`);
  if (seenOwner !== owner) return fail("not-owner", `owner on chain is ${seenOwner}`);

  let delegated: boolean | null = null;
  if (opts.mode === "mint") {
    const attempts = Math.max(1, opts.feedAttempts ?? 3);
    let lastErr = "";
    for (let i = 0; i < attempts; i++) {
      // Chain first: a feed whose status read failed may have landed anyway, and hatching twice would
      // spend a second care for nothing.
      if ((await deps.hatchedOnChain()) === true) {
        delegated = true;
        break;
      }
      try {
        await deps.feed();
        delegated = true; // the first sponsored op installs the 7702 delegation
        break;
      } catch (err) {
        lastErr = aaErrorDetail(err);
        if (i < attempts - 1) await deps.sleep(2000 * (i + 1));
      }
    }
    if (delegated !== true) {
      // Report the feed failure, then still ARM through the no-hatch path: a pet that hatches on its
      // first pass tap is far better than a pet whose every pass tap opens a website.
      deps.report("feed", lastErr || "feed failed");
    }
  }

  if (delegated !== true) {
    delegated = await deps.isDelegated();
    if (delegated === false) {
      if (!(await deps.bootstrap())) return fail("bootstrap", "delegation bootstrap did not land");
      delegated = true;
    }
  }

  try {
    if (await deps.grantAndInstall(token)) return { armed: true, stage: "armed" };
    return fail("install", "server did not activate the session");
  } catch (err) {
    // Unknown delegation (a failed getCode read) goes straight to the free grant; if that is refused,
    // bootstrap once and grant again. A CONFIRMED-delegated wallet never gets a second op.
    if (delegated === null && (await deps.bootstrap())) {
      try {
        if (await deps.grantAndInstall(token)) return { armed: true, stage: "armed" };
        return fail("install", "server did not activate the session");
      } catch (err2) {
        return fail("grant", aaErrorDetail(err2));
      }
    }
    return fail("grant", aaErrorDetail(err));
  }
}

/**
 * ONE ARMING PER PET AT A TIME, across every caller on the page: the chrome's self-heal, /me, the care
 * page and the mint page can all start within a second of each other. Two concurrent runs would race
 * two bootstraps (the second is refused by the per-wallet latch and would report a false failure) and
 * two session grants. Later callers get the in-flight run's result.
 */
const armInFlight = new Map<string, Promise<ArmResult>>();
export function armOnce(tokenId: string, run: () => Promise<ArmResult>): Promise<ArmResult> {
  const running = armInFlight.get(tokenId);
  if (running) return running;
  const p = run().finally(() => armInFlight.delete(tokenId));
  armInFlight.set(tokenId, p);
  return p;
}

// ------------------------------------------------------------------------------------ live wiring

const OWNER_OF_ABI = [
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
] as const;
const PET_STATE_ABI = [
  {
    type: "function",
    name: "petState",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "registered", type: "bool" },
      { name: "dead", type: "bool" },
      { name: "lastCareAt", type: "uint64" },
      { name: "isAlive", type: "bool" },
      { name: "secondsLeft", type: "uint256" },
    ],
  },
] as const;

/** The real dependencies for a signed-in Privy owner. */
export function liveArmDeps(input: {
  tokenId: string;
  owner: Address;
  signer: AaSigner;
  getAccessToken: () => Promise<string | null>;
  surface: ArmSurface;
}): ArmDeps {
  const pub = createPublicClient({ chain: robinhoodChain, transport: http() });
  const id = BigInt(input.tokenId);
  return {
    status: () => getCareSessionStatus(input.tokenId),
    accessToken: () => input.getAccessToken().catch(() => null),
    ownerOnChain: async () => {
      try {
        const pet = (await fetchLiveChainConfig())?.pet721;
        if (!pet) return null;
        const o = await pub.readContract({ address: pet as Address, abi: OWNER_OF_ABI, functionName: "ownerOf", args: [id] });
        return (o as string).toLowerCase();
      } catch {
        return null;
      }
    },
    hatchedOnChain: async () => {
      try {
        const vault = await liveVaultAddress();
        if (!vault) return null;
        const s = (await pub.readContract({ address: vault, abi: PET_STATE_ABI, functionName: "petState", args: [id] })) as readonly [boolean, boolean, bigint, boolean, bigint];
        return s[2] > 0n;
      } catch {
        return null;
      }
    },
    isDelegated: () => isDelegated(input.owner),
    feed: async () => {
      const res = await sponsoredCare(input.signer, id, "feed");
      if (res.status !== "success") throw new Error(`feed did not succeed (${res.txHash as Hex})`);
    },
    bootstrap: async () => {
      const vault = await liveVaultAddress();
      if (!vault) return false;
      return bootstrapDelegation(input.signer, id, vault);
    },
    grantAndInstall: async (token) => {
      const grant = await grantCareSession(input.signer, input.owner);
      const installed = await installCareSession(input.tokenId, grant, token);
      return Boolean(installed.active);
    },
    report: (stage, detail) => {
      console.error(`[walletchi] one-tap arming failed at ${stage}:`, detail);
      void reportArming(input.tokenId, { surface: input.surface, stage, detail, owner: input.owner });
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
