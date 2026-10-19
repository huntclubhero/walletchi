// WHERE IS THIS PAGE RUNNING? The two add-to-wallet buttons are the whole point of the
// mint, and they only work in a real browser: Apple Wallet installs a .pkpass through
// Safari, Google Wallet saves through Chrome (or the Google app). Inside the in-app
// browser of X, Instagram, TikTok and friends the Apple sheet often never appears and
// the Google save can fail silently, and on a computer a .pkpass download is a file,
// not a pass. The 2026-10-13 launch logs showed exactly that: every mobile keeper who
// minted and did NOT add the pass had come straight from the tweet, inside the X app.
//
// Pure function over the user-agent string so it is trivially testable and never
// touches `navigator` during server rendering (call it from an effect).

export type BrowserPlatform = "ios" | "android" | "desktop";

export interface BrowserContext {
  platform: BrowserPlatform;
  /** True when the page is inside another app's embedded browser (not Safari / Chrome). */
  inApp: boolean;
  /** The host app when we can name it ("X", "Instagram", ...). Null when unknown. */
  appName: string | null;
}

const NAMED_APPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Twitter for iPhone|TwitterAndroid|Twitter for iPad/i, "X"],
  [/\bInstagram\b/i, "Instagram"],
  [/\bBarcelona\b/i, "Threads"],
  [/FBAN|FBAV|FB_IAB|FB4A/i, "Facebook"],
  [/\bMessenger\b|FBMD/i, "Messenger"],
  [/TikTok|musical_ly|BytedanceWebview|Bytedance/i, "TikTok"],
  [/\bSnapchat\b/i, "Snapchat"],
  [/LinkedInApp/i, "LinkedIn"],
  [/\bDiscord\b/i, "Discord"],
  [/\bTelegram\b/i, "Telegram"],
  [/\bReddit\b/i, "Reddit"],
  [/\bLine\//i, "LINE"],
  [/\bGSA\//i, "the Google app"],
];

export function detectBrowserContext(ua: string | undefined | null): BrowserContext {
  const s = ua ?? "";
  const platform: BrowserPlatform = /iPhone|iPad|iPod/i.test(s)
    ? "ios"
    : /\bAndroid\b/i.test(s)
      ? "android"
      : "desktop";

  const named = NAMED_APPS.find(([re]) => re.test(s));
  if (named) return { platform, inApp: true, appName: named[1] };

  if (platform === "ios") {
    // Real iOS browsers all carry a "Safari/" token (Safari, Chrome "CriOS", Firefox
    // "FxiOS", Edge "EdgiOS"). A bare WKWebView does not. Safari View Controller does,
    // and it also handles passes, so it correctly reads as a real browser here.
    const inApp = !/\bSafari\//i.test(s);
    return { platform, inApp, appName: null };
  }
  if (platform === "android") {
    // Android's system WebView stamps "; wv)" into the UA; Chrome itself does not.
    const inApp = /;\s*wv\)/i.test(s) || (/\bVersion\/\d/i.test(s) && /\bChrome\//i.test(s));
    return { platform, inApp, appName: null };
  }
  return { platform, inApp: false, appName: null };
}

/** Human label for the callout: "the X app", "the Instagram app", or "this app". */
export function inAppLabel(ctx: BrowserContext): string {
  if (!ctx.inApp) return "";
  if (!ctx.appName) return "this app";
  return ctx.appName.startsWith("the ") ? ctx.appName : `the ${ctx.appName} app`;
}
