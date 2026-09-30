/**
 * RESET THE MINT GATE ONLY. Leaves every pet, pass and keeper record ALONE.
 *
 * WHY THIS EXISTS SEPARATELY. `reset-season-data.ts` calls
 * `prisma.runner.deleteMany({})` UNCONDITIONALLY: its `--sybil` flag only ADDS
 * the gate tables, it does not subtract the season wipe. Reaching for it to
 * "let someone mint again" destroys every living pet and every issued pass, and
 * pass authTokens are unrecoverable, so those passes die permanently. This
 * script is the safe half: it clears ONLY the anti-Sybil memory.
 *
 * Clears:
 *   MintedEmail      the one-inbox-one-pet wall
 *   MintedPrivyUser  the one-verified-identity-one-pet wall (the supply wall)
 *   MintSignal       fingerprint / IP history (FORENSICS ONLY now: these signals
 *                    are advisory, so clearing this table changes who can mint
 *                    by exactly nothing. Cleared for a clean slate, not a fix.)
 *
 * Touches NOTHING else: no Runner, no CareSession, no device registration.
 *
 * READ THIS BEFORE RUNNING. Clearing the two walls lets keepers who ALREADY OWN
 * a pet mint another one. That is the entire effect. It does NOT help someone
 * who was refused before minting: a velocity refusal happens at step 7 of the
 * gate and the atomic reserves are steps 8 and 9, so a blocked keeper never had
 * a row here to clear. If the complaint is "it says I already minted" but they
 * own no pet, the fix is the STUCK-MINT REAPER (reapStuckMints), which now runs
 * at boot and on an interval and hands those claims back automatically.
 *
 * Usage (from server/):
 *   DATABASE_URL=... RESET_CONFIRM_DB=<dbname> npx tsx scripts/reset-sybil-only.ts
 */

import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

let dbName = "";
let host = "";
try {
  const u = new URL(url);
  dbName = u.pathname.replace(/^\//, "").split("?")[0] ?? "";
  host = u.hostname;
} catch {
  console.error("DATABASE_URL is not parseable.");
  process.exit(2);
}

// Same confirmation shape as the season reset: naming the database is a
// deliberate act, unlike a yes/no an operator can pass reflexively.
if ((process.env.RESET_CONFIRM_DB ?? "") !== dbName) {
  console.error(
    `Refusing to run: this clears the one-pet-per-keeper walls, letting existing\n` +
      `keepers mint additional pets. Pets and passes are NOT touched.\n` +
      `Target database is "${dbName}" on ${host}.\n` +
      `Set RESET_CONFIRM_DB=${dbName} to confirm you mean THAT database.`,
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const before = {
      runners: await prisma.runner.count(),
      mintedEmails: await prisma.mintedEmail.count(),
      mintedPrivyUsers: await prisma.mintedPrivyUser.count(),
      mintSignals: await prisma.mintSignal.count(),
    };
    console.log(`\nTarget: ${dbName} on ${host}`);
    console.log("Before:", JSON.stringify(before));

    const mintedEmails = await prisma.mintedEmail.deleteMany({});
    // Clearing emails WITHOUT clearing identities would lock every returning
    // keeper out permanently: their inbox frees up but the Privy identity stays
    // claimed forever, and months later the refusal reads as an unrelated bug.
    const mintedPrivyUsers = await prisma.mintedPrivyUser.deleteMany({});
    const mintSignals = await prisma.mintSignal.deleteMany({});

    console.log("\nDeleted:");
    console.log(`  mintedEmails             ${mintedEmails.count}   (one-inbox-one-pet wall reset)`);
    console.log(`  mintedPrivyUsers         ${mintedPrivyUsers.count}   (verified-identity wall reset)`);
    console.log(`  mintSignals              ${mintSignals.count}   (forensics history; advisory, blocked nobody)`);

    const after = {
      runners: await prisma.runner.count(),
      mintedEmails: await prisma.mintedEmail.count(),
      mintedPrivyUsers: await prisma.mintedPrivyUser.count(),
      mintSignals: await prisma.mintSignal.count(),
    };
    console.log("\nAfter:", JSON.stringify(after));

    // The whole point of this script is that the season survives it. Prove it
    // rather than trusting the query above: a regression that started deleting
    // runners here would be catastrophic and completely silent.
    if (after.runners !== before.runners) {
      console.error(
        `\nFAILED: runner count changed ${before.runners} -> ${after.runners}. ` +
          `This script must NEVER touch pets. Investigate before running again.`,
      );
      process.exit(1);
    }
    if (after.mintedEmails > 0 || after.mintedPrivyUsers > 0) {
      console.error("\nFAILED: gate tables are not empty after the reset.");
      process.exit(1);
    }
    console.log(`\nOK. ${after.runners} pets and their passes are untouched; the mint gate is clear.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
