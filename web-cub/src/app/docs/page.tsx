import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/SiteChrome";
import { MergedStamp } from "@/components/MergedStamp";
import { PlatformCredentialsCompact } from "@/components/PlatformCredentials";
import { BRAND, ERC, ERC_PR_URL, ERC_SDK, WALLETCHI_SOURCE, PET721_CONFIGURED, PET721_ADDRESS } from "@/lib/brand";
import { robinhoodChain } from "@/lib/chain";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Everything behind WALLETCHI in one place: the ERC-8426 spec, the @erc8426 SDK packages, guides for Apple Wallet and Google Wallet, the conformance suite, and the live contract.",
};

// Every link on this page resolved on 2026-10-24 (npmjs.com answers 403 to curl, so the npm pages
// were confirmed through the registry instead). Package lines are the npm
// descriptions. No version numbers on purpose: npm always shows the current one.
const SDK_REPO = ERC_SDK.repo;
const NPM = (p: string) => `https://www.npmjs.com/package/@erc8426/${p}`;
const DOC = (p: string) => `${ERC_SDK.docs}/${p}.md`;

const STANDARD = [
  { k: "Spec", title: `Read ${ERC.number}`, body: "The published standard on ercs.ethereum.org.", href: ERC.specUrl, tag: "Start here" },
  { k: "Source", title: "Spec on GitHub", body: "The markdown in ethereum/ERCs, with its full history.", href: ERC.specSourceUrl },
  { k: "Forum", title: "The discussion", body: "The Ethereum Magicians thread: questions, review, what comes next.", href: ERC.discussionUrl },
  ...(ERC_PR_URL
    ? [{ k: "PR", title: "Pull request #2036", body: "Every revision and the editor review, merged into master.", href: ERC_PR_URL }]
    : []),
];

const PACKAGES = [
  { name: "contracts", for: "NFT projects", body: "Solidity interface, base implementation and use-case examples." },
  { name: "issuer", for: "Pass servers", body: "Challenges, the authorization floor, gated manifests, capability links, rotation." },
  { name: "apple", for: "Pass servers", body: "Apple Wallet: pkpass building, the PassKit web service, APNs push." },
  { name: "google", for: "Pass servers", body: "Google Wallet: Save to Google Wallet links, object upserts and pushes." },
  { name: "client", for: "Wallets, marketplaces", body: "Discover, resolve and acquire passes from any compliant token." },
  { name: "react", for: "Frontends", body: "React hooks and an Add to Wallet button." },
  { name: "conformance", for: "Everyone", body: "Check any contract and pass server against every MUST." },
  { name: "core", for: "All of the above", body: "Shared types, constants, CAIP-19, manifest and challenge codecs." },
];

const GUIDES = [
  { title: "Getting started", body: "From a token to a card on a phone.", href: DOC("getting-started") },
  { title: "Concepts", body: "Discovery, freshness, authorization.", href: DOC("concepts") },
  { title: "Apple Wallet", body: "Certificates, the web service, push.", href: DOC("platforms/apple") },
  { title: "Google Wallet", body: "Issuer account, classes, objects.", href: DOC("platforms/google") },
  { title: "Security", body: "Why a pass is a bearer artifact.", href: DOC("security") },
  { title: "Deploy", body: "Running an issuer in production.", href: DOC("deploy") },
  { title: "FAQ", body: "The questions people actually ask.", href: DOC("faq") },
  { title: "Changelog", body: "What changed in each release.", href: `${SDK_REPO}/blob/main/CHANGELOG.md` },
];

const JUMP = [
  { id: "standard", label: "The standard" },
  { id: "sdk", label: "SDK" },
  { id: "guides", label: "Guides" },
  { id: "build", label: "This build" },
];

