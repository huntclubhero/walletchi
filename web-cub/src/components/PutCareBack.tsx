"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets, useSign7702Authorization } from "@privy-io/react-auth";
import { AA_CARE_ENABLED } from "@/lib/aa-config";
import { privyWalletToSigner, type Sign7702Authorization } from "@/lib/aa";
import { sponsoredTopUp, type WithdrawResult } from "@/lib/withdraw";
import { readPetCareFunds, readWalletCare, careAmount } from "@/lib/pet-funds";
import type { Address } from "viem";

// How many feeds' worth the main button moves back in (the same reserve the withdraw warning keeps).
const TOP_UP_FEEDS = 50n;
// The card only appears once the pet is running LOW: fewer than this many feeds' worth inside
// (three days of all five needs). Showing it to a pet holding 2,000+ CARE prompted pointless
// top-ups (No. 0063 put 50 back three times on 2026-10-15 with thousands already inside).
const LOW_FEEDS = 15n;

// PUT CARE BACK (2026-10-15, No. 0091): every care is paid from the CARE inside the pet, so a keeper
// who withdrew it all could not feed, with thousands of CARE sitting in their own wallet. One tap moves
// it back in, gas sponsored (gas-sponsor.ts ownerTopUpOk). Shown on a live pet's page when it runs low and the
// owner's wallet holds CARE, and on the care page the moment a feed is refused for an empty pet.
export function PutCareBack({
  tba,
  ownerAddress,
  onDone,
}: {
  tba: string;
  ownerAddress: string;
  onDone?: () => void;
}) {
  if (!AA_CARE_ENABLED) return null;
  return <PutCareBackInner tba={tba} ownerAddress={ownerAddress} onDone={onDone} />;
}

function PutCareBackInner({
  tba,
  ownerAddress,
  onDone,
}: {
  tba: string;
  ownerAddress: string;
  onDone?: () => void;
}) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { signAuthorization } = useSign7702Authorization();

  const [wallet, setWallet] = useState<{ token: Address; balance: bigint } | null>(null);
  const [petBalance, setPetBalance] = useState<bigint | null>(null);
  const [cost, setCost] = useState<bigint>(10n ** 18n);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<WithdrawResult | null>(null);

  const embedded = useMemo(() => wallets.find((w) => w.walletClientType === "privy"), [wallets]);
  const walletAddress = embedded?.address as Address | undefined;
  const isOwner = Boolean(
    walletAddress && ownerAddress && walletAddress.toLowerCase() === ownerAddress.toLowerCase(),
  );

  const refresh = useCallback(async () => {
    const [w, funds] = await Promise.all([readWalletCare(ownerAddress), readPetCareFunds(tba)]);
    setWallet(w);
    if (funds) {
      setPetBalance(funds.balance);
      setCost(funds.cost);
    }
  }, [ownerAddress, tba]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const send = useCallback(
    async (amount: bigint) => {
      if (!embedded || !walletAddress || !wallet || busy) return;
      setError("");
      setBusy(true);
      try {
        const provider = (await embedded.getEthereumProvider()) as {
          request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
        };
        const signer = await privyWalletToSigner({
          provider,
          address: walletAddress,
          sign7702Authorization: (input) =>
            signAuthorization(
              { contractAddress: input.contractAddress, chainId: input.chainId, nonce: input.nonce },
              { address: walletAddress },
            ) as ReturnType<Sign7702Authorization>,
        });
        const res = await sponsoredTopUp(signer, wallet.token, tba, amount);
        if (res.status !== "success") throw new Error("failure");
        setDone(res);
        await refresh();
        onDone?.();
      } catch {
        setError("That did not go through. Please try again in a moment.");
      } finally {
        setBusy(false);
      }
    },
    [embedded, walletAddress, wallet, busy, signAuthorization, tba, refresh, onDone],
  );

  // Nothing to put back: the owner's wallet holds no CARE (or we could not read it). A signed-in
  // visitor who is not the owner has nothing to do here either.
  if (!done && (!wallet || wallet.balance === 0n)) return null;
  if (authenticated && walletAddress && !isOwner) return null;
  // Not low (or the pet's balance could not be read): nothing to ask for.
  if (!done && (petBalance === null || cost === 0n || petBalance / cost >= LOW_FEEDS)) return null;

  const some = wallet ? (wallet.balance < cost * TOP_UP_FEEDS ? wallet.balance : cost * TOP_UP_FEEDS) : 0n;
  const feedsInside = petBalance !== null && cost > 0n ? petBalance / cost : null;

  return (
    <div className="soft-card mt-6 p-6 text-center">
      <div className="lcd" style={{ fontSize: "0.7rem", color: "var(--color-teal-deep)", letterSpacing: "0.14em" }}>
        YOUR PET&apos;S FOOD
      </div>
      <p className="mt-3 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        Your pet pays for every feed with the CARE inside it.
        {feedsInside !== null && (
          <>
            {" "}It has enough for <strong>{feedsInside.toString()}</strong>{" "}
            {feedsInside === 1n ? "feed" : "feeds"} right now.
          </>
        )}
        {wallet && wallet.balance > 0n && (
          <>
            {" "}
            {isOwner ? `You have ${careAmount(wallet.balance)} CARE in your wallet.` : `The owner has ${careAmount(wallet.balance)} CARE in their wallet.`}
          </>
        )}
      </p>
      {wallet && wallet.balance > 0n && (
        <div className="mt-4 flex flex-col items-center gap-2">
          {!ready ? null : !authenticated ? (
            <button className="btn btn-teal" onClick={() => login({ loginMethods: ["email"] })}>
              Sign in to put CARE back
            </button>
          ) : !isOwner ? null : (
            <>
              <button className="btn btn-teal w-full max-w-xs" disabled={busy} onClick={() => send(some)}>
                {busy ? "Sending…" : `Put ${careAmount(some)} CARE back in`}
              </button>
              {wallet.balance > some && (
                <button className="btn btn-ghost w-full max-w-xs" disabled={busy} onClick={() => send(wallet.balance)}>
                  Put all {careAmount(wallet.balance)} back
                </button>
              )}
            </>
          )}
        </div>
      )}
      {done && (
        <p className="mt-3 text-xs" style={{ color: "var(--color-ink-soft)" }}>
          CARE is back in your pet. Go care for it!{" "}
          <a href={done.explorerUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
            View
          </a>
        </p>
      )}
      {error && (
        <p className="mt-3 text-xs" style={{ color: "var(--color-salmon-text)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
