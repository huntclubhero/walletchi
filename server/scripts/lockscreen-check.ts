// Lock-screen warning windows (relevantDates): the card surfaces in the last hours before
// the pet dies, from the SAME chain countdown as SURVIVES, and never from a guess.
import { relevantDatesFor, LOCK_SCREEN_WARNING_HOURS } from "../src/runner/pass.js";
import { reminderDue, checkInLine, lastChanceLine, isAlertLine, dueNeeds } from "../src/runner/reminders.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` | ${detail}`}`);
}
const now = Date.parse("2026-10-09T12:00:00Z");
const H = 3600;

const healthy = relevantDatesFor(now, 20 * H);
check("healthy pet: exactly one window, the death warning (no morning pop-up)", healthy.length === 1, JSON.stringify(healthy));
check("warning window ends at the death deadline", healthy[0]!.endDate === "2026-10-10T08:00:00Z", healthy[0]!.endDate);
check(`warning window opens ${LOCK_SCREEN_WARNING_HOURS} h before death`, healthy[0]!.startDate === "2026-10-10T05:00:00Z", healthy[0]!.startDate);

const close = relevantDatesFor(now, 1 * H);
check("under the warning span: window opens now", close[0]!.startDate === "2026-10-09T12:00:00Z", close[0]!.startDate);
check("under the warning span: still ends at death", close[0]!.endDate === "2026-10-09T13:00:00Z", close[0]!.endDate);

check("no chain countdown: no window at all, never a guessed deadline", relevantDatesFor(now, null).length === 0);
check("already lapsed (0 s): no window", relevantDatesFor(now, 0).length === 0);
check("every window starts before it ends", [...healthy, ...close].every((w) => Date.parse(w.startDate) < Date.parse(w.endDate)));
check("dates carry no milliseconds", [...healthy, ...close].every((w) => /:\d\dZ$/.test(w.startDate) && /:\d\dZ$/.test(w.endDate)));

// CARE REMINDERS: two per cycle (check-in at 8h, last chance at 2h), each naming the needs due.
const base = { quietNow: false, quietSoon: false, quietSpanSec: 9 * H, checkInSec: 8 * H, lastChanceSec: 2 * H };
const CHECK = checkInLine(7 * H + 40 * 60, ["Water", "Toy", "Explore"]);
const LAST = lastChanceLine(2 * H, ["Toy", "Explore"]);
const LEGACY_CHECK = "Daily care time for Tuck Lantern: tap Water, Toy and Explore on the back of this card.";
const LEGACY_CHECK_2 = "You missed something: your Chi dies in 7h 40m. Tap Water on the back of this card to keep it alive.";
check("healthy (12h left): no reminder", reminderDue({ ...base, secondsLeft: 12 * H, lastEvent: "napping" }) === null);
check("8h left: daily check-in", reminderDue({ ...base, secondsLeft: 8 * H, lastEvent: "napping" }) === "checkin");
check("check-in already showing: not sent twice", reminderDue({ ...base, secondsLeft: 5 * H, lastEvent: CHECK }) === null);
check("2h left: last chance even with the check-in showing", reminderDue({ ...base, secondsLeft: 2 * H, lastEvent: CHECK }) === "last-chance");
check("last chance already showing: not sent twice", reminderDue({ ...base, secondsLeft: 1 * H, lastEvent: LAST }) === null);
check("last chance ignores quiet hours", reminderDue({ ...base, quietNow: true, secondsLeft: 1.5 * H, lastEvent: "napping" }) === "last-chance");
check("check-in never sent during quiet hours", reminderDue({ ...base, quietNow: true, secondsLeft: 7 * H, lastEvent: "napping" }) === null);
check("check-in sent EARLY on the last tick before quiet hours", reminderDue({ ...base, quietSoon: true, secondsLeft: 15 * H, lastEvent: "napping" }) === "checkin");
check("not early when the pet will still be fine after quiet hours", reminderDue({ ...base, quietSoon: true, secondsLeft: 20 * H, lastEvent: "napping" }) === null);
check("a care clears the line, so the next cycle can remind again", reminderDue({ ...base, secondsLeft: 7 * H, lastEvent: "Cared for on-chain." }) === "checkin");
check("already dead: nothing", reminderDue({ ...base, secondsLeft: 0, lastEvent: null }) === null);
// Hunt 2026-10-18: every reminder says what was missed, how long until the pet dies, and which taps fix it.
check("check-in says what was missed, the time left and every due need", CHECK === "Your Chi dies in 7h 40m. Tap Water, Toy and Explore on the back of this card to keep it alive.", CHECK);
check("last chance says the time left and the due needs", LAST === "Last chance: your Chi dies in 2h. Tap Toy and Explore on the back of this card now.", LAST);
check("minutes only under an hour, one need reads cleanly", lastChanceLine(3000, ["Toy"]) === "Last chance: your Chi dies in 50m. Tap Toy on the back of this card now.", lastChanceLine(3000, ["Toy"]));
check("never says 0m: the floor is 1m", lastChanceLine(5, ["Toy"]).includes("dies in 1m."), lastChanceLine(5, ["Toy"]));
check("failed needs read: says all five needs, never a guess", checkInLine(6 * H, []).includes("Tap all five needs on the back of this card"), checkInLine(6 * H, []));
check("all five due: says all five needs instead of listing them", checkInLine(6 * H, ["Feed", "Water", "Play", "Toy", "Explore"]).includes("Tap all five needs"), checkInLine(6 * H, ["Feed", "Water", "Play", "Toy", "Explore"]));
check("a card still showing the old check-in wording counts as a reminder (no second check-in)", isAlertLine(LEGACY_CHECK) && reminderDue({ ...base, secondsLeft: 5 * H, lastEvent: LEGACY_CHECK }) === null);
check("the old wording still gets its last chance", reminderDue({ ...base, secondsLeft: 2 * H, lastEvent: LEGACY_CHECK }) === "last-chance");
check("the 10-18 wording also counts as a reminder", isAlertLine(LEGACY_CHECK_2) && reminderDue({ ...base, secondsLeft: 5 * H, lastEvent: LEGACY_CHECK_2 }) === null);
check("only Feed due: the line names Feed alone", checkInLine(7 * H, ["Feed"]) === "Your Chi dies in 7h. Tap Feed on the back of this card to keep it alive.", checkInLine(7 * H, ["Feed"]));
check("no opener: the line starts with the fact", CHECK.startsWith("Your Chi dies in") && !/missed something/.test(CHECK));
const LABELS = ["Feed", "Water", "Play", "Toy", "Explore"];
check("due needs: pet 90 shape (fed, never toy/explore) names toy and explore", JSON.stringify(dueNeeds(LABELS, [20 * H, 18 * H, 22 * H, 2 * H, 2 * H], 12 * H)) === JSON.stringify(["Toy", "Explore"]));
check("due needs: most urgent first", JSON.stringify(dueNeeds(LABELS, [20 * H, 5 * H, 20 * H, 1 * H, 20 * H], 12 * H)) === JSON.stringify(["Toy", "Water"]));
check("due needs: pet 19 shape (all due together) names all five", dueNeeds(LABELS, [3 * H, 3 * H, 3 * H, 3 * H, 3 * H], 12 * H).length === 5);
check("only reminder lines raise a banner", isAlertLine(CHECK) && isAlertLine(LAST) && !isAlertLine("Your pet is napping.") && !isAlertLine(null));
check("reminder text has no em dash or double hyphen", ![CHECK, LAST].some((l) => /—|--/.test(l)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
