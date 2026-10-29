// Wallet update precision: the tag + If-Modified-Since comparisons that made Wallet refetch
// unchanged passes forever (Render device logs 2026-10-06..07). Pure; no server needed.
import { formatUpdatedTag, notModifiedSince, parseUpdatedTag } from "../src/runner/pass-time.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
}

const updatedAt = new Date("2026-10-07T19:34:29.500Z");

// The "What changed?" loop: the tag we hand out must not match the same pass again.
const tag = formatUpdatedTag(updatedAt);
const since = parseUpdatedTag(tag)!;
check("ms tag round-trips exactly", since.getTime() === updatedAt.getTime());
check("pass is not newer than its own tag", !(updatedAt > since));
check("a later write is newer than the tag", new Date(updatedAt.getTime() + 1) > since);

// Devices registered before the fix hold a seconds tag.
const legacy = parseUpdatedTag(String(Math.floor(updatedAt.getTime() / 1000)))!;
check("legacy seconds tag covers its whole second", !(updatedAt > legacy));
check("legacy tag: a write in the next second is newer", new Date("2026-10-07T19:34:30.000Z") > legacy);
check("old bug reproduced: second-floored Date is older than updatedAt", updatedAt > new Date(Math.floor(updatedAt.getTime() / 1000) * 1000));

check("missing tag means everything", parseUpdatedTag(undefined) === undefined);
check("garbage tag means everything", parseUpdatedTag("abc") === undefined);
check("zero tag means everything", parseUpdatedTag("0") === undefined);

// If-Modified-Since: Last-Modified is updatedAt.toUTCString() (seconds), echoed back.
const lastModified = updatedAt.toUTCString();
check("echoed Last-Modified answers 304", notModifiedSince(lastModified, updatedAt));
check("old bug reproduced: raw ms compare refused the 304", !(new Date(lastModified).getTime() >= updatedAt.getTime()));
check("a write in a later second is served", !notModifiedSince(lastModified, new Date("2026-10-07T19:34:30.100Z")));
check("an older header is served", !notModifiedSince(new Date("2026-10-07T19:34:28Z").toUTCString(), updatedAt));
check("no header is served", !notModifiedSince(undefined, updatedAt));
check("unparseable header is served", !notModifiedSince("not a date", updatedAt));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
