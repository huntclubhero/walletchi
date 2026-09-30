import { logger } from "../logger.js";
import { StuckTxError, bumpedFees, nonceAlreadyResolved, type StuckTxFees } from "./stuck-tx.js";

// THE WRITE PIPELINE (launch fix 1, 2026-09-25). One per signing account.
//
// WHY THIS EXISTS. Before it, every relayer write was send-and-wait INSIDE the
// serial queue: the next mint could not even be broadcast until the previous
// mint's receipt came back, which on the real chain meant one receipt poll (4 s
// with viem's default) plus five RPC round trips per pet. The load rehearsal
// (LOAD-REHEARSAL-2026-09-25.md) put that at 7 to 13 mints a minute: 77 to 140
// minutes for the 1,000-pet collection, with the web client giving up on the
// 20th keeper in line. The chain itself was never the limit; our own waiting was.
//
// WHAT IT DOES INSTEAD. Nonces come from a LOCAL COUNTER (synced from the node's
// pending count on first use and after any failed broadcast), so a write can be
// signed and broadcast the moment the previous one is on the wire. Receipts are
// confirmed by ONE watcher per account that polls the node's MINED nonce once a
// second and fetches a receipt only for the entries that count says have landed:
// one round trip a second for the whole backlog instead of one per in-flight
// transaction, which is what keeps a 1,000-deep burst inside an RPC budget.
//
// THE THREE INVARIANTS THAT MAKE PIPELINING SAFE:
//   1. submit() is SERIALIZED by the caller (the account's SerialQueue). The
//      counter hands out each nonce exactly once, in order, and nothing else
//      may draw a nonce for this account. Replacements reuse a nonce they
//      already own; they never draw a new one.
//   2. A gap is never left behind. If a broadcast throws, we cannot know
//      whether the node kept the transaction, so the counter is dropped and
//      re-read from the node's PENDING count before the next write. A nonce
//      that never reached the node is reissued by that re-read; one that did
//      is skipped by it. Either way the next write lands on the right number.
//   3. "Stuck" is judged at the HEAD only. With ordered nonces, the lowest
//      unmined nonce is the only one whose replacement can help: everything
//      behind it is waiting for it, not for the chain. The head gets the same
//      policy the old per-write path had (wait, re-broadcast the original
//      bytes once, then fee-bump the same nonce a bounded number of times),
//      and the entries behind it get their own turn when they become head.
//
// A write never resolves as "failed" while its nonce is still unmined AND still
// ours to replace; it fails only when the node reports the nonce consumed by a
// hash we did not send (replaced from outside, or a gap we filled ourselves after
// a restart) or when the head exhausts its replacements. Those are the same two
// terminal verdicts the old path had; nothing new is swallowed.
//
// Pure logic with injected transport, like stuck-tx.ts, so the smoke suite
// drives every branch (ordering, unknown hash, head bump, exhausted head,
// broadcast failure resync, restart re-attach) without a chain.

export interface PipelineReceipt {
  status: string;
  transactionHash?: string;
  [key: string]: unknown;
}

export interface PipelineOverrides extends StuckTxFees {
  nonce: number;
}

/** What a signer hands back. `raw` present = signed locally and NOT yet broadcast:
 *  the pipeline will broadcast it (after `beforeBroadcast`). `raw` absent = the
 *  signer broadcast it itself (viem writeContract) and only knows the hash. */
export interface SignedWrite {
  hash: string;
  raw?: string;
}

export interface PipelineDeps {
  /** Next nonce including the mempool (blockTag pending): the counter's seed and resync source. */
  pendingNonce(): Promise<number>;
  /** Next nonce from mined state only (blockTag latest): what the watcher polls. */
  minedNonce(): Promise<number>;
  /** The receipt for a hash, or null when the node has none. MUST return null only
   *  on a definite "not found"; a transport error must THROW so it is never counted
   *  as evidence that the hash was replaced. */
  receipt(hash: string): Promise<PipelineReceipt | null>;
  /** Current fee estimate (cached by the pipeline for feeCacheMs). */
  fees(): Promise<StuckTxFees>;
  /** Broadcast locally signed bytes. Required for any signer that returns `raw`. */
  broadcastRaw?(raw: string): Promise<string>;
}

export interface PipelineOptions {
  /** How long the HEAD may sit unmined before the stuck policy acts on it. */
  waitMs: number;
  /** Fee-bumped replacements of the head before giving up on it. */
  maxBumps: number;
  /** Watcher cadence (the "pollingInterval"): one minedNonce read per tick. */
  pollMs: number;
  /** Ticks a mined nonce may go without a receipt for any of our hashes before it
   *  is declared consumed by someone else's transaction. Transport errors do not count. */
  unknownHashTicks?: number;
  /** How long one fee estimate serves consecutive submits. */
  feeCacheMs?: number;
}

