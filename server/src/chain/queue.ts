import { logger } from "../logger.js";

// A stuck tx (RPC hang, gas spike) would otherwise let the FIFO grow without
// bound while every later write silently queues behind it. Past this depth new
// writes are SHED with a loud error the routes map to a retryable failure,
// instead of stacking minutes of latency onto every subsequent action.
//
// SIZED TO THE COLLECTION (launch fix 2). This used to be 100, from the days when
// a queued task held its slot for a whole receipt wait and 100 slots meant ten
// minutes of backlog. Since launch fix 1 a mint holds its slot only for a
// signature and one broadcast round trip (a few hundred milliseconds on the
// real chain), so the depth here is the number of keepers who clicked inside
// that drain window, not a measure of how stuck anything is. The collection is
// 1,000 pets and a viral tweet can deliver all of them inside one drain window,
// so the queue must be able to hold the ENTIRE collection: the load rehearsal
// (LOAD-REHEARSAL-2026-09-25.md) showed a 200-burst shedding half its keepers
// at the old cap with "Mint did not complete", while the checkout gates ahead
// of the queue (supply cap, hourly budget counting in-flight mints, one pet per
// inbox) already bound how many mints can ever be queued. The small headroom
// above the cap is for the engine writes that share this queue (rewards pushes,
// the sellout season start, the splitter poke). A stuck transaction can no
// longer fill this queue either: it is judged and replaced at the pipeline's
// head, and everything behind it is broadcast, not queued.
const MAX_PENDING = 1_000 + 100;

export class QueueFullError extends Error {
  constructor(signer = "relayer") {
    super(`${signer} queue full: too many pending transactions, try again shortly`);
  }
}

// Single-worker serial queue. All writes for ONE signing account go through one of
// these, so that account's nonce is never used concurrently. Tasks run FIFO, one at
// a time.
//
// ONE QUEUE PER ACCOUNT, NOT ONE PER PROCESS. The thing being serialized is a single
// wallet's nonce sequence, and a nonce belongs to an ADDRESS: viem resolves the next
// nonce per-address at send time, so two different accounts can never take the same
// one. Sharing a queue across accounts would therefore buy no extra safety and would
// cost head-of-line blocking between unrelated signers. The `signer` label keeps the
// shed/telemetry lines saying WHICH wallet backed up.
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  constructor(private readonly signer: string = "relayer") {}

  enqueue<T>(label: string, task: () => Promise<T>): Promise<T> {
    if (this.depth >= MAX_PENDING) {
      logger.error({ label, depth: this.depth, signer: this.signer }, `${this.signer} queue full; shedding task`);
      return Promise.reject(new QueueFullError(this.signer));
    }
    this.depth += 1;
    const run = this.tail.then(async () => {
      const started = Date.now();
      try {
        const result = await task();
        logger.debug({ label, ms: Date.now() - started, signer: this.signer }, `${this.signer} task done`);
        return result;
      } finally {
        this.depth -= 1;
      }
    });
    // Keep the chain alive even if a task rejects, so later tasks still run.
    this.tail = run.catch(() => undefined);
    return run;
  }

  get pending(): number {
    return this.depth;
  }
}
