# Field notes

Things that broke while 1,000 pixel pets lived in real people's wallets. What we saw, why it happened, what we changed. All on the Robinhood Chain testnet season, October 2026.

## The album that ate a CPU core

**What we saw.** The API sat at a full CPU core for three days (Oct 22 to Oct 25). Traffic was flat. No deploy, no restart. Then it dropped to a tenth of a core on its own.

**Why.** Every living pet gets three personal album pictures (banner, PFP, wallpaper), and a warm loop repainted them every 5 minutes so the album opened instantly. The picture cache held 600 entries and dropped the oldest on every insert. Three pictures times 200 pets is 600. Above 200 living pets, each warm cycle evicted its own work and started over. A 5 minute loop turned into a 25 minute loop running back to back, forever. It stopped when enough pets had died to get the count under 600. The cache had no byte limit either, so memory sat at over half the box.

**Fix.** A true LRU bounded by bytes, not entries. The warm loop paints only what is missing, at most 60 pictures a cycle, never evicts, and picks up where it left off next cycle. A keeper opening their own album still paints on demand. After the deploy the first warm took 155 seconds, every cycle after that finished in milliseconds, zero evictions, and memory went from 2.4 GB to 1.3 GB.

**Lesson.** CPU pinned for hours with flat requests is a background loop. Count the "warm done" log lines before you blame traffic. `/internal/status` now reports the warm cycle time and evictions so the next one shows up in a health check.

## iOS told people to turn us off

**What we saw.** iPhones showed holders "Some passes are receiving too many updates" and offered to disable automatic updates for WALLETCHI. On Android, cards were piling up stale messages: old "A pet just went dark" lines and expired "Last chance" warnings.

**Why.** An hourly refresh moved a global version stamp, so every pass re-downloaded about 24 times a day, plus the whole roster on every deploy. The median iPhone pulled its pass 27 times a day and 37% of those downloads were identical. Apple's device log spelled out the three crimes: pushing a pass that had not changed, answering `If-Modified-Since` with a 200 instead of a 304, and pushing to a device with nothing registered. Worst case: a keeper landed ten cares on a pet whose phone had stopped fetching, so the card kept showing CRITICAL. On Google, `addMessage` appends forever, with no expiry.

**Fix.** Push only on a real change. Proper 304s and Last-Modified. The boot refresh runs only when the pass template itself changes. No silent refresh in quiet hours. Google messages are replaced instead of appended, expire, and clear after a care. A one-time cleanup ended 1,145 stale messages on 363 Android cards. Wallet service errors went from about 50 an hour to about 1. Care taps stayed instant: batching five taps into one delayed update would have been quieter and less fun, so no.

**Lesson.** A pass that stops updating shows a living pet as dying. Holders who already hit "disable" have to turn updates back on themselves, so you only get one shot at this.

## Mass death day

**What we saw.** On Oct 22, 476 Chis died in one day. 1,000 had been minted. 338 were left.

**Why.** Three things lined up. The life clock is 24 hours from the last care. The site mint hatches the pet a few seconds after minting, which starts that clock. And a lot of people minted and never added the card to a wallet. 387 of the 476 never tapped again after the hatch. By wallet: about 90% of pets with no wallet card died that day, 59% of Google card holders, 35% of Apple card holders. Farmed accounts died almost to the last pet. Real keepers mostly lived.

**Fix.** We started recording Google saves (Google only tells you through a callback, which was being logged and never stored), showed a "add it to your wallet" banner on /me, and sent one nudge email to the keepers with an egg or a pet and no wallet card.

**Lesson.** A 24 hour clock plus an auto-hatch at mint kills every mint-and-forget keeper exactly 24 hours later. Hatch on the first tap, or give the first day a longer window. And Android reminders are the weak link to look at next.

## Two pets, one key slot

**What we saw.** One keeper with three pets in one wallet. Taps on pet 87's card worked. Taps on pet 86's card failed every time with "Could not care right now". Caring from the website worked fine. Gas was sponsored, the wallet had plenty of CARE.

**Why.** One-tap care works by granting a session key, scoped to `care()` on the vault, on the keeper's 7702 smart account. The /me page armed 86 and 87 at the same time, and both grants were signed in the same second. Simulating each session's next call showed both on the same validation slot (the same nonce key). The first tap on 87 installed that slot with 87's key, and 86's key never validated after that. Its session was used zero times.

What we know for sure: same-second grants, shared nonce key, 86 always rejected while 87 landed. What we have not proven: that the shared slot is the reason 86's signature failed (the provider error was never logged), or whether the slot is assigned by a race or by on-chain state.

**Fix.** Revoke 86's dead session so taps fall back to the signed web care page, then re-arm 86 alone on the next visit. It got a fresh slot and its next two pass taps landed. For the real fix: arm one pet at a time per owner, check the slot at install, log the provider's error text, and retire a session that fails signature checks instead of letting it fail forever.

**Lesson.** "Could not care right now" with no error text is a dead end. Log the detail.

## The chat door and Safari

**What we saw.** CHI CHAT opens only from the CHAT link on the back of a living pet's pass. The day after launch, about ten keepers (us included) were getting a closed door (403) on the bare /chat page.

**Why.** The pass link checks the pass's signed tag, reads the owner fresh from the chain, sets a cookie scoped to /chat and redirects to the room. When Safari reopens an old room tab after the cookie is gone (expired, cleared, or a different browser context), bare /chat has no session to go on. It always answered with a cold 403 page, and keepers read that as the API being broken. The pass link itself kept working every time.

**Fix.** Still a 403, but a calm one: "Tap CHAT on your WALLETCHI pass to hop back in." The server also now sends the `bye` event the page was already listening for, so a room whose access is gone closes itself on the next 25 second heartbeat.

**Lesson.** The pass link is the key. Any page a keeper can land on without it should say how to get back in, not just no.

## Round 87 and the vault that said no 1,349 times

**What we saw.** Holder rewards for round 87 (135 holders, 50 test USDG) failed every claim with `BadProof`, every cycle.

**Why.** Two API instances were alive at once during a deploy handover, and both ran the rewards job. One posted round 87's Merkle root on chain. The other had read the round counter a moment earlier, built its own tree from slightly later balances, and saved it over the first one in the database. Its own on-chain post then reverted, but the save had already happened. So the database held proofs for a tree the chain had never seen. Same 135 accounts, 78 amounts off by a few raw units.

**What saved it.** The vault checks every claim against the posted root. It refused all 1,349 bad claims. Nobody got paid a wrong amount and nothing left the vault. The round can be rebuilt offline from the chain: replaying the token transfers reproduces the posted root exactly.

**Fix.** Three guards:

- A lease row in Postgres with an expiry, so only one instance snapshots and posts a round at a time. A row, not an advisory lock, because advisory locks leak through connection poolers.
- The proof store refuses to replace a stored round with a different Merkle root unless the caller names the exact root it is replacing. An instance that loses the race on chain deletes its own unposted tree.
- Before relaying claims, the server compares each stored round's root with the vault's root on chain. A mismatched round is skipped and reported on the status page, instead of burning a reverting claim per holder every cycle.

**Lesson.** Deploy handovers mean two copies of your server, both running cron. Anything that writes "the" answer needs a lock or a create-only insert. And verify on chain: the contract was the only part of the system that was right the whole time.
