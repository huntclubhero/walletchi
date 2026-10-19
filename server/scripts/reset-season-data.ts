/*
 * Wipe the season's off-chain data so a FRESH contract deploy starts clean.
 *
 * Why this exists as a script rather than a one-off query: every time we redeploy the season, the
 * DB keeps rows describing pets on contracts that no longer exist. Those rows are not merely dead
 * weight, they actively LIE. The leaderboard is built from them, so it credits new-season token ids
 * with the care counts of old-season pets, and a tester sees a pet they do not own sitting on the
 * board. Serials from a dead season also stay mapped onto token ids that now belong to somebody
 * else entirely.
 *
 * What it removes:
 *   Runner and everything cascading off it (CareSession, RunnerEvent, RunSession,
 *   RunnerDeviceRegistration are all onDelete: Cascade), plus CheckoutSession.
 *   Also HolderRewardRound + HolderRewardLeaf: they are the proof store for the OLD holder vault. A
 *   fresh vault numbers its rounds from zero again, so an old round's leaves would sit under a round
 *   id the new vault reuses, and the push engine (which reads leaves from here) would try to deliver
 *   a dead season's airdrop against the new vault.
 *   With --sybil it ALSO clears the anti-Sybil memory: MintedEmail (the one-inbox-one-pet wall)
 *   and MintSignal (the fingerprint / IP / subnet velocity history), so the same people can mint
 *   again on the new season.
 *
 * What it does NOT touch: the PUNCHCARD side (Card, Redemption, Vendor, AppleDeviceRegistration).
 * Different product, same database, and there is no reason a season reset should reach it.
 *
 * This is IRREVERSIBLE, so it refuses to run without naming the database out loud:
 *   RESET_CONFIRM_DB=<the database name in DATABASE_URL>
 *
 *   npx tsx scripts/reset-season-data.ts --sybil
 */
process.env.NODE_ENV ??= "script";
process.env.LOG_LEVEL ??= "warn";

import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

// Parse the database name out of the URL so the confirmation is about a real, specific target
// rather than a yes/no the operator can reflexively pass.
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

if ((process.env.RESET_CONFIRM_DB ?? "") !== dbName) {
  console.error(
    `Refusing to run: this permanently deletes every pet, pass and keeper record.\n` +
      `Target database is "${dbName}" on ${host}.\n` +
      `Set RESET_CONFIRM_DB=${dbName} to confirm you mean THAT database.`,
  );
  process.exit(2);
}

const alsoSybil = process.argv.includes("--sybil");

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const before = {
      runners: await prisma.runner.count(),
      careSessions: await prisma.careSession.count(),
      checkouts: await prisma.checkoutSession.count(),
      mintedEmails: await prisma.mintedEmail.count(),
      mintSignals: await prisma.mintSignal.count(),
      mintedPrivyUsers: await prisma.mintedPrivyUser.count(),
      holderRounds: await prisma.holderRewardRound.count(),
    };
    console.log(`\nTarget: ${dbName} on ${host}`);
    console.log("Before:", JSON.stringify(before));

    // Order matters only where a relation is NOT cascading; the Runner children all cascade, but
    // deleting them explicitly keeps the counts honest in the report below.
    const careSessions = await prisma.careSession.deleteMany({});
    const events = await prisma.runnerEvent.deleteMany({});
    const runSessions = await prisma.runSession.deleteMany({});
    const devices = await prisma.runnerDeviceRegistration.deleteMany({});
    const runners = await prisma.runner.deleteMany({});
    const checkouts = await prisma.checkoutSession.deleteMany({});
    const holderLeaves = await prisma.holderRewardLeaf.deleteMany({});
    const holderRounds = await prisma.holderRewardRound.deleteMany({});

    let mintedEmails = { count: 0 };
    let mintSignals = { count: 0 };
    let mintedPrivyUsers = { count: 0 };
    if (alsoSybil) {
      mintedEmails = await prisma.mintedEmail.deleteMany({});
      mintSignals = await prisma.mintSignal.deleteMany({});
      // The one-keeper-one-pet wall now ALSO claims the verified Privy identity,
      // not just the inbox. Clearing the emails without clearing these would
      // permanently lock every returning tester out of the next season: their
      // inbox frees up but their Privy identity stays claimed forever, and the
      // refusal would look like an unrelated bug months later.
      mintedPrivyUsers = await prisma.mintedPrivyUser.deleteMany({});
    }

    console.log("\nDeleted:");
    console.log(`  careSessions             ${careSessions.count}`);
    console.log(`  runnerEvents             ${events.count}`);
    console.log(`  runSessions              ${runSessions.count}`);
    console.log(`  runnerDeviceRegistrations ${devices.count}`);
    console.log(`  runners                  ${runners.count}`);
    console.log(`  checkoutSessions         ${checkouts.count}`);
    console.log(`  holderRewardRounds       ${holderRounds.count}   (+ ${holderLeaves.count} leaves; the old vault's proofs)`);
    if (alsoSybil) {
      console.log(`  mintedEmails             ${mintedEmails.count}   (one-inbox-one-pet wall reset)`);
      console.log(`  mintedPrivyUsers         ${mintedPrivyUsers.count}   (verified-identity wall reset)`);
      console.log(`  mintSignals              ${mintSignals.count}   (fingerprint / IP history reset)`);
    } else {
      console.log(`  mintedEmails             SKIPPED (pass --sybil to reset the mint gate too)`);
      console.log(`  mintSignals              SKIPPED`);
    }

    const after = {
      runners: await prisma.runner.count(),
      careSessions: await prisma.careSession.count(),
      checkouts: await prisma.checkoutSession.count(),
      mintedEmails: await prisma.mintedEmail.count(),
      mintSignals: await prisma.mintSignal.count(),
      mintedPrivyUsers: await prisma.mintedPrivyUser.count(),
      holderRounds: await prisma.holderRewardRound.count(),
    };
    console.log("\nAfter:", JSON.stringify(after));
    // Read back rather than trusting the delete counts: this is the one place where "I ran the
    // delete" and "the data is gone" are worth distinguishing.
    const dirty =
      after.runners > 0 ||
      after.careSessions > 0 ||
      after.checkouts > 0 ||
      after.holderRounds > 0 ||
      (alsoSybil &&
        (after.mintedEmails > 0 || after.mintSignals > 0 || after.mintedPrivyUsers > 0));
    console.log(dirty ? "\nRESULT: rows remain, reset INCOMPLETE\n" : "\nRESULT: clean\n");
    process.exit(dirty ? 1 : 0);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
