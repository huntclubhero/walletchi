"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets, useSign7702Authorization } from "@privy-io/react-auth";
import { AA_CARE_ENABLED } from "@/lib/aa-config";
import { privyWalletToSigner, type Sign7702Authorization } from "@/lib/aa";
import {
  readWithdrawable,
  sponsoredWithdraw,
  type TokenBalance,
  type WithdrawResult,
} from "@/lib/withdraw";
import { readPetCareFunds, careAmount } from "@/lib/pet-funds";
import type { Address } from "viem";

// How many feeds' worth of CARE the "keep some for food" button leaves inside the pet.
const FOOD_RESERVE_FEEDS = 50n;

// Withdraw a pet's account balances (CARE + USDG rewards) to its owner. Works for a LIVE or a DEAD
// pet (the account keeps working after death; only the NFT is soulbound), so it doubles as the way to
// rescue a memorial pet's stranded rewards. Owner-signed WalletchiAccount.execute() via the same AA
// path as care. Ships dark until AA_CARE_ENABLED and a fee-token address are wired.
//
// CARE IS THE PET'S FOOD (2026-10-15, No. 0091): every care is paid from the CARE in this
// account, so withdrawing all of it from a LIVE pet makes every feed revert. A keeper did
// exactly that twice and nearly lost the pet. Withdrawing CARE from a live pet now stops on a
// plain-words warning whose first button keeps a food reserve inside.
export function WithdrawRewards({
  tba,
  ownerAddress,
  alive,
}: {
  tba: string;
  ownerAddress: string;
  alive: boolean;
}) {
  if (!AA_CARE_ENABLED) return null;
  return <WithdrawInner tba={tba} ownerAddress={ownerAddress} alive={alive} />;
}

function WithdrawInner({ tba, ownerAddress, alive }: { tba: string; ownerAddress: string; alive: boolean }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { signAuthorization } = useSign7702Authorization();

  const [balances, setBalances] = useState<TokenBalance[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // token address in flight
  const [error, setError] = useState("");
  const [done, setDone] = useState<WithdrawResult | null>(null);
  // The CARE withdraw waiting on the food warning, with the reserve the safe option leaves behind.
  const [confirm, setConfirm] = useState<{ bal: TokenBalance; reserve: bigint; cost: bigint } | null>(null);

  const embedded = useMemo(() => wallets.find((w) => w.walletClientType === "privy"), [wallets]);
  const walletAddress = embedded?.address as Address | undefined;
  const isOwner = Boolean(
    walletAddress && ownerAddress && walletAddress.toLowerCase() === ownerAddress.toLowerCase(),
  );

  const refresh = useCallback(async () => {
    try {
      setBalances(await readWithdrawable(tba));
    } catch {
      setBalances([]);
    }
  }, [tba]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const buildSigner = useCallback(async () => {
    if (!embedded || !walletAddress) throw new Error("no wallet");
    const provider = (await embedded.getEthereumProvider()) as {
      request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
    return privyWalletToSigner({
      provider,
      address: walletAddress,
      sign7702Authorization: (input) =>
        signAuthorization(
          { contractAddress: input.contractAddress, chainId: input.chainId, nonce: input.nonce },
          { address: walletAddress },
        ) as ReturnType<Sign7702Authorization>,
    });
  }, [embedded, walletAddress, signAuthorization]);

  const send = useCallback(
    async (bal: TokenBalance, amount: bigint) => {
      if (!walletAddress || busy) return;
      setConfirm(null);
      setError("");
      setBusy(bal.token);
      try {
        const signer = await buildSigner();
        const res = await sponsoredWithdraw(signer, tba, bal.token, walletAddress, amount);
        if (res.status !== "success") throw new Error("failure");
        setDone(res);
        await refresh();
      } catch {
        setError("That did not go through. Please try again in a moment.");
      } finally {
        setBusy(null);
      }
    },
    [walletAddress, busy, buildSigner, tba, refresh],
  );

  const onWithdraw = useCallback(
    async (bal: TokenBalance) => {
      if (!alive || bal.symbol !== "CARE") return send(bal, bal.raw);
      // Unknown careCost falls back to 1 CARE: the warning still shows, which is the point.
      const funds = await readPetCareFunds(tba);
      const cost = funds?.cost ?? 10n ** 18n;
      setConfirm({ bal, reserve: cost * FOOD_RESERVE_FEEDS, cost });
    },
    [alive, send, tba],
  );

  // Nothing to show until there is a positive balance to withdraw.
  if (!balances || balances.length === 0) return null;

  return (
    <div className="soft-card mt-6 p-6 text-center">
      <div className="lcd" style={{ fontSize: "0.7rem", color: "var(--color-teal-deep)", letterSpacing: "0.14em" }}>
        REWARDS IN YOUR PET
      </div>
      <div className="mt-3 flex flex-col items-center gap-2">
        {balances.map((b) => (
          <div key={b.token} className="flex w-full max-w-xs items-center justify-between gap-3">
            <span className="display text-lg">
              {b.display} <span style={{ fontSize: "0.8rem", color: "var(--color-ink-muted)" }}>{b.symbol}</span>
            </span>
            {!ready ? null : !authenticated ? (
              <button className="btn btn-teal" style={{ fontSize: "0.8rem" }} onClick={() => login({ loginMethods: ["email"] })}>
                Sign in
              </button>
            ) : !isOwner ? (
              <span className="text-xs" style={{ color: "var(--color-ink-muted)" }}>owner only</span>
            ) : (
              <button
                className="btn btn-salmon"
                style={{ fontSize: "0.8rem" }}
                disabled={busy === b.token}
                onClick={() => onWithdraw(b)}
              >
                {busy === b.token ? "Sending…" : "Withdraw"}
              </button>
            )}
          </div>
        ))}
      </div>
      {confirm && (
        <div className="mt-4 rounded-2xl p-4 text-left" style={{ background: "var(--color-cream)" }}>
          <p className="display text-base">Heads up: this CARE is your pet&apos;s food</p>
          <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
            Every feed costs {careAmount(confirm.cost)} CARE, and it is paid from the CARE inside your pet, not
            from your wallet. If you take it all out, feeding stops working and your pet will die when its
            timer runs out.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {confirm.bal.raw > confirm.reserve && (
              <button className="btn btn-teal" onClick={() => send(confirm.bal, confirm.bal.raw - confirm.reserve)}>
                Withdraw {careAmount(confirm.bal.raw - confirm.reserve)}, keep {careAmount(confirm.reserve)} for food
              </button>
            )}
            <button className="btn btn-salmon" onClick={() => send(confirm.bal, confirm.bal.raw)}>
              Withdraw all {confirm.bal.display} anyway
            </button>
            <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {done && (
        <p className="mt-3 text-xs" style={{ color: "var(--color-ink-soft)" }}>
          Sent to your wallet.{" "}
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
      <p className="mt-3 text-xs" style={{ color: "var(--color-ink-muted)" }}>
        Moves tokens from your pet&apos;s account to your own wallet. Your pet pays for every feed with
        the CARE inside it, so leave some in or feeding stops working. Testnet tokens only: none of them
        has any value.
      </p>
    </div>
  );
}
