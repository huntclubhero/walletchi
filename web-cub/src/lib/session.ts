// ONE-TAP CARE: the single owner signature that turns every later wallet-pass tap into a silent,
// gasless care with no website and no prompt.
//
// THE MODEL (on-chain, server-held). The owner signs ONE Alchemy MAv2 grant (ERC-7715
// `functions-on-contract`) that scopes a freshly generated session key to care(uint256,uint8) on the
// PetVault and NOTHING else. The key + the grant's permissions context go to our server, which submits
// every later care with it. The pass link then feeds the pet directly: no website, no signature.
//
// WHY NOT BROWSER-LOCAL (the previous attempt, reverted at f95ee52): a wallet pass opens its links in an
// in-app browser with isolated, ephemeral storage, so a localStorage session key did not survive tap to
// tap. It re-granted every time and fell back to an owner signature on every feed. An on-chain permission
// has no storage dependency, which is exactly why this version works.
//
// GRIEF-NOT-THEFT, CHAIN-ENFORCED: the scope lives in the smart account's validation hooks, not in our
// server code, so the held key can only ever FEED. It cannot transfer the pet NFT, and it cannot move the
// pet's tokens anywhere except through the game's own burn/pot split. PROVEN on Robinhood testnet 46630
// (2026-08-12): the same session key attempting an NFT transferFrom is rejected at UserOp validation with
// PreUserOpValidationHookReverted(AddressNotAllowed()). That makes this strictly SAFER than the retired
// unrestricted care relayer it replaces. The honest ceiling is "force-care every cooldown until the pet's
// whole stake is burned and it starves": total loss of the stake, but never theft.
//
// DELEGATION ORDER MATTERS: Alchemy refuses wallet_createSession for an EOA that is not yet EIP-7702
// delegated ("7702 account must be delegated before calling `wallet_createSession`"). The delegation is
// installed by the wallet's FIRST sponsored op, so the caller must land one owner-signed sponsoredCare
// before granting. CareClient does exactly that: the feed you came to do IS the delegation step.
import { createSmartWalletClient, alchemyWalletTransport } from "@alchemy/wallet-apis";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { ALCHEMY_API_KEY, GAS_POLICY_ID } from "./aa-config";
import { robinhoodChain } from "./chain";
import { liveVaultAddress } from "./chain-config";
import type { AaSigner } from "./aa";

// care(uint256,uint8) selector: the ONLY function the session key may call. All five care actions
// (FEED/WATER/PLAY/TOY/EXPLORE) are this one selector with a different actionType byte, so one permission
// entry covers the whole game.
const CARE_SELECTOR = "0x966664bd" as Hex;

// Grant lifetime. The server clamps this to its own CARE_SESSION_TTL_HOURS ceiling, and the care page
// re-grants transparently once it lapses.
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

export interface GrantedCareSession {
  sessionKey: Hex; // the raw session private key (handed to our server, which seals it at rest)
  publicKey: Address; // its address, so the server can verify the two halves match
  context: Hex; // Alchemy permissions context (opaque; resolves to the on-chain deferred action)
  expiresAtSec: number;
}

// Have the owner sign the ONE grant. Returns the material to POST to the server. Throws if the wallet is
// not yet 7702 delegated (send one sponsoredCare first) or if AA is not configured.
export async function grantCareSession(ownerSigner: AaSigner, owner: Address): Promise<GrantedCareSession> {
  // The LIVE season's vault: the grant's scope must name the vault the pass
  // taps will actually call, or every one-tap care reverts against a dead
  // address (the 2026-08-26 stale-bundle failure).
  const vault = await liveVaultAddress();
  if (!ALCHEMY_API_KEY || !GAS_POLICY_ID || !vault) {
    throw new Error("account abstraction is not configured");
  }
  const ownerClient = createSmartWalletClient({
    signer: ownerSigner,
    transport: alchemyWalletTransport({ apiKey: ALCHEMY_API_KEY }),
    chain: robinhoodChain,
    paymaster: { policyId: GAS_POLICY_ID },
  });
  const sessionKey = generatePrivateKey();
  const account = privateKeyToAccount(sessionKey);
  const expiresAtSec = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const permissions = await ownerClient.grantPermissions({
    account: owner,
    expirySec: expiresAtSec,
    key: { publicKey: account.address, type: "secp256k1" },
    permissions: [
      // ONLY care() on the PetVault. Not "root": the scope IS the safety property.
      { type: "functions-on-contract", data: { address: vault as Address, functions: [CARE_SELECTOR] } },
    ],
  });
  return { sessionKey, publicKey: account.address, context: permissions.context, expiresAtSec };
}
