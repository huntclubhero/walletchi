// Alchemy Gas Manager sponsorship webhook (custom rules).
//
// This is a SEPARATE endpoint from the retired /api/pet/care relay (which returns
// 410 care_moved). Alchemy POSTs here BEFORE sponsoring each user operation and
// we return an approval decision. It restricts sponsorship to five shapes, each
// with its own authorization: care(uint256,uint8) -> our PetVault (owner or
// approved carer), the pinned setCarer(id, 0x0, 0) arming bootstrap (owner), an
// owner's withdraw from their pet's account to themselves, an owner's CARE
// top-up from their wallet into their own pet's account, and a PREPARED GIFT
// transfer (owner, matching a server-recorded intent; see runner/gift.ts).
// Everything else is denied.
//
// The account-abstraction care flow sends the owner's smart account an
// execute(target, value, data) / executeBatch(calls) userOp, so we decode that
// wrapper and inspect the inner target + selector.
//
// Alchemy webhook contract:
//   POST { userOperation: { callData, ... }, policyId, chainId, webhookData }
//   -> 200 { approved: boolean }
// The policy's "Sponsor on error or timeout" MUST be OFF so an endpoint outage
// fails CLOSED (an error must not mean "sponsor everything").
//
// This is a MAINNET hardening: on testnet the policy spend caps already bound
// abuse, so the endpoint can be deployed inert (nothing calls it) until a policy
// custom-rules webhook is pointed at it.
import type { Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeFunctionData, slice, getAddress, createPublicClient, http, defineChain, type Hex } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { giftSponsorVerdict } from "./gift.js";

// care(uint256,uint8) selector. Keep in lockstep with the web care client.
const CARE_SELECTOR = "0x966664bd";
// setCarer(uint256,address,uint64). THE ARMING BOOTSTRAP, and it is sponsorable
// in exactly ONE harmless shape: setCarer(tokenId, address(0), 0), a revoke.
//
// WHY THIS IS NEEDED AT ALL. One-tap care is granted by wallet_createSession,
// which Alchemy refuses for an account that is not yet EIP-7702 delegated, and
// the delegation only lands on that account's FIRST sponsored op. Before the
// sellout there is no care() to spend (the vault refuses every one), so a
// brand-new keeper had no way to delegate, could not be granted a session, and
// was therefore guaranteed to be sent to the website on their first tap: the
// exact thing one-tap care exists to prevent. setCarer carries no season gate
// (the vault says so explicitly), is owner-only on-chain, and revoking a carer
// a fresh pet has never had changes nothing.
const SET_CARER_SELECTOR = "0x1ca74cdf";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// ERC-721 transferFrom(address,address,uint256) and safeTransferFrom(address,address,uint256):
// the two 3-argument transfer shapes a PREPARED GIFT may take. The 4-argument safeTransferFrom
// (with data) is not one of them: the site never sends it, and there is no reason to fund it.
const TRANSFER_FROM_SELECTOR = "0x23b872dd";
const SAFE_TRANSFER_FROM_SELECTOR = "0x42842e0e";
// A legitimate sponsored care is a single call. Anything beyond a handful is either a bug
// or someone using our deny path as a free RPC amplifier.
const MAX_BATCH_CALLS = 8;

const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    outputs: [],
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "payable",
    outputs: [],
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
  },
] as const;

const CARE_ARGS_ABI = [
  {
    type: "function",
    name: "care",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "actionType", type: "uint8" },
    ],
    outputs: [],
  },
] as const;

const OWNER_ABI = [
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

// The pet ACCOUNT's own execute(to, value, data, operation) [4-arg], the ERC-20 transfer, and the
// ERC-6551 token() view, used to authorize a gasless WITHDRAW (an owner sweeping their pet's CARE /
// USDG rewards to themselves). Distinct from the owner smart-account's 3-arg execute above.
const ACCOUNT_EXECUTE4_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    outputs: [{ type: "bytes" }],
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
    ],
  },
] as const;

const TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const TOKEN_6551_ABI = [
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "chainId", type: "uint256" },
      { name: "tokenContract", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
  },
] as const;

