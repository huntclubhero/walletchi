# Step 2 build checklist: trustless gasless care (drop-in when JP's Alchemy key lands)

The contract half is DONE (care() owner-only, no relayer). This is the exact file-by-file change list for
the frontend + server so the build is fast + test-driven the moment we have NEXT_PUBLIC_ALCHEMY_API_KEY +
NEXT_PUBLIC_GAS_POLICY_ID. Prep already committed: `web-cub/src/lib/chain.ts`, `care.ts`, `aa-config.ts`,
env placeholders. Follow the official Alchemy x Privy 7702 example. No em dashes.

## web-cub (the new care surface)

1. **`src/lib/aa.ts` (NEW, needs the key to test).** The only untested-until-key module. Sketch:
   ```ts
   import { createSmartWalletClient } from "@alchemy/wallet-apis";      // + alchemyWalletTransport
   import { ALCHEMY_API_KEY, GAS_POLICY_ID } from "./aa-config";
   import { robinhoodChain } from "./chain";
   import { careCall, type CareAction } from "./care";
   // signer = the Privy embedded wallet wrapped as a viem account (toViemAccount, per the example)
   export async function sponsoredCare(privyWallet, tokenId: bigint, action: CareAction) {
     const client = createSmartWalletClient({
       signer, transport: alchemyWalletTransport({ apiKey: ALCHEMY_API_KEY }),
       chain: robinhoodChain, paymaster: { policyId: GAS_POLICY_ID },
     });
     return client.sendCalls([ careCall(tokenId, action) ]);  // EIP-7702 delegates at send time
   }
   ```
   Confirm the exact package name (`@alchemy/wallet-apis` per docs) + the Privy->viem signer helper
   against the official example; install it then; typecheck.

2. **A care route/page (NEW), e.g. `src/app/care/[serial]/[action]/page.tsx`.** Opened by the pass link.
   Flow: read serial+action from the path (validate isCareAction); require Privy sign-in (reuse PrivyGate);
   resolve the pet's tokenId + owner via the server API (`GET` the runner); assert the signed-in wallet ==
   the pet owner (else "claim this pet first" -> /claim); call `sponsoredCare(wallet, tokenId, action)`;
   show pending -> success (with explorerTxUrl) / error. Reuse the existing pet art + FrameShell chrome.
   Gate the whole thing on `AA_CARE_ENABLED` (fall back to the current server flow while false, so this
   ships dark until the key + cutover).

3. **Wire nothing else until cutover.** The mint (MintForm) and claim (ClaimFlow) already use Privy and are
   unchanged. Only care moves on-chain-client-side.

## server (retire the care relay at cutover)

4. **`src/runner/pass.ts` `actionUrl(...)`:** point the pass care link at the web-cub care page instead of
   the server endpoint. New: `${WEB_APP_URL}/care/${serial}/${action}`. DROP the `?s=<HMAC>` capability
   token: the owner's signature is now the proof of control (the ERC-4361 / HMAC pass-auth floor is
   satisfied by construction), so the capability-URL machinery for care is no longer needed. (Keep the
   pkpass DOWNLOAD capability + the memorial/collect links as they are; only the CARE link changes.)

5. **`src/runner/routes.ts`:** retire the care-submission routes: `GET/POST /api/runner/:serial/action/:action`
   (the interstitial + applyAction relay) AND the signed path `.../action/:action/challenge` + `.../signed`
   (owner-signs-via-AA supersedes ERC-4361). Keep everything else (passes, mint, claim SIWE, rewards,
   /internal, reads).

6. **`src/runner/actions.ts` + `src/runner/challenge.ts`:** delete `applyAction`'s relayer-care path and the
   challenge issue/verify module (no longer reachable). Keep the care-metrics counters if still wired to
   the drama feed, else drop.

7. **`src/chain/*.ts`:** the care WRITE (`careForPet` on the relayer/robinhood/mock chain clients) is no
   longer called by the server; remove it from the interface + impls (finalize + reads stay; mint stays via
   the issuer). The vault has no relayer now, so any vault-relayer read is already gone.

8. **Config:** the server no longer needs a vault care relayer key. It still needs a key for the finalize
   poke + the issuer mint relayer. Document the split. Add nothing; the Alchemy key/policy live only in
   web-cub (client-side, scoped by the policy).

## Cutover + test (with the key)
- Set NEXT_PUBLIC_ALCHEMY_API_KEY + NEXT_PUBLIC_GAS_POLICY_ID (+ NEXT_PUBLIC_PETVAULT_ADDRESS,
  NEXT_PUBLIC_ROBINHOOD_NETWORK=testnet) in the web-cub/Vercel env -> AA_CARE_ENABLED flips true.
- Testnet end-to-end: mint (Privy), open the care page, sign, confirm a REAL sponsored care landed
  (no ETH in the user's wallet, gas paid by the policy, pot/burn moved, lastCareAt reset). Check the
  Gas Manager dashboard shows the sponsored op.
- Then repoint the pass links (step 4) + retire the server relay (5-7) together, redeploy, re-verify a
  real pass-tap -> app -> sponsored care.
- Adversarial audit of the AA flow (can the paymaster be drained? can a non-owner get sponsored to care?
  policy limits; the 7702 delegation surface) before merge/deploy.

## Phase C (later): CARE-as-gas
Swap the Gas Manager sponsorship for a CARE token paymaster once Pons CARE is live + pooled (price feed).
Same care page; only the paymaster config changes.
