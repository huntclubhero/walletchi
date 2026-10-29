# CHI VALLEY pass link: env and rollout

The CHI VALLEY link on the back of a LIVING pet's pass (Apple back field `valley`, Google link `valley`,
right after CHI NIGHT). Code: `server/src/runner/valley.ts`. Contract with the valley:
chi-valley `valley/HOLDERS.md` section 1a. Test: `cd server && npm run valley-link:check`.

How it works: the pass carries a STABLE signed link,
`${PUBLIC_BASE_URL}/valley/<serial>?s=<tag>`, the same HMAC tag as the care links (keyed by the pet's
authToken peppered with CARE_LINK_SECRET), so it dies on a claim and on "Reset my pass links". Nothing
expiring is ever in the pass. A tap verifies the tag, counts against a per-pet limit (10 a minute), takes
a FRESH ownerOf read (a sold but unclaimed pet gets "This Chi has a new home"; an unreadable chain gets a
503 with Retry-After), then mints a 5 minute join token and answers
`302 ${VALLEY_URL}/#join=<token>` with Cache-Control no-store. The token is
`b64url(payload) + "." + b64url(HMAC_SHA256(VALLEY_TOKEN_SECRET, "chi-valley-join-v1." + b64url(payload)))`
with payload `{ v, aud, serial, tokenId, owner, name, number, stage, form, iat, exp, jti }`.

## Env (WALLETCHI API service on Render)

| Name | Default | Meaning |
| :- | :- | :- |
| `VALLEY_ENABLED` | false | The link on every living pet. |
| `VALLEY_SERIALS` | empty | Comma list of serials that get the link while ENABLED is off. |
| `VALLEY_URL` | https://chi-valley.onrender.com | Where a tap lands. chi-valley-dev while testing, chi-valley at release. Never touches the pass. Blank counts as the default. |
| `VALLEY_TOKEN_SECRET` | unset | The join token key, shared with the valley server. Dedicated (never CARE_LINK_SECRET), 32+ characters. Unset or shorter: no pass carries the link, /valley is a 404, one warn at boot. |

NONE of these is in passTemplateHash, on purpose. A template hash change runs the boot refresh in "bundle"
mode, which compares the art too, and the art moves with the time of day, so even an inert deploy would push
every card whose art drifted since its last version. The link is a back FIELD, so the scheduled background
refresh (every PASS_REFRESH_MINUTES, fields only, ignores the ALIVE headcount) pushes exactly the cards that
gain or lose it, and the same run patches their Google objects (silently; Google skips unchanged objects).
The Apple push waits in quiet hours (IDLE_QUIET_START_HOUR to IDLE_QUIET_END_HOUR, a non-vital change waits for
morning) but the Google patch does not, so flip the switches in daytime to keep both in one run.

While the secret is set, `GET /game/<serial>/sprite/<face>.png` also answers the `VALLEY_URL` origin (and only
it) with Access-Control-Allow-Origin plus Vary: Origin, so the valley may load sprites directly. The valley
proxies them by default. The sprite route is public `max-age=3600`, so a copy cached before the header
existed may lack it for up to an hour: cache bust (`?v=valley1`) if the valley ever loads them directly.

Walk frames for the valley: `GET /game/<serial>/frame/<face>/<pose>.png`, face in happy, aim, yell, dizzy and pose
in stand (byte-identical to the sprite), step (left foot lifted; mirror it for the other step) and hop (feet
tucked, in place). Same 544x416 canvas, same gate (gameEnabledFor), render semaphore, LRU, 1 hour cache and
valley CORS as the sprite. A FINAL FORM without feet draws the same in every pose.

## Rollout (HOLDERS.md section 5; one step at a time, freeze every other card change during each step)

1. Merge with every flag off and deploy. The boot log must say "boot pass refresh: template unchanged, pushing
   nothing". Every card is byte-identical.
2. In DAYTIME (outside quiet hours): set `VALLEY_TOKEN_SECRET` (the same value on the valley service) and
   `VALLEY_SERIALS=<pet serial>` (Hunt's card), then a MANUAL Render deploy (an env
   PUT does not redeploy; the old instance serves for about 2 minutes after handover, so check the pass diff
   hostname).
3. Wait for the next scheduled background refresh (up to PASS_REFRESH_MINUTES, 60 by default). It pushes his
   card only. The pass diff log for his serial must show ONLY `backFields.valley` added (once per dict:
   `storeCard`, and `posterGeneric` if his poster is on), `cm null`, `notifying 0`. Do NOT use
   `POST /internal/passes/refresh` to hurry it: that runs content mode, which counts the ALIVE headcount and
   can push the whole roster.

   How to confirm delivery for one serial (Render logs of the API service):
   - The run: `silent pass refresh finished` with `reason: "scheduled"`, `mode: "background"`. Its `pushed`
     count is the number of cards that changed (1 for Hunt alone; every other card must be `unchanged`).
   - The phone fetching it: search the serial and `pass diff`. Expect one line with `changed` 1 (2 with the
     poster), `notifying 0`, and `changes` holding only `storeCard.backFields.valley` (and
     `posterGeneric.backFields.valley`), `kind: "added"`, `cm: null`. Any other path in `changes` means
     something else moved: stop and look before the next step. No `pass diff` line for a serial = its phone has
     not fetched yet ("sent", not "received").
   - Google: the same scheduled run patches the Google object of a card that gained the link (no message,
     silent). Check on Hunt's Android card if he has one: "Play CHI VALLEY" under the links.
4. Ask Hunt: got a banner, or no banner? Stop on a banner.
5. Daytime: append the testers' serials (2 or 3 testers) to `VALLEY_SERIALS`, manual deploy,
   wait for the next scheduled refresh, read the log again.
6. Daytime: `VALLEY_ENABLED=true`, manual deploy, wait for the next scheduled refresh (living pets; tombstones
   get no link). Read the log again: only `backFields.valley` added, notifying 0. Say "sent", never
   "received", until holders confirm.

Never add a changeMessage to the link (Apple builds the banner from attributedValue, so it shows raw HTML).
Announce only through `POST /internal/announce`, Hunt's words, his card first.
Rollback: clear `VALLEY_ENABLED` and `VALLEY_SERIALS` (or unset the secret) and deploy; the next scheduled
refresh removes the link, which iOS shows silently.

Link previews: `/valley` answers HEAD with 405 (GET only), and a GET from a known preview fetcher (iMessage's
facebookexternalhit/Twitterbot, WhatsApp, Slackbot, Discordbot, TelegramBot, LinkedInBot and the like) gets a
plain "Open this link from your WALLETCHI pass to play." page: no chain read, no tap spent, no token.
