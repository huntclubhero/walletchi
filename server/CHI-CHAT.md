# CHI CHAT: the holders' room

One room. Every living Chi's keeper can open it from a CHAT link on the back of the pass and
nowhere else. Telegram-styled, one URL, the whole history visible to everyone in the room. Pure
talk: no tokens, no chain writes, no season state. Code: `src/runner/chat.ts`.

## How the door works

1. The pass carries `/chat/<serial>?s=<tag>`. The tag is the same HMAC capability the care links
   and CHI VALLEY use (`sign.ts`, keyed by the pet's authToken peppered with CARE_LINK_SECRET), so
   it dies on a secondary-market claim and on "Reset my pass links". Nothing expiring goes into
   the pass, so the push gate never re-pushes a card for it.
2. The tap verifies the tag, takes a FRESH on-chain `ownerOf` read (a sold-but-unclaimed pet is
   refused), then sets an HttpOnly, SameSite=Lax cookie scoped to `/chat` (a second tag with a
   different payload, so the cookie can never be turned back into a pass link) and redirects to
   `/chat`.
3. `/chat` is the room. Without the cookie it is a closed door. The cookie (7 days) is re-checked on
   every request: a rotated authToken, a dead pet or a pet out of the rollout is signed out at once,
   and the room and every post re-read the owner (cached 60 s) so a sold-but-unclaimed pet is shown
   the door too.
4. Link previews (iMessage, WhatsApp, Discord, Telegram) get a plain page, no cookie, no chain
   read. HEAD is a 405. Ten taps a minute per pet.

## Rollout switches (Render env)

| Setting | Meaning |
|---|---|
| `CHAT_SERIALS` | comma list of serials whose pass carries the link (Hunt's card first) |
| `CHAT_ENABLED` | `true` opens the room to every LIVING pet |
| `CHAT_MUTED_SERIALS` | these pets can read but not post |

Both switches default off: every pass is byte-identical until one is set. The link has no
`changeMessage` (silent on iOS), and no chat setting is in `passTemplateHash`, so the scheduled
background refresh pushes exactly the cards that gain the link. A Render env change needs a
deploy to take effect (env PUT does not redeploy).

Rollout, in order: (1) `CHAT_SERIALS=<Hunt's serial>`, deploy, Hunt taps, reports got/no banner;
(2) testers' serials; (3) `CHAT_ENABLED=true`. Daytime only, never during a mint, never while
reminders are due.

## The name

The first open shows "Pick your name" (the Chi's face, one field, Start chatting). The name is
saved per pet in `ChatName`, so it survives a new phone, a new cookie and a links reset. Rules:
2 to 20 characters of letters, numbers, spaces and `_ . - '`; unique across the room ignoring
case and spacing; a few house words reserved (walletchi, hunt, halldon, admin, mod...). Tapping
your avatar in the room opens the same screen to rename. Bubbles show the chosen name with the
Chi's number beside it, so identity stays anchored to the pet on chain, and the avatar is the
pet's own pixel face from its traits. `DELETE /internal/chat/names/<serial>` clears a name (the
keeper picks again; open rooms show the pass name meanwhile).

## GIFs (GIPHY)

Set `GIPHY_API_KEY` on Render (developers.giphy.com, a free API key, not an SDK key) and the
composer gains a GIF button: a picker with trending and search, "Powered by GIPHY" shown as their
terms ask. The page never talks to GIPHY: searches go through `/chat/api/gifs` with the server's
key (5 minute cache), and a GIF post sends only the gif id, which the server resolves itself and
stores as `{id,url,w,h}` on the line (so a line can never carry an arbitrary URL; only
`*.giphy.com` media, rating pg-13). The room's CSP admits `https://*.giphy.com` images. Unset
key = no button, GIF posts refused. Same pace and mute rules as text.

## Moderation

- `POST /internal/passes/push/<serial>` (bearer): push ONE card now through the normal content gate
  (only if it changed). For a per-serial rollout during quiet hours, when the hourly refresh would
  hold the new link until morning.

- `GET /internal/chat` (bearer INTERNAL_STATUS_TOKEN): open streams, Chis online, the rollout
  settings and the latest lines.
- `DELETE /internal/chat/messages/<id>`: soft delete (the row keeps `deletedAt`; readers skip it;
  every open room removes the bubble live).
- `CHAT_MUTED_SERIALS`: read only for those pets.

## Limits

- 500 characters per message (code points, so an emoji is one), plain text only, control
  characters dropped. The page escapes everything; links are not clickable.
- One message per 1.5 s and 20 a minute per pet. The global per-IP limiter applies on top.
- The room boots with the newest 60 lines and pages up on scroll. Live lines arrive over a
  server-sent event stream (heartbeat every 25 s, 1,500 streams max) with a 20 s catch-up poll
  underneath it, so a deploy handover or a dropped connection never loses a line.

## Data

`ChatMessage` (migration `20261028000000_chat_message`): id (the room's order), serial, tokenId,
body, deletedAt, createdAt. Additive; nothing else changes.

## Checks

`npm run chat:check` (137 checks, in-memory store + MockChain): the pass field and Google link
only in the rollout, byte-identical passes otherwise, the template hash untouched, the background
gate pushing exactly the gaining card, the tag (wrong, missing, care tag, valley tag, cookie tag,
unpeppered), the cookie attributes, the room page lockdown, the text rules, pace, muting, paging,
the stream (message, delete, presence), escaping, death and rotation, the owner guard, previews
and the tap limiter.
