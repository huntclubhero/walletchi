# Load rehearsal: the mint path under a burst (2026-09-25)

Harness: `npm run load:rehearsal` (`server/scripts/load-rehearsal.ts`). Real handlers, in-memory store,
MockChain behind the real relayer queue with 150 ms per chain call, a fake Google client at 250 ms per
call, a stubbed care bundler at 1.5 s, anti-Sybil gate ON, client polling every 2 s like the shipped
MintForm. Nothing live was touched. Numbers below are from a Windows dev box (many cores); the Render
service is a single instance (runbook: Starter, 0.5 vCPU, 512 MB per AUDIT-REPORT.md).

## Serialization points and throttles (file:line)

| Where | What it does |
|---|---|
| `src/chain/queue.ts:7,29` | ONE serial queue per signer. Every `issueRunner` waits for the previous receipt. `MAX_PENDING = 100`: the 101st waiting mint is rejected immediately (`QueueFullError`), fulfillment marks the row failed, the keeper sees "Mint did not complete". |
| `src/chain/robinhood.ts:509,539,549` + `stuck-tx.ts:118` | Per mint on the real chain: 2 simulate calls, pending nonce, fee estimate, send, then `waitForTransactionReceipt`. No `blockTime` on the chain definition, so viem polls receipts every 4 s: each serialized mint costs at least 4 s plus 5 RPC round trips. |
| `src/runner/routes.ts:434,477` | Checkout reads `mintBudgetState` on-chain per request (one RTT), then the sybil gate, then `withMintCapLock` (in-process promise chain, cheap). |
| `src/runner/routes.ts:210` `inFlightMints` | per-email in-flight set (correct, no serialization across emails). |
| `src/app.ts:65` | Global per-IP limiter 120 req/min, all routes including the 2 s poll. |
| PetIssuer `setMintBudget` (showcase 200/h) | On-chain hourly mint budget, owner-adjustable without a deploy. |
| `src/runner/pass.ts:420` + `pet.ts:882` | Every `.pkpass` = 9 sharp rasters + zip + (live) PKCS7 signing via node-forge, synchronous, on every download and every Apple refresh. Certificate parse is cached (`passes/certs.ts:11`). Not behind the render semaphore by design. |
| `src/runner/google.ts:142,496,659` | No access-token cache: every ensureObject / saveUrl / patchObject does an RS256 sign + token exchange. A mint does ensureObject + saveUrl (fulfillment) + saveUrl again (pass-link): 6 Google HTTPS calls and 3 RS256 signs. |
| `src/passes/apns.ts:36` | New http2 TLS connection to Apple per push call (no reuse). |
| `src/runner/session-care.ts:102` | `scryptSync` per care-session install (fresh salt): 49 ms of blocked event loop each, measured. |

## Measured

| scenario | n | ready | errors | checkout p50/p95 | time-to-ready p50/p95/max | mints/min | loop lag p99/max | heap peak | queue peak | cpu of one core |
|---|---|---|---|---|---|---|---|---|---|---|
| mint-10 | 10 | 10 | none | 182/183 ms | 2.0/2.0/2.0 s | 271 | 37/59 ms | 112 MB | 10 | 117% |
| mint-50 | 50 | 50 | none | 219/219 ms | 4.1/8.1/8.1 s | 361 | 49/67 ms | 122 MB | 50 | 214% |
| mint-200 | 200 | 100 | relayer_queue_full x100 | 264/271 ms | 2.0/16.2/16.2 s | 365 | 70/134 ms | 106 MB | 100 | 269% |
| mint-250, budget 200/h | 250 | 100 | relayer_queue_full x150 | 412/426 ms | 2.1/16.3/18.3 s | 320 | 90/306 ms | 138 MB | 99 | 311% |
| mint-250, budget 1000/h | 250 | 100 | relayer_queue_full x150 | 275/325 ms | 2.0/14.3/16.3 s | 361 | 71/281 ms | 136 MB | 100 | 314% |
| budget-waves 3 x 90, 200/h | 270 | 200 | mint_budget_exhausted x70 (all AFTER polling, 0 refused at checkout) | 200/214 ms | 8.1/14.2/16.2 s | 268 | 48/848 ms | 143 MB | 90 | 176% |
| mixed: 50 mints + 200 care taps | 50 | 50 | none; 200/200 taps landed, tap p50/p95 2.9/3.0 s | 221/222 ms | 6.1/10.1/10.1 s | 290 | 260/470 ms | 122 MB | 50 | 233% |
| nat: 50 keepers behind one IP | 50 | 6 | 429 on register x32, pass-link x6, pkpass x6; polls 429 for 58 s | 173/173 ms | 58.5 s | 6 | 21/208 ms | 134 MB | 50 | 30% |

