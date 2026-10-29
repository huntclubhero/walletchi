/**
 * USDG ON THE FACE CHECK (runner/usdg-front.ts, USDG_FRONT_SERIALS).
 *
 * Pins, for a listed living card: the header slot keyed "carebal" (key KEPT) reads "USD" /
 * "$10,000"; ALIVE keeps its key and label and shows just the verified number ("141", never
 * "/ 1,000"); the CARE balance is drawn as a chip into the Apple strip and the Google hero (route and
 * art version); Google's balance row reads USD BALANCE; nothing gains a changeMessage. A failed
 * USDG read shows today's CARE field exactly; a failed CARE read draws no chip. An unlisted card is
 * byte-identical (fields AND images, Apple and Google) with the switch off and with another card
 * listed. The switch is not a passTemplateHash input. Memorials and champions are never enabled.
 *
 * Run: npx tsx scripts/usdg-front-check.ts
 */
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??= "postgres://uf:uf@localhost:5432/uf";
process.env.DEMO_BYPASS_PAYMENT = "true";
process.env.PASS_STUB_MODE = "true";
process.env.EMAIL_STUB = "true";
process.env.GOOGLE_WALLET_STUB = "true";
process.env.PRIVY_APP_ID = "";
process.env.PRIVY_APP_SECRET = "";
process.env.ANTI_SYBIL_ENABLED = "false";
process.env.USDG_FRONT_SERIALS = "";
process.env.CARE_LINK_SECRET = "usdg-front-check-only-care-link-pepper-not-real";
process.env.INTERNAL_STATUS_TOKEN = "usdg-front-check-only-internal-token";

import { createHash } from "node:crypto";
const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
const { InMemoryStore } = await import("../src/store/memory.js");
const { Relayer } = await import("../src/chain/relayer.js");
const { MockChain } = await import("../src/chain/mock.js");
const { assembleRunnerPass } = await import("../src/runner/pass.js");
const { stablePassInputs } = await import("../src/runner/pass-memory.js");
const { getRunnerGoogle } = await import("../src/runner/google.js");
const { passTemplateHash } = await import("../src/runner/pass-gate.js");
const { _resetSeasonForRestartTest } = await import("../src/runner/season.js");
const { usdgFaceText, careChipFigure, usdgFrontEnabledFor } = await import("../src/runner/usdg-front.js");
import type { AppContext } from "../src/context.js";
import type { Runner } from "../src/store/types.js";
import type { AddressInfo } from "node:net";

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passes += 1;
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);

const store = new InMemoryStore();
const chain = new MockChain();
const relayer = new Relayer(chain);
const ctx = { store, relayer } as unknown as AppContext;
const server = createApp(ctx).listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
(config as { PUBLIC_BASE_URL: string }).PUBLIC_BASE_URL = base;
const cfg = config as unknown as { USDG_FRONT_SERIALS?: string; FEE_TOKEN_ADDRESS?: string };
cfg.FEE_TOKEN_ADDRESS ??= "0x2020202020202020202020202020202020202020";