export default function Docs() {
  return (
    <main className="relative" id="top">
      <SiteNav />

      {/* ------------------------------------------------------------------ HERO */}
      <section className="docs-hero">
        <div className="tx-stage-grid" aria-hidden />
        <div className="relative mx-auto grid w-[min(1180px,92vw)] items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
          <div>
            <div data-reveal>
              <MergedStamp tone="dark" />
            </div>
            <div data-reveal className="eyebrow mt-7" style={{ color: "#ffd9c9" }}>
              Docs
            </div>
            <h1 data-reveal className="display mt-3" style={{ fontSize: "clamp(2.4rem, 6vw + 0.3rem, 5rem)", color: "#fff", transitionDelay: "0.05s" }}>
              Build on <span style={{ color: "#ff9d82", whiteSpace: "nowrap" }}>{ERC.number}.</span>
            </h1>
            <p data-reveal className="mt-5 max-w-xl text-lg" style={{ color: "#d8ecef", transitionDelay: "0.1s" }}>
              Put any NFT in Apple Wallet and Google Wallet. The spec, the SDK, the guides and the
              live contract behind {BRAND.name}, all in one place.
            </p>
            <div data-reveal className="mt-7 flex flex-wrap gap-3" style={{ transitionDelay: "0.15s" }}>
              <a href={ERC.specUrl} target="_blank" rel="noreferrer" className="btn tx-btn-light">
                Read the spec <span aria-hidden>↗</span>
              </a>
              <a href={DOC("getting-started")} target="_blank" rel="noreferrer" className="btn tx-btn-outline">
                Get started <span aria-hidden>↗</span>
              </a>
            </div>
          </div>

          <div data-reveal className="tx-code" style={{ transitionDelay: "0.1s" }}>
            <div className="tx-code-bar">
              <span />
              <span />
              <span />
              <em className="lcd">terminal</em>
            </div>
            <pre>
              <code>
                <span className="c"># serve passes for your token</span>
                {"\n"}
                <span className="k">npm</span> i @erc8426/issuer @erc8426/apple @erc8426/google
                {"\n\n"}
                <span className="c"># add the pass to your contract</span>
                {"\n"}
                <span className="k">npm</span> i @erc8426/contracts
                {"\n\n"}
                <span className="c"># check any implementation against every MUST</span>
                {"\n"}
                <span className="k">npx</span> @erc8426/conformance <span className="f">--rpc</span> $RPC <span className="f">--contract</span> $ADDR <span className="f">--token</span> 1
              </code>
            </pre>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ JUMP BAR */}
      <nav className="docs-jump" aria-label="On this page">
        <div className="mx-auto flex w-[min(1180px,92vw)] gap-2 overflow-x-auto py-3">
          {JUMP.map((j) => (
            <a key={j.id} href={`#${j.id}`} className="docs-jump-link">
              {j.label}
            </a>
          ))}
        </div>
      </nav>

      {/* -------------------------------------------------------- THE STANDARD */}
      <section id="standard" className="tx-band docs-section">
        <div className="mx-auto w-[min(1180px,92vw)]">
          <SectionHead
            eyebrow="The standard"
            title={`${ERC.number}: ${ERC.title}`}
            body={`Status: ${ERC.status}. ERC-165 interface id ${ERC.interfaceId}. Merged into ethereum/ERCs ${ERC.mergedLabel}.`}
          />
          <div className="docs-grid docs-grid-4 mt-8">
            {STANDARD.map((c) => (
              <DocCard key={c.title} {...c} />
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ SDK */}
      <section id="sdk" className="tx-band tx-band-teal docs-section">
        <div className="mx-auto w-[min(1180px,92vw)]">
          <SectionHead
            eyebrow="The SDK"
            title="@erc8426 on npm"
            body="MIT licensed. Contracts, a pass server, Apple and Google delivery, a client for wallets and marketplaces, React components, and a conformance suite."
          />
          <div className="mt-6 flex flex-wrap gap-3">
            <a href={SDK_REPO} target="_blank" rel="noreferrer" className="btn btn-teal">
              Source on GitHub <span aria-hidden>↗</span>
            </a>
            <a href={ERC_SDK.npm} target="_blank" rel="noreferrer" className="btn btn-ghost">
              All packages <span aria-hidden>↗</span>
            </a>
            <a href={ERC_SDK.demo} target="_blank" rel="noreferrer" className="btn btn-ghost">
              Live demo <span aria-hidden>↗</span>
            </a>
          </div>
          <div className="docs-grid docs-grid-4 mt-8">
            {PACKAGES.map((p) => (
              <a key={p.name} href={NPM(p.name)} target="_blank" rel="noreferrer" className="docs-card docs-pkg">
                <span className="docs-card-k lcd">{p.for}</span>
                <span className="docs-pkg-name">
                  @erc8426/<b>{p.name}</b>
                </span>
                <span className="docs-card-body">{p.body}</span>
                <span className="docs-card-go" aria-hidden>↗</span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- GUIDES */}
      <section id="guides" className="tx-band docs-section">
        <div className="mx-auto w-[min(1180px,92vw)]">
          <SectionHead eyebrow="Guides" title="Read the docs" body="Written for people shipping passes, from the first token to production." />
          <div className="docs-grid docs-grid-4 mt-8">
            {GUIDES.map((g) => (
              <DocCard key={g.title} k="Guide" {...g} />
            ))}
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- THIS BUILD */}
      <section id="build" className="tx-band tx-band-river docs-section">
        <div className="mx-auto w-[min(1180px,92vw)]">
          <div className="eyebrow">This build</div>
          <h2 className="display mt-3" style={{ fontSize: "clamp(1.8rem, 4.4vw, 3rem)", color: "#fff" }}>
            {BRAND.name}, the live implementation.
          </h2>
          <p className="mt-4 max-w-2xl text-lg" style={{ color: "#d8ecef" }}>
            A pixel pet that is its own wallet pass, running on {robinhoodChain.name}. Everything the
            standard describes, working on real phones.
          </p>

          <dl className="docs-facts mt-8">
            <div>
              <dt className="lcd">Chain</dt>
              <dd>
                {robinhoodChain.name} <span className="mono">({robinhoodChain.id})</span>
              </dd>
            </div>
            <div>
              <dt className="lcd">Interface</dt>
              <dd className="mono">supportsInterface({ERC.interfaceId})</dd>
            </div>
            {PET721_CONFIGURED && BRAND.contractExplorer && (
              <div>
                <dt className="lcd">Pet contract</dt>
                <dd>
                  <a href={BRAND.contractExplorer} target="_blank" rel="noreferrer" className="mono docs-addr">
                    {PET721_ADDRESS} <span aria-hidden>↗</span>
                  </a>
                </dd>
              </div>
            )}
          </dl>

          <div className="docs-grid docs-grid-4 docs-grid-dark mt-8">
            <DocCard k="Code" title="WALLETCHI source" body="The full build behind this site, public on GitHub." href={WALLETCHI_SOURCE} dark />
            <DocCard k="Guide" title="How it works" body="Six steps, and what happens on chain at every tap." href="/how-to" dark internal />
            <DocCard k="Live" title="The Arena" body="Every pet, alive or not, and the Pot." href="/arena" dark internal />
            <DocCard k="Pass" title="Claim a pass" body="Got a pet from someone? Claim its card." href="/claim" dark internal />
          </div>

          <div className="mt-8">
            <PlatformCredentialsCompact />
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

function SectionHead({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return (
    <div className="max-w-3xl">
      <div data-reveal className="eyebrow" style={{ color: "var(--color-salmon-text)" }}>
        {eyebrow}
      </div>
      <h2 data-reveal className="display mt-3" style={{ fontSize: "clamp(1.8rem, 4.4vw, 3rem)", transitionDelay: "0.05s" }}>
        {title}
      </h2>
      <p data-reveal className="mt-4 text-lg" style={{ color: "var(--color-ink-soft)", transitionDelay: "0.1s" }}>
        {body}
      </p>
    </div>
  );
}

function DocCard({
  k,
  title,
  body,
  href,
  tag,
  dark,
  internal,
}: {
  k: string;
  title: string;
  body: string;
  href: string;
  tag?: string;
  dark?: boolean;
  internal?: boolean;
}) {
  return (
    <a
      href={href}
      {...(internal ? {} : { target: "_blank", rel: "noreferrer" })}
      className={`docs-card${dark ? " docs-card-dark" : ""}${tag ? " docs-card-lead" : ""}`}
    >
      <span className="docs-card-k lcd">
        {k}
        {tag && <span className="docs-card-tag">{tag}</span>}
      </span>
      <span className="docs-card-title display">{title}</span>
      <span className="docs-card-body">{body}</span>
      <span className="docs-card-go" aria-hidden>
        {internal ? "→" : "↗"}
      </span>
    </a>
  );
}
