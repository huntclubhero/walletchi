import { PetSprite } from "./PetSprite";
import { AccountNavLink } from "./AccountNavLink";
import { ContractChip } from "./ContractChip";
import { WalletPassPills } from "./WalletPass";
import { DonateButton } from "./DonateButton";
import { BRAND, ERC, ERC_PR_URL, ERC_SDK, TESTNET, MINT_OPEN } from "@/lib/brand";

/** Shared top nav. Cross-page links use plain anchors (full loads) so the global MotionRoot
 *  re-scans reveal targets on the destination page. The wallet pills ride along with it, so
 *  every page in the site carries the add-to-wallet promise. */
export function SiteNav() {
  return (
    <>
      <TestnetBar />
      <NavBar />
      <WalletPassPills />
    </>
  );
}

/** The one persistent Testnet Experience label. Said once, here, on every page; nothing else on
 *  the site repeats it as a caveat. The long line collapses to a short one on a phone. */
function TestnetBar() {
  return (
    <div className="testnet-bar" role="note" aria-label={`${TESTNET.label}. ${TESTNET.line}`}>
      <div className="testnet-bar-inner">
        <span className="testnet-chip">{TESTNET.label}</span>
        <span className="testnet-line testnet-line-long" aria-hidden>
          {TESTNET.line}
        </span>
        <span className="testnet-line testnet-line-short" aria-hidden>
          Robinhood Chain testnet. Fake tokens, no value.
        </span>
      </div>
    </div>
  );
}

function NavBar() {
  return (
    <header className="mx-auto flex w-[min(1120px,90vw)] items-center justify-between gap-3 py-4 sm:py-5">
      <a href="/" className="flex min-w-0 items-center gap-2">
        <span className="grid h-9 w-9 flex-none place-items-center rounded-2xl sm:h-10 sm:w-10" style={{ background: "#fff", boxShadow: "0 8px 18px -10px rgba(47,125,122,0.45)" }}>
          <PetSprite size={26} />
        </span>
        <span className="nav-brand-text display text-lg sm:text-xl" style={{ letterSpacing: "-0.01em" }}>
          {BRAND.name}
        </span>
      </a>
      <div className="nav-links flex items-center gap-3 sm:gap-5">
        <a href="/arena" className="flex items-center gap-1.5 whitespace-nowrap text-sm font-bold" style={{ color: "var(--color-ink-soft)" }}>
          <span className="nav-live-dot" aria-hidden />
          Arena
        </a>
        <a href="/how-to" className="hidden text-sm font-bold sm:inline" style={{ color: "var(--color-ink-soft)" }}>
          How to
        </a>
        <a href="/docs" className="whitespace-nowrap text-sm font-bold" style={{ color: "var(--color-ink-soft)" }}>
          Docs
        </a>
        <DonateButton variant="nav" />
        <AccountNavLink />
        {MINT_OPEN && (
          <a href="/#adopt" className="btn btn-cub nav-cta flex-none whitespace-nowrap">
            Get my pet
          </a>
        )}
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-10 border-t py-10" style={{ borderColor: "rgba(116,137,139,0.22)" }}>
      <div className="mx-auto flex w-[min(1120px,90vw)] flex-col items-center gap-4 text-center">
        <div className="flex items-center gap-2">
          <PetSprite size={28} />
          <span className="display text-lg">{BRAND.name}</span>
        </div>
        <p className="max-w-sm text-sm" style={{ color: "var(--color-ink-soft)" }}>
          {BRAND.tagline}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-4 text-sm" style={{ color: "var(--color-ink-muted)" }}>
          <a href="/arena" className="font-bold">The Arena</a>
          <span aria-hidden>·</span>
          <a href="/how-to" className="font-bold">How it works</a>
          <span aria-hidden>·</span>
          <a href="/docs" className="font-bold">Docs</a>
          <span aria-hidden>·</span>
          {MINT_OPEN && (
            <>
              <a href="/#adopt" className="font-bold">Get my pet</a>
              <span aria-hidden>·</span>
            </>
          )}
          <a href="/claim" className="font-bold">Got one from someone? Claim its pass</a>
          <span aria-hidden>·</span>
          <DonateButton variant="link" label="Donate to huntclubhero.eth" />
        </div>
        <p className="lcd" style={{ fontSize: "0.7rem", color: "var(--color-ink-muted)" }}>
          {TESTNET.label} on {BRAND.chainName} testnet. No token here has value.
        </p>
        {/* trust row: the contract itself, verifiable, plus the standard it demonstrates */}
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
          <ContractChip />
          {/* No configured collection means no explorer link: an "explorer" link that resolves to
              nothing (or to a dead prior-season address) is the same plausible-wrong-answer trap
              the hardcoded fallback was, so the whole link drops out rather than misleading. */}
          {BRAND.contractExplorer && (
            <>
              <span aria-hidden style={{ color: "var(--color-ink-muted)" }}>·</span>
              <a
                href={BRAND.contractExplorer}
                target="_blank"
                rel="noreferrer"
                className="lcd"
                style={{ fontSize: "0.7rem", color: "var(--color-teal-deep)" }}
              >
                View on explorer <span aria-hidden>↗</span>
              </a>
            </>
          )}
          <span aria-hidden style={{ color: "var(--color-ink-muted)" }}>·</span>
          <a href={ERC.specUrl} target="_blank" rel="noreferrer" className="lcd" style={{ fontSize: "0.7rem", color: "var(--color-teal-deep)" }}>
            The standard: {ERC.number}, {ERC.title} <span aria-hidden>↗</span>
          </a>
          <span aria-hidden style={{ color: "var(--color-ink-muted)" }}>·</span>
          <a href={ERC.specSourceUrl} target="_blank" rel="noreferrer" className="lcd" style={{ fontSize: "0.7rem", color: "var(--color-teal-deep)" }}>
            Spec on GitHub <span aria-hidden>↗</span>
          </a>
          <span aria-hidden style={{ color: "var(--color-ink-muted)" }}>·</span>
          <a href={ERC.discussionUrl} target="_blank" rel="noreferrer" className="lcd" style={{ fontSize: "0.7rem", color: "var(--color-teal-deep)" }}>
            Discussion <span aria-hidden>↗</span>
          </a>
          <span aria-hidden style={{ color: "var(--color-ink-muted)" }}>·</span>
          <a href={ERC_SDK.npm} target="_blank" rel="noreferrer" className="lcd" style={{ fontSize: "0.7rem", color: "var(--color-teal-deep)" }}>
            SDK on npm <span aria-hidden>↗</span>
          </a>
          {ERC_PR_URL && (
            <>
              <span aria-hidden style={{ color: "var(--color-ink-muted)" }}>·</span>
              <a href={ERC_PR_URL} target="_blank" rel="noreferrer" className="lcd" style={{ fontSize: "0.7rem", color: "var(--color-teal-deep)" }}>
                ERC pull request <span aria-hidden>↗</span>
              </a>
            </>
          )}
        </div>
      </div>
    </footer>
  );
}
