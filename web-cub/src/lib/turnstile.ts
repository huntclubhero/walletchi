// Cloudflare Turnstile loader (mint-time captcha, runbook STEP 8C).
//
// The site key arrives on the /api/mint/challenge response (served, not baked,
// so arming the captcha is a server env change with no web deploy). This module
// only knows how to fetch the widget script once and hand back the API.

export interface TurnstileRenderOptions {
  sitekey: string;
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
  theme?: "light" | "dark" | "auto";
}

export interface TurnstileApi {
  render(el: HTMLElement, opts: TurnstileRenderOptions): string;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<void> | null = null;

/** Inject the Turnstile script exactly once; resolves when its API is usable. */
export function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (turnstileApi()) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        // Allow a later retry instead of caching the failure forever.
        scriptPromise = null;
        reject(new Error("turnstile script failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

export function turnstileApi(): TurnstileApi | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile ?? null;
}