// PetIssuer.accountOf(tokenId): the registry-derived ERC-6551 account of a pet. The authoritative
// answer to "is this address really that pet's account", unlike token(), which the target reports.
const ISSUER_ACCOUNT_ABI = [
  { type: "function", name: "accountOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

// Authorize a gasless WITHDRAW: the outer op is execute(petTBA, 0, <petTBA.execute(token,0,transfer(to,amt),0)>).
// Sponsor ONLY when: the inner target is CARE or USDG, the transfer pays the SENDER (owner sweeps to
// self, never elsewhere), the TBA is one of OUR pet accounts (its 6551 token() names our Pet721 AND the
// issuer's accountOf for that token is this very address; token() alone is reported by the target, so
// a contract of the caller's choosing could claim it), and the SENDER is the current owner of that pet.
// On-chain execute() is owner-gated anyway, so this just stops us paying for ops that would revert
// (the same griefing guard as care).
async function ownerWithdrawOk(sender: string, tba: string, innerCallData: Hex): Promise<boolean> {
  const care = config.CARE_TOKEN_ADDRESS?.toLowerCase();
  const usdg = config.FEE_TOKEN_ADDRESS?.toLowerCase();
  const pet721 = config.pet721Address?.toLowerCase();
  const issuer = config.RUNNER_ISSUER_ADDRESS;
  if (!pet721 || !issuer) return false;
  let inner;
  try {
    inner = decodeFunctionData({ abi: ACCOUNT_EXECUTE4_ABI, data: innerCallData });
  } catch {
    return false;
  }
  if (inner.functionName !== "execute") return false;
  const [innerTarget, value, transferData, operation] = inner.args as [string, bigint, Hex, number];
  if (value !== 0n || Number(operation) !== 0) return false;
  let it: string;
  try {
    it = getAddress(innerTarget).toLowerCase();
  } catch {
    return false;
  }
  if (it !== care && it !== usdg) return false;
  let xfer;
  try {
    xfer = decodeFunctionData({ abi: TRANSFER_ABI, data: transferData });
  } catch {
    return false;
  }
  if (xfer.functionName !== "transfer") return false;
  let to: string;
  try {
    to = getAddress(xfer.args[0] as string).toLowerCase();
  } catch {
    return false;
  }
  if (to !== sender) return false; // must sweep to the owner, never elsewhere
  return isSendersPetAccount(sender, tba);
}

// True only when `tba` is one of OUR pet accounts AND `sender` owns that pet: its 6551 token() names
// our Pet721, the issuer's accountOf for that token is this very address (token() alone is reported by
// the target, so a contract of the caller's choosing could claim it), and ownerOf is the sender.
// Fails closed on any read error or missing config.
async function isSendersPetAccount(sender: string, tba: string): Promise<boolean> {
  const pet721 = config.pet721Address?.toLowerCase();
  const issuer = config.RUNNER_ISSUER_ADDRESS;
  if (!pet721 || !issuer) return false;
  try {
    const client = readClient();
    const tok = (await client.readContract({
      address: getAddress(tba),
      abi: TOKEN_6551_ABI,
      functionName: "token",
      args: [],
    })) as readonly [bigint, string, bigint];
    if (getAddress(tok[1]).toLowerCase() !== pet721) return false; // not one of our pet accounts
    const owner = await client.readContract({
      address: getAddress(config.pet721Address as string),
      abi: OWNER_ABI,
      functionName: "ownerOf",
      args: [tok[2]],
    });
    if (String(owner).toLowerCase() !== sender) return false;
    const account = await client.readContract({
      address: getAddress(issuer),
      abi: ISSUER_ACCOUNT_ABI,
      functionName: "accountOf",
      args: [tok[2]],
    });
    return getAddress(String(account)).toLowerCase() === getAddress(tba).toLowerCase();
  } catch {
    return false;
  }
}

// Authorize a gasless TOP-UP (2026-10-15, after No. 0091 nearly starved with 2,499 CARE in the
// keeper's wallet): the outer op is execute(CARE, 0, transfer(petTBA, amount)), the owner putting CARE
// from their own wallet back into their own pet so it can be fed. Sponsor ONLY when the target is CARE
// (never USDG or anything else), the recipient is a genuine pet account, and the SENDER owns that pet.
// The owner spends only their own tokens, so the guard here is the same as withdraw: never pay for a
// stranger's op or a transfer to an address that is not one of the sender's pets.
async function ownerTopUpOk(sender: string, target: string, data: Hex): Promise<boolean> {
  const care = config.CARE_TOKEN_ADDRESS?.toLowerCase();
  if (!care) return false;
  try {
    if (getAddress(target).toLowerCase() !== care) return false;
  } catch {
    return false;
  }
  let xfer;
  try {
    xfer = decodeFunctionData({ abi: TRANSFER_ABI, data });
  } catch {
    return false;
  }
  if (xfer.functionName !== "transfer") return false;
  const [to, amount] = xfer.args as readonly [string, bigint];
  if (amount <= 0n) return false;
  return isSendersPetAccount(sender, to);
}

const CARER_ABI = [
  { type: "function", name: "carerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

const ERC721_TRANSFER_ARGS_ABI = [
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    outputs: [],
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    outputs: [],
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
  },
] as const;

/**
 * The (from, to, tokenId) of a GIFT TRANSFER call on our Pet721, or null if this is not one.
 *
 * Shape only; permission is decided in the webhook body. Narrow on purpose: the target must be
 * the configured token contract and the selector one of the two 3-argument ERC-721 transfers.
 * Any other call on the token (approve, setApprovalForAll, setPayoutAddress, the 4-argument
 * safeTransferFrom) stays unfunded: none of them is something the product ever asks a keeper to
 * sign, and approvals in particular would let a sponsored op hand the pet to an operator.
 */
function giftTransferArgs(target: string, data: Hex): { from: string; to: string; tokenId: bigint } | null {
  const pet721 = config.pet721Address;
  if (!pet721) return null;
  try {
    if (getAddress(target) !== getAddress(pet721)) return null;
  } catch {
    return null;
  }
  if (!data || data.length < 10) return null;
  const selector = slice(data, 0, 4).toLowerCase();
  if (selector !== TRANSFER_FROM_SELECTOR && selector !== SAFE_TRANSFER_FROM_SELECTOR) return null;
  try {
    const d = decodeFunctionData({ abi: ERC721_TRANSFER_ARGS_ABI, data });
    const [from, to, tokenId] = d.args as readonly [string, string, bigint];
    return { from: String(from).toLowerCase(), to: String(to).toLowerCase(), tokenId };
  } catch {
    return null;
  }
}

// WHY THIS EXISTS: without it we PAY FOR THE ATTACK. Checking only "is this shaped like a care() to
// our vault" means we sponsor a force-care from ANYONE against ANY pet. The vault rejects the call, so
// nothing is stolen, but the gas is spent from our policy either way, and that is the whole reason
// griefing is +EV here: the griefer's cost basis is zero because we cover it. Worse, once the policy
// budget is drained, gasless care stops for real keepers and their pets starve, so an availability
// attack costs the attacker nothing at all.
//
// So: sponsor a care only when the sender is actually allowed to make it, which is the pet's owner or
// the carer that owner approved on-chain. Reads are cached briefly because a stale read can only cause
// us to sponsor an op the vault then rejects, which is exactly the status quo we are improving on.
const AUTH_TTL_MS = 15_000;
const authCache = new Map<string, { owner: string; carer: string; at: number }>();

// TEST SEAM (check scripts only, same `_`-prefixed convention as the MockChain setters and
// _setPrivyClientForTests). The webhook reads ownership straight from the chain through its own
// viem client, not through the AppContext relayer, so without this the approval rules could only
// be exercised against a live RPC. Set from inside the process by an import; nothing on the
// request path can reach it. Also clears the read cache so a scenario's owner change is seen.
type AuthorizationReader = (tokenId: bigint) => Promise<{ owner: string; carer: string } | null>;
let authorizationReaderOverride: AuthorizationReader | null = null;
export function _setAuthorizationReaderForTests(reader: AuthorizationReader | null): void {
  authorizationReaderOverride = reader;
  authCache.clear();
}

// TEST SEAM (check scripts only): replaces the viem client for this module's chain reads (the withdraw
// rule has no reader seam of its own; authorizedCarers uses it too unless an authorization reader is set).
let readClientOverride: ReturnType<typeof makeReadClient> | null = null;
export function _setReadClientForTests(client: ReturnType<typeof makeReadClient> | null): void {
  readClientOverride = client;
}

function readClient() {
  return readClientOverride ?? makeReadClient();
}

function makeReadClient() {
  const rh = config.robinhood;
  return createPublicClient({
    chain: defineChain({
      id: rh.chainId,
      name: `Robinhood ${config.ROBINHOOD_NETWORK}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rh.rpcUrl] } },
    }),
    transport: http(),
  });
}

/** The addresses currently permitted to care for `tokenId`, or null when we cannot tell. */
async function authorizedCarers(tokenId: bigint): Promise<{ owner: string; carer: string } | null> {
  if (authorizationReaderOverride) {
    const read = await authorizationReaderOverride(tokenId);
    return read ? { owner: read.owner.toLowerCase(), carer: read.carer.toLowerCase() } : null;
  }
  const pet721 = config.pet721Address;
  const vault = config.PETVAULT_ADDRESS;
  if (!pet721 || !vault) return null;
  const key = tokenId.toString();
  const hit = authCache.get(key);
  if (hit && Date.now() - hit.at < AUTH_TTL_MS) return { owner: hit.owner, carer: hit.carer };
  try {
    const client = readClient();
    const [owner, carer] = await Promise.all([
      client.readContract({ address: pet721 as `0x${string}`, abi: OWNER_ABI, functionName: "ownerOf", args: [tokenId] }),
      // carerOf only exists on vaults built from the carer-registry release; an older vault simply has
      // no delegated carer, so treat a revert as "no carer" rather than as an error.
      client
        .readContract({ address: vault as `0x${string}`, abi: CARER_ABI, functionName: "carerOf", args: [tokenId] })
        .catch(() => "0x0000000000000000000000000000000000000000" as const),
    ]);
    const out = { owner: String(owner).toLowerCase(), carer: String(carer).toLowerCase() };
    if (authCache.size > 4000) authCache.clear();
    authCache.set(key, { ...out, at: Date.now() });
    return out;
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 160), tokenId: key }, "gas sponsorship: authorization read failed");
    return null;
  }
}

const SET_CARER_ARGS_ABI = [
  {
    type: "function",
    name: "setCarer",
    stateMutability: "nonpayable",
    outputs: [],
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "carer", type: "address" },
      { name: "expiresAt", type: "uint64" },
    ],
  },
] as const;

/**
 * The tokenId of an ARMING BOOTSTRAP call, or null if this is not one.
 *
 * Deliberately narrow: only `setCarer(tokenId, address(0), 0)` on the configured
 * vault qualifies. Sponsoring setCarer in general would let an owner hand a
 * carer seat to an arbitrary address on our gas, and repeatedly; pinning both
 * arguments makes the only sponsorable form a no-op whose sole side effect is
 * the 7702 delegation we are actually paying for. The caller still has to prove
 * ownership below, exactly like a care.
 */
function armBootstrapTokenId(target: string, data: Hex): bigint | null {
  if (!config.PETVAULT_ADDRESS) return null;
  try {
    if (getAddress(target) !== getAddress(config.PETVAULT_ADDRESS)) return null;
  } catch {
    return null;
  }
  if (!data || data.length < 10) return null;
  if (slice(data, 0, 4).toLowerCase() !== SET_CARER_SELECTOR) return null;
  try {
    const d = decodeFunctionData({ abi: SET_CARER_ARGS_ABI, data });
    if (d.functionName !== "setCarer") return null;
    const [tokenId, carer, expiresAt] = d.args as [bigint, string, bigint];
    if (String(carer).toLowerCase() !== ZERO_ADDRESS) return null;
    if (BigInt(expiresAt) !== 0n) return null;
    return tokenId;
  } catch {
    return null;
  }
}

/** The tokenId a care() call targets, or null if the calldata is not a care(). */
function careTokenId(data: Hex): bigint | null {
  try {
    const d = decodeFunctionData({ abi: CARE_ARGS_ABI, data });
    return d.functionName === "care" ? (d.args[0] as bigint) : null;
  } catch {
    return null;
  }
}

// True only for a call that is care(uint256,uint8) -> the configured PetVault.
function isCareToVault(target: string, data: Hex): boolean {
  if (!config.PETVAULT_ADDRESS) return false;
  try {
    if (getAddress(target) !== getAddress(config.PETVAULT_ADDRESS)) return false;
  } catch {
    return false; // unparseable address
  }
  if (!data || data.length < 10) return false; // need at least a 4-byte selector
  return slice(data, 0, 4).toLowerCase() === CARE_SELECTOR;
}

// Mount with a RAW body parser (before the global express.json) so the exact
// bytes Alchemy signed are available for HMAC verification:
//   app.use("/api/gas-sponsorship/webhook", express.raw({ type: "*/*" }), gasSponsorWebhook)
export async function gasSponsorWebhook(req: Request, res: Response): Promise<void> {
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  // Fail CLOSED: any deny (bad signature, wrong chain, not-care) returns
  // { approved: false } with HTTP 200 so Alchemy records a clean rejection.
  // `extra` carries the observed selector etc. so an unexpected userOp shape is
  // identifiable from one log line instead of guessing at the calldata format.
  const deny = (reason: string, extra: Record<string, unknown> = {}): void => {
    logger.warn({ reason, ...extra }, "gas sponsorship webhook: deny");
    res.status(200).json({ approved: false });
  };
  const approve = (extra: Record<string, unknown> = {}): void => {
    logger.info({ ...extra }, "gas sponsorship webhook: approve");
    res.status(200).json({ approved: true });
  };
  try {
    // 1) Authenticate the caller as Alchemy (only when a signing key is set).
    //
    // FAIL-OPEN BY DESIGN, AND DELIBERATELY LEFT THAT WAY. With no key this check is skipped
    // and the endpoint is anonymous. That is not silent any more: config.ts now emits a loud
    // [BOOT GUARD] startup ERROR whenever real value is at stake and this key is unset, and
    // refuses to boot outright on mainnet. It is NOT enforced here because this webhook
    // APPROVING is what lets keepers feed their pets: denying unsigned calls on a live season
    // whose key was never set would starve every pet on the chain. The remaining checks below
    // (chain id, care()/withdraw-only calldata, and an on-chain authorization read) are what
    // actually constrain an anonymous caller, and they all fail closed.
    const key = config.GAS_WEBHOOK_SIGNING_KEY;
    if (key) {
      const provided = String(req.header("x-alchemy-signature") || "");
      let got: Buffer;
      try {
        got = Buffer.from(provided, "hex");
      } catch {
        return deny("unparseable signature");
      }
      const want = createHmac("sha256", key).update(raw).digest();
      if (got.length !== want.length || !timingSafeEqual(got, want)) return deny("bad signature");
    }

    // 2) Parse the payload.
    let body: { userOperation?: { callData?: Hex }; chainId?: number | string };
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return deny("invalid json");
    }

    // 3) This chain only.
    if (Number(body.chainId) !== config.robinhood.chainId) return deny(`wrong chainId ${body.chainId}`);

    // 4) Only care() -> PetVault (single execute or every call in an executeBatch).
    const callData = body.userOperation?.callData;
    if (!callData) return deny("no callData");
    const selector = callData.length >= 10 ? callData.slice(0, 10).toLowerCase() : "short";
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: callData });
    } catch {
      // Not the account's execute/executeBatch wrapper (delegate exposes
      // execute 0xb61d27f6 + executeBatch 0x34fcd5be). Log the selector so an
      // unexpected wrapper is a known quantity, not a guess.
      return deny("callData is not execute/executeBatch", { selector });
    }
    // Sender is needed for both the withdraw check and the care authorization.
    const sender = String((body.userOperation as { sender?: string } | undefined)?.sender ?? "").toLowerCase();
    if (!sender) return deny("no sender in userOperation", { selector });

    // 4a) WITHDRAW: a single execute to a pet TBA sweeping CARE/USDG to the owner. Approve straight
    // away when it checks out (owner sweeping their own pet to themselves); it is not a care op.
    if (decoded.functionName === "execute") {
      const [target, , data] = decoded.args as [string, bigint, Hex];
      if (!isCareToVault(target, data)) {
        // PREPARED GIFT: transferFrom(from, to, tokenId) on our Pet721, funded ONLY when the
        // sender is the pet's current owner, `from` is that sender, and (tokenId, from, to) is
        // exactly an intent the owner prepared through POST /api/pet/:id/gift/prepare inside its
        // window, at most GIFT_SPONSOR_MAX_PER_HOUR times per pet. The shape alone is never
        // enough: "any transferFrom on our token" would fund a stranger's op the token reverts
        // (not the owner), or an owner's op to a recipient the server never heard of, and the
        // pet's seller-side clean-up (session revoke, keepsake) keys on the intent. The
        // ownership read comes first so a stranger cannot spend the owner's hourly window.
        const gift = giftTransferArgs(target, data);
        if (gift !== null) {
          const idStr = gift.tokenId.toString();
          if (gift.from !== sender) {
            return deny("gift transfer is not from the sender", { tokenId: idStr, sender, from: gift.from });
          }
          const auth = await authorizedCarers(gift.tokenId);
          if (!auth) return deny("authorization unavailable", { tokenId: idStr });
          if (sender !== auth.owner) {
            return deny("gift transfer by a non-owner", { tokenId: idStr, sender, owner: auth.owner });
          }
          const reason = giftSponsorVerdict({ tokenId: idStr, from: gift.from, to: gift.to });
          if (reason !== null) return deny(reason, { tokenId: idStr, sender, to: gift.to });
          return approve({ kind: "gift", tokenId: idStr, sender, to: gift.to });
        }
        if (await ownerWithdrawOk(sender, target, data)) {
          return approve({ kind: "withdraw", selector, sender });
        }
        if (await ownerTopUpOk(sender, target, data)) {
          return approve({ kind: "top-up", selector, sender });
        }
        // ARMING BOOTSTRAP: the one non-care op we fund, and only for the pet's
        // OWNER. Same authorization bar as a care, for the same reason: shape is
        // not permission, and paying for a call the vault will reject is exactly
        // how a griefer drains the policy at zero cost to themselves.
        const armId = armBootstrapTokenId(target, data);
        if (armId !== null) {
          const auth = await authorizedCarers(armId);
          if (!auth) return deny("authorization unavailable", { tokenId: armId.toString() });
          if (sender !== auth.owner) {
            return deny("arming bootstrap by a non-owner", { tokenId: armId.toString(), sender });
          }
          return approve({ kind: "arm-bootstrap", tokenId: armId.toString(), sender });
        }
        return deny("not care()->vault, owner-withdraw, owner top-up, arming bootstrap or prepared gift", {
          selector,
          fn: decoded.functionName,
        });
      }
      // else: it IS care() -> vault; fall through to the care authorization below.
    } else {
      // executeBatch is care-only.
      const calls = decoded.args[0] as readonly { target: string; value: bigint; data: Hex }[];
      if (!(calls.length > 0 && calls.every((c) => isCareToVault(c.target, c.data)))) {
        return deny("not care() -> PetVault", { selector, fn: decoded.functionName });
      }
    }

    // 5) CARE AUTHORIZATION. Shape is not permission: only sponsor a care the sender may actually make.
    const targets: Hex[] =
      decoded.functionName === "execute"
        ? [(decoded.args as [string, bigint, Hex])[2]]
        : (decoded.args[0] as readonly { data: Hex }[]).map((c) => c.data);
    // BOUND THE WORK. This endpoint is reachable anonymously when no signing key is set,
    // and a 256 KB executeBatch can hold thousands of calls. Each one used to drive its own
    // pair of sequential RPC reads, and cycling distinct made-up tokenIds defeats the cache
    // entirely, so a denied request still cost us the reads. A real care op is one call.
    if (targets.length > MAX_BATCH_CALLS) {
      return deny("batch too large", { selector, calls: targets.length });
    }
    const tokenIds = new Set<string>();
    for (const d of targets) {
      const t = careTokenId(d);
      if (t === null) return deny("care calldata not decodable", { selector });
      tokenIds.add(t.toString());
    }
    if (tokenIds.size > MAX_BATCH_CALLS) return deny("too many distinct pets", { selector });
    for (const idStr of tokenIds) {
      const tokenId = BigInt(idStr);
      const auth = await authorizedCarers(tokenId);
      // Fail CLOSED, consistent with the rest of this endpoint: if we cannot establish who may care,
      // we do not pay. A keeper retries; a griefer gets nothing funded.
      if (!auth) return deny("authorization unavailable", { tokenId: tokenId.toString() });
      if (sender !== auth.owner && (auth.carer === ZERO_ADDRESS || sender !== auth.carer)) {
        return deny("sender is neither owner nor approved carer", {
          tokenId: tokenId.toString(),
          sender,
        });
      }
    }

    return approve({ selector, fn: decoded.functionName, sender });
  } catch (e) {
    return deny("exception " + String(e).slice(0, 120));
  }
}
