import { config } from "../config.js";
import { SCENE_CSS } from "./scenes.js";

// WALLETCHI care actions on the pass back. TRUSTLESS CUTOVER: care() is
// OWNER-ONLY on-chain now, so the server no longer relays care (the old
// applyAction relay is retired). The pass links 302-redirect to the web care
// page where the owner signs the care; an off-server care is folded back into
// the DB by reconcileOnChainCare (idle.ts). This module keeps the shared care
// vocabulary (action names) and the standalone wallet-webview pages the
// remaining pass links (rewards collect, error pages) still render.

export type CareAction = "feed" | "water" | "play" | "toy" | "explore";

// The explicit result of a care action, rendered on the confirm page as a bold
// "Water +40" line with an animated before/after meter. FIVE-NEEDS: the label
// is the served NEED's own name (canonical order Feed/Water/Play/Toy/Explore),
// and a successful care puts that need's meter at 100%. Absent on cooldown,
// gone, and hatch pages (the hatch is its own moment).
export interface StatDelta {
  statLabel: "Feed" | "Water" | "Play" | "Toy" | "Explore";
  delta: number;
  from: number; // 0-100 before the action
  to: number; // 0-100 after the action (100 for the served need)
}

// One entry of the post-care "what next" guidance (D6): a remaining need,
// sorted by urgency by the caller, with its signed care link so the keeper can
// serve it in one tap. timeLabel is a short human window like "3h left".
export interface NextNeed {
  action: string;
  label: string;
  href: string;
  timeLabel?: string;
}

export interface PageResult {
  code: number;
  title: string;
  body: string;
  emoji: string;
  stat?: StatDelta;
  txHash?: string; // on-chain care tx (survival live only) -> Blockscout link
  updating?: boolean; // the wallet card was pushed; nudge the user to look at it
  // A live cooldown countdown. The vault enforces a per-pet gap between cares, and the single most
  // likely tap a new keeper makes lands inside it (mint-time arming feeds the pet as part of
  // minting). A static "try again in a moment" reads as a failure, so tick it down in front of
  // them and fire the care off automatically the instant it is allowed.
  countdown?: { seconds: number; retryUrl: string };
  // An animated pixel scene (inline SVG from scenes.ts) shown above the copy: the
  // pet, in the keeper's own hue, actually eating / drinking / playing. Turns a
  // blank confirmation into a moment. When present the big emoji is suppressed.
  scene?: string;
  // This care HATCHED the egg. The scene is a one-shot reveal, so the page must NOT
  // auto-close (that was the "it closed before I saw the hatch" bug): the keeper
  // ends it themselves. A scene without hatch still dwells a beat longer than a
  // bare confirm before tidying the tab away.
  hatch?: boolean;
  // An optional prominent link button (e.g. "Meet your pet" -> the pet's page on
  // a hatch). Same-origin or app URL; rendered as the primary action.
  link?: { href: string; label: string };
  // FIVE-NEEDS next-need guidance (D6, REQUIRED on the care confirm page): the
  // remaining needs sorted by urgency, each a tappable signed care link, with
  // the most urgent headlined ("Next: Water"). The links are GET care links
  // (prefetch-safe interstitial), same-origin, and carry the same HMAC
  // authority the keeper just exercised.
  nextNeeds?: NextNeed[];
}

export function isCareAction(a: string): a is CareAction {
  return a === "feed" || a === "water" || a === "play" || a === "toy" || a === "explore";
}

