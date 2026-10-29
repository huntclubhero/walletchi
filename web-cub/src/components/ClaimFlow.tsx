"use client";

import { useCallback, useState } from "react";
import { PetPortrait } from "./PetPortrait";
import { PetSprite, paletteFromSeed } from "./PetSprite";
import { AppleGlyph, GoogleGlyph } from "./WalletPass";
import { OpenInSafariHint } from "./OpenInSafariHint";
import {
  claimByWallet,
  claimByEmail,
  fetchClaimNonce,
  ApiError,
  type ClaimResult,
  type ClaimPet,
} from "@/lib/api";
import { petPortraitByToken } from "@/lib/brand";
import { formatDuration } from "@/lib/format";
import {
  hasWallet,
  connectWallet,
  buildClaimMessage,
  signMessage,
  isUserRejection,
} from "@/lib/wallet";
import { safeUrl } from "@/lib/safe-url";
import { PRIVY_ENABLED } from "@/lib/privy";

type Stage = "idle" | "connecting" | "signing" | "verifying" | "picking" | "success";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A signed claim we can re-send with a chosen tokenId (so the picker never re-signs).
interface Pending {
  address: string;
  message: string;
  signature: string;
}

const DEAD_MESSAGE =
  "This pet is a soulbound memorial. It has passed on, so it can be viewed forever but cannot be claimed for transfer.";

