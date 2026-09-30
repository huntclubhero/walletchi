"use client";

import type { ReactNode } from "react";
import { usePrivy, useLoginWithEmail, useCreateWallet, useWallets, useSign7702Authorization } from "@privy-io/react-auth";
import { privyWalletToSigner, type AaSigner, type Sign7702Authorization } from "@/lib/aa";
import { fetchLiveChainConfig } from "@/lib/chain-config";
import { armOnce, armOneTap, liveArmDeps, type ArmMode, type ArmResult, type ArmSurface } from "@/lib/arming";
import type { Address } from "viem";
import { PRIVY_ENABLED } from "@/lib/privy";

/** Privy's headless email-OTP flow states (sendCode -> loginWithCode). */
export type OtpStatus =
  | "initial"
  | "sending-code"
  | "awaiting-code-input"
  | "submitting-code"
  | "done"
  | "error";

/**
 * The one safe doorway to Privy hooks. usePrivy throws without a provider, and
 * the provider only mounts when the app id is configured, so components never
 * call the hook directly: they render through PrivyGate, which falls back
 * cleanly (default: nothing) when Privy is not configured.
 */
export interface PrivySessionInfo {
  ready: boolean;
  authenticated: boolean;
  /** The signed-in email, when the user logged in with one. */
  email: string | null;
  /** The user's primary wallet (embedded or linked). Null until created. */
  walletAddress: string | null;
  /**
   * True once the embedded signer is available. `walletAddress` arrives with the user object the
   * instant sign-in completes, but the wallet that signs (useWallets) provisions a beat later.
   * Anything that arms on sign-in must wait for this, or it fires into "no embedded wallet yet"
   * and latches (tester pet No. 3, 2026-09-25).
   */
  signerReady: boolean;
  login: () => void;
  logout: () => Promise<void>;
  /** Short-lived Privy access token for server calls. Null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /**
   * Headless email OTP (the inline self-custody mint flow). `sendCode` emails a
   * one-time passcode; `loginWithCode` verifies it and resolves once the user is
   * authenticated. The embedded wallet provisions a beat later, so `walletAddress`
   * flips non-null shortly after loginWithCode resolves: gate the auto-mint on it.
   */
  sendCode: (email: string) => Promise<void>;
  loginWithCode: (code: string) => Promise<void>;
  /** Current stage of the email OTP flow, for spinners/copy. */
  otpStatus: OtpStatus;
  /**
   * Explicitly create the user's embedded wallet. REQUIRED after a headless
   * login like loginWithCode: Privy only auto-creates a wallet through its own
   * modal, never for direct login methods, so without this the signed-in user
   * has no wallet to mint into. Rejects if the user already has one.
   */
  createWallet: () => Promise<string | null>;
  /**
   * Arm ONE-TAP CARE at mint time, so the keeper never has to come back to a website.
   *
   * WHY THIS RUNS HERE AND NOT ON THE CARE PAGE. Sending someone back to a site the
   * first time they tap their wallet pass breaks the entire illusion the product is
   * built on: the pass IS the game. Testers told us it "feels like shit", and they
   * were right. Everything a keeper must ever sign now happens once, during mint,
   * while they are already on the site and already expecting to act.
   *
   * The order is forced by Alchemy: wallet_createSession refuses an EOA that is not
   * yet EIP-7702 delegated, and the delegation only lands on the wallet's FIRST
   * sponsored op. So the first care is what installs it. That care also hatches the
   * pet, which is why the dormant egg goes away: Hunt's explicit trade, and the
   * right one, because a pet that is alive the moment it lands in your wallet beats
   * a pet you must visit a website to wake up.
   *
   * Best effort by design. Any failure leaves the keeper exactly where they were
   * before this existed: a minted pet that arms on its first visit to the care page.
   */
  armOneTapCare: (tokenId: string) => Promise<boolean>;
  /**
   * Arm a pet that is NOT armed yet, on any later sign-in (/me). Never hatches: it delegates with
   * the harmless setCarer bootstrap and grants the session, so the pet's clock does not start until
   * its keeper actually cares for it. A no-op for a pet that is already armed.
   */
  armOnSignIn: (tokenId: string) => Promise<boolean>;
  /**
   * The OWNER signer (the embedded wallet as an Alchemy-compatible signer), for the one action a
   * keeper signs deliberately outside arming: "Gift this pet" (lib/aa.ts sponsoredGift). Null until
   * the embedded wallet exists. Never the care session key, which cannot transfer anything.
   */
  getOwnerSigner: () => Promise<AaSigner | null>;
}

