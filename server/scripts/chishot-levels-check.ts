/*
 * CHI SHOT level check. Runs the real game core (server/game/chishot/core.js)
 * headless and proves two things about every level:
 *   1. The fort STANDS: left alone for 8 seconds nothing breaks and nothing dies.
 *   2. It is WINNABLE: a greedy search over plain launches (no powers) kills every
 *      gremlin inside the level's shot budget.
 * Exits nonzero on any failure. Run: npx tsx scripts/chishot-levels-check.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const dir = resolve(process.cwd(), "game", "chishot");
const sandbox: Record<string, unknown> = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(resolve(dir, "planck.min.js"), "utf8"), sandbox);
if (!sandbox.planck) {
  // UMD fallback: the bundle may have attached to module.exports instead.
  sandbox.planck = require(resolve(dir, "planck.min.js"));
}
vm.runInContext(readFileSync(resolve(dir, "core.js"), "utf8"), sandbox);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Core = sandbox.ChiCore as any;

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

type Pull = { x: number; y: number };
const candidates: Pull[] = [];
for (let deg = 5; deg <= 70; deg += 5) {
  for (const k of [0.55, 0.7, 0.85, 1]) {
    const a = (deg * Math.PI) / 180;
    candidates.push({ x: -Math.cos(a) * Core.MAX_PULL * k, y: -Math.sin(a) * Core.MAX_PULL * k });
  }
}

// Play a level with a fixed list of pulls; returns the game after it resolves.
function play(level: number, pulls: Pull[]) {
  const g = new Core.Game(level, "Round", {});
  let shot = 0;
  for (let t = 0; t < 60 * 60; t++) {
    if (g.state === "aim") {
      if (shot >= pulls.length) break;
      g.launch(pulls[shot++]);
    }
    if (g.state === "won" || g.state === "lost") break;
    g.update(1 / 60);
  }
  return g;
}

// ONLY=10 (1-based, comma list) re-measures just those levels while tuning.
const only = (process.env.ONLY ?? "").split(",").filter(Boolean).map((n) => Number(n) - 1);
for (let i = 0; i < Core.LEVELS.length; i++) {
  if (only.length && !only.includes(i)) continue;
  const L = Core.LEVELS[i];
  console.log(`\nLevel ${i + 1}: ${L.name} (${L.shots} shots)`);

  // 1. Stability: left alone for a full minute, NOTHING moves (a player can take their time).
  const idle = new Core.Game(i, "Round", {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const start = idle.ents.filter((e: any) => e.kind !== "rock").map((e: any) => { const p = e.body.getPosition(); return { e, x: p.x, y: p.y, a: e.body.getAngle() }; });
  for (let t = 0; t < 60 * 60; t++) idle.update(1 / 60);
  const broken = idle.ents.filter((e: { dead?: boolean }) => e.dead).length;
  let drift = 0;
  for (const s0 of start) { const p = s0.e.body.getPosition(); drift = Math.max(drift, Math.hypot(p.x - s0.x, p.y - s0.y), Math.abs(s0.e.body.getAngle() - s0.a)); }
  ok(broken === 0, `fort stands untouched for 60 s (${broken} pieces lost)`);
  ok(drift < 0.02, `no piece drifts over 60 s (max drift ${drift.toFixed(4)})`);

  // 2. Winnable: a small beam search over plain launches (no powers). At each shot keep the best
  // few sequences by gremlins killed, then score; stop as soon as any sequence wins.
  const BEAM = 3;
  let oneShotWins = 0;
  let beam: Pull[][] = [[]];
  let chosen: Pull[] = [];
  let best = play(i, []);
  outer: for (let s = 0; s < L.shots; s++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scored: { seq: Pull[]; kills: number; score: number; won: boolean; g: any }[] = [];
    for (const seq of beam) {
      for (const c of candidates) {
        const g = play(i, [...seq, c]);
        const won = g.state === "won";
        if (s === 0 && won) oneShotWins++;
        scored.push({ seq: [...seq, c], kills: g.gremsKilled, score: g.score, won, g });
      }
    }
    scored.sort((a, b) => (b.won ? 1 : 0) - (a.won ? 1 : 0) || b.kills - a.kills || b.score - a.score);
    const win = scored.find((x) => x.won);
    // keep the run that actually happened (the physics engine pools objects, so a replay can differ)
    if (win) { chosen = win.seq; best = win.g; break outer; }
    beam = scored.slice(0, BEAM).map((x) => x.seq);
    chosen = beam[0]!;
    best = scored[0]!.g;
  }
  console.log(`  INFO  difficulty: ${((oneShotWins / candidates.length) * 100).toFixed(0)}% of first shots win outright; a perfect player needs ${chosen.length} of ${L.shots}`);
  ok(best.state === "won", `winnable in ${chosen.length}/${L.shots} shots (killed ${best.gremsKilled}/${best.gremsTotal}, score ${best.score}, stars ${best.starsFor(best.score)})`);
}

console.log(`\nRESULT: ${failures === 0 ? "all levels pass" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