// The GET interstitial for a pass link (the rewards collect link uses it). Pass
// links live in wallet passes as plain GETs, and GETs get prefetched (mail
// scanners, link previews, wallet crawlers): a prefetch must never trigger the
// action. This page auto-submits a POST to the same URL (one invisible hop for
// a human; crawlers do not run JS or POST). The visible button is the no-JS
// fallback.
export function interstitialPage(
  postUrl: string,
  opts?: { sceneMarkup?: string; title?: string },
): string {
  const escUrl = postUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  // sceneMarkup is our own inline SVG (from scenes.ts); title is our own copy. Neither is user data.
  const scene = opts?.sceneMarkup;
  const title = opts?.title ?? "One moment";
  const headBlock = scene ? `<div class="scene">${scene}</div>` : `<div class="e">🐾</div>`;
  // Never "free": gas is sponsored, but a care spends CARE from the pet's own
  // account (the burn leg, 69% under the season-2 split, destroys most of it).
  // Only the gas is on us.
  const sub = scene
    ? "This lands on-chain in a moment. No gas for you: the CARE comes from your pet's own account."
    : "Getting your pet's care ready.";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WALLETCHI</title>
<style>
  body{margin:0;box-sizing:border-box;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(120% 90% at 50% 0%, #15505F, #0E2A3A);color:#EAF3F5;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;text-align:center;padding:24px}
  button{font-family:inherit}
  .card{max-width:340px}
  .e{font-size:60px;line-height:1}
  h1{font-size:22px;margin:14px 0 6px;color:#EAF3F5}
  p{color:#B7D2DA;font-size:15px;line-height:1.5;margin:0}
  .dots{margin-top:10px;color:#8FD3E8;font-size:13px;letter-spacing:3px;font-weight:800;animation:wtcpulse 1.2s ease-in-out infinite}
  @keyframes wtcpulse{0%,100%{opacity:.4}50%{opacity:1}}
  .go{margin-top:20px;background:linear-gradient(90deg,#F98F76,#FFC0A6);color:#0E2A3A;border:0;border-radius:12px;padding:14px 26px;font-size:16px;font-weight:800;cursor:pointer}
  .b{margin-top:20px;color:#F98F76;font-size:12px;letter-spacing:2px;font-weight:700}
  .scene{margin:0 auto 2px}
${scene ? SCENE_CSS : ""}
</style></head>
<body><div class="card">${headBlock}<h1>${title}</h1><p>${sub}</p>${scene ? `<div class="dots">CARING</div>` : ""}
<form id="go" method="post" action="${escUrl}"><button class="go" type="submit">Care for your pet</button></form>
<div class="b">WALLETCHI</div></div>
<script>document.getElementById("go").submit();</script>
</body></html>`;
}

// A tiny cute confirmation page in the soft palette. No em dashes. Self-contained
// inline CSS: this is a standalone wallet-webview page. When the action carried a
// stat delta it renders a bold "Hunger +20" line and a meter bar that animates
// from the before value to the after value; when the care was a real on-chain tx
// it links the hash on Blockscout AFTER the result; when the wallet card was
// pushed it adds a subtle "updating now" nudge. All three degrade gracefully
// (cooldown / gone / hatch pages simply omit them).
// Escape anything interpolated into the confirm page. Every current call site passes
// literals or chain data, so there is no live XSS, but this page is served from the
// origin that also serves capability-bearing care links, and it is one careless call
// site away from being a real one. Cheap insurance on a surface that spends money.
function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function confirmPage(r: PageResult): string {
  const s = r.stat;
  const statBlock = s
    ? `<div class="d">${esc(s.statLabel)} +${esc(s.delta)}</div>
<div class="m"><div class="mf" style="--from:${s.from}%;--to:${s.to}%"></div></div>
<div class="mv">${s.from} to ${s.to}</div>`
    : "";
  const txBlock = r.txHash
    ? `<a class="tx" href="${esc(config.robinhood.explorer)}/tx/${esc(r.txHash)}" target="_blank" rel="noopener">View on Blockscout</a>`
    : "";
  const updBlock = r.updating ? `<p class="u">Your wallet card is updating now</p>` : "";
  // The countdown POSTs the SAME signed care link again when it reaches zero, so the keeper's one
  // tap becomes one feed even though they were early. form-action 'self' covers this (same origin).
  const cd = r.countdown;
  const countdownBlock = cd
    ? `<div class="cd" id="cd">${cd.seconds}<span class="cds">s</span></div>
<form id="retry" method="POST" action="${esc(cd.retryUrl)}"></form>
<button class="feed" id="feed" disabled>Going through automatically...</button>`
    : "";
  // The animated pixel scene replaces the big static emoji when present. r.scene is
  // pre-rendered inline SVG from scenes.ts (already escaped/structured markup, not
  // user data), so it is embedded verbatim.
  const sceneBlock = r.scene ? `<div class="scene">${r.scene}</div>` : "";
  const emojiBlock = r.scene ? "" : `<div class="e">${esc(r.emoji)}</div>`;
  const linkBlock = r.link ? `<a class="primary" href="${esc(r.link.href)}">${esc(r.link.label)}</a>` : "";
  // NO next-need menu. A grid of follow-up tap targets turned a one-tap care into
  // a decision screen that sat there waiting for input, which is the opposite of
  // the point: tap the card, see it land, done. Which need is next belongs in a
  // push, not in a menu that holds the tab open. (nextNeeds is still accepted on
  // PageResult so callers do not break; it is deliberately not rendered.)
  const nextBlock = "";
  // A hatch is a one-shot reveal, so it must NOT auto-close (the old flat 4s close
  // is exactly what ate the hatch moment). Every other confirm closes itself: a
  // scene page dwells a little longer so the animation is actually seen, a plain
  // page keeps 4s.
  const autocloseMs = r.hatch ? 0 : r.scene ? 6500 : 4000;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WALLETCHI</title>
<style>
  body{margin:0;box-sizing:border-box;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(120% 90% at 50% 0%, #15505F, #0E2A3A);color:#EAF3F5;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;text-align:center;padding:24px}
  button{font-family:inherit}
  .card{max-width:340px}
  .e{font-size:60px;line-height:1}
  h1{font-size:22px;margin:14px 0 6px;color:#EAF3F5}
  p{color:#B7D2DA;font-size:15px;line-height:1.5;margin:0}
  .d{margin-top:18px;font-size:19px;font-weight:800;color:#FFC0A6}
  .m{margin:10px auto 0;width:220px;height:10px;border-radius:5px;background:rgba(234,243,245,0.16);overflow:hidden}
  .mf{height:100%;border-radius:5px;background:linear-gradient(90deg,#F98F76,#FFC0A6);width:var(--to);animation:fillup 900ms ease-out}
  @keyframes fillup{from{width:var(--from)}to{width:var(--to)}}
  .mv{margin-top:6px;font-size:12px;color:#7FA4AE}
  .tx{display:block;margin-top:16px;color:#8FD3E8;font-size:13px;text-decoration:underline}
  .u{margin-top:14px;font-size:12px;color:#7FA4AE}
  .b{margin-top:20px;color:#F98F76;font-size:12px;letter-spacing:2px;font-weight:700}
  .done{margin-top:22px;background:transparent;color:#EAF3F5;border:1px solid rgba(234,243,245,0.35);border-radius:12px;padding:11px 30px;font-size:15px;font-weight:700;cursor:pointer}
  .hint{margin-top:12px;font-size:12px;color:#7FA4AE;opacity:0;transition:opacity .4s}
  .cd{margin-top:18px;font-size:54px;font-weight:800;color:#FFC0A6;line-height:1;font-variant-numeric:tabular-nums}
  .cds{font-size:22px;font-weight:700;color:#B7D2DA;margin-left:2px}
  .feed{margin-top:18px;background:#F98F76;color:#1B2B33;border:0;border-radius:12px;padding:12px 30px;font-size:15px;font-weight:800;cursor:pointer}
  .feed[disabled]{background:rgba(249,143,118,0.35);color:#B7D2DA;cursor:default}
  .scene{margin:0 auto 2px}
  .primary{display:block;width:fit-content;margin:18px auto 0;background:linear-gradient(90deg,#F98F76,#FFC0A6);color:#0E2A3A;border:0;border-radius:12px;padding:13px 30px;font-size:16px;font-weight:800;text-decoration:none}
  .primary + .done{margin-top:12px}
  /* The hatch page is the only one with a primary button, and it used to share an inline row with
     the Blockscout link (both inline-block), so the first tap after minting rendered them jammed side
     by side. Each is its own line now: button, then link, then Done. */
  .nx{margin-top:18px}
  .nxh{font-size:15px;font-weight:800;color:#FFC0A6;margin-bottom:8px}
  .pill{display:inline-block;margin:4px;background:rgba(234,243,245,0.10);border:1px solid rgba(234,243,245,0.25);border-radius:999px;padding:8px 14px;color:#EAF3F5;font-size:13px;font-weight:700;text-decoration:none}
  .pt{margin-left:6px;color:#7FA4AE;font-weight:600}
${SCENE_CSS}
</style></head>
<body><div class="card">${sceneBlock}${emojiBlock}<h1>${esc(r.title)}</h1><p>${esc(r.body)}</p>${countdownBlock}${statBlock}${nextBlock}${linkBlock}${txBlock}${updBlock}
<button class="done" onclick="closeTab()">Done</button>
<p class="hint" id="hint">You can close this tab</p>
<div class="b">WALLETCHI</div></div>
<script>
  // Tidy up after a care action so daily feeds do not pile up Safari tabs (tester feedback 2026-08).
  // A pass link always opens a NEW tab, which cannot be reused, so instead we close this one once the
  // care is done. window.open("","_self") coaxes iOS Safari into permitting close() on a pass-opened
  // tab; if the browser still refuses, the "close this tab" hint fades in so it is obvious the care
  // already worked and the tab is safe to swipe away.
  function closeTab(){
    try { window.open("", "_self"); window.close(); } catch (e) {}
    setTimeout(function(){ var h = document.getElementById("hint"); if (h) h.style.opacity = "1"; }, 350);
  }
  // A countdown page must NOT auto-close: the whole point is that the keeper watches it tick and
  // the feed then happens. A hatch reveal (autoclose 0) also stays put so the keeper actually sees
  // the egg open. Every other terminal page tidies its own tab after a beat (longer when a scene is
  // playing so the animation is seen).
  var AUTOCLOSE = ${autocloseMs};
  var cdEl = document.getElementById("cd");
  if (!cdEl) {
    if (AUTOCLOSE > 0) setTimeout(closeTab, AUTOCLOSE);
  } else {
    var left = parseInt(cdEl.textContent, 10) || 0;
    var feedBtn = document.getElementById("feed");
    var retry = document.getElementById("retry");
    var fire = function () {
      if (feedBtn) { feedBtn.disabled = true; feedBtn.textContent = "Sending..."; }
      retry.submit();
    };
    if (feedBtn) feedBtn.addEventListener("click", fire);
    var tick = setInterval(function () {
      left -= 1;
      if (left > 0) {
        cdEl.textContent = String(left);
        return;
      }
      clearInterval(tick);
      cdEl.textContent = "0";
      if (feedBtn) { feedBtn.disabled = false; feedBtn.textContent = "Feed now"; }
      fire();
    }, 1000);
  }
</script>
</body></html>`;
}