async function mint(email: string): Promise<Runner> {
  const co = (await fetch(`${base}/api/runner/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }).then((r) => r.json())) as { id: string };
  let runner = await store.getRunner(co.id);
  for (let i = 0; i < 60 && runner?.status !== "ready"; i++) {
    await sleep(25);
    runner = await store.getRunner(co.id);
  }
  return runner!;
}

type Field = { key: string; label?: string; value?: string; changeMessage?: string };
type Card = { storeCard?: Record<string, Field[]> };
const fresh = async (r: Runner) => (await store.getRunner(r.serial))!;
// Every render reads fresh (the balance caches would otherwise hide a changed mock value) and carries
// a verified ALIVE line, as stablePassInputs does once the headcount is verified on-chain.
async function render(r: Runner) {
  _resetSeasonForRestartTest();
  const runner = await fresh(r);
  const p = await assembleRunnerPass(runner, { ...(await stablePassInputs(ctx, runner)), aliveLine: "141 / 1,000" });
  return { json: JSON.stringify(p.passJson), card: p.passJson as Card, strip: sha(p.images["strip@3x.png"]!) };
}
const header = (c: Card) => c.storeCard?.headerFields ?? [];
const allFields = (c: Card) => Object.values(c.storeCard ?? {}).flat();
type GoogleModule = { id: string; header: string; body: string };
const google = getRunnerGoogle() as unknown as {
  loyaltyObject: (r: Runner, ...a: unknown[]) => { heroImage?: { sourceUri: { uri: string } }; textModulesData?: GoogleModule[] };
};
const gObj = (r: Runner, care: string | null, usdg: string | null) => google.loyaltyObject(r, null, null, care, false, usdg);
const heroUri = (r: Runner, care: string | null, usdg: string | null = "$10,000") => gObj(r, care, usdg).heroImage!.sourceUri.uri;
const balanceRow = (r: Runner, care: string | null, usdg: string | null) => (gObj(r, care, usdg).textModulesData ?? []).find((m) => m.id === "carebal");
const heroPng = async (r: Runner) => {
  _resetSeasonForRestartTest();
  return sha(Buffer.from(await (await fetch(`${base}/api/runner/${r.serial}/hero.png`)).arrayBuffer()));
};

try {
  const listed = await mint("usdg-listed@walletchi.test");
  const other = await mint("usdg-other@walletchi.test");
  check("the test pets are minted with accounts", [listed, other].every((p) => p.status === "ready" && !!p.tbaAddress));
  const hashOff = passTemplateHash();

  console.log("\nthe figures");
  check("the face reads like money: whole dollars with separators, floored", usdgFaceText(10_000n * 10n ** 6n) === "$10,000" && usdgFaceText(100_999_999n) === "$100");
  check("cents only under $100", usdgFaceText(12_509_999n) === "$12.50" && usdgFaceText(0n) === "$0.00" && usdgFaceText(99_999_999n) === "$99.99");
  check("a million and up compacts", usdgFaceText(1_234_567n * 10n ** 6n) === "$1.2M" && usdgFaceText(1_000_000n * 10n ** 6n) === "$1M");
  check("the CARE chip's figure drops the ticker", careChipFigure("12,481 CARE") === "12,481" && careChipFigure(null) === undefined && careChipFigure("") === undefined);

  console.log("\nswitched off (the default)");
  const off = await render(listed);
  const offOther = await render(other);
  const heroOff = await heroPng(listed);
  const heroOffOther = await heroPng(other);
  check("no card is listed", !usdgFrontEnabledFor(listed) && !usdgFrontEnabledFor(other));
  check("ALIVE reads as today (141 / 1,000) and CARE is in the header", header(off.card).some((f) => f.key === "alive" && f.value === "141 / 1,000") && header(off.card).some((f) => f.key === "carebal"));

  console.log("\none card listed");
  cfg.USDG_FRONT_SERIALS = ` ${listed.serial} `;
  check("the listed card is enabled, the other is not", usdgFrontEnabledFor(listed) && !usdgFrontEnabledFor(other));
  check("the switch is not a passTemplateHash input", passTemplateHash() === hashOff);
  const on = await render(listed);
  const alive = header(on.card).find((f) => f.key === "alive");
  const offCare = header(off.card).find((f) => f.key === "carebal")!;
  const onBal = header(on.card).find((f) => f.key === "carebal");
  check("ALIVE keeps its key and label and shows just the verified number", alive?.label === "ALIVE" && alive.value === "141" && !on.json.includes("/ 1,000"), JSON.stringify(alive));
  check("the carebal slot (same key) reads USDG like money", onBal?.label === "USD" && onBal.value === "$10,000" && header(on.card).length === header(off.card).length, JSON.stringify(onBal));
  check("the rest of the pass JSON is unchanged (only ALIVE and the carebal slot moved)",
    on.json === off.json.replace('"value":"141 / 1,000"', '"value":"141"').replace(JSON.stringify(offCare), JSON.stringify({ key: "carebal", label: "USD", value: "$10,000" })));
  check("no field carries a changeMessage it did not carry before", allFields(on.card).filter((f) => f.changeMessage !== undefined).length === allFields(off.card).filter((f) => f.changeMessage !== undefined).length && alive?.changeMessage === undefined);
  check("the strip art carries the CARE chip (it differs from the unlisted render)", on.strip !== off.strip);
  const heroOn = await heroPng(listed);
  check("the Google hero carries the CARE chip", heroOn !== heroOff);
  check("the Google art version moves with the CARE figure", heroUri(await fresh(listed), "100 CARE") !== heroUri(await fresh(listed), null) && heroUri(await fresh(listed), "100 CARE") !== heroUri(await fresh(listed), "101 CARE"));
  check("Google's balance row reads USD BALANCE, and CARE BALANCE when the USDG read failed",
    balanceRow(await fresh(listed), "100 CARE", "$10,000")?.header === "USD BALANCE" && balanceRow(await fresh(listed), "100 CARE", "$10,000")?.body === "$10,000" &&
      JSON.stringify(balanceRow(await fresh(listed), "100 CARE", null)) === JSON.stringify({ id: "carebal", header: "CARE BALANCE", body: "100 CARE" }));
  const otherOn = await render(other);
  check("an UNLISTED card is byte-identical with another card listed (fields and strip)", otherOn.json === offOther.json && otherOn.strip === offOther.strip);
  check("an unlisted card's hero, art version and Google object are identical, even if handed a USDG value",
    (await heroPng(other)) === heroOffOther && JSON.stringify(gObj(await fresh(other), "100 CARE", "$10,000")) === JSON.stringify(gObj(await fresh(other), "100 CARE", null)));

  console.log("\nthe value moves");
  chain.mockSetFeeTokenBalance(42_000_000n * 10n ** 6n);
  const moved = await render(listed);
  const movedBal = header(moved.card).find((f) => f.key === "carebal");
  check("a new USDG balance shows on the next render, with no changeMessage", movedBal?.value === "$42M" && movedBal.changeMessage === undefined, JSON.stringify(movedBal));
  chain.mockSetFeeTokenBalance(10_000n * 10n ** 6n);

  console.log("\nfail closed");
  chain.mockSetFeeTokenBalance(new Error("rpc down"));
  const failed = await render(listed); // the render helper clears the caches: nothing read before
  check("a failed USDG read shows today's CARE field exactly (never a guess, never a gap)",
    JSON.stringify(header(failed.card).find((f) => f.key === "carebal")) === JSON.stringify(offCare) && failed.json === off.json.replace('"value":"141 / 1,000"', '"value":"141"'));
  check("the CARE chip still rides the art while only USDG is unreadable", failed.strip === on.strip);
  chain.mockSetFeeTokenBalance(10_000n * 10n ** 6n);
  const rel = relayer as unknown as { careBalanceOf: (a: string) => Promise<bigint> };
  const realCare = rel.careBalanceOf.bind(relayer);
  rel.careBalanceOf = async () => { throw new Error("care rpc down"); };
  check("a failed CARE read draws no chip on the Google hero", (await heroPng(listed)) === heroOff);
  rel.careBalanceOf = realCare;

  console.log("\nliving cards only");
  await store.updateRunner(listed.serial, { gone: true });
  check("a memorial in the list is not enabled", !usdgFrontEnabledFor(await fresh(listed)));
  await store.updateRunner(listed.serial, { gone: false, won: true });
  check("a champion in the list is not enabled", !usdgFrontEnabledFor(await fresh(listed)));
  await store.updateRunner(listed.serial, { won: false });

  console.log("\n\"all\": every living card");
  for (const v of ["all", " ALL ", "All"]) {
    cfg.USDG_FRONT_SERIALS = v;
    check(`"${v}" enables every living card, listed or not`, usdgFrontEnabledFor(await fresh(listed)) && usdgFrontEnabledFor(await fresh(other)));
  }
  check("the unlisted card renders the USDG face under \"all\"", header((await render(other)).card).find((f) => f.key === "carebal")?.label === "USD");
  await store.updateRunner(other.serial, { gone: true });
  check("\"all\" still skips a memorial", !usdgFrontEnabledFor(await fresh(other)));
  await store.updateRunner(other.serial, { gone: false, won: true });
  check("\"all\" still skips a champion", !usdgFrontEnabledFor(await fresh(other)));
  await store.updateRunner(other.serial, { won: false });
  cfg.USDG_FRONT_SERIALS = "allx";
  check("only the exact word: \"allx\" is a serial list, not everyone", !usdgFrontEnabledFor(await fresh(other)));
  cfg.USDG_FRONT_SERIALS = `${listed.serial}`;
  check("the explicit list still works", usdgFrontEnabledFor(await fresh(listed)) && !usdgFrontEnabledFor(await fresh(other)));

  console.log("\nswitched back off");
  cfg.USDG_FRONT_SERIALS = "";
  const back = await render(listed);
  check("the listed card is byte-identical to before the switch (fields and strip)", back.json === off.json && back.strip === off.strip);
  check("and its hero too", (await heroPng(listed)) === heroOff);
} finally {
  server.close();
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