export interface WriteTicket {
  label: string;
  nonce: number;
  hash: string;
}

export interface WriteHandle extends WriteTicket {
  /** Resolves with the receipt of WHICHEVER attempt mined; rejects on the two terminal verdicts. */
  receipt: Promise<PipelineReceipt>;
}

interface Entry {
  /** Registration order. Two entries CAN share a nonce (a write re-issued on a nonce the
   *  node had dropped, after a counter resync); the node holds at most one of them, and
   *  the newer is the likelier, so it is the one the head policy acts on. */
  seq: number;
  label: string;
  nonce: number;
  hashes: string[];
  raw: string | null;
  fees: StuckTxFees;
  resend: (ov: PipelineOverrides) => Promise<SignedWrite>;
  bumps: number;
  rebroadcast: boolean;
  headSince: number | null;
  missingTicks: number;
  resolve: (r: PipelineReceipt) => void;
  reject: (e: Error) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class WritePipeline {
  private next: number | null = null;
  private seq = 0;
  private readonly entries = new Map<number, Entry>(); // by seq
  private readonly promises = new WeakMap<Entry, Promise<PipelineReceipt>>();
  private loop: Promise<void> | null = null;
  private feeCache: { at: number; fees: StuckTxFees } | null = null;
  private readonly unknownHashTicks: number;
  private readonly feeCacheMs: number;

  constructor(
    private readonly signer: string,
    private readonly deps: PipelineDeps,
    private readonly opts: PipelineOptions,
  ) {
    this.unknownHashTicks = opts.unknownHashTicks ?? 30;
    this.feeCacheMs = opts.feeCacheMs ?? 10_000;
  }

  /** Broadcast but not yet mined (or otherwise settled). */
  get unmined(): number {
    return this.entries.size;
  }

  /** The nonce the next submit will use, or null when it must be re-read from the node. */
  get nextNonce(): number | null {
    return this.next;
  }

  /**
   * Sign and broadcast one write on the next nonce. MUST be called under the
   * account's SerialQueue (invariant 1). Resolves as soon as the transaction is on
   * the wire; the receipt is awaited separately through the returned handle.
   *
   * `sign` may broadcast itself (returns only the hash) or sign locally (returns
   * `raw`), in which case `beforeBroadcast` runs with the ticket BEFORE the bytes
   * go out. That ordering is what makes a restart recoverable: a mint persists
   * its hash and nonce to the row first, so a process that dies one instruction
   * later still leaves enough behind to find (or rule out) the transaction.
   * `resend` signs AND broadcasts a replacement with the overrides it is given.
   */
  async submit(
    label: string,
    sign: (ov: PipelineOverrides) => Promise<SignedWrite>,
    resend: (ov: PipelineOverrides) => Promise<SignedWrite>,
    beforeBroadcast?: (ticket: WriteTicket) => Promise<void>,
  ): Promise<WriteHandle> {
    if (this.next === null) {
      this.next = await this.deps.pendingNonce();
      logger.info({ signer: this.signer, nonce: this.next }, "write pipeline: nonce counter synced from the node");
    }
    const nonce = this.next;
    const fees = await this.cachedFees();
    let signed: SignedWrite;
    try {
      signed = await sign({ nonce, ...fees });
    } catch (err) {
      // A signer that broadcasts itself may have thrown AFTER the node accepted
      // the transaction (a timeout on the reply). Not knowable from here, so the
      // counter is re-read from pending state before the next write (invariant 2).
      this.next = null;
      throw err;
    }
    const ticket: WriteTicket = { label, nonce, hash: signed.hash };
    const hashes = [signed.hash];
    if (signed.raw !== undefined) {
      if (beforeBroadcast) {
        try {
          await beforeBroadcast(ticket);
        } catch (err) {
          // Nothing reached the node: the nonce is simply handed back, no re-read needed.
          this.next = nonce;
          throw err;
        }
      }
      if (!this.deps.broadcastRaw) throw new Error(`${this.signer} pipeline: signer returned raw bytes but no broadcastRaw is configured`);
      try {
        const reported = await this.deps.broadcastRaw(signed.raw);
        if (reported && reported.toLowerCase() !== signed.hash.toLowerCase()) {
          logger.warn({ signer: this.signer, label, nonce, local: signed.hash, node: reported }, "write pipeline: node reported a different hash than the local one; watching both");
          hashes.unshift(reported);
        }
      } catch (err) {
        this.next = null;
        throw err;
      }
    }
    this.next = nonce + 1;
    return this.register(label, nonce, hashes, signed.raw ?? null, fees, resend);
  }

  /**
   * Re-attach a write a PREVIOUS PROCESS broadcast (restart recovery). The nonce and
   * hash come from durable storage; `resend` rebuilds and broadcasts a replacement
   * if the head policy needs one. Settles on the same two terminal verdicts as a
   * fresh submit, so the caller's finalize/fail path is identical.
   */
  attach(ticket: WriteTicket, resend: (ov: PipelineOverrides) => Promise<SignedWrite>, fees?: StuckTxFees): WriteHandle {
    for (const existing of this.entries.values()) {
      if (existing.hashes.includes(ticket.hash)) {
        return { label: existing.label, nonce: existing.nonce, hash: ticket.hash, receipt: this.promiseOf(existing) };
      }
    }
    return this.register(ticket.label, ticket.nonce, [ticket.hash], null, fees ?? { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }, resend);
  }

  private promiseOf(e: Entry): Promise<PipelineReceipt> {
    return this.promises.get(e)!;
  }

  private register(
    label: string,
    nonce: number,
    hashes: string[],
    raw: string | null,
    fees: StuckTxFees,
    resend: (ov: PipelineOverrides) => Promise<SignedWrite>,
  ): WriteHandle {
    let resolve!: (r: PipelineReceipt) => void;
    let reject!: (e: Error) => void;
    const receipt = new Promise<PipelineReceipt>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const seq = ++this.seq;
    const entry: Entry = { seq, label, nonce, hashes, raw, fees, resend, bumps: 0, rebroadcast: false, headSince: null, missingTicks: 0, resolve, reject };
    this.entries.set(seq, entry);
    this.promises.set(entry, receipt);
    this.ensureLoop();
    return { label, nonce, hash: hashes[0]!, receipt };
  }

  private async cachedFees(): Promise<StuckTxFees> {
    const now = Date.now();
    if (this.feeCache && now - this.feeCache.at < this.feeCacheMs) return this.feeCache.fees;
    const fees = await this.deps.fees();
    this.feeCache = { at: now, fees };
    return fees;
  }

  private ensureLoop(): void {
    if (this.loop) return;
    this.loop = this.run().finally(() => {
      this.loop = null;
      // Entries registered while the loop was winding down would otherwise wait forever.
      if (this.entries.size) this.ensureLoop();
    });
  }

  // The watcher. Runs only while something is unmined; one minedNonce read per tick.
  private async run(): Promise<void> {
    while (this.entries.size) {
      await sleep(this.opts.pollMs);
      if (!this.entries.size) break;
      let mined: number;
      try {
        mined = await this.deps.minedNonce();
      } catch (err) {
        logger.warn({ signer: this.signer, err: String(err) }, "write pipeline: mined-nonce read failed; retrying next tick");
        continue;
      }
      // Lowest nonce first; among entries sharing a nonce, the newest first (see Entry.seq).
      const ordered = [...this.entries.values()].sort((a, b) => a.nonce - b.nonce || b.seq - a.seq);
      for (const e of ordered) {
        if (e.nonce < mined) await this.settleMined(e);
      }
      const head = ordered.find((e) => e.nonce >= mined && this.entries.has(e.seq));
      if (!head) continue;
      const now = Date.now();
      if (head.headSince === null) {
        head.headSince = now;
      } else if (now - head.headSince >= this.opts.waitMs) {
        await this.unstick(head);
      }
    }
  }

  // The node says this nonce has mined. One of OUR hashes must own the receipt
  // (newest attempt first: the latest replacement is the likeliest). A definite
  // miss on every hash, sustained across enough ticks, means the nonce was taken
  // by a transaction we did not send.
  private async settleMined(e: Entry): Promise<void> {
    let definiteMiss = true;
    for (const h of [...e.hashes].reverse()) {
      try {
        const r = await this.deps.receipt(h);
        if (r) {
          this.entries.delete(e.seq);
          e.resolve(r);
          return;
        }
      } catch (err) {
        definiteMiss = false;
        logger.warn({ signer: this.signer, label: e.label, nonce: e.nonce, hash: h, err: String(err) }, "write pipeline: receipt read failed; not counting it as a miss");
      }
    }
    if (!definiteMiss) return;
    e.missingTicks += 1;
    if (e.missingTicks < this.unknownHashTicks) return;
    this.entries.delete(e.seq);
    const err = new Error(
      `${this.signer} nonce ${e.nonce} (${e.label}) was mined by a transaction this process did not send ` +
        `(our hashes: ${e.hashes.join(", ")}). The write did not land.`,
    );
    logger.error({ signer: this.signer, label: e.label, nonce: e.nonce, hashes: e.hashes }, err.message);
    e.reject(err);
  }

  // The head has sat unmined for waitMs. Same policy as the old per-write path
  // plus one cheaper first step: a transaction the node never received (a lost
  // reply, a sequencer hiccup) is fixed by sending the SAME bytes again, which
  // costs nothing and cannot double-spend (same nonce, same hash).
  //
  // Whenever the head goes out again (re-broadcast or fee-bumped replacement),
  // the TAIL behind it goes out again too, in nonce order, with its original
  // bytes. Robinhood Chain is an Arbitrum Orbit chain: its sequencer does not
  // hold a traditional mempool, and a transaction whose nonce is ahead of the
  // account's next one is held only briefly and then rejected. So when one
  // transaction in the middle of a burst is lost, everything broadcast after it
  // is dropped as "nonce too high" within about a second. Without this, each of
  // those would sit as head for the full waitMs before its own re-broadcast:
  // one lost transaction in a 200-deep burst would cost 200 x 30 s, about 100
  // minutes, and keepers polling the whole time. Same bytes, same nonces, so it
  // cannot double-spend; on a chain with a real mempool the node answers
  // "already known" and nothing changes.
  private async rebroadcastTail(head: Entry): Promise<void> {
    if (!this.deps.broadcastRaw) return;
    // One set of bytes per nonce: among entries sharing a nonce the newest wins
    // (the same rule the watcher uses for the head, see Entry.seq).
    const byNonce = new Map<number, Entry>();
    for (const e of this.entries.values()) {
      if (e.nonce <= head.nonce || !e.raw) continue;
      const seen = byNonce.get(e.nonce);
      if (!seen || e.seq > seen.seq) byNonce.set(e.nonce, e);
    }
    if (byNonce.size === 0) return;
    let sent = 0;
    let refused = 0;
    let firstRefusal: string | null = null;
    for (const e of [...byNonce.values()].sort((a, b) => a.nonce - b.nonce)) {
      try {
        await this.deps.broadcastRaw(e.raw!);
        sent += 1;
      } catch (err) {
        refused += 1;
        firstRefusal ??= String(err);
      }
    }
    logger.warn(
      { signer: this.signer, headNonce: head.nonce, sent, refused, firstRefusal },
      "write pipeline: re-broadcast the tail behind the head in nonce order (already known is fine)",
    );
  }

  private async unstick(head: Entry): Promise<void> {
    const now = Date.now();
    if (head.raw && !head.rebroadcast && this.deps.broadcastRaw) {
      head.rebroadcast = true;
      head.headSince = now;
      try {
        await this.deps.broadcastRaw(head.raw);
        logger.warn({ signer: this.signer, label: head.label, nonce: head.nonce }, "write pipeline: head unmined; re-broadcast the original bytes");
      } catch (err) {
        logger.warn({ signer: this.signer, label: head.label, nonce: head.nonce, err: String(err) }, "write pipeline: re-broadcast refused (already known is fine)");
      }
      await this.rebroadcastTail(head);
      return;
    }
    if (head.bumps >= this.opts.maxBumps) {
      this.entries.delete(head.seq);
      // Whatever is in the mempool under this nonce is now unknown to us: re-read
      // the counter so the next write neither collides with it nor leaves a gap.
      this.next = null;
      const err = new StuckTxError(head.label, head.nonce, head.hashes);
      logger.error({ signer: this.signer, label: head.label, nonce: head.nonce, hashes: head.hashes }, err.message);
      head.reject(err);
      return;
    }
    const fees = bumpedFees(head.fees);
    head.bumps += 1;
    head.headSince = now;
    logger.warn(
      { signer: this.signer, label: head.label, nonce: head.nonce, attempt: head.bumps, maxFeePerGas: String(fees.maxFeePerGas) },
      "write pipeline: head stuck; replacing with a fee bump",
    );
    try {
      const signed = await head.resend({ nonce: head.nonce, ...fees });
      head.hashes.push(signed.hash);
      head.raw = signed.raw ?? null;
      head.rebroadcast = false;
      head.fees = fees;
      await this.rebroadcastTail(head);
    } catch (err) {
      if (nonceAlreadyResolved(err)) {
        // A RACE WE WON: it mined while we were preparing the bump. The next tick's
        // mined-nonce read settles it through the normal path.
        logger.info({ signer: this.signer, label: head.label, nonce: head.nonce }, "write pipeline: replacement refused because the nonce already resolved");
        return;
      }
      logger.warn({ signer: this.signer, label: head.label, nonce: head.nonce, err: String(err) }, "write pipeline: replacement send failed; will retry after waitMs");
    }
  }
}
