"use client";

import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { PRIVY_APP_ID, PRIVY_ENABLED } from "@/lib/privy";
import { robinhoodChain, robinhoodMainnet, robinhoodTestnet } from "@/lib/chain";

/**
 * Client-only Privy wrapper mounted in the root layout. Email login with an
 * embedded wallet created for users who arrive without one, so a normie gets a
 * real wallet from just an email OTP. When NEXT_PUBLIC_PRIVY_APP_ID is unset
 * this renders children untouched (no provider, no sign-in surfaces), keeping
 * the founder demo byte-identical.
 */
export function PrivyShell({ children }: { children: ReactNode }) {
  if (!PRIVY_ENABLED) return <>{children}</>;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "wallet"],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          // NORMIE-FRIENDLY SIGNING. Privy's default prompt shows a raw hash for a UserOp signature,
          // which reads as gibberish to anyone who has not signed a transaction before and is the
          // single most confusing moment in the whole flow. Hide it: the person already pressed a
          // button in OUR interface that says what is about to happen ("Feed your pet"), and that is
          // the consent moment. The wallet is one we provisioned for them from an email, so there is
          // no second party for them to verify against.
          //
          // BE HONEST ABOUT WHAT THIS COSTS. An earlier version of this comment argued the setting
          // was safe because care() is owner-only on-chain, the EIP-7702 authorization is refused
          // unless it targets the pinned Alchemy delegate, and the session grant is scoped to the
          // care() selector. All three of those are true, and none of them is a property of THIS
          // SETTING. They are properties of OUR call sites. This flag is provider-level: with it
          // false, every embedded-wallet operation on this origin is silent, including arbitrary
          // personal_sign, arbitrary eth_signTypedData_v4 and eth_sendTransaction, whether or not
          // our code is the caller.
          //
          // So the real bound is not the selector, it is the integrity of the bundle we serve. Any
          // script that executes on this origin can ask this wallet to sign anything, with no
          // prompt, and an EIP-7702 authorization tuple can be relayed by ANY sender in a type-4
          // transaction, so our gas policy is not a barrier either. That is the trade being made
          // for the one-tap flow, and it should be written down as a trade rather than dressed up
          // as a guarantee.
          //
          // Privy honours a PER-CALL override, so the correct fix is to default this to true and
          // pass false only at the care call sites. That needs a browser test first: the AA path
          // signs through embedded.getEthereumProvider() rather than useSignMessage, so it may
          // already be headless and the override may cost nothing. Not flipped blind, because
          // getting it wrong reintroduces the raw-hash prompt this exists to remove.
          showWalletUIs: false,
        },
        // Robinhood Chain must be registered or the embedded wallet rejects signing on it
        // ("chain not configured in PrivyProvider config"), which the AA care flow needs.
        supportedChains: [robinhoodTestnet, robinhoodMainnet],
        defaultChain: robinhoodChain,
        appearance: {
          theme: "light",
          accentColor: "#2f7d7a",
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
