import { BRAND, ERC, ERC_PR_URL } from "@/lib/brand";
import { PlatformCredentialsCompact } from "./PlatformCredentials";

/** The ERC behind the demo. Honest about what exists: a discussion thread today, a PR link only
 *  once ERC_PR_URL is set, and platform claims only from PLATFORM_CREDENTIALS (masked, verified). Pet721
 *  implements IERC721WalletPass (1b0ee1d): supportsInterface(0xef5f1e71), a GATED passURI manifest,
 *  PassUpdate on mint / transfer / care / prize push, BatchPassUpdate on settlement + reward pushes.
 *  Every sentence below must stay true of that contract. */
export function StandardBlock() {
  return (
    <section id="standard" className="tx-band tx-band-lav">
      <div className="mx-auto grid w-[min(1180px,92vw)] items-center gap-10 lg:grid-cols-[1fr_1fr]">
        <div>
          <div data-reveal className="eyebrow" style={{ color: "#ffd9c9" }}>
            The standard behind it
          </div>
          <h2 data-reveal className="display mt-3" style={{ fontSize: "clamp(1.8rem, 5vw, 3.6rem)", color: "#fff", transitionDelay: "0.05s" }}>
            {ERC.number}: {ERC.title}.
          </h2>
          <p data-reveal className="mt-4 text-lg" style={{ color: "#efeafb", transitionDelay: "0.1s" }}>
            {BRAND.name} is a live implementation of {ERC.number} ({ERC.status}). The pet contract answers{" "}
            <span className="mono">supportsInterface({ERC.interfaceId})</span>, so any marketplace or
            wallet that reads the standard can find the pass behind a token and offer the button.
          </p>
          <ul data-reveal className="tx-spec-list mt-6" style={{ transitionDelay: "0.14s" }}>
            <li>
              <b>passURI</b>: like tokenURI, it points at the pet&apos;s pass manifest. Here it runs
              gated: only the proven owner gets the Apple and Google links, and a transfer rotates them.
            </li>
            <li>
              <b>PassUpdate</b>: the contract emits it on every mint, transfer and care, telling the
              card to refresh. BatchPassUpdate covers reward pushes and the season&apos;s end.
            </li>
            <li>
              <b>An authorization floor</b>: a pass is a bearer artifact, so every on-chain action it
              can reach needs proof of control plus a fresh ownerOf read.
            </li>
          </ul>
          <div data-reveal className="mt-6" style={{ transitionDelay: "0.16s" }}>
            <PlatformCredentialsCompact />
          </div>
          <div data-reveal className="mt-7 flex flex-wrap gap-3" style={{ transitionDelay: "0.18s" }}>
            <a href={ERC.discussionUrl} target="_blank" rel="noreferrer" className="btn tx-btn-light">
              Read the discussion <span aria-hidden>↗</span>
            </a>
            {ERC_PR_URL && (
              <a href={ERC_PR_URL} target="_blank" rel="noreferrer" className="btn tx-btn-outline">
                The ERC pull request <span aria-hidden>↗</span>
              </a>
            )}
          </div>
        </div>

        <div data-reveal className="tx-code" style={{ transitionDelay: "0.1s" }}>
          <div className="tx-code-bar">
            <span />
            <span />
            <span />
            <em className="lcd">IERC721WalletPass · implemented by the pet contract</em>
          </div>
          <pre>
            <code>
              <span className="c">{`// ERC-165 id ${ERC.interfaceId}`}</span>
              {"\n"}
              <span className="k">interface</span> IERC721WalletPass {"{"}
              {"\n"}
              {"  "}<span className="k">event</span> <span className="f">PassUpdate</span>(uint256 <span className="k">indexed</span> tokenId);
              {"\n"}
              {"  "}<span className="k">event</span> <span className="f">BatchPassUpdate</span>(uint256 fromTokenId, uint256 toTokenId);
              {"\n\n"}
              {"  "}<span className="k">function</span> <span className="f">passURI</span>(uint256 tokenId)
              {"\n"}
              {"    "}<span className="k">external view returns</span> (string <span className="k">memory</span>);
              {"\n"}
              {"}"}
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}
