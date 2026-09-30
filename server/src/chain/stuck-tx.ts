import { logger } from "../logger.js";

// STUCK-TX POLICY (runbook STEP 8C). A relayer write used to be send-and-wait
// with no timeout: a transaction the chain accepted but never mined (fee spike,
// dropped from the mempool) parked waitForTransactionReceipt forever, and
// because every signer's writes are serialized through a SerialQueue, ONE stuck
// tx silently froze every mint, care write and gasless claim behind it. During
// the endgame that is a fairness incident, not an ops one.
//
// The policy: pin the nonce and fees explicitly, wait a bounded time for the
// receipt, and on timeout REPLACE the same nonce with a fee-bumped copy, a
// bounded number of times. The nonce pin is what makes replacement possible at
// all; it is safe here ONLY because each signer's writes are serial (the queue
// guarantees no second in-flight send from the same account).
//
// Pure logic with injected transport so the smoke suite can drive every branch
// (stuck, replaced, raced, exhausted) without a chain.

export interface StuckTxFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface StuckTxOverrides extends StuckTxFees {
  nonce: number;
}

export interface StuckTxReceipt {
  status: string;
  [key: string]: unknown;
}

export interface StuckTxDeps {
  /** Sign + broadcast with the pinned nonce/fees; resolves to the tx hash. */
  send(overrides: StuckTxOverrides): Promise<string>;
  /** Resolve the receipt or THROW after timeoutMs (viem's timeout behavior). */
  waitReceipt(hash: string, timeoutMs: number): Promise<StuckTxReceipt>;
  /** Next nonce including mempool (blockTag pending): what a fresh send would use. */
  pendingNonce(): Promise<number>;
  /** Next nonce from mined state only (blockTag latest): proves our nonce landed. */
  minedNonce(): Promise<number>;
  /** Current fee estimate for the first attempt. */
  fees(): Promise<StuckTxFees>;
}

export interface StuckTxOptions {
  /** How long to wait for a receipt before treating the tx as stuck. */
  waitMs: number;
  /** How many fee-bumped replacements to attempt after the original send. */
  maxBumps: number;
}

/** Thrown when the nonce never mines through every replacement attempt. The
 *  message is deliberately greppable: this is the alert the runbook asked for. */
export class StuckTxError extends Error {
  constructor(label: string, nonce: number, hashes: string[]) {
    super(
      `STUCK TX: ${label} nonce ${nonce} did not mine after ${hashes.length} attempt(s) ` +
        `(hashes: ${hashes.join(", ")}). The signer's queue is blocked until this nonce ` +
        `resolves; check the RPC and the signer's balance, then re-run the write.`,
    );
    this.name = "StuckTxError";
  }
}

// Each replacement must outbid the last by enough that nodes accept it (most
// require +10%); 25% keeps replacements decisive without burning the tank.
const BUMP_NUMERATOR = 125n;
const BUMP_DENOMINATOR = 100n;

export function bumpedFees(fees: StuckTxFees): StuckTxFees {
  const bump = (v: bigint) => {
    const next = (v * BUMP_NUMERATOR) / BUMP_DENOMINATOR;
    // Integer floor on a tiny fee (testnet gas is ~0.01 gwei) could round a
    // bump away entirely; a replacement that does not raise the fee is refused
    // by the node, so force at least +1 wei of progress.
    return next > v ? next : v + 1n;
  };
  return {
    maxFeePerGas: bump(fees.maxFeePerGas),
    maxPriorityFeePerGas: bump(fees.maxPriorityFeePerGas),
  };
}

/** True for the send errors that mean "this nonce already resolved", which is
 *  a RACE WE WON (the earlier attempt mined while we were preparing the bump),
 *  never a failure. Matched loosely: node error strings are not standardized. */
export function nonceAlreadyResolved(err: unknown): boolean {
  return /nonce too low|already known|already imported/i.test(String(err));
}

/**
 * Send one write under the stuck-tx policy. Returns the receipt of WHICHEVER
 * attempt mined (original or a replacement: they share the nonce, so exactly
 * one can).
 */
export async function sendWithStuckTxPolicy(
  label: string,
  deps: StuckTxDeps,
  opts: StuckTxOptions,
): Promise<StuckTxReceipt> {
  const nonce = await deps.pendingNonce();
  let fees = await deps.fees();
  const hashes: string[] = [];
  hashes.push(await deps.send({ nonce, ...fees }));

  // One of `hashes` mined (minedNonce moved past ours): find its receipt. Newest
  // first: the most recent replacement is the likeliest to have landed.
  const recoverMined = async (): Promise<StuckTxReceipt | null> => {
    for (const h of [...hashes].reverse()) {
      try {
        return await deps.waitReceipt(h, 10_000);
      } catch {
        // Not this attempt: a replaced tx has no receipt.
      }
    }
    return null;
  };

  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.waitReceipt(hashes[hashes.length - 1]!, opts.waitMs);
    } catch {
      // Timed out. If the nonce advanced, one of OUR attempts mined and we were
      // simply watching the wrong hash.
      if ((await deps.minedNonce().catch(() => nonce)) > nonce) {
        const receipt = await recoverMined();
        if (receipt) return receipt;
      }
      if (attempt >= opts.maxBumps) {
        const err = new StuckTxError(label, nonce, hashes);
        logger.error({ label, nonce, hashes }, err.message);
        throw err;
      }
      fees = bumpedFees(fees);
      logger.warn(
        { label, nonce, attempt: attempt + 1, maxFeePerGas: String(fees.maxFeePerGas) },
        "stuck tx: replacing with a fee bump",
      );
      try {
        hashes.push(await deps.send({ nonce, ...fees }));
      } catch (err) {
        if (nonceAlreadyResolved(err)) {
          const receipt = await recoverMined();
          if (receipt) return receipt;
        }
        throw err;
      }
    }
  }
}
