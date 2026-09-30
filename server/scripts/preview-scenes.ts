// Renders every care scene variant + the hatch reveal to a single self-contained
// HTML body for visual review. Not shipped; a dev/preview aid.
import { writeFileSync } from "node:fs";
import { careScene, hatchScene, SCENE_CSS, SCENE_VARIANTS } from "../src/runner/scenes.js";

const seeds = ["7", "42", "128", "911"]; // spread across body hues
const actions = ["feed", "water", "play", "toy", "explore"] as const;

function cell(label: string, svg: string): string {
  return `<div class="cell"><div class="lbl">${label}</div>${svg}</div>`;
}

let cards = "";
let i = 0;
for (const a of actions) {
  for (let v = 0; v < SCENE_VARIANTS[a]; v++) {
    const seed = seeds[i++ % seeds.length]!;
    cards += cell(`${a} · variant ${v} · pet #${seed}`, careScene(a, seed, v));
  }
}
for (const seed of seeds) cards += cell(`HATCH · pet #${seed}`, hatchScene(seed));

const body = `<style>
  body{margin:0;background:radial-gradient(130% 90% at 50% 0%, #15505F, #0E2A3A);font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;color:#EAF3F5;padding:26px 18px}
  h1{text-align:center;font-size:22px;margin:0 0 4px}
  .sub{text-align:center;color:#8FD3E8;font-size:13px;margin:0 0 24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;max-width:1080px;margin:0 auto}
  .cell{background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:16px;padding:14px 12px 6px;text-align:center}
  .lbl{font-size:11px;letter-spacing:1.2px;color:#B7D2DA;text-transform:uppercase;margin-bottom:6px;font-weight:700}
${SCENE_CSS}
</style>
<h1>WALLETCHI care scenes</h1>
<p class="sub">Live animations · seeded to real pet hues · shown on the pass-tap care + confirm pages</p>
<div class="grid">${cards}</div>`;

writeFileSync(process.argv[2] ?? "scene-preview.html", body);
console.log("wrote", process.argv[2] ?? "scene-preview.html");
