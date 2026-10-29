import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Runner } from "../store/types.js";
import { RUNNER_THEME, TESTNET_COPY, runnerNumber } from "./theme.js";
import { emailHash, normalizeEmail } from "./sybil.js";

// PII discipline for the checkout hot path: logs carry the anti-sybil email
// hash (plus the serial for correlation), never the raw inbox address.
const toHash = (email: string) => emailHash(normalizeEmail(email));

interface RunnerReceiptLinks {
  appleUrl: string;
  googleUrl: string | null;
  cardUrl: string;
}

// Mail opens links in a fresh Safari page, and a bare .pkpass leaves that page black on iOS 27
// (it looks broken after Add). Send the email to the pass's landing page instead (routes.ts 9a),
// which shows the pet and loads the pass in the same tab. Anything that is not a capability
// .pkpass URL passes through untouched.
export function appleLandingUrl(appleUrl: string): string {
  return /\/runner-passes\/[^/]+\/[^/]+\.pkpass$/.test(appleUrl) ? appleUrl.replace(/\.pkpass$/, "/add") : appleUrl;
}

function button(href: string, label: string, bg: string, fg: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto;">
    <tr><td align="center" bgcolor="${bg}" style="border-radius:10px;">
      <a href="${href}" target="_blank"
        style="display:inline-block;padding:15px 34px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:${fg};text-decoration:none;border-radius:10px;">
        ${label}</a>
    </td></tr></table>`;
}

export function buildRunnerReceiptHtml(
  runner: Runner,
  links: RunnerReceiptLinks,
  /** Set while a sellout-gated season has NOT started: feeding is refused until
   *  the collection mints out, so the card must not tell the keeper to tap Feed. */
  seasonPending?: { minted: number; maxSupply: number } | null,
): string {
  const number = runnerNumber(runner.tokenId, runner.serial);
  // THE OPENING INSTRUCTION MUST BE POSSIBLE. On a sellout-gated season that has
  // not started, care() is refused, so "tap Feed to hatch it" sends every keeper
  // straight into a refusal on the one email they actually read.
  const leadLine = seasonPending
    ? `${RUNNER_THEME.petLabel} ${number} is yours. Add it to your wallet now. The season begins the moment the collection mints out (${seasonPending.minted} of ${seasonPending.maxSupply} so far), and every pet starts its life together at that instant. Nothing is ticking yet.`
    : `${RUNNER_THEME.petLabel} ${number} is yours. Add it to your wallet. If it is still an egg, tap Feed on the card to hatch it.`;
  const testnetRow =
    config.ROBINHOOD_NETWORK === "testnet"
      ? `<tr><td align="center" style="padding-top:20px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#FFD9C9;"><b>${TESTNET_COPY.label}.</b> ${TESTNET_COPY.body}</span>
        </td></tr>`
      : "";
  const googleButton = links.googleUrl
    ? button(links.googleUrl, "Save to Google Wallet", "#F5F0E8", "#111111")
    : "";
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#0E2A3A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0E2A3A;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr><td align="center" style="padding-bottom:8px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:800;letter-spacing:2px;color:#EAF3F5;">${RUNNER_THEME.gameName}</span>
        </td></tr>
        <tr><td align="center" style="padding-bottom:24px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#B7D2DA;">${RUNNER_THEME.tagline}</span>
        </td></tr>
        <tr><td align="center" style="padding-bottom:8px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:18px;color:#EAF3F5;">${leadLine}</span>
        </td></tr>
        <tr><td align="center" style="padding:16px 0;">
          ${button(appleLandingUrl(links.appleUrl), "Add to Apple Wallet", "#111111", "#EAF3F5")}
          ${googleButton}
        </td></tr>
        <tr><td align="center" style="padding-top:16px;">
          <a href="${links.cardUrl}" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#F98F76;text-decoration:none;">View your pet on chain</a>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#B7D2DA;">Every care spends a little CARE from your pet&rsquo;s own account, and it starts with a float of it. The buttons on the back of the card act on chain; the front updates when the chain does.</span>
        </td></tr>
        ${testnetRow}
        <tr><td align="center" style="padding-top:28px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#7FA4AE;">Can&rsquo;t find the buttons? On iPhone, open the card and tap <b>&#8226;&#8226;&#8226;</b> at the top right: they are on the back. On Android they sit right on the card. Keep all five needs fed, every day. Miss any one and your pet is gone.</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendRunnerReceiptEmail(
  runner: Runner,
  links: RunnerReceiptLinks,
  seasonPending?: { minted: number; maxSupply: number } | null,
): Promise<{ sent: boolean; id?: string; reason?: string }> {
  const html = buildRunnerReceiptHtml(runner, links, seasonPending);
  const subject = `Your ${RUNNER_THEME.gameName} card is ready`;

  if (!config.modes.emailLive) {
    logger.warn(
      { serial: runner.serial, toHash: toHash(runner.email), subject, htmlBytes: html.length },
      "EMAIL STUB: runner receipt not sent (no RESEND_API_KEY). HTML built successfully.",
    );
    return { sent: false, reason: "stub" };
  }

  const { Resend } = await import("resend");
  const resend = new Resend(config.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: config.EMAIL_FROM,
    to: runner.email,
    subject,
    html,
  });
  if (error) {
    logger.error({ err: error }, "resend runner send failed");
    return { sent: false, reason: String(error) };
  }
  logger.info(
    { id: data?.id, serial: runner.serial, toHash: toHash(runner.email) },
    "runner receipt email sent",
  );
  return { sent: true, id: data?.id };
}

/** Memorial email sent once when a pet dies: a keepsake + a fresh pass link so the
 *  keeper can re-add the soulbound memorial pass if the in-place update didn't
 *  reach their wallet. Same link shape as the receipt (now rendering memorial). */
/** Which need ran out, for the memorial email (Hunt 2026-10-21: "let them know why"). */
export interface DeathCause {
  need: string; // display name, e.g. "Toy"
  lastAtMs: number; // when that need was last cared for
  others: string[]; // the needs that were still fine
}

export function deathCauseLine(cause: DeathCause | null | undefined): string {
  if (!cause) return "";
  const when = new Date(cause.lastAtMs).toUTCString().replace(/:\d\d GMT$/, " UTC");
  return `Why it died: ${cause.need} ran out. Its last ${cause.need} was ${when}. Each of the five needs (Feed, Water, Play, Toy, Explore) runs on its own clock, so every one needs a tap each day; tapping one twice does not reset the others.`;
}

export function buildRunnerMemorialHtml(runner: Runner, links: RunnerReceiptLinks, cause?: DeathCause | null): string {
  const number = runnerNumber(runner.tokenId, runner.serial);
  const born = runner.bornAt ? new Date(runner.bornAt).getTime() : null;
  const died = runner.diedAt ? new Date(runner.diedAt).getTime() : Date.now();
  const days = born ? Math.max(1, Math.round((died - born) / 86_400_000)) : null;
  const cared = runner.careCount ?? 0;
  const livedLine = days
    ? `It lived ${days} ${days === 1 ? "day" : "days"} and was cared for ${cared} ${cared === 1 ? "time" : "times"}.`
    : `It was cared for ${cared} ${cared === 1 ? "time" : "times"}.`;
  const googleButton = links.googleUrl
    ? button(links.googleUrl, "Save memorial to Google Wallet", "#F5F0E8", "#111111")
    : "";
  const pet = RUNNER_THEME.petLabel;
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#0E2A3A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0E2A3A;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr><td align="center" style="padding-bottom:8px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:800;letter-spacing:2px;color:#EAF3F5;">${RUNNER_THEME.gameName}</span>
        </td></tr>
        <tr><td align="center" style="padding-bottom:20px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#B7D2DA;">In memory of ${pet} ${number}</span>
        </td></tr>
        <tr><td align="center" style="padding-bottom:8px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:18px;color:#EAF3F5;">Your ${pet.toLowerCase()} has passed on. ${livedLine}</span>
        </td></tr>
        ${cause ? `<tr><td align="center" style="padding-bottom:8px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#FFD9C9;">${deathCauseLine(cause)}</span>
        </td></tr>` : ""}
        <tr><td align="center" style="padding-bottom:8px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#B7D2DA;">Its memorial pass is yours to keep. Add it to your wallet so it stays with you.</span>
        </td></tr>
        <tr><td align="center" style="padding:16px 0;">
          ${button(appleLandingUrl(links.appleUrl), "Add memorial to Apple Wallet", "#111111", "#EAF3F5")}
          ${googleButton}
        </td></tr>
        <tr><td align="center" style="padding-top:16px;">
          <a href="${links.cardUrl}" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#F98F76;text-decoration:none;">Visit its memorial on chain</a>
        </td></tr>
        <tr><td align="center" style="padding-top:28px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#7FA4AE;">A ${RUNNER_THEME.gameName} never truly leaves: its memorial lives on chain forever.</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendRunnerMemorialEmail(
  runner: Runner,
  links: RunnerReceiptLinks,
  cause?: DeathCause | null,
): Promise<{ sent: boolean; id?: string; reason?: string }> {
  const html = buildRunnerMemorialHtml(runner, links, cause);
  const number = runnerNumber(runner.tokenId, runner.serial);
  const subject = `In memory of your ${RUNNER_THEME.petLabel} ${number}`;

  if (!config.modes.emailLive) {
    logger.warn(
      { serial: runner.serial, toHash: toHash(runner.email), subject, htmlBytes: html.length },
      "EMAIL STUB: memorial not sent (no RESEND_API_KEY). HTML built successfully.",
    );
    return { sent: false, reason: "stub" };
  }

  const { Resend } = await import("resend");
  const resend = new Resend(config.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: config.EMAIL_FROM,
    to: runner.email,
    subject,
    html,
  });
  if (error) {
    logger.error({ err: error }, "resend memorial send failed");
    return { sent: false, reason: String(error) };
  }
  logger.info({ id: data?.id, serial: runner.serial, toHash: toHash(runner.email) }, "runner memorial email sent");
  return { sent: true, id: data?.id };
}
