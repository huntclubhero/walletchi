// Account-abstraction config for the trustless care flow. The care action is a gas-sponsored,
// owner-signed UserOp: the user's Privy embedded wallet signs care(), EIP-7702 delegates it to an
// Alchemy Smart Wallet at send time (no migration), and the Alchemy Gas Manager policy sponsors the
// gas. These two values come from JP's Alchemy setup (an app for Robinhood Chain + a Gas Manager
// policy linked to it). Until both are set, AA_CARE_ENABLED is false and the care UI stays gated,
// exactly like PRIVY_ENABLED / SELF_CUSTODY_ENABLED in lib/privy.ts.
import { PRIVY_ENABLED } from "./privy";
import { PETVAULT_ADDRESS } from "./care";

// Alchemy Wallet APIs key (the app the Gas Manager policy is linked to). Public: it only authorizes
// bundler/paymaster reads scoped by the policy, never a spend of user funds.
export const ALCHEMY_API_KEY = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY?.trim() || "";

// Alchemy Gas Manager sponsorship policy id (not a secret). The policy MUST be linked to the app
// behind ALCHEMY_API_KEY or sponsorship will not fire.
export const GAS_POLICY_ID = process.env.NEXT_PUBLIC_GAS_POLICY_ID?.trim() || "";

// Trustless gasless care is live only when Privy is on AND both Alchemy values are present. Flipping
// this on is the whole "retire the relayer" cutover: the pass links point at the AA care page and the
// server stops relaying cares.
// Also require the PetVault address: without it careCall() throws only at click time, so the page would
// render a live "ready" state and fail on tap. Gating here keeps the flow all-or-nothing.
export const AA_CARE_ENABLED =
  PRIVY_ENABLED && ALCHEMY_API_KEY.length > 0 && GAS_POLICY_ID.length > 0 && PETVAULT_ADDRESS.length > 0;