pkpass download p50 600 to 860 ms, max 2.7 s under load (rasterization). Invariants held in every run:
unique serials, unique tokenIds, chain-issued count equals ready rows, failed mints release the email
claim, no stuck rows, one registration per device.

## Projection

With the mock at 150 ms per write the ceiling is 360 mints/min. On the real chain the serialized cost per
mint is at least one 4 s receipt poll plus 5 RPC round trips, so 4.5 to 8.5 s per mint: 7 to 13 mints/min,
77 to 140 minutes for 1,000 pets, if every keeper waits. They will not: anything beyond 100 queued mints
is shed, the shipped MintForm stops polling after 120 s (so with 5 to 8 s per mint, about the 20th keeper
in line already sees a timeout while their pet mints anyway), and the showcase budget of 200/h stops the
chain at 200 regardless.

## Biggest bottleneck and smallest change

The single relayer queue with the 4 s receipt poll, capped at 100 pending. Smallest change: send mints
without awaiting the receipt (pin nonces from a local counter, submit back to back, confirm receipts in a
separate watcher), and set `pollingInterval` to about 1 s on the write client. That takes a mint from
4 to 8 s to a few hundred ms of serialized time and makes a 200-burst drain in under a minute. Second
change, one line: raise `MAX_PENDING` so a burst waits instead of failing. Third, no code: the owner calls
`setMintBudget(1000, 3600)` before the tweet, or the hour caps at 200.

## Is one Render instance enough?

For 1,000 mints spread over an hour, yes on throughput once the queue is fixed. Not on the burst shape: the
200-burst used 52 to 63 s of CPU here (mostly pass rasterization); on 0.5 vCPU that is 5 to 8 minutes of
CPU inside the burst, and the event loop already reached 470 to 850 ms lag on a fast box. The per-IP
limiter is the more certain failure: 50 keepers behind one campus or carrier NAT lose their passes to
429s (only 6 of 50 finished). Exempt or raise the limit for `GET /api/runner/checkout/:id`, pass-link,
pkpass and the Apple registration routes, or key the limiter on IP plus route.

## Correctness under concurrency

No duplicate serials, tokenIds or registrations. One product bug: a burst that crosses the hourly budget is
accepted at checkout (the pre-check reads the chain's `used`, which only moves when the serialized mint
runs) and fails after 2 to 16 s of polling with "Busy hour". Reserve against a local in-flight count
(`used + relayer.pending >= max`) to refuse at checkout.

Not in the repo: the Render plan, instance count, autoscaling, memory. Check the dashboard for plan (Starter
or higher; free sleeps), instance count (must stay 1: the queue, PoW nonces, rate limits and dedup sets are
in-process), health check path `/health`, and memory (heap peaked at 143 MB here before rasters and zips).

## After the launch fixes (2026-09-26, branch launch-fixes)

Same harness, same knobs (chain 150 ms, block 1 s, Google 250 ms, bundler 1.5 s, poll 2 s, budget 200/h
unless named), one process for all scenarios like the baseline. Fixes measured: relayer pipelining with one
receipt watcher (1), queue sized to the collection and checkout reserving against used + in-flight (2),
per-IP limiter windows for the keeper-flow routes (3), cached Google token, one reused APNs session, async
scrypt seal (4; Google and APNs are faked or stubbed here, so 4 shows up only through the seal), and the
MintForm patience rule, which the harness client mirrors (5).