export function PrivyGate({
  fallback = null,
  children,
}: {
  fallback?: ReactNode;
  children: (session: PrivySessionInfo) => ReactNode;
}) {
  if (!PRIVY_ENABLED) return <>{fallback}</>;
  return <PrivyGateInner>{children}</PrivyGateInner>;
}

function PrivyGateInner({ children }: { children: (session: PrivySessionInfo) => ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { sendCode, loginWithCode, state } = useLoginWithEmail();
  const { createWallet } = useCreateWallet();
  const { wallets } = useWallets();
  const { signAuthorization } = useSign7702Authorization();
  // THE ONE ARMING PATH, shared with the care page (lib/arming.ts). The EMBEDDED wallet specifically:
  // it is the pet's owner and the only signer that can produce a 7702 authorization for a website
  // (extension wallets deliberately refuse), so an external wallet here would fail every op.
  // Best effort by design: a failure leaves the pet minted and theirs, and it is retried on their
  // next sign-in anywhere. It is never silent any more: armOneTap beacons every failure to the server.
  // Shared with every other caller on the page through armOnce (lib/arming.ts).
  const arm = async (tokenId: string, mode: ArmMode, surface: ArmSurface): Promise<boolean> =>
    (await armOnce(tokenId, () => armFresh(tokenId, mode, surface))).armed;
  // The embedded wallet as an Alchemy signer, built the same way for arming and for a gift.
  const ownerSigner = async (): Promise<{ signer: AaSigner; address: Address } | null> => {
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    const address = embedded?.address as Address | undefined;
    if (!embedded || !address) return null;
    const provider = (await embedded.getEthereumProvider()) as {
      request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
    const signer = privyWalletToSigner({
      provider,
      address,
      sign7702Authorization: (input) =>
        signAuthorization(
          { contractAddress: input.contractAddress, chainId: input.chainId, nonce: input.nonce },
          { address },
        ) as ReturnType<Sign7702Authorization>,
    });
    return { signer, address };
  };
  const armFresh = async (tokenId: string, mode: ArmMode, surface: ArmSurface): Promise<ArmResult> => {
    try {
      const owner = await ownerSigner();
      if (!owner) return { armed: false, stage: "no-token", detail: "no embedded wallet yet" };
      const { signer, address } = owner;
      // Under the SELLOUT model a care() is refused until mint-out, so even the mint takes the
      // no-hatch path there. Under the clock model (the showcase) the mint hatches, as ruled.
      const cfg = await fetchLiveChainConfig();
      const preSeason = Boolean(cfg?.season?.selloutStartsSeason && !cfg.season.started);
      const result = await armOneTap(
        liveArmDeps({ tokenId, owner: address, signer, getAccessToken, surface }),
        { mode: mode === "mint" && !preSeason ? "mint" : "signin", owner: address },
      );
      return result;
    } catch (err) {
      console.error("[walletchi] one-tap arming threw:", err);
      return { armed: false, stage: "grant", detail: String(err) };
    }
  };
  const session: PrivySessionInfo = {
    ready,
    authenticated,
    email: user?.email?.address ?? null,
    walletAddress: user?.wallet?.address ?? null,
    signerReady: wallets.some((w) => w.walletClientType === "privy"),
    login: () => login(),
    logout,
    getAccessToken,
    sendCode: (email: string) => sendCode({ email }),
    loginWithCode: (code: string) => loginWithCode({ code }),
    otpStatus: state.status,
    createWallet: async () => {
      const w = await createWallet();
      return w?.address ?? null;
    },
    armOneTapCare: (tokenId: string) => arm(tokenId, "mint", "mint"),
    armOnSignIn: (tokenId: string) => arm(tokenId, "signin", "me"),
    getOwnerSigner: async () => (await ownerSigner())?.signer ?? null,
  };
  return <>{children(session)}</>;
}
