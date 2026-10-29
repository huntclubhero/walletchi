// Privy client config. Sign-in is entirely optional: when the app id is absent
// (founder demo without Privy) every sign-in surface hides and the email-only
// custodial mint works exactly as before.
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() || "";
export const PRIVY_ENABLED = PRIVY_APP_ID.length > 0;

// Self-custody mint gate, deliberately SEPARATE from PRIVY_ENABLED. Privy can be
// configured for the header sign-in / "My pets" surfaces while the mint still
// runs the simple email flow. The inline email->code->auto-mint flow only turns
// on when BOTH Privy is enabled AND this flag is set, which must not happen until
// the SERVER verifies Privy tokens (PRIVY_APP_SECRET on Render) and requires
// self-custody. Flipping it on before then would make users do the code step for
// nothing (the mint would still be custodial): pure friction, no ownership.
export const SELF_CUSTODY_ENABLED =
  PRIVY_ENABLED && (process.env.NEXT_PUBLIC_SELF_CUSTODY?.trim() || "") === "1";