| scenario | n | ready | errors | checkout p50/p95 | time-to-ready p50/p95/max | mints/min | loop lag p99/max | heap peak | queue peak | cpu (s / % of one core) |
|---|---|---|---|---|---|---|---|---|---|---|
| mint-10 | 10 | 10 | none | 178/179 ms | 2.0/4.0/4.0 s | 142 | 31/45 ms | 79 MB | 10 | 4.9 s / 79% |
| mint-50 | 50 | 50 | none | 175/177 ms | 6.1/10.1/10.1 s | 292 | 43/69 ms | 116 MB | 50 | 22.5 s / 181% |
| mint-200 | 200 | **200** | none | 207/240 ms | 18.2/**32.3**/34.3 s | 347 | 49/84 ms | 131 MB | 200 | 91.1 s / 250% |
| mint-250, budget 200/h | 250 | 200 | mint_busy x50, all **at checkout** | 220/230 ms | 18.2/32.3/34.3 s | 347 | 55/81 ms | 120 MB | 200 | 102.0 s / 279% |
| mint-250, budget 1000/h | 250 | **250** | none | 245/272 ms | 22.3/40.7/42.7 s | 349 | 66/224 ms | 178 MB | 250 | 135.5 s / 300% |
| budget-waves 3 x 90, 200/h | 270 | 200 | mint_busy x70, **all at checkout, 0 after polling** | 195/207 ms | 8.1/16.1/16.2 s | 291 | 39/145 ms | 121 MB | 90 | 93.6 s / 217% |
| mixed: 50 mints + 200 care taps | 50 | 50 | none; 200/200 taps landed, tap p50/p95 2.8/2.9 s | 234/234 ms | 6.1/10.1/10.1 s | 291 | **40/65 ms** | 256 MB | 50 | 24.5 s / 195% |
| nat: 50 keepers behind one IP | 50 | **50** | none (0 x 429) | 170/171 ms | 6.1/10.1/10.1 s | 293 | 40/108 ms | 273 MB | 50 | 22.5 s / 183% |

Against the baseline: mint-200 went from 100/200 (100 shed as relayer_queue_full) to 200/200 with time to
ready p95 32 s; mint-250 at 1,000/h from 100/250 to 250/250; the budget-crossing wave is now refused at
checkout (70 x 429 mint_busy with Retry-After) instead of failing after 2 to 16 s of polling; the NAT went
from 6/50 to 50/50; mixed event-loop lag fell from 260/470 ms to 40/65 ms (p99/max). Invariants held in
every scenario: unique serials, unique tokenIds, one pet per inbox, chain-issued count equals ready rows,
failed mints release the email claim, no stuck rows, one registration per device. Restart recovery of
in-flight mints is proven by the smoke suite, not this harness (a row with no ticket fails and releases its
claim; a broadcast ticket is re-attached, settled and fulfilled; a ticket the chain does not know fails
cleanly; a recovered unmined head is re-signed from the row), together with nonce resync after a failed
broadcast, same-nonce fee bumps, the unknown-hash verdict, and the tail re-broadcast behind a stuck head.

CPU per ready pet: 0.46 s at mint-200 here against 0.52 to 0.63 s in the baseline (the "% of one core" is
higher only because the same work now finishes in half the wall time). It is still mostly pkpass
rasterization on sharp's threads, so the Render sizing note above stands.

How to read these numbers. This box is shared: runs taken while other jobs were busy on it showed the same
work costing 2 to 3 x the CPU and loop maxima of 450 to 660 ms (the throughput, readiness and correctness
results did not change). The table above is a run on a quiet box. Compare the baseline on shape, not on
single-digit milliseconds.

Harness change in the same branch: budget-waves now fetches and solves every wave's proof-of-work
challenge before its probe starts, like the other scenarios. A CPU profile showed the 0.8 to 2.9 s loop
"stalls" it used to report (848 ms in the baseline table) were the harness solving the next wave's 90
challenges in-process, not the server.

Still true after the fixes: the real chain's latency is not in this harness. Mints now broadcast back to
back and one watcher polls the mined nonce once a second, so the per-mint serialized cost on the real chain
should be the sign + persist + broadcast round trips (a few hundred ms), not a 4 s receipt poll. That is
unmeasured against the live chain; the first live burst is the measurement. The owner still
has to call `setMintBudget(1000, 3600)` before the announcement, or the hour stops at 200 (now refused
cleanly at checkout).
