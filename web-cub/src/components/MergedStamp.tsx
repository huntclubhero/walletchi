import { ERC } from "@/lib/brand";

/** The day the standard landed: ERC-8426 merged into ethereum/ERCs. One stamp, used on the home hero
 *  and the docs page, linking straight to the published spec. `tone` picks cream or river ink. */
export function MergedStamp({ tone = "light" }: { tone?: "light" | "dark" }) {
  return (
    <a
      href={ERC.specUrl}
      target="_blank"
      rel="noreferrer"
      className={`merged-stamp merged-stamp-${tone}`}
      aria-label={`${ERC.number} merged into Ethereum's ERCs on ${ERC.mergedLabel}. Read the spec.`}
    >
      <span className="merged-stamp-tag">
        <span className="merged-stamp-dot" aria-hidden />
        Merged
      </span>
      <span className="merged-stamp-text">
        <span className="merged-stamp-line">
          <b>{ERC.number}</b> is in Ethereum&apos;s ERCs
        </span>
        <span className="merged-stamp-when">
          <time dateTime={ERC.mergedAt}>{ERC.mergedLabel}</time>
        </span>
      </span>
      <span className="merged-stamp-arrow" aria-hidden>↗</span>
    </a>
  );
}