export function ClaimFlow() {
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<ClaimResult | null>(null);
  const [pets, setPets] = useState<ClaimPet[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [walletError, setWalletError] = useState("");
  const [noWallet, setNoWallet] = useState(false);

  // wallet path: the buyer's contact. The claim unbinds the seller's email on
  // the server, so this is how the new owner gets a receipt + recovery path.
  const [claimEmail, setClaimEmail] = useState("");

  // email path
  const [email, setEmail] = useState("");
  const [petNumber, setPetNumber] = useState("");
  const [emailError, setEmailError] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailed, setEmailed] = useState(false);

  const applyResult = useCallback((res: ClaimResult, signed: Pending | null) => {
    if (res.multiple && res.pets && res.pets.length > 0) {
      setPets(res.pets);
      if (signed) setPending(signed);
      setStage("picking");
      return;
    }
    // `emailed` alone is a valid 200: the server sent the pass by email instead
    // of returning capability URLs; the success card shows the inbox line.
    if (res.serial || res.applePassUrl || res.googleSaveUrl || res.emailed) {
      setResult(res);
      setStage("success");
      return;
    }
    setWalletError("We could not read the den's answer. Please try again.");
    setStage("idle");
  }, []);

  const mapWalletError = useCallback((err: unknown) => {
    if (isUserRejection(err)) {
      setWalletError(
        "You cancelled the signature. Nothing happened to your pet. Try again whenever you are ready.",
      );
      return;
    }
    if (err instanceof ApiError) {
      if (err.code === "dead_soulbound") setWalletError(DEAD_MESSAGE);
      else if (err.code === "not_owner" || err.status === 403)
        setWalletError(
          "That wallet does not hold a WALLETCHI. Connect the wallet that owns your pet, or use the email path below.",
        );
      else if (err.code === "not_found" || err.status === 404)
        setWalletError("We could not find that pet. Double-check the number and try again.");
      else setWalletError(err.message);
      return;
    }
    setWalletError("Something got tangled reaching the den. Please try again.");
  }, []);

  const onConnect = useCallback(async () => {
    setWalletError("");
    setNoWallet(false);
    const contact = claimEmail.trim();
    if (!EMAIL_RE.test(contact)) {
      setWalletError(
        "Add your email first: it is where your pass receipt goes, and how we re-send the pass if you ever lose it.",
      );
      return;
    }
    if (!hasWallet()) {
      setNoWallet(true);
      return;
    }
    try {
      setStage("connecting");
      const address = await connectWallet();
      // Fresh server-issued single-use nonce, embedded in the signed message.
      const nonce = await fetchClaimNonce();
      setStage("signing");
      const message = buildClaimMessage(address, nonce);
      const signature = await signMessage(address, message);
      const signed: Pending = { address, message, signature };
      setStage("verifying");
      const res = await claimByWallet({ address, signature, message, email: contact });
      applyResult(res, signed);
    } catch (err) {
      mapWalletError(err);
      setStage("idle");
    }
  }, [claimEmail, applyResult, mapWalletError]);

  const onPick = useCallback(
    async (tokenId?: string) => {
      if (!pending || !tokenId) return;
      setWalletError("");
      try {
        setStage("verifying");
        // Same signature, chosen tokenId, same contact: the email rides along on
        // the second call because the FIRST call stopped at the picker, before
        // anything was stored.
        const res = await claimByWallet({ ...pending, tokenId, email: claimEmail.trim() });
        applyResult(res, pending);
      } catch (err) {
        mapWalletError(err);
        setStage("picking");
      }
    },
    [pending, claimEmail, applyResult, mapWalletError],
  );

  const onEmail = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setEmailError("");
      const cleanEmail = email.trim();
      const tokenId = petNumber.replace(/\D/g, "").replace(/^0+/, "") || "";
      if (!EMAIL_RE.test(cleanEmail)) {
        setEmailError("Enter a real email so we can send your pass.");
        return;
      }
      setEmailBusy(true);
      try {
        const res = await claimByEmail(cleanEmail, tokenId || undefined);
        if (res.applePassUrl || res.googleSaveUrl || res.serial) {
          setResult(res);
          setStage("success");
        } else {
          setEmailed(true);
        }
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.code === "dead_soulbound") setEmailError(DEAD_MESSAGE);
          else if (err.code === "not_owner" || err.status === 403)
            setEmailError("That email is not on file for this pet. Try the connect-wallet path above.");
          else if (err.code === "not_found" || err.status === 404)
            setEmailError(
              tokenId
                ? "We could not find that pet number. Double-check it and try again."
                : "We could not find a pet for that email. Sign in with it under My pets, or use the wallet path.",
            );
          else setEmailError(err.message);
        } else {
          setEmailError("Something got tangled reaching the den. Please try again.");
        }
      } finally {
        setEmailBusy(false);
      }
    },
    [email, petNumber],
  );

  const reset = useCallback(() => {
    setStage("idle");
    setResult(null);
    setPets([]);
    setPending(null);
    setWalletError("");
    setClaimEmail("");
    setEmailed(false);
    setEmail("");
    setPetNumber("");
    setEmailError("");
  }, []);

  if (stage === "success" && result) {
    return <ClaimSuccess result={result} onReset={reset} />;
  }

  if (stage === "picking") {
    return <PetPicker pets={pets} onPick={onPick} onCancel={reset} error={walletError} />;
  }

  const busy = stage === "connecting" || stage === "signing" || stage === "verifying";

  return (
    // No data-reveal in here: ClaimFlow re-mounts these cards after load, and
    // MotionRoot only observes reveal targets once, so late nodes would stay
    // invisible (opacity 0) forever.
    <div className="grid gap-6 md:grid-cols-2">
      {/* PATH A: connect wallet (primary) */}
      <div className="soft-card p-6 sm:p-7">
        <div className="eyebrow" style={{ color: "var(--color-lav-deep)" }}>
          The quick way
        </div>
        <h2 className="display mt-2" style={{ fontSize: "1.5rem" }}>
          Connect your wallet
        </h2>
        <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
          Add your email, then connect the wallet that holds your pet and sign a quick message to
          prove it is yours. Your pass is ready right away, and the receipt lands in your inbox so
          you can always get it back. No fee, no transaction.
        </p>

        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          className="field mt-4"
          placeholder="you@email.com"
          value={claimEmail}
          disabled={busy}
          onChange={(ev) => setClaimEmail(ev.target.value)}
          aria-label="Your email for the pass receipt"
        />

        {busy ? (
          <div className="mt-4 flex items-center gap-3 rounded-2xl p-4" style={{ background: "var(--color-lav-soft)" }}>
            <span className="spin" style={{ borderTopColor: "var(--color-lav-deep)", borderColor: "rgba(107,85,168,0.35)" }} />
            <span className="text-sm font-bold" style={{ color: "var(--color-lav-deep)" }}>
              {stage === "connecting" && "Waking up your wallet"}
              {stage === "signing" && "Waiting for your signature"}
              {stage === "verifying" && "Checking who owns this pet"}
            </span>
          </div>
        ) : (
          <button className="btn btn-cub mt-4 w-full" onClick={onConnect}>
            Connect wallet
          </button>
        )}

        {noWallet && (
          <p className="mt-3 text-sm" style={{ color: "var(--color-ink-soft)" }}>
            We could not find a wallet in this browser. No worries, use the email path instead, or
            open this page in your wallet app.
          </p>
        )}
        {/* A GIFTED pet lands in the recipient's embedded wallet, which no browser extension can
            connect and whose email is not the one on file (that was the giver's). Their claim is
            their first sign-in: /me lists the pet from the chain, and Add to wallet rotates the
            pass. Say so here, where the giver sends them. */}
        {PRIVY_ENABLED && (
          <p className="mt-3 text-sm" style={{ color: "var(--color-ink-soft)" }}>
            Was it a gift, and you sign in to WALLETCHI with your email? It is already waiting for
            you:{" "}
            <a href="/me" className="font-bold" style={{ color: "var(--color-teal-deep)" }}>
              open My pets
            </a>{" "}
            and tap Add to wallet. That claims it.
          </p>
        )}
        {walletError && !busy && (
          <p className="mt-3 text-sm" style={{ color: "var(--color-salmon-text)" }}>
            {walletError}
          </p>
        )}
      </div>

      {/* PATH B: email fallback */}
      <div className="soft-card p-6 sm:p-7">
        <div className="eyebrow" style={{ color: "var(--color-teal-deep)" }}>
          No wallet handy?
        </div>
        <h2 className="display mt-2" style={{ fontSize: "1.5rem" }}>
          Claim by email
        </h2>
        {emailed ? (
          <div className="mt-4 rounded-2xl p-4" style={{ background: "var(--color-teal-soft)" }}>
            <div className="display" style={{ fontSize: "1.05rem" }}>
              Check your inbox.
            </div>
            <p className="mt-1 text-sm" style={{ color: "var(--color-ink-soft)" }}>
              If that email is on file for the pet, we just sent your add-to-wallet link. It can take
              a minute to arrive.
            </p>
          </div>
        ) : (
          <form onSubmit={onEmail}>
            <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
              Enter the email you minted with, or the one you sign in with. We find your pets, verify
              ownership, then email your add-to-wallet link.
            </p>
            <div className="mt-4 grid gap-3">
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                className="field"
                placeholder="you@email.com"
                value={email}
                disabled={emailBusy}
                onChange={(ev) => setEmail(ev.target.value)}
                aria-label="Your email"
              />
              <input
                type="text"
                inputMode="numeric"
                className="field"
                placeholder="Pet number (optional)"
                value={petNumber}
                disabled={emailBusy}
                onChange={(ev) => setPetNumber(ev.target.value)}
                aria-label="Pet number (optional)"
              />
            </div>
            <button type="submit" className="btn btn-teal mt-3 w-full" disabled={emailBusy}>
              {emailBusy ? (
                <>
                  <span className="spin" style={{ borderTopColor: "var(--color-teal-deep)", borderColor: "rgba(28,127,143,0.35)" }} /> Verifying
                </>
              ) : (
                <>Email me my pass</>
              )}
            </button>
            {emailError && (
              <p className="mt-3 text-sm" style={{ color: "var(--color-salmon-text)" }}>
                {emailError}
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- success */

function ClaimSuccess({ result, onReset }: { result: ClaimResult; onReset: () => void }) {
  const number = result.runnerNumber || (result.tokenId ? `No. ${result.tokenId}` : "your pet");
  const lifeLeft = formatDuration(result.secondsLeft);

  return (
    // Mounted dynamically: no data-reveal (MotionRoot never observes late nodes).
    <div className="soft-card mx-auto max-w-[520px] p-6 text-center sm:p-8">
      <div className="mx-auto" style={{ width: 240, maxWidth: "100%" }}>
        <PetPortrait serial={result.serial} seed={result.tokenId ?? result.serial} width={240} />
      </div>
      <div className="eyebrow mt-4" style={{ color: "var(--color-teal-deep)" }}>
        Ownership verified
      </div>
      <h2 className="display mt-1" style={{ fontSize: "clamp(1.6rem, 4vw, 2.1rem)" }}>
        {number} is yours.
      </h2>
      <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        Add its living card to your wallet. Your pet keeps every stat and all of its history: it does
        not reset and it will not die from being sold.
        {lifeLeft ? ` It has ${lifeLeft} of life left, so care for its oldest need soon.` : ""}
      </p>

      <div className="mt-5 flex flex-col gap-3">
        {/* SAME TAB on purpose (2026-10-19): a .pkpass opened in a new tab leaves an empty tab behind the Add sheet, black on iOS 27. Same-tab navigation shows the sheet over this page and stays here. */}
        {safeUrl(result.applePassUrl) && (
          <a href={safeUrl(result.applePassUrl)} className="btn btn-apple w-full">
            <AppleGlyph /> Add to Apple Wallet
          </a>
        )}
        {result.googleSaveUrl && (
          <a href={safeUrl(result.googleSaveUrl)} target="_blank" rel="noreferrer" className="btn btn-google w-full">
            <GoogleGlyph /> Save to Google Wallet
          </a>
        )}
        {!result.applePassUrl && !result.googleSaveUrl && result.emailed && (
          <div className="rounded-2xl p-4 text-left" style={{ background: "var(--color-teal-soft)" }}>
            <div className="display" style={{ fontSize: "1.05rem" }}>
              Check your inbox.
            </div>
            <p className="mt-1 text-sm" style={{ color: "var(--color-ink-soft)" }}>
              We emailed your add-to-wallet link to the address on file. It can take a minute to
              arrive.
            </p>
          </div>
        )}
        {(result.applePassUrl || result.googleSaveUrl) && (
          <OpenInSafariHint appleUrl={result.applePassUrl} googleUrl={result.googleSaveUrl} />
        )}
        {(result.applePassUrl || result.googleSaveUrl) && result.emailed && (
          <p className="text-sm" style={{ color: "var(--color-ink-muted)" }}>
            A receipt with these links is on its way to your inbox, in case you ever need them
            again.
          </p>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-4 text-sm">
        {result.serial && (
          <a href={`/pet/${result.serial}`} className="font-bold" style={{ color: "var(--color-teal-deep)" }}>
            See its live page
          </a>
        )}
        <button className="font-bold" style={{ color: "var(--color-ink-muted)" }} onClick={onReset}>
          Claim another
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ multi picker */

function PetPicker({
  pets,
  onPick,
  onCancel,
  error,
}: {
  pets: ClaimPet[];
  onPick: (tokenId?: string) => void;
  onCancel: () => void;
  error: string;
}) {
  return (
    // Mounted dynamically: no data-reveal (MotionRoot never observes late nodes).
    <div className="soft-card mx-auto max-w-[640px] p-6 sm:p-7">
      <div className="eyebrow" style={{ color: "var(--color-lav-deep)" }}>
        You own more than one
      </div>
      <h2 className="display mt-2" style={{ fontSize: "1.5rem" }}>
        Which pet do you want to claim?
      </h2>
      <p className="mt-2 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        Pick a pet to add its pass. You can come back and claim the others any time.
      </p>
      {error && (
        <p className="mt-3 text-sm" style={{ color: "var(--color-salmon-text)" }}>
          {error}
        </p>
      )}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {pets.map((p) => {
          const dead = (p.status || "").toLowerCase() === "dead";
          return (
            <button
              key={p.tokenId ?? p.serial}
              className="pet-choice"
              onClick={() => !dead && onPick(p.tokenId)}
              disabled={dead}
              aria-disabled={dead}
            >
              <ChoicePortrait pet={p} />
              <span className="min-w-0 text-left">
                <span className="block font-bold" style={{ color: "var(--color-ink)" }}>
                  {p.runnerNumber || `No. ${p.tokenId}`}
                </span>
                <span className={`status-tag status-tag-${(p.status || "alive").toLowerCase()}`}>
                  {dead ? "Memorial, cannot transfer" : p.status || "Alive"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <button className="mt-5 text-sm font-bold" style={{ color: "var(--color-ink-muted)" }} onClick={onCancel}>
        Back
      </button>
    </div>
  );
}

function ChoicePortrait({ pet }: { pet: ClaimPet }) {
  const seed = pet.tokenId ?? pet.serial ?? "walletchi";
  const src = pet.tokenId ? petPortraitByToken(pet.tokenId) : "";
  const [loaded, setLoaded] = useState(false);
  return (
    <span
      className="flex-none"
      style={{ width: 56, height: 56, borderRadius: 14, overflow: "hidden", position: "relative", background: "linear-gradient(160deg,#eaf6f7,#fdeee6)" }}
    >
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          onLoad={() => setLoaded(true)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: loaded ? "block" : "none" }}
        />
      )}
      {!loaded && (
        <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          <PetSprite size={34} palette={paletteFromSeed(seed)} />
        </span>
      )}
    </span>
  );
}


