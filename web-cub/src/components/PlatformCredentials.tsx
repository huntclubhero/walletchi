import { AppleGlyph, GoogleGlyph } from "./WalletPass";
import { PLATFORM_CREDENTIALS } from "@/lib/brand";

/**
 * The platform credentials panel: the Apple and Google Wallet credentials this build holds,
 * shown the way a certificate is, not the way a badge is. Everything here comes from
 * PLATFORM_CREDENTIALS (brand.ts), which stores MASKED IDs only, and whose wording law applies:
 * Apple ISSUED a certificate (no review exists), Google APPROVED the issuer and the pass class.
 */

type Cred = (typeof PLATFORM_CREDENTIALS)["apple"] | (typeof PLATFORM_CREDENTIALS)["google"];

const CARDS: { key: "apple" | "google"; glyph: React.ReactNode }[] = [
  { key: "apple", glyph: <AppleGlyph size={20} /> },
  { key: "google", glyph: <GoogleGlyph size={20} /> },
];

export function PlatformCredentials() {
  return (
    <section className="cred-band" aria-labelledby="cred-title">
      <div className="mx-auto w-[min(1180px,92vw)]">
        <div className="grid items-end gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <div data-reveal className="eyebrow" style={{ color: "var(--color-teal-deep)" }}>
              Platform credentials
            </div>
            <h2 id="cred-title" data-reveal className="display mt-3" style={{ fontSize: "clamp(1.7rem, 4.6vw, 3.2rem)", transitionDelay: "0.05s" }}>
              Real wallet credentials, on file.
            </h2>
          </div>
          <p data-reveal className="text-base" style={{ color: "var(--color-ink-soft)", transitionDelay: "0.1s" }}>
            Every pass is signed with an Apple-issued certificate and published through a
            Google-approved issuer account. IDs are partly masked. Checked{" "}
            {PLATFORM_CREDENTIALS.checkedOn}.
          </p>
        </div>

        <div className="mt-9 grid gap-6 md:grid-cols-2">
          {CARDS.map(({ key, glyph }, i) => (
            <CredCard key={key} id={key} cred={PLATFORM_CREDENTIALS[key]} glyph={glyph} delay={i * 0.08} />
          ))}
        </div>
      </div>
    </section>
  );
}

function CredCard({ id, cred, glyph, delay }: { id: string; cred: Cred; glyph: React.ReactNode; delay: number }) {
  return (
    <article data-reveal className="cred-card" style={{ transitionDelay: `${delay}s` }}>
      <header className="cred-head">
        <span className="cred-glyph" aria-hidden>
          {glyph}
        </span>
        <span className="display cred-name">{cred.platform}</span>
        <span className="lcd cred-kind">Credential</span>
      </header>
      <Seal id={`cred-arc-${id}`} />
      <div className="cred-body">
        <ul className="cred-claims">
          {cred.claims.map((c) => (
            <li key={c}>
              <span className="cred-check" aria-hidden>
                <svg viewBox="0 0 16 16" width="12" height="12">
                  <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              {c}
            </li>
          ))}
        </ul>
        <dl className="cred-rows">
          {cred.rows.map((r) => (
            <div key={r.label} className="cred-row">
              <dt className="lcd">{r.label}</dt>
              <dd className={r.mono ? "cred-mono" : "cred-val"}>{r.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </article>
  );
}

/** A small rubber-stamp seal: ring, check, "ON FILE". Decorative; the claims carry the meaning. */
function Seal({ id }: { id: string }) {
  return (
    <svg className="cred-seal" viewBox="0 0 100 100" aria-hidden>
      <defs>
        <path id={id} d="M50,50 m-34,0 a34,34 0 1,1 68,0 a34,34 0 1,1 -68,0" />
      </defs>
      <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 3" />
      {/* textLength pins the phrase to the ring's circumference (2 x pi x 34, about 213), so it
          closes on itself cleanly instead of overrunning and wrapping into garble. */}
      <text fontSize="10" fontWeight="800" fill="currentColor">
        <textPath href={`#${id}`} textLength="207" lengthAdjust="spacing">
          CREDENTIAL ON FILE · CREDENTIAL ON FILE ·
        </textPath>
      </text>
      <path d="M36 51l9 9 19-20" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Compact two-line version for dark blocks (the "standard behind it" section). */
export function PlatformCredentialsCompact() {
  const rows = [
    { glyph: <AppleGlyph size={15} />, claim: PLATFORM_CREDENTIALS.apple.claims[0], id: PLATFORM_CREDENTIALS.apple.rows[0] },
    { glyph: <GoogleGlyph size={15} />, claim: PLATFORM_CREDENTIALS.google.claims[0], id: PLATFORM_CREDENTIALS.google.rows[0] },
  ];
  return (
    <ul className="cred-compact">
      {rows.map((r) => (
        <li key={r.claim}>
          <span className="cred-compact-glyph" aria-hidden>
            {r.glyph}
          </span>
          <span className="cred-compact-claim">{r.claim}</span>
          <span className="cred-compact-id">
            {r.id.label} <b>{r.id.value}</b>
          </span>
        </li>
      ))}
    </ul>
  );
}
