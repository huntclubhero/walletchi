/*
 * CHI SHOT. Angry Birds, starring the keeper's own WALLETCHI.
 *
 * Look: Rovio's classic cartoon recipe drawn procedurally in Canvas 2D: simple round shapes, a
 * thick outline in a darkened body hue (never black), one soft radial shade per body lit from the
 * top left, a glossy highlight, saturated characters over calmer backgrounds, wood/stone/glass with
 * four damage states, and a chunky rounded display face (Lilita One, OFL, served by us). Every
 * sprite is baked once to an offscreen canvas and drawn scaled, so nothing builds a gradient per
 * frame. Controls follow the real thing: grab the pet in the sling (it follows your finger inside the
 * pull circle), drag anywhere else to pan with momentum, pinch to zoom, double tap to zoom out, tap
 * mid-flight for the power. Physics, levels and rules live in core.js.
 */
(function () {
  "use strict";

  var Core = window.ChiCore;
  var BOOT = window.CHI || {
    title: "CHI SHOT", serial: "dev", name: "Test Pet", number: "No. 0000", shape: "Round", v: "1",
    palette: { body: "#FFDB4E", outline: "#CE9E17", belly: "#FFF1AE" },
    traits: { eyes: "Round", cheeks: "Peach", marking: "None", accent: "Sprout", pattern: "Solid", shape: "Round", accessory: "None", belly: "Cream" },
  };
  var TR = BOOT.traits || {};
  var PAL = BOOT.palette;
  var SHAPE = TR.shape || BOOT.shape || "Round";
  var SAVE_KEY = "chishot:" + BOOT.serial;
  // Carry progress over from the game's working name, once.
  try {
    var oldSave = localStorage.getItem("pslg:" + BOOT.serial);
    if (oldSave && !localStorage.getItem(SAVE_KEY)) localStorage.setItem(SAVE_KEY, oldSave);
  } catch (e) { /* storage blocked */ }
  var FONT = "'Lilita', 'Arial Rounded MT Bold', 'Arial Black', 'Helvetica Neue', sans-serif";
  var PPM = 96; // sprite DESIGN units, px per metre (all drawing code is written in these)
  // Sprites are baked at RES x the design size, so that at the closest zoom on this screen one
  // baked pixel still covers at most one device pixel: crisp on a phone and on an iPad Pro alike.
  var RES = (function () {
    var d = Math.min(window.devicePixelRatio || 1, 2), small = Math.min(window.innerWidth, window.innerHeight) || 390;
    var need = ((small / 12.5) * 1.6 * d * 1.05) / 96;
    return Math.max(1, Math.min(2.3, Math.ceil(need * 4) / 4));
  })();
  var SL = Core.SLING, PET_R = Core.PET_R;

  // ---------------------------------------------------------------- canvas
  var cvs = document.getElementById("c");
  var ctx = cvs.getContext("2d");
  var dpr = 1, W = 0, H = 0, portrait = true;
  function mk(w, h) {
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  // A sprite canvas at RES x, with its context pre-scaled so bake code draws in design units.
  function mkB(w, h) {
    var c = mk(w * RES, h * RES);
    c.getContext("2d").scale(RES, RES);
    return c;
  }
  // Draw a baked canvas at its design size.
  function blit(c, x, y) { ctx.drawImage(c, x, y, c.width / RES, c.height / RES); }
  var SA = { t: 0, r: 0, b: 0, l: 0 };
  function readSafeArea() {
    var cs = getComputedStyle(document.documentElement);
    var f = function (n) { return parseFloat(cs.getPropertyValue(n)) || 0; };
    SA = { t: f("--sat"), r: f("--sar"), b: f("--sab"), l: f("--sal") };
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    cvs.width = Math.round(W * dpr);
    cvs.height = Math.round(H * dpr);
    portrait = H >= W;
    readSafeArea();
    computeUI();
    hudCache = {};
    bakeBackdrop(theme);
    if (game) { setZoomLimits(true); cam.cx = clampCamX(cam.cx); cam.cy = clampCamY(cam.cy); }
  }

  // ---------------------------------------------------------------- UI system
  // One unit for every screen: 1.0 on a 390 pt phone, smaller on compact phones, larger (capped) on
  // tablets. Type sizes come from one scale and spacing from one 8 pt grid, both multiplied by U, so
  // every screen keeps the same proportions and rhythm. Tap targets never drop below 44 pt.
  var U = 1, TS = {}, GAP = 8, EDGE = 16, BTN_R = 22;
  function computeUI() {
    U = clamp(Math.min(W, H) / 390, 0.82, 1.45);
    TS = { cap: 13 * U, body: 16 * U, label: 20 * U, title: 28 * U, display: 40 * U };
    GAP = 8 * U;
    EDGE = 16 * U;
    BTN_R = Math.max(22, 22 * U);
  }
  function snap(v) { return Math.round(v); }

  // ---------------------------------------------------------------- utils
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var R = rng(Date.now() & 0xffff);
  function rand(a, b) { return a + (b - a) * R(); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function backOut(t) { var c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mixHex(a, b, t) {
    var x = hexRgb(a), y = hexRgb(b);
    var c = [0, 1, 2].map(function (i) { return Math.round(x[i] + (y[i] - x[i]) * t); });
    return "#" + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
  }
  function shade(h, t) { return t < 0 ? mixHex(h, "#000000", -t) : mixHex(h, "#ffffff", t); }
  function rgba(h, a) { var c = hexRgb(h); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
  function fmt(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  function rrect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function poly(g, pts) {
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.closePath();
  }
  function ell(g, x, y, rx, ry, rot) { g.beginPath(); g.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rot || 0, 0, Math.PI * 2); }
  function fillStroke(g, fill, stroke, lw) {
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
  }
  // Display text: white-ish fill, thick dark stroke, a drop shadow: the arcade look.
  function txt(g, s, x, y, size, fill, stroke, align, opts) {
    opts = opts || {};
    g.font = size + "px " + FONT;
    g.textAlign = align || "center";
    g.textBaseline = "middle";
    g.lineJoin = "round";
    g.miterLimit = 2;
    if (opts.shadow !== false) {
      g.fillStyle = "rgba(0,0,0,0.28)";
      g.fillText(s, x, y + size * 0.1);
    }
    if (stroke) {
      g.lineWidth = opts.sw || Math.max(2, size * 0.22);
      g.strokeStyle = stroke;
      g.strokeText(s, x, y);
    }
    g.fillStyle = fill;
    g.fillText(s, x, y);
  }
  function star5(g, x, y, r, inner) {
    g.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + (i * Math.PI) / 5, rr2 = i % 2 ? r * (inner || 0.48) : r;
      if (i) g.lineTo(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2); else g.moveTo(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2);
    }
    g.closePath();
  }

  // ---------------------------------------------------------------- glow sprites (for "lighter")
  var glowCache = {};
  function glowSprite(col) {
    if (!glowCache[col]) {
      var c = mk(128, 128), g = c.getContext("2d");
      var gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, "rgba(" + col + ",1)");
      gr.addColorStop(0.35, "rgba(" + col + ",0.45)");
      gr.addColorStop(1, "rgba(" + col + ",0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
      glowCache[col] = c;
    }
    return glowCache[col];
  }
  function glowAt(x, y, r, col, a) {
    if (a <= 0.003 || r <= 0) return;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, a);
    ctx.drawImage(glowSprite(col), x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // ================================================================ THE PET (a cartoon of itself)
  var CHEEK = { Pink: "#FF9EC4", Coral: "#FF8A6E", Peach: "#FFC58A" };
  var INK = "#2A1A14";
  var petCache = {};
  function petSprite(face) {
    if (petCache[face]) return petCache[face];
    var Rp = PET_R * PPM;
    var S = Math.ceil(Rp * 4.6), c = mkB(S, S), g = c.getContext("2d");
    var cx = S / 2, cy = S / 2 + Rp * 0.35;
    var body = PAL.body, out = shade(PAL.outline, -0.35), dark = mixHex(body, PAL.outline, 0.55), light = shade(body, 0.42);
    var belly = TR.belly === "Pale" ? "#FBF3EC" : PAL.belly;
    var lw = Rp * 0.1;
    g.lineJoin = "round";
    g.lineCap = "round";

    // --- behind the body: shape feature + head accent
    var s;
    if (SHAPE === "Ears") {
      for (s = -1; s <= 1; s += 2) {
        g.beginPath();
        g.moveTo(cx + s * Rp * 0.28, cy - Rp * 0.8);
        g.quadraticCurveTo(cx + s * Rp * 0.7, cy - Rp * 1.65, cx + s * Rp * 1.02, cy - Rp * 1.18);
        g.quadraticCurveTo(cx + s * Rp * 1.05, cy - Rp * 0.7, cx + s * Rp * 0.85, cy - Rp * 0.45);
        g.closePath();
        fillStroke(g, body, out, lw);
        g.beginPath();
        g.moveTo(cx + s * Rp * 0.45, cy - Rp * 0.85);
        g.quadraticCurveTo(cx + s * Rp * 0.72, cy - Rp * 1.38, cx + s * Rp * 0.88, cy - Rp * 1.1);
        g.quadraticCurveTo(cx + s * Rp * 0.88, cy - Rp * 0.8, cx + s * Rp * 0.75, cy - Rp * 0.65);
        g.closePath();
        fillStroke(g, "#FFB3C7", null);
      }
    } else if (SHAPE === "Horns") {
      for (s = -1; s <= 1; s += 2) {
        g.beginPath();
        g.moveTo(cx + s * Rp * 0.35, cy - Rp * 0.78);
        g.quadraticCurveTo(cx + s * Rp * 0.55, cy - Rp * 1.6, cx + s * Rp * 1.08, cy - Rp * 1.62);
        g.quadraticCurveTo(cx + s * Rp * 0.8, cy - Rp * 1.18, cx + s * Rp * 0.78, cy - Rp * 0.55);
        g.closePath();
        fillStroke(g, "#F3E6C2", "#5E4A2A", lw * 0.9);
        g.beginPath();
        g.moveTo(cx + s * Rp * 0.5, cy - Rp * 1.0);
        g.quadraticCurveTo(cx + s * Rp * 0.62, cy - Rp * 1.3, cx + s * Rp * 0.85, cy - Rp * 1.4);
        g.strokeStyle = "rgba(255,255,255,0.7)";
        g.lineWidth = lw * 0.5;
        g.stroke();
      }
    } else if (SHAPE === "Tail") {
      g.beginPath();
      g.moveTo(cx + Rp * 0.8, cy + Rp * 0.15);
      g.quadraticCurveTo(cx + Rp * 1.75, cy + Rp * 0.05, cx + Rp * 1.5, cy - Rp * 0.7);
      g.quadraticCurveTo(cx + Rp * 1.35, cy - Rp * 0.05, cx + Rp * 0.85, cy + Rp * 0.55);
      g.closePath();
      fillStroke(g, body, out, lw);
    }
    var acc = TR.accent || "Sprout";
    if (acc === "Sprout") {
      g.beginPath(); g.moveTo(cx, cy - Rp * 0.92); g.quadraticCurveTo(cx + Rp * 0.05, cy - Rp * 1.25, cx - Rp * 0.02, cy - Rp * 1.42);
      g.strokeStyle = "#2F6B22"; g.lineWidth = lw * 1.4; g.stroke(); g.strokeStyle = "#5BAE3C"; g.lineWidth = lw * 0.7; g.stroke();
      ell(g, cx - Rp * 0.28, cy - Rp * 1.42, Rp * 0.28, Rp * 0.13, -0.5); fillStroke(g, "#6CC24A", "#2F6B22", lw * 0.7);
      ell(g, cx + Rp * 0.24, cy - Rp * 1.5, Rp * 0.28, Rp * 0.13, 0.55); fillStroke(g, "#7FD45A", "#2F6B22", lw * 0.7);
    } else if (acc === "Ears") {
      for (s = -1; s <= 1; s += 2) { ell(g, cx + s * Rp * 0.62, cy - Rp * 0.78, Rp * 0.3, Rp * 0.3); fillStroke(g, body, out, lw); ell(g, cx + s * Rp * 0.62, cy - Rp * 0.78, Rp * 0.15, Rp * 0.15); fillStroke(g, "#FFB3C7", null); }
    } else if (acc === "Antenna") {
      g.beginPath(); g.moveTo(cx, cy - Rp * 0.9); g.quadraticCurveTo(cx + Rp * 0.25, cy - Rp * 1.3, cx + Rp * 0.18, cy - Rp * 1.6);
      g.strokeStyle = out; g.lineWidth = lw * 0.9; g.stroke();
      ell(g, cx + Rp * 0.18, cy - Rp * 1.66, Rp * 0.17, Rp * 0.17); fillStroke(g, "#FFE06B", "#9A7A12", lw * 0.7);
    } else if (acc === "Fin") {
      g.beginPath(); g.moveTo(cx - Rp * 0.1, cy - Rp * 0.9); g.quadraticCurveTo(cx + Rp * 0.35, cy - Rp * 1.7, cx + Rp * 0.7, cy - Rp * 1.45); g.quadraticCurveTo(cx + Rp * 0.5, cy - Rp * 1.1, cx + Rp * 0.55, cy - Rp * 0.75); g.closePath();
      fillStroke(g, dark, out, lw);
    } else if (acc === "Tuft") {
      for (var k = -1; k <= 1; k++) {
        g.beginPath();
        g.moveTo(cx + k * Rp * 0.24 - Rp * 0.15, cy - Rp * 0.88);
        g.quadraticCurveTo(cx + k * Rp * 0.34, cy - Rp * 1.25, cx + k * Rp * 0.42 + Rp * 0.04, cy - Rp * (1.5 - 0.15 * Math.abs(k)));
        g.quadraticCurveTo(cx + k * Rp * 0.24 + Rp * 0.12, cy - Rp * 1.1, cx + k * Rp * 0.24 + Rp * 0.15, cy - Rp * 0.88);
        g.closePath();
        fillStroke(g, body, out, lw * 0.9);
      }
    }

    // --- body with the classic one-light shade
    var gr = g.createRadialGradient(cx - Rp * 0.3, cy - Rp * 0.35, Rp * 0.05, cx, cy, Rp * 1.08);
    gr.addColorStop(0, light);
    gr.addColorStop(0.55, body);
    gr.addColorStop(1, dark);
    ell(g, cx, cy, Rp, Rp * 0.97);
    g.fillStyle = gr;
    g.fill();
    g.save();
    ell(g, cx, cy, Rp, Rp * 0.97);
    g.clip();
    // pattern, in its own darker/lighter hue
    var pd = rgba(dark, 0.75), pl = rgba(shade(body, 0.6), 0.85);
    var pat = TR.pattern || "Solid";
    if (pat === "Stripes") { g.fillStyle = pd; for (var i = -1; i <= 1; i++) { rrect(g, cx + i * Rp * 0.48 - Rp * 0.09, cy - Rp * 1.1, Rp * 0.18, Rp * 1.2, Rp * 0.09); g.fill(); } }
    else if (pat === "Spots") { g.fillStyle = pd; [[-0.55, -0.45, 0.16], [0.5, -0.55, 0.13], [0.72, -0.05, 0.11], [-0.7, 0.05, 0.1], [0.05, -0.75, 0.1]].forEach(function (d) { ell(g, cx + d[0] * Rp, cy + d[1] * Rp, d[2] * Rp, d[2] * Rp); g.fill(); }); }
    else if (pat === "Patch") { ell(g, cx - Rp * 0.55, cy - Rp * 0.3, Rp * 0.48, Rp * 0.55, 0.3); g.fillStyle = pd; g.fill(); }
    else if (pat === "Star") { star5(g, cx, cy - Rp * 0.6, Rp * 0.22); g.fillStyle = pl; g.fill(); }
    else if (pat === "Two-Tone") { g.fillStyle = pd; g.fillRect(cx - Rp * 1.2, cy + Rp * 0.12, Rp * 2.4, Rp * 1.2); }
    else if (pat === "Saddle") { ell(g, cx, cy - Rp * 0.95, Rp * 1.1, Rp * 0.42); g.fillStyle = pd; g.fill(); }
    else if (pat === "Mask") { g.fillStyle = pd; ell(g, cx - Rp * 0.38, cy - Rp * 0.1, Rp * 0.42, Rp * 0.33, 0.2); g.fill(); ell(g, cx + Rp * 0.38, cy - Rp * 0.1, Rp * 0.42, Rp * 0.33, -0.2); g.fill(); }
    // belly
    ell(g, cx, cy + Rp * 0.5, Rp * 0.66, Rp * 0.5);
    g.fillStyle = belly;
    g.fill();
    // markings
    var mk2 = TR.marking || "None";
    if (mk2 === "Spots") { g.fillStyle = rgba(PAL.outline, 0.7); [[-0.5, -0.55], [0.55, -0.5], [-0.3, 0.05], [0.35, 0.1]].forEach(function (d) { ell(g, cx + d[0] * Rp, cy + d[1] * Rp, Rp * 0.07, Rp * 0.07); g.fill(); }); }
    else if (mk2 === "Stripe") { g.beginPath(); g.arc(cx, cy - Rp * 0.1, Rp * 0.78, -Math.PI * 0.82, -Math.PI * 0.18); g.strokeStyle = rgba(PAL.outline, 0.75); g.lineWidth = Rp * 0.1; g.stroke(); }
    else if (mk2 === "Belly Patch") { ell(g, cx, cy + Rp * 0.55, Rp * 0.24, Rp * 0.17); g.fillStyle = rgba(PAL.outline, 0.45); g.fill(); }
    else if (mk2 === "Star") { star5(g, cx, cy - Rp * 0.62, Rp * 0.17); g.fillStyle = "#FFF3C4"; g.fill(); }
    else if (mk2 === "Freckles") { g.fillStyle = rgba(PAL.outline, 0.65); [[-0.62, 0.12], [-0.5, 0.2], [-0.55, 0.05], [0.62, 0.12], [0.5, 0.2], [0.55, 0.05]].forEach(function (d) { ell(g, cx + d[0] * Rp, cy + d[1] * Rp, Rp * 0.035, Rp * 0.035); g.fill(); }); }
    // rim light on the upper left edge
    g.beginPath();
    g.arc(cx, cy, Rp * 0.93, Math.PI * 1.05, Math.PI * 1.55);
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.lineWidth = lw * 0.6;
    g.stroke();
    g.restore();
    ell(g, cx, cy, Rp, Rp * 0.97);
    g.strokeStyle = out;
    g.lineWidth = lw;
    g.stroke();

    // --- cheeks + face
    if (TR.cheeks && CHEEK[TR.cheeks] && face !== "dizzy") {
      g.fillStyle = rgba(CHEEK[TR.cheeks], 0.7);
      ell(g, cx - Rp * 0.6, cy + Rp * 0.2, Rp * 0.17, Rp * 0.11); g.fill();
      ell(g, cx + Rp * 0.6, cy + Rp * 0.2, Rp * 0.17, Rp * 0.11); g.fill();
    }
    petFace(g, face, cx, cy, Rp, out, body, lw);

    // --- accessory on top
    var ax = TR.accessory || "None";
    if (ax === "Bow") {
      for (s = -1; s <= 1; s += 2) { poly(g, [cx - Rp * 0.42, cy - Rp * 0.82, cx - Rp * 0.42 + s * Rp * 0.34, cy - Rp * 1.05, cx - Rp * 0.42 + s * Rp * 0.34, cy - Rp * 0.6]); fillStroke(g, "#FF5C8A", "#8E1E43", lw * 0.7); }
      ell(g, cx - Rp * 0.42, cy - Rp * 0.82, Rp * 0.1, Rp * 0.1); fillStroke(g, "#D63A6A", "#8E1E43", lw * 0.6);
    } else if (ax === "Shades") {
      for (s = -1; s <= 1; s += 2) { rrect(g, cx + s * Rp * 0.36 - Rp * 0.3, cy - Rp * 0.3, Rp * 0.6, Rp * 0.36, Rp * 0.14); fillStroke(g, "#1A1C22", "#000000", lw * 0.6); }
      g.beginPath(); g.moveTo(cx - Rp * 0.08, cy - Rp * 0.2); g.lineTo(cx + Rp * 0.08, cy - Rp * 0.2); g.strokeStyle = "#1A1C22"; g.lineWidth = lw * 0.8; g.stroke();
      g.beginPath(); g.moveTo(cx - Rp * 0.6, cy - Rp * 0.24); g.lineTo(cx - Rp * 0.48, cy - Rp * 0.12); g.strokeStyle = "rgba(255,255,255,0.7)"; g.lineWidth = lw * 0.5; g.stroke();
    } else if (ax === "Party Hat") {
      poly(g, [cx - Rp * 0.38, cy - Rp * 0.82, cx + Rp * 0.32, cy - Rp * 0.88, cx + Rp * 0.02, cy - Rp * 1.78]);
      fillStroke(g, "#FF7AC0", "#8E2C66", lw * 0.8);
      g.save(); poly(g, [cx - Rp * 0.38, cy - Rp * 0.82, cx + Rp * 0.32, cy - Rp * 0.88, cx + Rp * 0.02, cy - Rp * 1.78]); g.clip();
      g.fillStyle = "#FFE06B"; for (i = 0; i < 3; i++) g.fillRect(cx - Rp * 0.5, cy - Rp * (1.05 + i * 0.25), Rp, Rp * 0.07); g.restore();
      ell(g, cx + Rp * 0.02, cy - Rp * 1.82, Rp * 0.13, Rp * 0.13); fillStroke(g, "#FFE06B", "#9A7A12", lw * 0.6);
    } else if (ax === "Crown") {
      poly(g, [cx - Rp * 0.45, cy - Rp * 0.82, cx - Rp * 0.5, cy - Rp * 1.3, cx - Rp * 0.22, cy - Rp * 1.05, cx, cy - Rp * 1.42, cx + Rp * 0.22, cy - Rp * 1.05, cx + Rp * 0.5, cy - Rp * 1.3, cx + Rp * 0.45, cy - Rp * 0.82]);
      fillStroke(g, "#F2C200", "#7A5A00", lw * 0.8);
      ell(g, cx, cy - Rp * 1.0, Rp * 0.08, Rp * 0.08); fillStroke(g, "#FF2D55", "#7A0A1E", lw * 0.4);
    } else if (ax === "Halo") {
      ell(g, cx, cy - Rp * 1.35, Rp * 0.55, Rp * 0.17); g.strokeStyle = "#B88A00"; g.lineWidth = lw * 1.4; g.stroke(); g.strokeStyle = "#FFE884"; g.lineWidth = lw * 0.8; g.stroke();
    } else if (ax === "Scarf") {
      g.beginPath(); g.moveTo(cx - Rp * 0.78, cy + Rp * 0.5); g.quadraticCurveTo(cx, cy + Rp * 0.78, cx + Rp * 0.78, cy + Rp * 0.5); g.lineTo(cx + Rp * 0.7, cy + Rp * 0.75); g.quadraticCurveTo(cx, cy + Rp * 1.0, cx - Rp * 0.7, cy + Rp * 0.75); g.closePath();
      fillStroke(g, "#5CC5D6", "#1F6A78", lw * 0.8);
      poly(g, [cx + Rp * 0.35, cy + Rp * 0.8, cx + Rp * 0.6, cy + Rp * 0.78, cx + Rp * 0.62, cy + Rp * 1.2, cx + Rp * 0.42, cy + Rp * 1.12]); fillStroke(g, "#4AB2C4", "#1F6A78", lw * 0.7);
    } else if (ax === "Leaf") {
      ell(g, cx + Rp * 0.3, cy - Rp * 1.05, Rp * 0.34, Rp * 0.15, -0.6); fillStroke(g, "#6CC24A", "#2F6B22", lw * 0.7);
    } else if (ax === "Ribbon") {
      for (s = -1; s <= 1; s += 2) { poly(g, [cx, cy + Rp * 0.68, cx + s * Rp * 0.3, cy + Rp * 0.52, cx + s * Rp * 0.3, cy + Rp * 0.86]); fillStroke(g, "#FF7AA8", "#8E2C55", lw * 0.6); }
      ell(g, cx, cy + Rp * 0.68, Rp * 0.08, Rp * 0.08); fillStroke(g, "#E14E82", "#8E2C55", lw * 0.5);
    }
    // gloss
    ell(g, cx - Rp * 0.42, cy - Rp * 0.55, Rp * 0.26, Rp * 0.13, -0.6);
    g.fillStyle = "rgba(255,255,255,0.4)";
    g.fill();

    var spr = { c: c, cx: cx, cy: cy, R: Rp };
    petCache[face] = spr;
    return spr;
  }

  function petFace(g, face, cx, cy, Rp, out, body, lw) {
    var style = TR.eyes || "Round";
    var er = style === "Big" ? Rp * 0.33 : Rp * 0.27;
    var ex = Rp * 0.35, ey = -Rp * 0.1;
    for (var s = -1; s <= 1; s += 2) {
      var x = cx + s * ex, y = cy + ey;
      if (face === "blink") {
        g.beginPath(); g.moveTo(x - er * 0.8, y + er * 0.1); g.quadraticCurveTo(x, y + er * 0.45, x + er * 0.8, y + er * 0.1);
        g.strokeStyle = out; g.lineWidth = lw * 0.9; g.stroke();
      } else if (face === "happy") {
        g.beginPath(); g.moveTo(x - er * 0.8, y + er * 0.25); g.quadraticCurveTo(x, y - er * 0.6, x + er * 0.8, y + er * 0.25);
        g.strokeStyle = out; g.lineWidth = lw * 1.1; g.stroke();
      } else if (face === "dizzy") {
        g.beginPath();
        for (var a = 0; a < Math.PI * 4; a += 0.3) { var rr2 = (a / (Math.PI * 4)) * er * 0.85; var px2 = x + Math.cos(a * s) * rr2, py2 = y + Math.sin(a * s) * rr2; if (a === 0) g.moveTo(px2, py2); else g.lineTo(px2, py2); }
        ell(g, x, y, er, er); g.fillStyle = "#ffffff"; g.fill(); g.strokeStyle = out; g.lineWidth = lw * 0.55; g.stroke();
        g.beginPath();
        for (a = 0; a < Math.PI * 4; a += 0.3) { rr2 = (a / (Math.PI * 4)) * er * 0.8; px2 = x + Math.cos(a * s) * rr2; py2 = y + Math.sin(a * s) * rr2; if (a === 0) g.moveTo(px2, py2); else g.lineTo(px2, py2); }
        g.strokeStyle = INK; g.lineWidth = lw * 0.45; g.stroke();
      } else {
        var k = face === "yell" ? 1.15 : 1;
        var rx = er * k * (style === "Oval" ? 0.78 : 1), ry = er * k;
        if (style === "Beady" && face !== "yell") {
          ell(g, x, y, er * 0.45, er * 0.5); g.fillStyle = INK; g.fill();
          ell(g, x - er * 0.15, y - er * 0.18, er * 0.13, er * 0.13); g.fillStyle = "#fff"; g.fill();
        } else {
          ell(g, x, y, rx, ry); g.fillStyle = "#ffffff"; g.fill(); g.strokeStyle = out; g.lineWidth = lw * 0.55; g.stroke();
          var pr = er * (face === "yell" ? 0.32 : 0.44);
          var ox = face === "aim" ? er * 0.32 : face === "yell" ? er * 0.1 : er * 0.12, oy = face === "aim" ? er * 0.05 : 0;
          ell(g, x + ox, y + oy, pr, pr); g.fillStyle = INK; g.fill();
          ell(g, x + ox - pr * 0.35, y + oy - pr * 0.35, pr * 0.34, pr * 0.34); g.fillStyle = "#ffffff"; g.fill();
          if (style === "Sparkle") { star5(g, x + ox + pr * 0.5, y + oy + pr * 0.45, pr * 0.32, 0.4); g.fillStyle = "#ffffff"; g.fill(); }
          if (style === "Sleepy" && face !== "yell") {
            g.save(); ell(g, x, y, rx, ry); g.clip(); g.fillStyle = body; g.fillRect(x - rx - 1, y - ry - 1, rx * 2 + 2, ry * 0.85); g.restore();
            g.beginPath(); g.moveTo(x - rx, y - ry * 0.15); g.lineTo(x + rx, y - ry * 0.15); g.strokeStyle = out; g.lineWidth = lw * 0.55; g.stroke();
          }
        }
      }
      // the brows ARE the character
      var browCol = shade(PAL.outline, -0.45);
      var inY, outY;
      if (face === "aim") { inY = y - er * 0.95; outY = y - er * 1.6; }
      else if (face === "yell") { inY = y - er * 1.45; outY = y - er * 1.55; }
      else if (face === "dizzy") { inY = y - er * 1.5; outY = y - er * 1.25; }
      else { inY = y - er * 1.2; outY = y - er * 1.45; }
      g.beginPath();
      g.moveTo(x - s * er * 0.25, inY);
      g.lineTo(x + s * er * 1.05, outY);
      g.strokeStyle = browCol;
      g.lineWidth = Rp * (face === "aim" ? 0.17 : 0.13);
      g.lineCap = "round";
      g.stroke();
    }
    // mouth
    var my = cy + Rp * 0.33;
    if (face === "yell") {
      ell(g, cx, my + Rp * 0.05, Rp * 0.24, Rp * 0.2); fillStroke(g, "#5A1020", out, lw * 0.6);
      ell(g, cx, my + Rp * 0.15, Rp * 0.13, Rp * 0.07); g.fillStyle = "#FF6B8A"; g.fill();
    } else if (face === "happy") {
      g.beginPath(); g.moveTo(cx - Rp * 0.26, my - Rp * 0.02); g.quadraticCurveTo(cx, my + Rp * 0.42, cx + Rp * 0.26, my - Rp * 0.02); g.closePath();
      fillStroke(g, "#5A1020", out, lw * 0.6);
      ell(g, cx, my + Rp * 0.14, Rp * 0.11, Rp * 0.06); g.fillStyle = "#FF6B8A"; g.fill();
    } else if (face === "dizzy") {
      g.beginPath(); g.moveTo(cx - Rp * 0.22, my); g.quadraticCurveTo(cx - Rp * 0.11, my - Rp * 0.1, cx, my); g.quadraticCurveTo(cx + Rp * 0.11, my + Rp * 0.1, cx + Rp * 0.22, my);
      g.strokeStyle = out; g.lineWidth = lw * 0.7; g.stroke();
    } else if (face === "aim") {
      g.beginPath(); g.moveTo(cx - Rp * 0.17, my + Rp * 0.04); g.quadraticCurveTo(cx, my - Rp * 0.04, cx + Rp * 0.17, my + Rp * 0.04);
      g.strokeStyle = out; g.lineWidth = lw * 0.75; g.stroke();
    } else {
      g.beginPath(); g.moveTo(cx - Rp * 0.17, my - Rp * 0.02); g.quadraticCurveTo(cx, my + Rp * 0.14, cx + Rp * 0.17, my - Rp * 0.02);
      g.strokeStyle = out; g.lineWidth = lw * 0.75; g.stroke();
    }
  }

  // ================================================================ GREMLINS
  var GT = {
    imp: { body: "#7448B3", out: "#24103F", belly: "#A47BDC", ear: "#E06A9A", horn: 0.75 },
    brute: { body: "#5C8A2E", out: "#18300B", belly: "#8DB653", ear: "#D86A8F", horn: 0.9 },
    king: { body: "#B4253D", out: "#3A0610", belly: "#DE5D70", ear: "#FF8AA6", horn: 1.15 },
  };
  var gremCache = {};
  function gremSprite(type, expr) {
    var key = type + ":" + expr;
    if (gremCache[key]) return gremCache[key];
    var st = GT[type], Rg = Core.GREMS[type].r * PPM;
    var S = Math.ceil(Rg * 4.4), c = mkB(S, S), g = c.getContext("2d");
    var cx = S / 2, cy = S / 2 + Rg * 0.18;
    var body = st.body, out = st.out, dark = mixHex(body, out, 0.5), light = shade(body, 0.32);
    var lw = Rg * 0.11;
    g.lineJoin = "round";
    g.lineCap = "round";
    var s;
    // bat ears, swept up and out, with a notch
    for (s = -1; s <= 1; s += 2) {
      poly(g, [cx + s * Rg * 0.45, cy - Rg * 0.62, cx + s * Rg * 1.55, cy - Rg * 1.3, cx + s * Rg * 1.22, cy - Rg * 0.78, cx + s * Rg * 1.42, cy - Rg * 0.45, cx + s * Rg * 0.85, cy - Rg * 0.05]);
      fillStroke(g, dark, out, lw);
      poly(g, [cx + s * Rg * 0.7, cy - Rg * 0.58, cx + s * Rg * 1.28, cy - Rg * 1.0, cx + s * Rg * 1.02, cy - Rg * 0.62, cx + s * Rg * 0.9, cy - Rg * 0.3]);
      fillStroke(g, st.ear, null);
    }
    // horns
    for (s = -1; s <= 1; s += 2) {
      var hh = st.horn;
      g.beginPath();
      g.moveTo(cx + s * Rg * 0.22, cy - Rg * 0.82);
      g.quadraticCurveTo(cx + s * Rg * 0.35, cy - Rg * (1.2 + 0.4 * hh), cx + s * Rg * (0.7 + 0.15 * hh), cy - Rg * (1.35 + 0.45 * hh));
      g.quadraticCurveTo(cx + s * Rg * 0.55, cy - Rg * 1.05, cx + s * Rg * 0.58, cy - Rg * 0.7);
      g.closePath();
      fillStroke(g, "#EFE2BE", "#4A3A20", lw * 0.85);
    }
    // body
    var gr = g.createRadialGradient(cx - Rg * 0.3, cy - Rg * 0.35, Rg * 0.05, cx, cy, Rg * 1.08);
    gr.addColorStop(0, light);
    gr.addColorStop(0.55, body);
    gr.addColorStop(1, dark);
    // spiky fur along the crown (drawn as part of the silhouette)
    g.beginPath();
    var spikes = 7;
    for (var i = 0; i <= 64; i++) {
      var a = (i / 64) * Math.PI * 2;
      var rr2 = Rg;
      var top = Math.sin(a) < -0.35;
      if (top) {
        var ph = ((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
        rr2 = Rg * (1 + 0.16 * Math.max(0, Math.sin(ph * Math.PI * 2 * spikes)));
      }
      var px2 = cx + Math.cos(a) * rr2, py2 = cy + Math.sin(a) * rr2 * 0.97;
      if (i === 0) g.moveTo(px2, py2); else g.lineTo(px2, py2);
    }
    g.closePath();
    g.fillStyle = gr;
    g.fill();
    g.save();
    g.clip();
    ell(g, cx, cy + Rg * 0.62, Rg * 0.7, Rg * 0.5);
    g.fillStyle = st.belly;
    g.fill();
    if (type === "brute") {
      var hg = g.createLinearGradient(cx, cy - Rg, cx, cy - Rg * 0.2);
      hg.addColorStop(0, "#C8CFD8"); hg.addColorStop(1, "#6D7684");
      g.fillStyle = hg;
      ell(g, cx, cy - Rg * 0.55, Rg * 1.1, Rg * 0.62); g.fill();
      g.fillStyle = "#59616E"; g.fillRect(cx - Rg * 1.2, cy - Rg * 0.22, Rg * 2.4, Rg * 0.12);
      g.fillStyle = "#3D434D";
      for (i = -2; i <= 2; i++) { ell(g, cx + i * Rg * 0.38, cy - Rg * 0.16, Rg * 0.045, Rg * 0.045); g.fill(); }
      rrect(g, cx - Rg * 0.08, cy - Rg * 0.25, Rg * 0.16, Rg * 0.42, Rg * 0.05); g.fillStyle = "#7C8592"; g.fill();
    }
    if (expr === "hurt2") { ell(g, cx + Rg * 0.25, cy - Rg * 0.78, Rg * 0.2, Rg * 0.15); g.fillStyle = shade(body, 0.25); g.fill(); }
    g.beginPath();
    g.arc(cx, cy, Rg * 0.92, Math.PI * 1.05, Math.PI * 1.5);
    g.strokeStyle = "rgba(255,255,255,0.3)";
    g.lineWidth = lw * 0.6;
    g.stroke();
    g.restore();
    g.strokeStyle = out;
    g.lineWidth = lw;
    g.stroke();
    if (type === "brute") {
      ell(g, cx, cy - Rg * 0.55, Rg * 1.1, Rg * 0.62);
      g.save(); g.beginPath(); g.arc(cx, cy, Rg, 0, Math.PI * 2); g.clip(); g.strokeStyle = out; g.lineWidth = lw * 0.7; g.stroke(); g.restore();
    }
    if (type === "king") {
      poly(g, [cx - Rg * 0.6, cy - Rg * 0.78, cx - Rg * 0.66, cy - Rg * 1.4, cx - Rg * 0.3, cy - Rg * 1.08, cx, cy - Rg * 1.56, cx + Rg * 0.3, cy - Rg * 1.08, cx + Rg * 0.66, cy - Rg * 1.4, cx + Rg * 0.6, cy - Rg * 0.78]);
      var cg = g.createLinearGradient(cx, cy - Rg * 1.5, cx, cy - Rg * 0.8);
      cg.addColorStop(0, "#FFE680"); cg.addColorStop(1, "#E0A800");
      fillStroke(g, cg, "#6B4A00", lw * 0.8);
      ell(g, cx, cy - Rg * 1.02, Rg * 0.1, Rg * 0.1); fillStroke(g, "#FF2D55", "#7A0A1E", lw * 0.4);
      ell(g, cx - Rg * 0.4, cy - Rg * 0.95, Rg * 0.07, Rg * 0.07); fillStroke(g, "#5CC8E0", "#1A5A6A", lw * 0.3);
      ell(g, cx + Rg * 0.4, cy - Rg * 0.95, Rg * 0.07, Rg * 0.07); fillStroke(g, "#5CC8E0", "#1A5A6A", lw * 0.3);
    }

    // eyes: big, yellow, glowing; slit pupils are drawn live so they can track the pet
    var er = Rg * 0.25, ex = Rg * 0.36, ey = -Rg * 0.06;
    var eyes = [];
    for (s = -1; s <= 1; s += 2) {
      var x = cx + s * ex, y = cy + ey;
      var bruised = expr === "hurt2" || (expr === "hurt1" && s < 0);
      if (bruised) { ell(g, x, y, er * 1.35, er * 1.25); g.fillStyle = "rgba(40,10,50,0.55)"; g.fill(); }
      if (expr === "blink") {
        g.beginPath(); g.moveTo(x - er, y); g.lineTo(x + er, y + s * er * 0.15); g.strokeStyle = out; g.lineWidth = lw * 0.9; g.stroke();
      } else if (expr === "laugh") {
        g.beginPath(); g.moveTo(x - er * 0.9, y + er * 0.2); g.quadraticCurveTo(x, y - er * 0.8, x + er * 0.9, y + er * 0.2); g.strokeStyle = out; g.lineWidth = lw; g.stroke();
      } else if (expr === "hurt2" || (expr === "hurt1" && s < 0)) {
        g.beginPath(); g.moveTo(x - er * 0.6, y - er * 0.6); g.lineTo(x + er * 0.6, y + er * 0.6); g.moveTo(x + er * 0.6, y - er * 0.6); g.lineTo(x - er * 0.6, y + er * 0.6);
        g.strokeStyle = INK; g.lineWidth = lw * 0.8; g.stroke();
      } else {
        var k = expr === "scared" ? 1.25 : 1;
        // angry eyes are cut flat by the brow
        g.save();
        ell(g, x, y, er * k * 1.05, er * k);
        if (expr !== "scared") { g.beginPath(); g.moveTo(x - er * 1.4, y - er * (s < 0 ? 0.15 : 0.95)); g.lineTo(x + er * 1.4, y - er * (s < 0 ? 0.95 : 0.15)); g.lineTo(x + er * 1.4, y + er * 1.4); g.lineTo(x - er * 1.4, y + er * 1.4); g.closePath(); g.clip(); ell(g, x, y, er * 1.05, er); }
        var eg = g.createRadialGradient(x, y, 0, x, y, er * k);
        eg.addColorStop(0, "#FFF6A8"); eg.addColorStop(0.6, "#FFD83D"); eg.addColorStop(1, "#F29A1C");
        g.fillStyle = eg;
        g.fill();
        g.restore();
        ell(g, x, y, er * k * 1.05, er * k);
        if (expr !== "scared") { g.save(); g.beginPath(); g.moveTo(x - er * 1.4, y - er * (s < 0 ? 0.15 : 0.95)); g.lineTo(x + er * 1.4, y - er * (s < 0 ? 0.95 : 0.15)); g.lineTo(x + er * 1.4, y + er * 1.4); g.lineTo(x - er * 1.4, y + er * 1.4); g.closePath(); g.clip(); ell(g, x, y, er * 1.05, er); g.strokeStyle = out; g.lineWidth = lw * 0.55; g.stroke(); g.restore(); }
        else { g.strokeStyle = out; g.lineWidth = lw * 0.55; g.stroke(); }
        eyes.push({ x: (x - cx) / PPM, y: (y - cy) / PPM, r: (er * k) / PPM, scared: expr === "scared" });
      }
      // heavy brow
      if (expr !== "laugh" && expr !== "blink") {
        g.beginPath();
        if (expr === "scared") { g.moveTo(x - s * er * 0.1, y - er * 1.65); g.lineTo(x + s * er * 1.1, y - er * 1.25); }
        else { g.moveTo(x - s * er * 0.3, y - er * (s < 0 ? 0.3 : 0.3) - er * 0.25); g.lineTo(x + s * er * 1.25, y - er * 1.3); }
        g.strokeStyle = out;
        g.lineWidth = Rg * 0.16;
        g.stroke();
      }
    }
    // the grin
    var my = cy + Rg * 0.35, mw = Rg * 0.62;
    if (expr === "scared") {
      ell(g, cx, my + Rg * 0.05, Rg * 0.16, Rg * 0.13); fillStroke(g, "#2A0A14", out, lw * 0.5);
    } else {
      var open = expr === "laugh" ? Rg * 0.42 : expr === "hurt2" ? Rg * 0.26 : Rg * 0.2;
      g.beginPath();
      g.moveTo(cx - mw, my - Rg * 0.06);
      g.quadraticCurveTo(cx, my + Rg * 0.12, cx + mw, my - Rg * 0.06);
      g.quadraticCurveTo(cx, my + open + Rg * 0.18, cx - mw, my - Rg * 0.06);
      g.closePath();
      fillStroke(g, "#2A0A14", out, lw * 0.6);
      if (expr === "laugh" || expr === "hurt2") { ell(g, cx + (expr === "hurt2" ? Rg * 0.15 : 0), my + open * 0.8, Rg * 0.18, Rg * 0.09); g.fillStyle = "#E8506E"; g.fill(); }
      // jagged teeth hanging from the top lip
      var n = 6, missing = expr === "hurt1" ? [2] : expr === "hurt2" ? [1, 4] : [];
      for (i = 0; i < n; i++) {
        if (missing.indexOf(i) >= 0) continue;
        var t0 = (i + 0.5) / n, tx = cx - mw * 0.86 + t0 * mw * 1.72;
        var curve = Math.sin(t0 * Math.PI) * Rg * 0.1;
        var tw = mw * 0.13, tl = Rg * (i % 2 ? 0.16 : 0.22);
        poly(g, [tx - tw, my - Rg * 0.04 + curve, tx + tw, my - Rg * 0.04 + curve, tx, my - Rg * 0.04 + curve + tl]);
        fillStroke(g, "#FFF6E0", out, lw * 0.3);
      }
    }
    var spr = { c: c, cx: cx, cy: cy, R: Rg, eyes: eyes };
    gremCache[key] = spr;
    return spr;
  }

  // ================================================================ MATERIALS
  var MAT = {
    wood: { light: "#E8B96A", mid: "#C9893A", dark: "#8E5A22", out: "#4D2A0E", knot: "#7A4A1C", chips: ["#C9893A", "#E8B96A", "#8E5A22"], pop: "#4D2A0E" },
    stone: { light: "#C8CDD2", mid: "#9BA3AB", dark: "#6B7278", out: "#3B4045", chips: ["#9BA3AB", "#C8CDD2", "#6B7278"], pop: "#3B4045" },
    glass: { light: "#E6F7FF", mid: "#9ED8F5", dark: "#5FB3E0", out: "#2C7FB0", chips: ["#E6F7FF", "#9ED8F5", "#ffffff"], pop: "#2C7FB0" },
    tnt: { light: "#F05A4E", mid: "#D8302A", dark: "#8E1A16", out: "#3D0806", chips: ["#D8302A", "#F4E3B5", "#3D0806"], pop: "#3D0806" },
  };
  function blockSprite(e, stage) {
    e.tex = e.tex || [];
    if (e.tex[stage]) return e.tex[stage];
    var m = MAT[e.mat], w = e.w * PPM, h = e.h * PPM, pad = 6;
    var c = mkB(w + pad * 2, h + pad * 2), g = c.getContext("2d"), rr2 = rng(e.seed + stage * 7);
    g.translate(pad, pad);
    g.lineJoin = "round";
    g.lineCap = "round";
    var lw = 3.4, rad = Math.min(w, h) * (e.mat === "stone" ? 0.16 : 0.12);
    var vertical = h > w;
    var gr = vertical ? g.createLinearGradient(0, 0, w, 0) : g.createLinearGradient(0, 0, 0, h);
    if (e.mat === "glass") {
      gr.addColorStop(0, rgba(m.light, 0.85)); gr.addColorStop(0.5, rgba(m.mid, 0.78)); gr.addColorStop(1, rgba(m.dark, 0.8));
    } else {
      gr.addColorStop(0, m.light); gr.addColorStop(0.45, m.mid); gr.addColorStop(1, m.dark);
    }
    rrect(g, 0, 0, w, h, rad);
    g.fillStyle = gr;
    g.fill();
    g.save();
    rrect(g, 0, 0, w, h, rad);
    g.clip();
    if (e.mat === "wood") {
      var along = vertical ? h : w, across = vertical ? w : h;
      var lines = Math.max(2, Math.min(4, Math.round(across / 10)));
      for (var i = 0; i < lines; i++) {
        var o = ((i + 1) / (lines + 1)) * across;
        g.beginPath();
        for (var t = 0; t <= along; t += 6) {
          var wv = Math.sin(t * 0.045 + i * 1.7 + e.seed) * across * 0.06;
          if (vertical) { if (t === 0) g.moveTo(o + wv, t); else g.lineTo(o + wv, t); } else { if (t === 0) g.moveTo(t, o + wv); else g.lineTo(t, o + wv); }
        }
        g.strokeStyle = rgba(m.dark, 0.45);
        g.lineWidth = 1.6;
        g.stroke();
      }
      if (along > 1.6 * PPM && across > 14) {
        var kp = along * (0.3 + rr2() * 0.4), kx = vertical ? w / 2 : kp, ky = vertical ? kp : h / 2;
        for (var kk = 0; kk < 3; kk++) { ell(g, kx, ky, (vertical ? across : 18) * (0.28 - kk * 0.08), (vertical ? 18 : across) * (0.28 - kk * 0.08)); g.strokeStyle = rgba(m.knot, 0.75 - kk * 0.15); g.lineWidth = 1.6; g.stroke(); }
      }
      // nails at the ends
      g.fillStyle = "#5A4A3A";
      var nails = vertical ? [[w / 2, 7], [w / 2, h - 7]] : [[7, h / 2], [w - 7, h / 2]];
      nails.forEach(function (n) { if (across > 10) { ell(g, n[0], n[1], 2.2, 2.2); g.fill(); } });
      // top bevel light
      g.fillStyle = "rgba(255,255,255,0.25)";
      if (vertical) g.fillRect(2, 0, 3, h); else g.fillRect(0, 2, w, 3);
    } else if (e.mat === "stone") {
      for (i = 0; i < 4; i++) {
        var fx = rr2() * w, fy = rr2() * h, fs = Math.min(w, h) * (0.4 + rr2() * 0.5);
        poly(g, [fx, fy, fx + fs * 0.7, fy + fs * 0.1, fx + fs * 0.5, fy + fs * 0.6, fx - fs * 0.1, fy + fs * 0.45]);
        g.fillStyle = i % 2 ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.1)";
        g.fill();
      }
      for (i = 0; i < (w * h) / 220; i++) { g.fillStyle = rr2() < 0.5 ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.25)"; g.fillRect(rr2() * w, rr2() * h, 1.6, 1.6); }
      g.fillStyle = "rgba(255,255,255,0.3)";
      g.fillRect(0, 0, w, 3);
    } else if (e.mat === "glass") {
      g.beginPath(); g.moveTo(w * 0.08, h * 0.15); g.lineTo(w * 0.55, h * 0.75);
      if (vertical) { g.moveTo(w * 0.2, h * 0.05); g.lineTo(w * 0.8, h * 0.35); }
      g.strokeStyle = "rgba(255,255,255,0.7)"; g.lineWidth = Math.max(2, Math.min(w, h) * 0.12); g.stroke();
      g.fillStyle = "rgba(255,255,255,0.85)"; g.fillRect(w * 0.08, h * 0.08, Math.max(3, w * 0.08), Math.max(3, h * 0.08));
    } else if (e.mat === "tnt") {
      g.fillStyle = m.dark;
      g.fillRect(0, h * 0.12, w, h * 0.1); g.fillRect(0, h * 0.78, w, h * 0.1);
      rrect(g, w * 0.14, h * 0.32, w * 0.72, h * 0.36, 4); g.fillStyle = "#F4E3B5"; g.fill(); g.strokeStyle = "#7A5A2A"; g.lineWidth = 2; g.stroke();
      g.font = Math.round(h * 0.3) + "px " + FONT; g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "#2B1A12";
      g.fillText("TNT", w / 2, h * 0.51);
    }
    // damage: cracks that follow the material
    if (stage > 0) {
      var cracks = stage === 1 ? 1 : stage === 2 ? 2 : 4;
      g.strokeStyle = e.mat === "glass" ? "rgba(255,255,255,0.95)" : rgba(m.out, 0.9);
      g.lineWidth = e.mat === "glass" ? 2 : 2.2;
      for (var cc = 0; cc < cracks; cc++) {
        var sx = rr2() * w, sy = rr2() < 0.5 ? 0 : h;
        if (rr2() < 0.4) { sx = rr2() < 0.5 ? 0 : w; sy = rr2() * h; }
        var ang = Math.atan2(h / 2 - sy, w / 2 - sx);
        if (e.mat === "wood") ang = vertical ? (sy === 0 ? Math.PI / 2 : -Math.PI / 2) : sx === 0 ? 0 : Math.PI;
        g.beginPath(); g.moveTo(sx, sy);
        var len = Math.max(w, h) * (stage === 3 ? 0.8 : 0.45), stepL = e.mat === "stone" ? 9 : 6, x2 = sx, y2 = sy;
        for (var d = 0; d < len; d += stepL) {
          ang += (rr2() - 0.5) * (e.mat === "stone" ? 1.3 : e.mat === "wood" ? 0.35 : 0.9);
          x2 += Math.cos(ang) * stepL; y2 += Math.sin(ang) * stepL;
          g.lineTo(x2, y2);
          if (stage >= 2 && rr2() < 0.18) { g.moveTo(x2, y2); g.lineTo(x2 + Math.cos(ang + 1) * stepL * 1.5, y2 + Math.sin(ang + 1) * stepL * 1.5); g.moveTo(x2, y2); }
        }
        g.stroke();
      }
    }
    g.restore();
    // chipped corners on the last state
    if (stage === 3) {
      g.save(); g.globalCompositeOperation = "destination-out";
      poly(g, [w - Math.min(w, h) * 0.45, 0, w, 0, w, Math.min(w, h) * 0.45]); g.fill();
      poly(g, [0, h - Math.min(w, h) * 0.35, 0, h, Math.min(w, h) * 0.35, h]); g.fill();
      g.restore();
    }
    rrect(g, 0, 0, w, h, rad);
    if (stage === 3) { g.save(); g.beginPath(); g.rect(0, 0, w, h); poly(g, [w - Math.min(w, h) * 0.45, 0, w, 0, w, Math.min(w, h) * 0.45]); g.restore(); }
    g.strokeStyle = m.out;
    g.lineWidth = lw;
    g.stroke();
    var spr = { c: c, pad: pad };
    e.tex[stage] = spr;
    return spr;
  }
  function rockSprite(e) {
    if (e.tex) return e.tex;
    var w = e.w * PPM, h = e.h * PPM, pad = 10;
    var c = mkB(w + pad * 2, h + pad * 2), g = c.getContext("2d"), rr2 = rng(e.seed);
    g.translate(pad, pad);
    rrect(g, 0, 0, w, h + 20, 22);
    var gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, "#C58A4E"); gr.addColorStop(1, "#7A4A22");
    g.fillStyle = gr; g.fill();
    g.save(); g.clip();
    for (var i = 0; i < w / 24; i++) { ell(g, rr2() * w, 22 + rr2() * (h - 16), 5 + rr2() * 9, 4 + rr2() * 6); g.fillStyle = i % 2 ? "rgba(255,255,255,0.14)" : "rgba(60,30,10,0.22)"; g.fill(); }
    g.fillStyle = "#6FB83A"; g.fillRect(0, 0, w, 16);
    g.fillStyle = "#8FD34D"; g.fillRect(0, 0, w, 7);
    g.restore();
    rrect(g, 0, 0, w, h + 20, 22);
    g.strokeStyle = "#4A2A10"; g.lineWidth = 4; g.stroke();
    g.fillStyle = "#8FD34D";
    for (i = 6; i < w - 6; i += 9) { poly(g, [i - 4, 3, i, -6 - rr2() * 5, i + 4, 3]); g.fill(); }
    e.tex = { c: c, pad: pad };
    return e.tex;
  }

  // ================================================================ THE SLING
  var TIP_B = { x: -0.5, y: 3.02 }, TIP_F = { x: 0.5, y: 3.02 }, FORK = { x: 0, y: 1.72 };
  var slingBackC = null, slingFrontC = null;
  function bakeSling() {
    var Wm = 1.6, Hm = 3.45, ox = Wm / 2, oy = Hm; // origin = base of the trunk
    function part(drawArms) {
      var c = mkB(Wm * PPM, Hm * PPM), g = c.getContext("2d");
      g.lineCap = "round"; g.lineJoin = "round";
      function P(x, y) { return [(x + ox) * PPM, (oy - y) * PPM]; }
      function limb(a, b, wM, col) {
        var p = P(a.x, a.y), q = P(b.x, b.y);
        g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]);
        g.strokeStyle = "#3B1D0B"; g.lineWidth = wM * PPM + 8; g.stroke();
        g.strokeStyle = col; g.lineWidth = wM * PPM; g.stroke();
        g.strokeStyle = "rgba(255,255,255,0.28)"; g.lineWidth = wM * PPM * 0.25;
        g.beginPath(); g.moveTo(p[0] - wM * PPM * 0.2, p[1]); g.lineTo(q[0] - wM * PPM * 0.2, q[1]); g.stroke();
      }
      drawArms(limb, P, g);
      return c;
    }
    slingBackC = part(function (limb) {
      limb({ x: 0, y: 0.05 }, FORK, 0.3, "#A0602A");
      limb(FORK, TIP_B, 0.22, "#8E5222");
    });
    slingFrontC = part(function (limb, P, g) {
      limb(FORK, TIP_F, 0.22, "#B06A2E");
      // a leather wrap where the band ties on
      var p = P(TIP_F.x - 0.04, TIP_F.y - 0.12);
      rrect(g, p[0] - 0.14 * PPM, p[1] - 0.12 * PPM, 0.28 * PPM, 0.24 * PPM, 6);
      g.fillStyle = "#4A2412"; g.fill(); g.strokeStyle = "#2A1206"; g.lineWidth = 3; g.stroke();
    });
  }

  // ================================================================ BACKDROPS
  var THEMES = {
    day: { sky: ["#4FA6E3", "#86C9F0", "#C4E8F8"], sun: "255,244,190", far: "#A4D45E", farOut: "#7FB14A", near: "#6FB83A", nearOut: "#4E8E26", tree: "#4E9A2E", treeOut: "#2C5E16", ground: ["#8FD34D", "#6FB83A", "#B5783A", "#8C5424"], clouds: 1, stars: 0, moon: 0, castle: 0, glow: 0.35 },
    sunset: { sky: ["#5A3C8E", "#E2745A", "#FFD39A"], sun: "255,214,150", far: "#B97A6E", farOut: "#8A5552", near: "#7E8F3C", nearOut: "#56622A", tree: "#5D6E2C", treeOut: "#38431A", ground: ["#A2C24A", "#7E9A38", "#A86A36", "#7C4A22"], clouds: 0.7, stars: 0, moon: 0, castle: 1, glow: 0.6 },
    night: { sky: ["#0D1636", "#1E2C5E", "#3D5A8E"], sun: "190,210,255", far: "#2E4466", farOut: "#1C2C46", near: "#2C4A3A", nearOut: "#18301F", tree: "#22382A", treeOut: "#0F1D14", ground: ["#4E7A3E", "#3A5E30", "#6A4426", "#4A2C18"], clouds: 0.35, stars: 1, moon: 1, castle: 1, glow: 1 },
  };
  var theme = "day", TH = THEMES.day;
  var skyC = null, farC = null, nearC = null, cloudCs = [], groundC = null, sunPos = { x: 0, y: 0, r: 0 }, windows = [];
  function bakeBackdrop(name) {
    theme = name || "day";
    TH = THEMES[theme];
    var dw = Math.round(W * dpr), dh = Math.round(H * dpr);
    // sky
    skyC = mk(dw, dh);
    var g = skyC.getContext("2d");
    var gr = g.createLinearGradient(0, 0, 0, dh * 0.8);
    gr.addColorStop(0, TH.sky[0]); gr.addColorStop(0.55, TH.sky[1]); gr.addColorStop(1, TH.sky[2]);
    g.fillStyle = gr; g.fillRect(0, 0, dw, dh);
    var rr2 = rng(77);
    if (TH.stars) for (var i = 0; i < 120; i++) { g.fillStyle = "rgba(255,255,255," + (0.3 + rr2() * 0.7).toFixed(2) + ")"; var sz = rr2() < 0.15 ? 2.4 : 1.4; g.fillRect(rr2() * dw, rr2() * dh * 0.55, sz * dpr, sz * dpr); }
    var sr = Math.min(dw, dh) * (TH.moon ? 0.07 : 0.1);
    sunPos = { x: dw * 0.78, y: dh * (TH.moon ? 0.18 : theme === "sunset" ? 0.5 : 0.2), r: sr };
    var sg = g.createRadialGradient(sunPos.x, sunPos.y, sr * 0.6, sunPos.x, sunPos.y, sr * 3.2);
    sg.addColorStop(0, "rgba(" + TH.sun + ",0.55)"); sg.addColorStop(1, "rgba(" + TH.sun + ",0)");
    g.fillStyle = sg; g.fillRect(0, 0, dw, dh);
    g.beginPath(); g.arc(sunPos.x, sunPos.y, sr, 0, Math.PI * 2);
    g.fillStyle = TH.moon ? "#F4F1DE" : "rgb(" + TH.sun + ")"; g.fill();
    if (TH.moon) { g.fillStyle = "rgba(160,170,190,0.35)"; [[0.3, -0.2, 0.22], [-0.25, 0.25, 0.16], [0.1, 0.35, 0.1]].forEach(function (d) { g.beginPath(); g.arc(sunPos.x + d[0] * sr, sunPos.y + d[1] * sr, d[2] * sr, 0, Math.PI * 2); g.fill(); }); }
    // clouds
    cloudCs = [];
    for (var k = 0; k < 3; k++) {
      var cw = 220 * dpr, ch = 90 * dpr, cc = mk(cw, ch), cg = cc.getContext("2d");
      var puffs = [[0.25, 0.62, 0.22], [0.45, 0.42, 0.28], [0.68, 0.55, 0.24], [0.85, 0.68, 0.15], [0.12, 0.72, 0.13]];
      cg.beginPath();
      puffs.forEach(function (p) { cg.moveTo(p[0] * cw + p[2] * ch * 1.6, p[1] * ch); cg.arc(p[0] * cw, p[1] * ch, p[2] * ch * 1.6, 0, Math.PI * 2); });
      cg.fillStyle = theme === "night" ? "rgba(120,140,190,0.35)" : theme === "sunset" ? "rgba(255,220,200,0.85)" : "#FFFFFF";
      cg.fill();
      cg.save(); cg.clip(); cg.fillStyle = theme === "day" ? "#D9EEF7" : "rgba(0,0,0,0.08)"; cg.fillRect(0, ch * 0.72, cw, ch); cg.restore();
      cloudCs.push(cc);
    }
    // far hills (pointy, Poached Eggs style) and the gremlin lair on dusk/night levels
    var tw = Math.round(1400 * dpr), fh = Math.round(H * 0.5 * dpr);
    farC = mk(tw, fh);
    g = farC.getContext("2d");
    rr2 = rng(3);
    g.beginPath(); g.moveTo(0, fh);
    for (var x = 0; x <= tw; x += 4) {
      var y = fh * 0.55 - Math.abs(Math.sin((x / tw) * Math.PI * 7)) * fh * 0.28 - Math.sin((x / tw) * Math.PI * 2) * fh * 0.08;
      g.lineTo(x, y);
    }
    g.lineTo(tw, fh); g.closePath();
    var fg = g.createLinearGradient(0, fh * 0.2, 0, fh);
    fg.addColorStop(0, TH.far); fg.addColorStop(1, mixHex(TH.far, TH.farOut, 0.6));
    g.fillStyle = fg; g.fill();
    g.strokeStyle = TH.farOut; g.lineWidth = 3 * dpr; g.stroke();
    windows = [];
    if (TH.castle) {
      var kx = tw * 0.62, kb = fh * 0.5, u = 14 * dpr;
      g.fillStyle = mixHex(TH.farOut, "#000000", 0.35);
      g.fillRect(kx, kb - 5 * u, 9 * u, 5 * u);
      g.fillRect(kx - 2 * u, kb - 8.5 * u, 3 * u, 8.5 * u);
      g.fillRect(kx + 8 * u, kb - 10 * u, 3 * u, 10 * u);
      for (var cr = 0; cr < 3; cr++) { g.fillRect(kx - 2 * u + cr * u, kb - 9.3 * u, 0.6 * u, 0.9 * u); g.fillRect(kx + 8 * u + cr * u, kb - 10.8 * u, 0.6 * u, 0.9 * u); }
      poly(g, [kx - 2.3 * u, kb - 9.3 * u, kx - 0.5 * u, kb - 12 * u, kx + 1.3 * u, kb - 9.3 * u]); g.fill();
      [[kx - 1.1 * u, kb - 6.5 * u], [kx + 9 * u, kb - 7.5 * u], [kx + 9 * u, kb - 4.5 * u], [kx + 3.8 * u, kb - 3.2 * u], [kx + 6 * u, kb - 3.2 * u]].forEach(function (p) {
        g.fillStyle = "#FFB347"; g.fillRect(p[0], p[1], 0.8 * u, 1.2 * u); windows.push({ x: p[0] / dpr + 0.4 * u / dpr, y: p[1] / dpr + 0.6 * u / dpr });
      });
    }
    // near hills with round cartoon trees
    var nh = Math.round(H * 0.46 * dpr);
    nearC = mk(tw, nh);
    g = nearC.getContext("2d");
    rr2 = rng(9);
    var treeXs = [];
    for (i = 0; i < 9; i++) treeXs.push(rr2() * tw);
    function hillY(x2) { return nh * 0.66 - Math.sin((x2 / tw) * Math.PI * 4) * nh * 0.1 - Math.sin((x2 / tw) * Math.PI * 10 + 1) * nh * 0.035; }
    treeXs.forEach(function (tx) {
      var ty = hillY(tx), r2 = nh * (0.1 + rr2() * 0.07);
      g.lineWidth = 3 * dpr; g.strokeStyle = TH.treeOut;
      g.fillStyle = mixHex(TH.tree, "#5A3314", 0.6); g.fillRect(tx - r2 * 0.12, ty - r2 * 0.9, r2 * 0.24, r2 * 1.2); g.strokeRect(tx - r2 * 0.12, ty - r2 * 0.9, r2 * 0.24, r2 * 1.2);
      var blobs = [[0, -1.35, 1], [-0.6, -1.0, 0.7], [0.65, -1.05, 0.72]];
      g.lineWidth = 6 * dpr; g.strokeStyle = TH.treeOut;
      blobs.forEach(function (b2) { g.beginPath(); g.arc(tx + b2[0] * r2, ty + b2[1] * r2, b2[2] * r2, 0, Math.PI * 2); g.stroke(); });
      var tg = g.createRadialGradient(tx - r2 * 0.4, ty - r2 * 1.8, r2 * 0.1, tx, ty - r2 * 1.2, r2 * 1.6);
      tg.addColorStop(0, shade(TH.tree, 0.3)); tg.addColorStop(1, TH.tree);
      g.fillStyle = tg;
      blobs.forEach(function (b2) { g.beginPath(); g.arc(tx + b2[0] * r2, ty + b2[1] * r2, b2[2] * r2, 0, Math.PI * 2); g.fill(); });
      g.beginPath(); g.arc(tx - r2 * 0.3, ty - r2 * 1.7, r2 * 0.35, 0, Math.PI * 2); g.fillStyle = "rgba(255,255,255,0.12)"; g.fill();
    });
    g.beginPath(); g.moveTo(0, nh);
    for (x = 0; x <= tw; x += 4) g.lineTo(x, hillY(x));
    g.lineTo(tw, nh); g.closePath();
    var ng = g.createLinearGradient(0, nh * 0.3, 0, nh);
    ng.addColorStop(0, shade(TH.near, 0.12)); ng.addColorStop(1, mixHex(TH.near, TH.nearOut, 0.5));
    g.fillStyle = ng; g.fill();
    g.strokeStyle = TH.nearOut; g.lineWidth = 3 * dpr; g.stroke();
    // ground tile, in world units (8 m wide, 5 m deep) at 48 px/m
    var GP = 48, gw = 8 * GP, gh = 5 * GP + 18;
    groundC = mk(gw, gh);
    g = groundC.getContext("2d");
    rr2 = rng(5);
    var dg = g.createLinearGradient(0, 18, 0, gh);
    dg.addColorStop(0, TH.ground[2]); dg.addColorStop(1, TH.ground[3]);
    g.fillStyle = dg; g.fillRect(0, 18, gw, gh);
    for (i = 0; i < 26; i++) { ell(g, rr2() * gw, 34 + rr2() * (gh - 40), 3 + rr2() * 6, 2 + rr2() * 4); g.fillStyle = i % 3 ? "rgba(255,230,190,0.18)" : "rgba(40,20,5,0.25)"; g.fill(); }
    g.fillStyle = TH.ground[1]; g.fillRect(0, 12, gw, 16);
    g.fillStyle = TH.ground[0]; g.fillRect(0, 12, gw, 7);
    g.fillStyle = TH.ground[0];
    for (x = 0; x < gw; x += 7) { poly(g, [x - 3, 14, x + 1, 4 + rr2() * 4, x + 4, 14]); g.fill(); }
    g.fillStyle = "rgba(0,0,0,0.18)"; g.fillRect(0, 28, gw, 3);
  }

  // ---------------------------------------------------------------- audio
  var Au = (function () {
    var ac = null, master, music, sfx, comp, noiseBuf, delay, fb, muted = false;
    try { muted = localStorage.getItem("chishot:mute") === "1"; } catch (e) { /* storage blocked */ }
    function init() {
      if (ac) { if (ac.state !== "running") ac.resume(); return; }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      // "ambient": follows the ring/silent switch and mixes with whatever the keeper is listening to
      try { if (navigator.audioSession) navigator.audioSession.type = "ambient"; } catch (e) { /* older Safari */ }
      ac = new AC();
      comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      master = ac.createGain(); master.gain.value = muted ? 0 : 0.9;
      comp.connect(master); master.connect(ac.destination);
      music = ac.createGain(); music.gain.value = 0.3; music.connect(comp);
      sfx = ac.createGain(); sfx.gain.value = 0.8; sfx.connect(comp);
      delay = ac.createDelay(1); delay.delayTime.value = 0.165;
      fb = ac.createGain(); fb.gain.value = 0.28;
      var wet = ac.createGain(); wet.gain.value = 0.35;
      delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(music);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      var dd = noiseBuf.getChannelData(0);
      for (var i = 0; i < dd.length; i++) dd[i] = Math.random() * 2 - 1;
      if (ac.state !== "running") ac.resume();
    }
    function now() { return ac ? ac.currentTime : 0; }
    function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
    function tone(t, f, dur, type, vol, dest, o) {
      if (!ac) return;
      o = o || {};
      var osc = ac.createOscillator(), gn = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f, t);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + (o.slide || dur));
      if (o.vib) {
        var lfo = ac.createOscillator(), lg = ac.createGain();
        lfo.frequency.value = o.vib; lg.gain.value = f * 0.02;
        lfo.connect(lg); lg.connect(osc.frequency); lfo.start(t); lfo.stop(t + dur + 0.05);
      }
      var node = osc;
      if (o.lp) { var fl = ac.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.value = o.lp; osc.connect(fl); node = fl; }
      node.connect(gn);
      gn.gain.setValueAtTime(0.0001, t);
      gn.gain.exponentialRampToValueAtTime(vol, t + (o.a || 0.005));
      gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      gn.connect(dest || sfx);
      if (o.send) gn.connect(delay);
      osc.start(t); osc.stop(t + dur + 0.05);
    }
    function noise(t, dur, vol, type, f0, f1, q, dest) {
      if (!ac) return;
      var src = ac.createBufferSource(); src.buffer = noiseBuf;
      var fl = ac.createBiquadFilter(); fl.type = type || "bandpass"; fl.Q.value = q || 1;
      fl.frequency.setValueAtTime(f0, t);
      if (f1) fl.frequency.exponentialRampToValueAtTime(f1, t + dur);
      var gn = ac.createGain();
      gn.gain.setValueAtTime(vol, t);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(fl); fl.connect(gn); gn.connect(dest || sfx);
      src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
    }

    // ---- music: an 8-bar loop in A minor, layered by intensity.
    var BPM = 138, STEPT = 60 / BPM / 4, seqOn = false, nextT = 0, step = 0, timer = null;
    var intensity = 0, duck = 1;
    var CH = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
    var ROOT = [45, 41, 48, 43];
    var _ = null;
    var MEL = [
      [76, _, 74, 72, _, 69, _, 72, 74, _, 76, _, 79, _, 76, _],
      [77, _, 76, 74, _, 72, _, 69, 72, _, 74, _, 76, _, _, _],
      [79, _, 76, 72, _, 76, _, 79, 84, _, 83, _, 79, _, 76, _],
      [74, _, 76, 79, _, 83, _, 81, 79, _, 76, _, 74, _, 71, _],
      [81, _, 79, 76, _, 79, _, 81, 84, _, 81, _, 79, _, 76, _],
      [77, _, 79, 81, _, 84, _, 81, 77, _, 76, _, 74, _, 72, _],
      [76, _, 79, 84, _, 83, _, 79, 76, _, 79, _, 84, _, 88, _],
      [86, _, 83, 79, _, 81, _, 83, 86, _, _, _, 83, _, _, _],
    ];
    function playStep(s, t) {
      var bar = Math.floor(s / 16) % 8, i = s % 16, ch = bar % 4;
      var lvl = intensity;
      // bass: driving octave eighths
      if (i % 2 === 0) tone(t, mtof(ROOT[ch] + (i % 4 === 2 ? 12 : 0)), STEPT * 1.8, "triangle", 0.3 * duck, music, { lp: 900 });
      // arpeggio
      var arpVol = (lvl >= 2 ? 0.06 : 0.04) * duck;
      tone(t, mtof(CH[ch][i % 3] + 12 + (lvl >= 2 && i % 8 > 3 ? 12 : 0)), STEPT * 1.4, "sine", arpVol * 1.6, music, { lp: 3000 });
      // hats
      if (i % 2 === 1 || lvl >= 2) noise(t, 0.03, (i % 4 === 2 ? 0.09 : 0.05) * duck, "highpass", 7000, 0, 0.7, music);
      if (lvl >= 1) {
        if (i % 4 === 0) { tone(t, 150, 0.14, "sine", 0.9 * duck, music, { to: 42, slide: 0.12 }); }
        if (i === 4 || i === 12) { noise(t, 0.13, 0.32 * duck, "bandpass", 1800, 900, 0.8, music); tone(t, 190, 0.08, "triangle", 0.18 * duck, music); }
        var n = MEL[bar][i];
        if (n !== null) {
          // marimba-ish pluck: a sine body plus a quick bright partial
          tone(t, mtof(n), STEPT * 3, "sine", 0.2 * duck, music, { send: true });
          tone(t, mtof(n) * 4, STEPT * 0.6, "sine", 0.035 * duck, music);
          tone(t, mtof(n), STEPT * 1.2, "triangle", 0.06 * duck, music, { lp: 2600 });
        }
        if (lvl >= 2 && n !== null) tone(t, mtof(n - 12), STEPT * 2, "triangle", 0.07 * duck, music);
      }
    }
    function sched() {
      if (!ac || !seqOn) return;
      while (nextT < ac.currentTime + 0.14) {
        playStep(step, nextT);
        nextT += STEPT;
        step = (step + 1) % 128;
      }
    }
    function startMusic() {
      if (!ac || seqOn) return;
      seqOn = true;
      nextT = ac.currentTime + 0.05;
      timer = setInterval(sched, 30);
    }
    function setIntensity(v) { intensity = v; }
    function duckFor(sec) {
      duck = 0.25;
      setTimeout(function () { duck = 1; }, sec * 1000);
    }
    function setMuted(m) {
      muted = m;
      try { localStorage.setItem("chishot:mute", m ? "1" : "0"); } catch (e) { /* storage blocked */ }
      if (master) master.gain.setTargetAtTime(m ? 0 : 0.9, ac.currentTime, 0.05);
    }
    var lastStretch = 0, lastImpact = 0;
    var api = {
      init: init, startMusic: startMusic, setIntensity: setIntensity, duckFor: duckFor,
      isMuted: function () { return muted; }, setMuted: setMuted,
      suspend: function () { if (ac) ac.suspend(); }, resume: function () { if (ac) ac.resume(); },
      click: function () { var t = now(); tone(t, 1300, 0.04, "square", 0.12); tone(t + 0.03, 1800, 0.04, "square", 0.08); },
      stretch: function (k) {
        var t = now();
        if (!ac || t - lastStretch < 0.06) return;
        lastStretch = t;
        tone(t, 260 + k * 520, 0.05, "square", 0.05, sfx, { lp: 1600 });
      },
      launch: function () {
        var t = now();
        noise(t, 0.28, 0.5, "bandpass", 500, 2600, 1.2);
        tone(t, 180, 0.2, "sine", 0.5, sfx, { to: 520, slide: 0.15 });
        tone(t + 0.02, 140, 0.12, "triangle", 0.3, sfx, { to: 90 });
      },
      yell: function () {
        var t = now();
        tone(t, 620, 0.28, "square", 0.12, sfx, { to: 980, slide: 0.12, vib: 18, lp: 3000 });
        tone(t + 0.12, 900, 0.18, "square", 0.08, sfx, { to: 700, vib: 20, lp: 3000 });
      },
      impact: function (mat, s) {
        var t = now();
        if (!ac || t - lastImpact < 0.045) return;
        lastImpact = t;
        var v = clamp(s / 12, 0.15, 1);
        if (mat === "glass") { noise(t, 0.12, 0.45 * v, "highpass", 3500, 0, 1); tone(t, 2400 + Math.random() * 900, 0.15, "sine", 0.12 * v); }
        else if (mat === "stone") { noise(t, 0.2, 0.6 * v, "lowpass", 500, 120, 1); tone(t, 90, 0.18, "sine", 0.5 * v, sfx, { to: 50 }); }
        else if (mat === "wood" || mat === "tnt") { noise(t, 0.12, 0.5 * v, "bandpass", 700, 300, 2); tone(t, 150, 0.12, "triangle", 0.4 * v, sfx, { to: 90 }); }
        else { noise(t, 0.16, 0.45 * v, "lowpass", 400, 100, 1); tone(t, 110, 0.12, "sine", 0.35 * v, sfx, { to: 60 }); }
      },
      crash: function (mat) {
        var t = now();
        if (mat === "glass") { noise(t, 0.35, 0.6, "highpass", 2800, 6000, 1); for (var i = 0; i < 4; i++) tone(t + i * 0.035, 2000 + Math.random() * 2400, 0.2, "sine", 0.12); }
        else if (mat === "stone") { noise(t, 0.45, 0.8, "lowpass", 900, 90, 1); tone(t, 70, 0.3, "sine", 0.6, sfx, { to: 35 }); }
        else { noise(t, 0.3, 0.7, "bandpass", 900, 250, 1.5); tone(t, 120, 0.2, "triangle", 0.5, sfx, { to: 60 }); noise(t + 0.08, 0.2, 0.3, "bandpass", 1500, 600, 2); }
      },
      gremHit: function () { var t = now(); tone(t, 260, 0.18, "sawtooth", 0.16, sfx, { to: 120, lp: 1400 }); },
      gremDie: function (big) {
        var t = now(), k = big ? 0.6 : 1;
        tone(t, 980 * k, 0.32, "square", 0.16, sfx, { to: 240 * k, vib: 30, lp: 3500 });
        noise(t, 0.35, 0.6, "bandpass", 1200, 300, 1);
        tone(t + 0.05, 420 * k, 0.25, "sine", 0.5, sfx, { to: 60 });
      },
      laugh: function () {
        var t = now(), notes = [330, 290, 335, 280, 340, 260];
        for (var i = 0; i < notes.length; i++) {
          tone(t + i * 0.085, notes[i], 0.07, "square", 0.09, sfx, { lp: 1800, vib: 25 });
          noise(t + i * 0.085, 0.05, 0.08, "bandpass", 1500, 0, 3);
        }
      },
      boom: function () {
        var t = now();
        noise(t, 1.1, 1.0, "lowpass", 2200, 80, 0.7);
        tone(t, 80, 0.7, "sine", 0.9, sfx, { to: 28, slide: 0.6 });
        noise(t, 0.2, 0.6, "highpass", 2000, 0, 0.6);
      },
      power: function () {
        var t = now();
        tone(t, 300, 0.25, "square", 0.12, sfx, { to: 1600, slide: 0.2, lp: 4000 });
        for (var i = 0; i < 3; i++) tone(t + 0.12 + i * 0.05, 1800 + i * 500, 0.12, "sine", 0.1);
      },
      combo: function (n) { var t = now(); tone(t, 520 + n * 130, 0.12, "square", 0.1, sfx, { lp: 4000 }); tone(t + 0.07, 780 + n * 130, 0.14, "square", 0.09, sfx, { lp: 4000 }); },
      star: function (i) { var t = now(), f = [1046, 1318, 1568][i] || 1568; tone(t, f, 0.6, "sine", 0.3); tone(t, f * 2, 0.35, "triangle", 0.08); tone(t + 0.04, f * 1.5, 0.4, "sine", 0.1); },
      bonus: function (i) { var t = now(); tone(t, 660 + i * 110, 0.15, "square", 0.1, sfx, { lp: 3000 }); },
      win: function () {
        var t = now(), seq = [72, 76, 79, 84, 79, 84, 88];
        duckFor(2.4);
        for (var i = 0; i < seq.length; i++) tone(t + i * 0.1, mtof(seq[i]), i === seq.length - 1 ? 0.8 : 0.14, "square", 0.13, sfx, { lp: 3800, vib: i === seq.length - 1 ? 6 : 0 });
        tone(t + 0.6, mtof(60), 0.9, "triangle", 0.25);
      },
      lose: function () {
        var t = now();
        duckFor(2.2);
        tone(t, 330, 0.4, "sawtooth", 0.14, sfx, { to: 250, lp: 1500 });
        tone(t + 0.42, 262, 0.75, "sawtooth", 0.14, sfx, { to: 150, slide: 0.7, lp: 1300, vib: 5 });
      },
      whoosh: function () { var t = now(); noise(t, 0.4, 0.25, "bandpass", 400, 1800, 0.8); },
      firework: function (big) {
        var t = now();
        tone(t, 500, 0.5, "sine", 0.06, sfx, { to: 1600, slide: 0.45 });
        noise(t + 0.48, big ? 0.9 : 0.6, big ? 0.7 : 0.5, "lowpass", 1800, 120, 0.8);
        for (var i = 0; i < 7; i++) noise(t + 0.6 + i * 0.07 + Math.random() * 0.05, 0.05, 0.12, "highpass", 5000, 0, 1);
      },
      hop: function () { var t = now(); tone(t, 330, 0.16, "square", 0.08, sfx, { to: 720, slide: 0.12, lp: 2600 }); tone(t + 0.3, 520, 0.06, "triangle", 0.12); },
    };
    return api;
  })();


  // ---------------------------------------------------------------- save
  var save = { stars: [], best: [] };
  try {
    var raw = localStorage.getItem(SAVE_KEY);
    if (raw) save = JSON.parse(raw) || save;
  } catch (e) { /* storage blocked: progress lives for this session only */ }
  save.stars = save.stars || [];
  save.best = save.best || [];
  function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* storage blocked */ } }
  function unlocked(i) { return i === 0 || (save.stars[i - 1] || 0) > 0; }

  // ---------------------------------------------------------------- particles + fx
  var parts = [], pops = [], glows = [], trail = [], prevTrail = [];
  var shake = 0, flash = 0, flashCol = "#ffffff", timeScale = 1, slowT = 0, slowTo = 1, hitStop = 0;
  var MAXP = 240;
  function addPart(p) { if (parts.length < MAXP) parts.push(p); }
  function puff(x, y, n, col, size, up) {
    for (var i = 0; i < n; i++) {
      var a = rand(0, Math.PI * 2), sp = rand(0.4, 2.2);
      addPart({ k: "puff", x: x + Math.cos(a) * size * 0.4, y: y + Math.sin(a) * size * 0.4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + (up || 0.6), t: 0, life: rand(0.35, 0.7), s: size * rand(0.5, 1), col: col, g: -0.5 });
    }
  }
  function debris(e) {
    var m = MAT[e.mat], n = e.mat === "glass" ? 11 : e.mat === "stone" ? 6 : 9;
    for (var i = 0; i < n; i++) {
      var lx = (R() - 0.5) * e.w, ly = (R() - 0.5) * e.h, ca = Math.cos(e.a), sa = Math.sin(e.a);
      addPart({ k: e.mat === "glass" ? "shard" : e.mat === "stone" ? "chunk" : "splinter", x: e.x + lx * ca - ly * sa, y: e.y + lx * sa + ly * ca, vx: rand(-4, 4), vy: rand(1, 6), t: 0, life: e.mat === "glass" ? rand(0.4, 0.6) : rand(0.7, 1.0), s: e.mat === "stone" ? rand(0.12, 0.26) : rand(0.08, 0.2), rot: rand(0, 6), vr: rand(-8, 8), col: m.chips[i % 3], out: m.out, g: e.mat === "glass" ? 14 : 18 });
    }
  }
  function tufts(x, y, n) {
    for (var i = 0; i < n; i++) {
      var a = rand(0, Math.PI * 2), sp = rand(1, 3.5);
      addPart({ k: "tuft", x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 1.5, t: 0, life: rand(0.6, 0.9), s: rand(0.12, 0.2), rot: rand(0, 6), vr: rand(-4, 4), col: PAL.body, out: shade(PAL.outline, -0.3), g: 4 });
    }
  }
  function sparks(x, y, n, spd, cols) {
    cols = cols || ["#FFF3A6", "#FFB13B", "#FF6A2A"];
    for (var i = 0; i < n; i++) {
      var a = rand(0, Math.PI * 2), sp = rand(spd * 0.3, spd);
      addPart({ k: "spark", x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 1.5, t: 0, life: rand(0.25, 0.6), s: rand(0.05, 0.1), col: cols[i % cols.length], g: 6 });
    }
  }
  function stars(x, y, n) {
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2;
      addPart({ k: "star", x: x, y: y, vx: Math.cos(a) * 2.6, vy: Math.sin(a) * 2.6 + 1, t: 0, life: 0.6, s: 0.16, rot: rand(0, 6), vr: 6, col: "#FFE14D", g: 3 });
    }
  }
  function popup(x, y, s, col, size, life) {
    if (pops.length > 7) pops.splice(0, pops.length - 7);
    for (var i = 0; i < pops.length; i++) {
      var o = pops[i];
      if (!o.sticky && o.t < 0.5 && Math.abs(o.x - x) < 2.4 && Math.abs(o.y - y) < 0.8) y = o.y + 0.85;
    }
    pops.push({ x: x, y: y, s: s, col: col || "#FFFFFF", stroke: "#2B1A12", size: size || 22, t: 0, life: life || 1.1 });
  }
  function addShake(v) { shake = Math.max(shake, v); }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* unsupported */ } }
  function slowmo(to, sec) { slowTo = to; slowT = sec; }

  // ---------------------------------------------------------------- game state
  var scene = "boot", sceneT = 0, game = null, levelIdx = 0;
  var cam = { cx: 8, cy: 6, zoom: 30, user: false, tx: 8, ty: 6, userZoom: 30 }, zLim = { min: 10, max: 60, base: 30, fit: 30 };
  var zoomAnim = null; // { from, to, t, ax, ay (screen anchor), wx, wy (world anchor) }
  var introT = 1, introFrom = 0;
  var pull = { x: 0, y: 0 }, aiming = false, cancelT = 0, cancelFrom = null, bandOsc = 0, bandVel = 0;
  var petState = {}, pid = 1;
  var shownScore = 0, combo = 0, comboT = 0, intensityT = 0, loadT = 1, hopped = false, lastKills = 0;
  var result = null, banner = null;
  var buttons = [];
  var firstShotEver = true;
  try { firstShotEver = localStorage.getItem("chishot:aimed") !== "1"; } catch (e) { /* storage blocked */ }

  function anim(e) {
    if (!e.anim) e.anim = { blinkT: rand(1, 4), blink: 0, hurtT: 0, flashT: 0, laughT: 0, scaredT: 0, bump: 0, flinch: 0, ph: rand(0, 6) };
    return e.anim;
  }
  function idOf(p) { if (!p.__id) p.__id = pid++; return p.__id; }
  function petVis(p) {
    var k = idOf(p);
    if (!petState[k]) petState[k] = { face: "yell", sq: 0, sqDir: 0, stretch: 1 };
    return petState[k];
  }

  // ---- camera geometry
  function viewW() { return W / cam.zoom; }
  function viewH() { return H / cam.zoom; }
  function groundFrac() { return portrait ? 0.76 : 0.84; }
  function baseCy() { return (H * groundFrac() - H / 2) / cam.zoom; }
  function W2S(x, y) { return { x: (x - cam.cx) * cam.zoom + W / 2 + shX, y: H / 2 - (y - cam.cy) * cam.zoom + shY }; }
  function S2W(sx, sy) { return { x: (sx - W / 2) / cam.zoom + cam.cx, y: cam.cy - (sy - H / 2) / cam.zoom }; }
  var shX = 0, shY = 0;

  function setZoomLimits(keep) {
    var ext = game.extent();
    var spanW = ext.max + 6, spanH = Math.max(ext.top + 4, 10);
    zLim.base = portrait ? W / 17.5 : H / 12.5;
    zLim.fit = Math.min(W / spanW, H / (spanH / (groundFrac() * 0.92)));
    zLim.min = Math.min(zLim.base, zLim.fit) * 0.92;
    zLim.max = zLim.base * 1.6;
    if (!keep) cam.zoom = !portrait && zLim.fit >= zLim.base * 0.78 ? Math.min(zLim.base, zLim.fit) : zLim.base;
    cam.zoom = clamp(cam.zoom, zLim.min, zLim.max);
    if (!keep) cam.userZoom = cam.zoom;
    cam.userZoom = clamp(cam.userZoom, zLim.min, zLim.max);
  }
  function aimPose() {
    var ext = game.extent(), vw = viewW();
    var x;
    if (ext.max + 6 <= vw) x = (-5 + ext.max + 1) / 2;
    else x = SL.x - 4.2 + vw / 2; // room for a full pull and the first pet in line
    return { x: clampCamX(x), y: baseCy() };
  }
  function clampCamX(x) {
    var ext = game ? game.extent() : { max: 30 };
    var lo = -7 + viewW() / 2, hi = ext.max + 7 - viewW() / 2;
    if (hi < lo) return (lo + hi) / 2;
    return clamp(x, lo, hi);
  }
  function clampCamY(y) { return clamp(y, baseCy() - 1.2, 40); }
  function soft(v, lo, hi, give) {
    if (v < lo) return lo - (1 - 1 / (1 + (lo - v) / give)) * give;
    if (v > hi) return hi + (1 - 1 / (1 + (v - hi) / give)) * give;
    return v;
  }
  function softCamX(x) { var c = clampCamX(x); return c === x ? x : soft(x, Math.min(c, x === c ? c : clampCamX(-1e9)), Math.max(c, clampCamX(1e9)), 2.2); }

  // ---------------------------------------------------------------- levels
  function startLevel(i) {
    fin = null;
    levelIdx = i;
    parts = []; pops = []; trail = []; prevTrail = [];
    petState = {};
    result = null;
    shake = 0; flash = 0; timeScale = 1; slowT = 0; hitStop = 0;
    shownScore = 0; combo = 0; comboT = 0; pull = { x: 0, y: 0 }; aiming = false; cancelT = 0;
    pointers = {}; mode = null; panVel = { x: 0, y: 0 };
    game = new Core.Game(i, SHAPE, {
      hit: onHit, breakBlock: onBreak, killGrem: onKill, explode: onExplode, power: onPower,
      petImpact: onPetImpact, nextShot: onNextShot, lost: onLost, won: onWon, petGone: onPetGone,
    });
    if (Core.LEVELS[i].theme !== theme) bakeBackdrop(Core.LEVELS[i].theme);
    setZoomLimits(false);
    cam.user = false;
    var ext = game.extent();
    introFrom = clampCamX(ext.max - viewW() / 2 + 1);
    cam.cx = introFrom;
    cam.cy = baseCy();
    introT = 0;
    scene = "play";
    sceneT = 0;
    banner = { t: 0, s1: "LEVEL " + (i + 1), s2: Core.LEVELS[i].name };
    if (portrait && !rotateCard.seen) {
      rotateCard = { seen: true, show: true, t: 0 };
      try { sessionStorage.setItem("chishot:rot", "1"); } catch (e) { /* storage blocked */ }
    }
    loadT = 0; hopped = false; lastKills = 0;
    Au.setIntensity(1);
    Au.whoosh();
  }

  // ---- core events
  function onHit(e, dmg, imp, other) {
    if (dmg < 0.25) return;
    var p = e.body.getPosition();
    if (e.kind === "grem") {
      var a = anim(e);
      a.hurtT = 0.5; a.flashT = 0.1; a.bump = 1;
      Au.gremHit();
      stars(p.x, p.y + e.r, 4);
    } else if (e.kind === "block" || e.kind === "tnt") {
      Au.impact(e.mat, imp);
      if (imp > 1.5) { var m = MAT[e.mat]; for (var i = 0; i < Math.min(4, Math.round(imp / 2)); i++) addPart({ k: e.mat === "glass" ? "shard" : "chunk", x: p.x, y: p.y, vx: rand(-2.5, 2.5), vy: rand(0.5, 3), t: 0, life: 0.45, s: 0.07, rot: rand(0, 6), vr: rand(-6, 6), col: m.chips[i % 3], out: m.out, g: 14 }); }
    }
  }
  function onBreak(e, pts) {
    debris(e);
    puff(e.x, e.y, e.mat === "glass" ? 3 : 5, e.mat === "glass" ? "rgba(230,247,255,0.8)" : "rgba(255,255,255,0.85)", 0.35);
    Au.crash(e.mat);
    popup(e.x, e.y + 0.3, fmt(pts), "#FFFFFF", 20, 0.9);
    pops[pops.length - 1].stroke = MAT[e.mat].pop;
    bumpCombo(e.x, e.y);
    for (var i = 0; i < game.ents.length; i++) {
      var o = game.ents[i];
      if (o.kind === "grem" && !o.dead) { var op = o.body.getPosition(); if (Math.abs(op.x - e.x) < 2 && Math.abs(op.y - e.y) < 2) anim(o).flinch = 0.12; }
    }
  }
  function onKill(e, last, pts) {
    var big = e.type !== "imp";
    var col = e.type === "imp" ? "rgba(170,130,230,0.9)" : e.type === "brute" ? "rgba(150,200,90,0.9)" : "rgba(240,110,130,0.9)";
    for (var i = 0; i < 8; i++) { var a = (i / 8) * Math.PI * 2; addPart({ k: "puff", x: e.x + Math.cos(a) * e.r * 0.6, y: e.y + Math.sin(a) * e.r * 0.6, vx: Math.cos(a) * 2.2, vy: Math.sin(a) * 2.2, t: 0, life: 0.55, s: e.r * 0.65, col: col, g: -0.2 }); }
    puff(e.x, e.y, 4, "rgba(255,255,255,0.9)", e.r * 0.8, 0.5);
    for (i = 0; i < 4; i++) addPart({ k: "tooth", x: e.x, y: e.y, vx: rand(-4, 4), vy: rand(2, 6), t: 0, life: 0.9, s: 0.08, rot: rand(0, 6), vr: rand(-10, 10), col: "#FFF6E0", out: "#2A0A14", g: 18 });
    glows.push({ x: e.x, y: e.y, r: e.r * 4, col: "255,200,120", a: 0.7, t: 0, life: 0.3 });
    Au.gremDie(big);
    buzz(big ? 30 : 18);
    if (!cam.user) cam.zoom *= big ? 1.04 : 1.02;
    addShake(big ? 9 : 5);
    hitStop = big ? 0.08 : 0.05;
    popup(e.x, e.y + e.r + 0.4, fmt(pts), "#B6FF6A", big ? 30 : 24, 1.3);
    pops[pops.length - 1].stroke = "#1E3A0E";
    bumpCombo(e.x, e.y);
    for (i = 0; i < game.ents.length; i++) {
      var o = game.ents[i];
      if (o.kind === "grem" && !o.dead) anim(o).scaredT = 0.8;
    }
    if (last) {
      slowmo(0.22, 1.1);
      flash = 0.45; flashCol = "#ffffff";
      Au.setIntensity(2);
    }
  }
  function onExplode(x, y, R2) {
    sparks(x, y, 30, 11);
    for (var i = 0; i < 12; i++) { var a = (i / 12) * Math.PI * 2; addPart({ k: "puff", x: x, y: y, vx: Math.cos(a) * rand(2, 4.5), vy: Math.sin(a) * rand(2, 4.5) + 1, t: 0, life: rand(0.6, 1.0), s: rand(0.4, 0.8), col: "rgba(90,80,80,0.75)", g: -0.6 }); }
    glows.push({ x: x, y: y, r: R2 * 1.2, col: "255,160,60", a: 1, t: 0, life: 0.45, burst: true });
    flash = 0.5; flashCol = "#FFF4D0";
    addShake(14);
    slowmo(0.45, 0.25);
    Au.boom();
    buzz(45);
    if (!cam.user) cam.zoom *= 1.05;
  }
  function onPower(kind, p) {
    var pos = p.body.getPosition();
    Au.power();
    sparks(pos.x, pos.y, 16, 6, ["#FFFFFF", "#FFF3A6", "#7AF0FF"]);
    popup(pos.x, pos.y + 1.1, kind + "!", "#FFE14D", 30, 0.9);
    glows.push({ x: pos.x, y: pos.y, r: 2.4, col: "255,250,210", a: 0.8, t: 0, life: 0.3 });
    addShake(3);
    for (var i = 0; i < game.pets.length; i++) petVis(game.pets[i]).power = kind;
  }
  function onPetImpact(p, imp, other) {
    var v = petVis(p);
    if (imp > 2.2) {
      v.face = "dizzy";
      var vel = p.body.getLinearVelocity();
      v.sq = Math.min(1, imp / 12);
      v.sqDir = Math.atan2(-vel.y, vel.x);
      var pos = p.body.getPosition();
      if (imp > 4) { tufts(pos.x, pos.y, 5); puff(pos.x, pos.y - 0.2, 4, "rgba(255,255,255,0.85)", 0.3); addShake(Math.min(6, imp / 5)); }
      if (other && other.kind === "ground" && imp > 2.5) puff(pos.x, 0.15, 5, rgba(TH.ground[2], 0.6), 0.32, 0.4);
      Au.impact(other && other.mat ? other.mat : "ground", imp);
    }
  }
  function onNextShot() {
    if (game.gremsKilled === lastKills) {
      for (var i = 0; i < game.ents.length; i++) {
        var o = game.ents[i];
        if (o.kind === "grem" && !o.dead) anim(o).laughT = 1.6;
      }
      Au.laugh();
      var any = game.ents.filter(function (o) { return o.kind === "grem" && !o.dead; })[0];
      if (any) { var ap = any.body.getPosition(); popup(ap.x, ap.y + any.r + 0.6, "HA HA!", "#FFFFFF", 22, 1.2); pops[pops.length - 1].stroke = "#1E3A0E"; }
    }
    lastKills = game.gremsKilled;
    loadT = 0; hopped = false;
    cam.user = false;
  }
  function onLost() {
    for (var i = 0; i < game.ents.length; i++) {
      var o = game.ents[i];
      if (o.kind === "grem" && !o.dead) anim(o).laughT = 9;
    }
    var g0 = game;
    setTimeout(function () {
      if (game !== g0 || game.state !== "lost") return;
      Au.laugh();
      Au.lose();
      Au.setIntensity(0);
      showResult(false, 0);
    }, 700);
  }
  function onWon(bonus) {
    Au.setIntensity(1);
    var g0 = game, n = game.shotsLeft;
    for (var i = 0; i < n; i++) (function (k) {
      setTimeout(function () {
        if (game !== g0) return;
        var wp = waitingPos(k, 0);
        popup(wp.x, wp.y + 1.1, "10,000", "#FFE14D", 26, 1.2);
        sparks(wp.x, wp.y, 12, 5);
        Au.bonus(k);
      }, 250 + k * 280);
    })(i);
    setTimeout(function () {
      if (game !== g0 || scene !== "play") return;
      Au.win();
      showResult(true, bonus);
    }, 300 + n * 280);
  }
  function onPetGone(p) {
    var pos = p.body.getPosition();
    puff(pos.x, pos.y, 6, "rgba(255,255,255,0.85)", 0.35);
  }
  var comboPop = null;
  function bumpCombo(x, y) {
    combo = comboT > 0 ? combo + 1 : 1;
    comboT = 0.75;
    if (combo >= 3) {
      if (comboPop && pops.indexOf(comboPop) >= 0) {
        comboPop.s = "COMBO x" + combo; comboPop.t = 0.12; comboPop.life = 1.1; comboPop.size = Math.min(40, 26 + combo);
      } else {
        popup(x, y + 1.6, "COMBO x" + combo, "#7AF0FF", 26, 1.1);
        comboPop = pops[pops.length - 1];
        comboPop.stroke = "#0E3A4A";
        comboPop.sticky = true;
      }
      Au.combo(combo);
      Au.setIntensity(2);
      intensityT = 4;
    }
  }
  function showResult(won, bonus) {
    var st = won ? game.starsFor(game.score) : 0;
    var prevBest = save.best[levelIdx] || 0;
    if (won) {
      save.stars[levelIdx] = Math.max(save.stars[levelIdx] || 0, st);
      save.best[levelIdx] = Math.max(prevBest, game.score);
      persist();
    }
    result = { final: won && levelIdx === Core.LEVELS.length - 1, won: won, stars: st, score: game.score, best: Math.max(prevBest, won ? game.score : 0), newBest: won && game.score > prevBest, t: 0, starShown: 0, bonus: bonus, confetti: null, bursts: [] };
    scene = "result";
  }

  // ---------------------------------------------------------------- input (Angry Birds controls)
  var pointers = {}, mode = null, aimId = null, panId = null, pinch = null, panVel = { x: 0, y: 0 }, lastTap = 0, lastTouchT = 0;
  function nPointers() { return Object.keys(pointers).length; }
  function pouchPos() {
    if (aiming) return { x: SL.x + pull.x, y: SL.y + pull.y };
    if (cancelT > 0 && cancelFrom) { var k = 1 - cancelT / 0.15; return { x: lerp(cancelFrom.x, SL.x, ease(k)), y: lerp(cancelFrom.y, SL.y, ease(k)) }; }
    return { x: SL.x + bandOsc * 0.45, y: SL.y + bandOsc * 0.12 };
  }
  function hitButton(x, y) {
    for (var i = buttons.length - 1; i >= 0; i--) {
      var b = buttons[i];
      if (b.r ? Math.hypot(x - b.x, y - b.y) <= b.r + 6 : x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
    return null;
  }
  function resetTouches() {
    pointers = {}; mode = null; pinch = null; panId = null; aimId = null;
    if (aiming) { aiming = false; pull = { x: 0, y: 0 }; }
  }
  cvs.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    // iOS can drop a pointerup when a finger slides off the screen edge; a PRIMARY pointer means
    // nothing else is touching, so whatever is still recorded is stale.
    if (e.isPrimary) resetTouches();
    Au.init();
    Au.startMusic();
    lastTouchT = performance.now();
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), lx: e.clientX, ly: e.clientY, lt: performance.now() };
    try { cvs.setPointerCapture(e.pointerId); } catch (er) { /* not supported */ }
    if (nPointers() === 1) {
      var b = hitButton(e.clientX, e.clientY);
      if (b) { Au.click(); b.fn(); delete pointers[e.pointerId]; return; }
    }
    if (scene === "title") { Au.click(); scene = "levels"; sceneT = 0; Au.setIntensity(0); return; }
    if (scene !== "play" || !game) return;
    if (nPointers() === 2) {
      // pinch: the aim (if any) is cancelled, never fired
      if (aiming) { aiming = false; cancelFrom = { x: SL.x + pull.x, y: SL.y + pull.y }; cancelT = 0.15; pull = { x: 0, y: 0 }; }
      var ids = Object.keys(pointers), a = pointers[ids[0]], b2 = pointers[ids[1]];
      var mx = (a.x + b2.x) / 2, my = (a.y + b2.y) / 2;
      pinch = { d: Math.hypot(a.x - b2.x, a.y - b2.y) || 1, zoom: cam.zoom, anchor: S2W(mx, my) };
      panVel = { x: 0, y: 0 };
      mode = "pinch";
      cam.user = true;
      return;
    }
    if (nPointers() > 2) return;
    if (introT < 1) { introT = 1; return; }
    if (game.state === "flying") { game.usePower(); mode = null; return; }
    if (game.state === "aim" && loadT >= 1) {
      var w = S2W(e.clientX, e.clientY), pp = pouchPos();
      var grab = Math.max(PET_R * 1.7, 30 / cam.zoom);
      if (Math.hypot(w.x - pp.x, w.y - pp.y) <= grab) {
        mode = "aim"; aimId = e.pointerId; aiming = true;
        pull = { x: pp.x - SL.x, y: pp.y - SL.y };
        return;
      }
    }
    mode = "pan"; panId = e.pointerId; panVel = { x: 0, y: 0 };
  });
  cvs.addEventListener("pointermove", function (e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    lastTouchT = performance.now();
    var now = performance.now();
    var dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (mode === "pinch" && pinch && nPointers() >= 2) {
      var ids = Object.keys(pointers), a = pointers[ids[0]], b = pointers[ids[1]];
      var d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      // rubber band past the zoom limits, so the pinch never hits a wall
      cam.zoom = soft(pinch.zoom * (d / pinch.d), zLim.min, zLim.max, zLim.base * 0.18);
      cam.userZoom = clamp(cam.zoom, zLim.min, zLim.max);
      cam.cx = pinch.anchor.x - (mx - W / 2) / cam.zoom;
      cam.cy = clampCamY(pinch.anchor.y + (my - H / 2) / cam.zoom);
      return;
    }
    if (mode === "aim" && e.pointerId === aimId && game && game.state === "aim") {
      var w = S2W(e.clientX, e.clientY);
      pull = game.clampPull({ x: w.x - SL.x, y: w.y - SL.y });
      if (SL.y + pull.y < PET_R * 0.85) pull.y = PET_R * 0.85 - SL.y;
      Au.stretch(Math.hypot(pull.x, pull.y) / Core.MAX_PULL);
      return;
    }
    if (mode === "pan" && e.pointerId === panId) {
      if (!cam.user && Math.hypot(p.x - p.sx, p.y - p.sy) < 8) return; // still a tap
      cam.user = true;
      zoomAnim = null;
      // 1:1 with the finger; past an edge it gives with resistance instead of stopping dead
      var lo = clampCamX(-1e9), hi = clampCamX(1e9);
      var over = cam.cx < lo || cam.cx > hi ? 0.4 : 1;
      cam.cx -= (dx / cam.zoom) * over;
      cam.cy = clampCamY(cam.cy + dy / cam.zoom);
      // fling velocity from the last ~90 ms of movement, not a single noisy frame
      p.hist = (p.hist || []).filter(function (hh) { return now - hh.t < 90; });
      p.hist.push({ t: now, x: e.clientX, y: e.clientY });
      p.lt = now;
    }
  });
  function endPointer(e, cancelled) {
    var p = pointers[e.pointerId];
    delete pointers[e.pointerId];
    if (!p) return;
    if (mode === "aim" && e.pointerId === aimId) {
      aiming = false;
      mode = null;
      var len = Math.hypot(pull.x, pull.y);
      if (cancelled || !game || game.state !== "aim" || len < 0.3) {
        cancelFrom = { x: SL.x + pull.x, y: SL.y + pull.y }; cancelT = 0.15; pull = { x: 0, y: 0 };
        return;
      }
      var pet = game.launch(pull);
      if (pet) {
        petVis(pet).face = "yell";
        prevTrail = trail; trail = [];
        bandOsc = 1; bandVel = 0;
        cam.user = false;
        Au.launch(); Au.yell(); buzz(15);
        puff(SL.x, SL.y, 4, "rgba(255,255,255,0.7)", 0.3);
        addShake(2);
        if (firstShotEver) { firstShotEver = false; try { localStorage.setItem("chishot:aimed", "1"); } catch (er) { /* storage blocked */ } }
      }
      pull = { x: 0, y: 0 };
      return;
    }
    if (mode === "pinch") {
      if (nPointers() < 2) {
        pinch = null;
        var rest = Object.keys(pointers);
        if (rest.length === 1) { mode = "pan"; panId = Number(rest[0]); var q = pointers[rest[0]]; q.sx = q.x - 100; q.sy = q.y; } else mode = null;
      }
      return;
    }
    if (mode === "pan" && e.pointerId === panId) {
      mode = null;
      var hs = (p.hist || []).filter(function (hh) { return performance.now() - hh.t < 90; });
      if (hs.length >= 2) {
        var h0 = hs[0], h1 = hs[hs.length - 1], hdt = Math.max(16, h1.t - h0.t) / 1000;
        panVel = { x: -(h1.x - h0.x) / cam.zoom / hdt, y: (h1.y - h0.y) / cam.zoom / hdt };
      } else panVel = { x: 0, y: 0 };
      var moved = Math.hypot(p.x - p.sx, p.y - p.sy), quick = performance.now() - p.t < 260;
      if (moved < 8 && quick) {
        var now = performance.now();
        if (now - lastTap < 320) {
          // double tap: glide between the whole fort and the normal view, around the tapped point
          var to = cam.zoom > (zLim.min + zLim.base) / 2 ? zLim.min : zLim.base;
          var wa = S2W(p.x, p.y);
          zoomAnim = { from: cam.zoom, to: to, t: 0, ax: p.x, ay: p.y, wx: wa.x, wy: wa.y };
          cam.userZoom = to;
          cam.user = true;
          lastTap = 0;
        } else lastTap = now;
        panVel = { x: 0, y: 0 };
      }
    }
  }
  cvs.addEventListener("pointerup", function (e) { Au.init(); Au.startMusic(); endPointer(e, false); });
  cvs.addEventListener("pointercancel", function (e) { endPointer(e, true); });
  document.addEventListener("touchend", function () { Au.init(); Au.startMusic(); }, { passive: true });
  window.addEventListener("resize", function () { resize(); });
  window.addEventListener("blur", resetTouches);
  cvs.addEventListener("wheel", function (e) {
    e.preventDefault();
    if (scene !== "play" || !game) return;
    var a = S2W(e.clientX, e.clientY);
    cam.zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0016), zLim.min, zLim.max);
    cam.userZoom = cam.zoom;
    cam.cx = clampCamX(a.x - (e.clientX - W / 2) / cam.zoom);
    cam.cy = clampCamY(a.y + (e.clientY - H / 2) / cam.zoom);
    cam.user = true;
    lastTouchT = performance.now();
  }, { passive: false });
  // Safari's own pinch-zoom must never move the page under the game
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });
  document.addEventListener("touchmove", function (e) { if (e.scale !== undefined && e.scale !== 1) e.preventDefault(); }, { passive: false });
  window.addEventListener("orientationchange", function () { setTimeout(resize, 250); });
  document.addEventListener("visibilitychange", function () { if (document.hidden) Au.suspend(); else Au.resume(); });

  // ---------------------------------------------------------------- update
  function waitingPos(i, t) {
    var bob = Math.sin(t * 2 * Math.PI + i * 1.3) * 0.03 + Math.max(0, Math.sin(t * 2.4 + i * 1.7) - 0.85) * 1.6;
    return { x: -2.75 - i * 1.15, y: PET_R + bob };
  }
  function update(dt) {
    sceneT += dt;
    if ((scene === "play" || scene === "result") && game) {
      if (rotateCard.show) { banner = banner && { t: 0, s1: banner.s1, s2: banner.s2 }; return; }
      if (introT < 1) introT = Math.min(1, introT + dt / 1.8);
      else if (loadT < 1 && game.state === "aim") {
        if (!hopped) { hopped = true; Au.hop(); }
        loadT = Math.min(1, loadT + dt / 0.55);
        if (loadT >= 1) puff(SL.x, SL.y - 0.4, 3, "rgba(255,255,255,0.7)", 0.2);
      }
      if (slowT > 0) { slowT -= dt; timeScale = lerp(timeScale, slowTo, 0.25); } else timeScale = lerp(timeScale, 1, 0.12);
      if (hitStop > 0) hitStop -= dt;
      else if (introT >= 1 || game.state !== "aim") game.update(dt * timeScale);
      if (cancelT > 0) cancelT = Math.max(0, cancelT - dt);
      if (banner) { banner.t += dt; if (banner.t > 2.2) banner = null; }
      comboT -= dt;
      if (intensityT > 0) { intensityT -= dt; if (intensityT <= 0 && game.state !== "won" && game.state !== "lost") Au.setIntensity(1); }

      // camera
      if (introT < 1) {
        var tgt = aimPose(), k = ease(introT);
        cam.cx = lerp(introFrom, tgt.x, k);
        cam.cy = tgt.y;
      } else if (mode !== "pan" && mode !== "pinch") {
        if (zoomAnim) {
          zoomAnim.t = Math.min(1, zoomAnim.t + dt / 0.38);
          cam.zoom = lerp(zoomAnim.from, zoomAnim.to, ease(zoomAnim.t));
          cam.cx = clampCamX(zoomAnim.wx - (zoomAnim.ax - W / 2) / cam.zoom);
          cam.cy = clampCamY(baseCy());
          if (zoomAnim.t >= 1) zoomAnim = null;
        }
        if (Math.abs(panVel.x) + Math.abs(panVel.y) > 0.05) {
          cam.cx += panVel.x * dt;
          cam.cy = clampCamY(cam.cy + panVel.y * dt);
          var f0 = Math.exp(-dt * 3.4); // the same glide at 60 or 120 Hz
          panVel.x *= f0; panVel.y *= f0;
          if (cam.cx !== clampCamX(cam.cx)) { panVel.x *= Math.exp(-dt * 14); }
        }
        // spring back from any rubber-band stretch
        var cxC = clampCamX(cam.cx);
        if (cxC !== cam.cx) cam.cx += (cxC - cam.cx) * (1 - Math.exp(-dt * 10));
        var zC = clamp(cam.zoom, zLim.min, zLim.max);
        if (zC !== cam.zoom && !zoomAnim) cam.zoom += (zC - cam.zoom) * (1 - Math.exp(-dt * 10));
        if (cam.user && game.state === "aim" && !aiming && nPointers() === 0 && performance.now() - lastTouchT > 2000) cam.user = false;
        if (!cam.user) {
          var tx = cam.cx, ty = cam.cy, speed = 2.6;
          // Angry Birds framing: ease out a little while a pet flies, back to your zoom after
          var ext0 = game.extent(), wide = ext0.max + 6 > W / cam.userZoom;
          var zT = game.state === "flying" && wide ? Math.max(zLim.min, cam.userZoom * 0.8) : cam.userZoom;
          if (!zoomAnim) cam.zoom += (zT - cam.zoom) * (1 - Math.exp(-dt * 2.2));
          if (game.state === "flying" && game.pets.length) {
            var lead = game.lerpPos(game.pets[0]), lv = game.pets[0].body.getLinearVelocity();
            tx = clampCamX(lead.x + lv.x * 0.3 - viewW() * 0.1);
            ty = clampCamY(Math.max(baseCy(), lead.y - viewH() * 0.32));
            speed = 7;
          } else if (game.state === "aim" && !aiming) {
            var ap = aimPose(); tx = ap.x; ty = ap.y; speed = 2.4;
          } else if (game.state === "aim") {
            ty = baseCy();
          }
          var f = 1 - Math.exp(-dt * speed);
          cam.cx += (tx - cam.cx) * f;
          cam.cy += (ty - cam.cy) * f;
        }
      }

      // pets: trail, afterimages, squash recovery
      for (var i = 0; i < game.pets.length; i++) {
        var pe = game.pets[i], v = petVis(pe), pp = pe.body.getPosition();
        v.sq = Math.max(0, v.sq - dt * 4);
        v.histT = (v.histT || 0) + dt;
        if (pe.hits === 0 && v.histT > 0.035) { v.histT = 0; v.hist = (v.hist || []).concat([{ x: pp.x, y: pp.y }]).slice(-3); }
        if (pe.hits > 0) v.hist = null;
        if (i === 0 && pe.hits === 0 && !pe.done) {
          var last = trail[trail.length - 1];
          if (!last || Math.hypot(pp.x - last.x, pp.y - last.y) > 0.62) trail.push({ x: pp.x, y: pp.y, big: trail.length % 3 === 0 });
        }
        if (v.power === "TURBO" && pe.hits === 0) sparks(pp.x, pp.y, 1, 2, ["#FFF3A6", "#FFB13B"]);
      }

      // gremlin brains
      var look = game.pets[0] ? game.pets[0].body.getPosition() : { x: SL.x, y: SL.y };
      for (var j = 0; j < game.ents.length; j++) {
        var e = game.ents[j];
        if (e.kind !== "grem" || e.dead) continue;
        var a = anim(e), ep = e.body.getPosition();
        a.lookX = clamp(look.x - ep.x, -1, 1); a.lookY = clamp(look.y - ep.y, -1, 1);
        a.hurtT -= dt; a.flashT -= dt; a.laughT -= dt; a.scaredT -= dt; a.flinch -= dt;
        if (a.bump > 0) a.bump = Math.max(0, a.bump - dt * 3);
        a.blinkT -= dt;
        if (a.blinkT < 0) { a.blink = 0.12; a.blinkT = rand(2.5, 4.5); }
        a.blink -= dt;
        if (game.state === "flying" && game.pets.length && game.pets[0].hits === 0 && Math.abs(look.x - ep.x) < 5) a.scaredT = Math.max(a.scaredT, 0.2);
      }

      bandVel += (-bandOsc * 300 - bandVel * 10) * dt;
      bandOsc += bandVel * dt;
    }

    for (var q = parts.length - 1; q >= 0; q--) {
      var p = parts[q];
      var sdt = dt * Math.max(0.35, scene === "play" ? timeScale : 1);
      p.t += sdt;
      if (p.t >= p.life) { parts.splice(q, 1); continue; }
      p.vy -= p.g * sdt;
      p.x += p.vx * sdt;
      p.y += p.vy * sdt;
      if (p.rot !== undefined) p.rot += p.vr * sdt;
      if (p.k === "puff") { p.vx *= 0.92; p.vy *= 0.92; }
      if ((p.k === "chunk" || p.k === "tooth" || p.k === "splinter") && p.y < 0.05) { p.y = 0.05; p.vy *= -0.35; p.vx *= 0.6; }
    }
    for (q = pops.length - 1; q >= 0; q--) { pops[q].t += dt; if (pops[q].t >= pops[q].life) pops.splice(q, 1); }
    for (q = glows.length - 1; q >= 0; q--) { glows[q].t += dt; if (glows[q].t >= glows[q].life) glows.splice(q, 1); }
    shake *= Math.pow(0.002, dt);
    if (shake < 0.1) shake = 0;
    flash = Math.max(0, flash - dt * 2.4);
    if (game) shownScore += (game.score - shownScore) * (1 - Math.exp(-dt * 8));
    if (result) result.t += dt;
  }

  // ---------------------------------------------------------------- draw: world
  function drawSprite(spr, sx, sy, scale, rot, sxs, sys, flip) {
    ctx.save();
    ctx.translate(sx, sy);
    if (rot) ctx.rotate(rot);
    ctx.scale((flip ? -1 : 1) * scale * (sxs || 1), scale * (sys || 1));
    blit(spr.c, -spr.cx, -spr.cy);
    ctx.restore();
  }
  function drawBackdrop(t) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(skyC, 0, 0);
    ctx.restore();
    var gy = W2S(0, 0).y;
    // clouds drift and parallax slowly
    for (var i = 0; i < 4; i++) {
      var cc = cloudCs[i % cloudCs.length];
      var cw = cc.width / dpr, ch = cc.height / dpr, span = W + cw * 2;
      var x = (((i * 360 + t * (6 + i * 2) - cam.cx * cam.zoom * 0.08) % span) + span) % span - cw;
      var y = H * (0.08 + (i % 3) * 0.1);
      ctx.globalAlpha = TH.clouds;
      ctx.drawImage(cc, x, y, cw * (0.8 + (i % 2) * 0.4), ch * (0.8 + (i % 2) * 0.4));
      ctx.globalAlpha = 1;
    }
    drawLayer(farC, 0.18, gy + H * 0.02, t);
    drawAmbient(t, frameDt);
    drawLayer(nearC, 0.42, gy + H * 0.02, t);
    // castle windows flicker on dusk and night
    if (windows.length) {
      var tw = farC.width / dpr, off = -((cam.cx * cam.zoom * 0.18) % tw);
      if (off > 0) off -= tw;
      var top = gy + H * 0.02 - farC.height / dpr;
      for (var xx = off; xx < W; xx += tw) for (var k = 0; k < windows.length; k++) glowAt(xx + windows[k].x, top + windows[k].y, (10 + Math.sin(t * 6 + k) * 2) * TH.glow, "255,170,80", 0.5 * TH.glow);
    }
    // ground
    var GP = 48, sc = cam.zoom / GP, tileW = 8 * cam.zoom;
    var x0 = Math.floor((cam.cx - viewW() / 2 - 8) / 8) * 8;
    for (var gx = x0; gx < cam.cx + viewW() / 2 + 8; gx += 8) {
      var s = W2S(gx, 0);
      ctx.drawImage(groundC, s.x, s.y - 12 * sc, tileW + 1, groundC.height * sc);
    }
    var below = W2S(0, -5).y + 6 * sc;
    if (below < H) { ctx.fillStyle = TH.ground[3]; ctx.fillRect(0, below - 1, W, H - below + 1); }
  }
  var amb = [];
  function drawAmbient(t, dt) {
    var kind = theme === "night" ? "fly" : theme === "sunset" ? "ember" : "leaf";
    while (amb.length < 16) amb.push({ x: rand(0, 1), y: rand(0, 1), s: rand(0.6, 1.2), ph: rand(0, 6), v: rand(0.02, 0.05) });
    for (var i = 0; i < amb.length; i++) {
      var a = amb[i];
      a.x += (kind === "leaf" ? a.v : a.v * 0.3) * dt * (kind === "leaf" ? 1 : Math.sin(t * 0.7 + a.ph));
      a.y += (kind === "ember" ? -a.v : kind === "leaf" ? a.v * 0.6 : Math.sin(t + a.ph) * 0.01) * dt;
      if (a.x > 1.05) a.x = -0.05; if (a.x < -0.05) a.x = 1.05;
      if (a.y > 1.05) a.y = -0.05; if (a.y < -0.05) a.y = 1.05;
      var sx = a.x * W - ((cam.cx * cam.zoom * 0.6) % W + W) % W * 0.2, sy = a.y * H * 0.85;
      if (kind === "fly") {
        var on = 0.5 + 0.5 * Math.sin(t * 2.5 + a.ph);
        glowAt(sx, sy, 10 * U * a.s, "255,240,140", 0.6 * on);
        ell(ctx, sx, sy, 1.6 * U, 1.6 * U); ctx.fillStyle = "rgba(255,250,200," + on.toFixed(2) + ")"; ctx.fill();
      } else if (kind === "ember") {
        glowAt(sx, sy, 6 * U * a.s, "255,150,60", 0.45);
        ell(ctx, sx, sy, 1.4 * U, 1.4 * U); ctx.fillStyle = "#FFC266"; ctx.fill();
      } else {
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(t * 1.5 + a.ph); ctx.scale(1, Math.sin(t * 3 + a.ph));
        ell(ctx, 0, 0, 4 * U * a.s, 2 * U * a.s); ctx.fillStyle = "rgba(120,180,70,0.8)"; ctx.fill();
        ctx.restore();
      }
    }
  }
  function drawLayer(c, f, bottom, t) {
    var tw = c.width / dpr, th = c.height / dpr;
    var off = -((cam.cx * cam.zoom * f) % tw);
    if (off > 0) off -= tw;
    for (var x = off; x < W; x += tw) ctx.drawImage(c, x, bottom - th, tw, th);
  }
  function drawSlingBack() {
    var s = W2S(0, 0), sc = cam.zoom / PPM;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.scale(sc, sc);
    blit(slingBackC, -0.8 * PPM, -3.45 * PPM);
    ctx.restore();
  }
  function drawSlingFront() {
    var s = W2S(0, 0), sc = cam.zoom / PPM;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.scale(sc, sc);
    blit(slingFrontC, -0.8 * PPM, -3.45 * PPM);
    ctx.restore();
  }
  function bandTo(tip, pp, behind) {
    var a = W2S(tip.x, tip.y);
    var len = Math.hypot(pull.x, pull.y), dx = len > 0.05 ? pull.x / len : -1, dy = len > 0.05 ? pull.y / len : 0;
    var b = W2S(pp.x + dx * PET_R * 0.85, pp.y + dy * PET_R * 0.85);
    ctx.lineCap = "round";
    ctx.strokeStyle = "#2A1206";
    ctx.lineWidth = cam.zoom * (behind ? 0.16 : 0.18);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = "#5A2E14";
    ctx.lineWidth = cam.zoom * (behind ? 0.08 : 0.1);
    ctx.stroke();
    if (behind) {
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(Math.atan2(-dy, dx));
      ell(ctx, 0, 0, cam.zoom * 0.16, cam.zoom * 0.34); fillStroke(ctx, "#5A2E14", "#2A1206", cam.zoom * 0.05);
      ctx.restore();
    }
  }
  function drawEnt(e, t) {
    if (e.dead) return;
    var pos = game.lerpPos(e), ang = pos.a, s = W2S(pos.x, pos.y), sc = cam.zoom / PPM;
    if (e.kind === "rock") {
      var rt = rockSprite(e);
      ctx.save(); ctx.translate(s.x, s.y); ctx.scale(sc, sc);
      blit(rt.c, -(e.w * PPM) / 2 - rt.pad, -(e.h * PPM) / 2 - rt.pad);
      ctx.restore();
      return;
    }
    if (e.kind === "grem") {
      var a = anim(e);
      var hpK = e.hp / e.maxHp;
      var expr = a.laughT > 0 ? "laugh" : a.scaredT > 0 ? "scared" : a.blink > 0 ? "blink" : hpK < 0.4 ? "hurt2" : hpK < 0.75 || a.hurtT > 0 ? "hurt1" : "idle";
      var sp = gremSprite(e.type, expr);
      var br = Math.sin(t * (a.laughT > 0 ? 18 : 3.9) + a.ph);
      var bump = a.bump > 0 ? Math.sin(a.bump * Math.PI * 3) * a.bump * 0.3 : 0;
      var fl = a.flinch > 0 ? 0.1 : 0;
      var sy = 1 + br * (a.laughT > 0 ? 0.06 : 0.025) - bump - fl, sx = 1 - br * 0.015 + bump;
      // soft contact shadow
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      var gs = W2S(pos.x, 0);
      if (pos.y - e.r < 0.25) { ell(ctx, gs.x, gs.y, e.r * cam.zoom * 0.9, e.r * cam.zoom * 0.18); ctx.fill(); }
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(-ang * 0.5);
      ctx.translate(0, e.r * cam.zoom * (1 - sy));
      ctx.scale(sc * sx, sc * sy);
      blit(sp.c, -sp.cx, -sp.cy);
      // slit pupils that follow the pet
      for (var i = 0; i < sp.eyes.length; i++) {
        var ey = sp.eyes[i], ex = ey.x * PPM + (a.lookX || 0) * ey.r * PPM * 0.35, eyy = ey.y * PPM - (a.lookY || 0) * ey.r * PPM * 0.25;
        ell(ctx, ex, eyy, ey.r * PPM * (ey.scared ? 0.18 : 0.16), ey.r * PPM * (ey.scared ? 0.32 : 0.6));
        ctx.fillStyle = "#1A0508";
        ctx.fill();
      }
      if (a.flashT > 0) {
        ctx.globalAlpha = 0.75;
        blit(flashOf(sp), -sp.cx, -sp.cy);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      for (i = 0; i < sp.eyes.length; i++) glowAt(s.x + sp.eyes[i].x * cam.zoom, s.y + sp.eyes[i].y * cam.zoom, sp.eyes[i].r * cam.zoom * 2.2, "255,190,60", 0.25 + 0.35 * TH.glow);
      return;
    }
    var hpK2 = Math.max(0, e.hp / e.maxHp), stage = hpK2 > 0.75 ? 0 : hpK2 > 0.5 ? 1 : hpK2 > 0.25 ? 2 : 3;
    var spr = blockSprite(e, stage);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(-ang);
    ctx.scale(sc, sc);
    blit(spr.c, -(e.w * PPM) / 2 - spr.pad, -(e.h * PPM) / 2 - spr.pad);
    ctx.restore();
    if (e.kind === "tnt") glowAt(s.x, s.y - e.h * cam.zoom * 0.5, cam.zoom * 0.25, "255,180,80", 0.4 * TH.glow);
  }
  function flashOf(sp) {
    if (!sp.flash) {
      var c = mk(sp.c.width, sp.c.height), g = c.getContext("2d");
      g.drawImage(sp.c, 0, 0);
      g.globalCompositeOperation = "source-in";
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, c.width, c.height);
      sp.flash = c;
    }
    return sp.flash;
  }
  function drawPet(face, x, y, ang, sx, sy, dirAng, alpha) {
    var spr = petSprite(face), s = W2S(x, y), sc = cam.zoom / PPM;
    ctx.save();
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    ctx.translate(s.x, s.y);
    if (dirAng !== undefined) { ctx.rotate(dirAng); ctx.scale(sx, sy); ctx.rotate(-dirAng); }
    else { ctx.rotate(ang || 0); ctx.scale(sx || 1, sy || 1); }
    ctx.scale(sc, sc);
    blit(spr.c, -spr.cx, -spr.cy);
    ctx.restore();
  }
  function drawPets(t) {
    var loading = game.state === "aim" && loadT < 1 && introT >= 1;
    var waiting = game.shotsLeft - (game.state === "aim" ? 1 : 0);
    if (game.state === "won") waiting = game.shotsLeft;
    for (var i = 0; i < waiting; i++) {
      var w0 = waitingPos(i + 1, t), w1 = waitingPos(i, t);
      var wx = loading ? lerp(w0.x, w1.x, ease(loadT)) : w1.x;
      var gs = W2S(wx, 0);
      ctx.fillStyle = "rgba(0,0,0,0.18)"; ell(ctx, gs.x, gs.y, PET_R * cam.zoom * 0.8, PET_R * cam.zoom * 0.16); ctx.fill();
      var blinkNow = (Math.sin(t * 1.3 + i * 2.1) > 0.985);
      drawPet(game.state === "won" ? "happy" : blinkNow ? "blink" : "idle", wx, w1.y, 0, 1, 1);
    }
    if (loading) {
      // the next pet hops up into the pouch in two little arcs
      var from = waitingPos(0, 0), k = ease(loadT);
      var hx = lerp(from.x, SL.x, k), hy = lerp(from.y, SL.y, k) + Math.sin(k * Math.PI) * 1.4;
      var sq = Math.sin(k * Math.PI);
      drawPet("happy", hx, hy, 0, 1 - sq * 0.1, 1 + sq * 0.14);
    }
    if (game.state === "aim" && introT >= 1 && !loading) {
      var pp = pouchPos(), len = Math.hypot(pull.x, pull.y) / Core.MAX_PULL;
      var dir = Math.atan2(-pull.y, pull.x);
      var breath = aiming ? 0 : Math.sin(t * 2.6) * 0.025;
      drawPet(aiming ? "aim" : (Math.sin(t * 1.7) > 0.97 ? "blink" : "idle"), pp.x, pp.y, 0, 1 + len * 0.18 - breath, 1 - len * 0.12 + breath, aiming && len > 0.05 ? dir : undefined);
    }
    for (i = 0; i < game.spent.length; i++) {
      var sp = game.spent[i];
      if (sp.removed) continue;
      var bp = game.lerpPos(sp);
      drawPet("dizzy", bp.x, bp.y, -bp.a, 1, 1);
    }
    for (i = 0; i < game.pets.length; i++) {
      var pe = game.pets[i], v = petVis(pe), bp2 = game.lerpPos(pe);
      var vel = pe.body.getLinearVelocity(), spd = Math.hypot(vel.x, vel.y);
      if (pe.hits === 0) {
        var st = Math.min(0.25, spd / 80);
        if (v.hist) for (var hh = 0; hh < v.hist.length; hh++) drawPet(v.face, v.hist[hh].x, v.hist[hh].y, 0, 1 + st, 1 - st * 0.8, Math.atan2(-vel.y, vel.x), 0.1 + hh * 0.07);
        drawPet(v.face, bp2.x, bp2.y, 0, 1 + st, 1 - st * 0.8, Math.atan2(-vel.y, vel.x));
      } else {
        var sqk = v.sq;
        drawPet(v.face, bp2.x, bp2.y, -bp2.a, 1 + sqk * 0.25, 1 - sqk * 0.25);
        if (v.face === "dizzy" && spd < 2) {
          // orbiting dizzy stars
          for (var k2 = 0; k2 < 3; k2++) {
            var an = t * 5 + (k2 * Math.PI * 2) / 3, s2 = W2S(bp2.x + Math.cos(an) * PET_R * 0.9, bp2.y + PET_R * 1.05 + Math.sin(an) * PET_R * 0.25);
            star5(ctx, s2.x, s2.y, cam.zoom * 0.1); fillStroke(ctx, "#FFE14D", "#8A6A00", cam.zoom * 0.025);
          }
        }
      }
      if (v.power === "RAM" || v.power === "SLAM") glowAt(W2S(bp2.x, bp2.y).x, W2S(bp2.x, bp2.y).y, PET_R * cam.zoom * 2.4, "255,130,60", 0.55);
    }
  }
  function drawTrail() {
    var sets = [prevTrail, trail];
    for (var k = 0; k < 2; k++) {
      var tr = sets[k];
      for (var i = 0; i < tr.length; i++) {
        var s = W2S(tr[i].x, tr[i].y), r = cam.zoom * (tr[i].big ? 0.11 : 0.075);
        ell(ctx, s.x, s.y, r, r);
        ctx.fillStyle = k === 0 ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.9)";
        ctx.fill();
        ctx.strokeStyle = "rgba(60,90,120,0.4)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (game.state === "aim" && aiming && Math.hypot(pull.x, pull.y) > 0.3) {
      var pts = game.preview(pull, firstShotEver ? 16 : 10, 0.07);
      for (var j = 0; j < pts.length; j++) {
        var s2 = W2S(pts[j].x, pts[j].y), r2 = cam.zoom * 0.07 * (1 - j / pts.length * 0.5);
        ell(ctx, s2.x, s2.y, r2, r2);
        ctx.fillStyle = "rgba(255,255,255," + (0.85 - (j / pts.length) * 0.7).toFixed(2) + ")";
        ctx.fill();
      }
    }
  }
  function drawParts() {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], s = W2S(p.x, p.y), k = p.t / p.life, z = cam.zoom, r = p.s * z;
      ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      if (p.k === "puff") {
        ell(ctx, s.x, s.y, r * (0.6 + k * 0.9), r * (0.6 + k * 0.9));
        ctx.fillStyle = p.col; ctx.fill();
      } else if (p.k === "spark") {
        glowAt(s.x, s.y, r * 4, "255,190,90", 0.7 * (1 - k));
        ell(ctx, s.x, s.y, r, r); ctx.fillStyle = p.col; ctx.fill();
      } else if (p.k === "star") {
        ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(p.rot);
        star5(ctx, 0, 0, r, 0.45); fillStroke(ctx, p.col, "#8A6A00", Math.max(1, z * 0.02));
        ctx.restore();
      } else {
        ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(p.rot || 0);
        if (p.k === "splinter") { rrect(ctx, -r, -r * 0.22, r * 2, r * 0.44, r * 0.1); }
        else if (p.k === "shard") { poly(ctx, [-r, r * 0.5, r * 0.9, r * 0.2, -r * 0.1, -r]); }
        else if (p.k === "chunk") { poly(ctx, [-r, -r * 0.3, -r * 0.2, -r, r * 0.9, -r * 0.5, r, r * 0.6, -r * 0.4, r]); }
        else if (p.k === "tuft") { ctx.beginPath(); ctx.moveTo(-r, 0); ctx.quadraticCurveTo(0, -r * 0.7, r, 0); ctx.quadraticCurveTo(0, r * 0.7, -r, 0); ctx.closePath(); }
        else if (p.k === "tooth") { poly(ctx, [-r * 0.5, -r * 0.5, r * 0.5, -r * 0.5, 0, r]); }
        fillStroke(ctx, p.col, p.out || null, Math.max(1, z * 0.025));
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    for (i = 0; i < glows.length; i++) {
      var gl = glows[i], k2 = gl.t / gl.life, s3 = W2S(gl.x, gl.y);
      if (gl.burst) {
        var br = gl.r * cam.zoom * (0.3 + backOut(Math.min(1, k2 * 3)) * 0.8);
        ell(ctx, s3.x, s3.y, br, br);
        ctx.fillStyle = "rgba(255,200,90," + (0.85 * (1 - k2)).toFixed(3) + ")"; ctx.fill();
        ell(ctx, s3.x, s3.y, br * 0.6, br * 0.6);
        ctx.fillStyle = "rgba(255,250,220," + (0.9 * (1 - k2)).toFixed(3) + ")"; ctx.fill();
      }
      glowAt(s3.x, s3.y, gl.r * cam.zoom * (0.8 + k2 * 0.6), gl.col, gl.a * (1 - k2));
    }
    for (i = 0; i < pops.length; i++) {
      var po = pops[i], kk = po.t / po.life, s4 = W2S(po.x, po.y + Math.max(0, (po.t - 0.42)) * 1.2);
      var sc = po.t < 0.12 ? 0.6 + backOut(po.t / 0.12) * 0.4 : 1;
      ctx.globalAlpha = kk > 0.65 ? (1 - kk) / 0.35 : 1;
      txt(ctx, po.s, s4.x, s4.y, Math.round(po.size * sc), po.col, po.stroke, "center", { sw: po.size * 0.22 });
      ctx.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------- draw: UI
  var hudCache = {};
  function cachedPiece(key, w, h, draw) {
    var c = hudCache[key];
    if (!c) {
      c = mk(w * dpr, h * dpr);
      var g = c.getContext("2d");
      g.scale(dpr, dpr);
      var keep = ctx;
      ctx = g; // the drawing helpers below all draw on `ctx`
      try { draw(); } finally { ctx = keep; }
      hudCache[key] = c;
    }
    return c;
  }
  function woodPanel(x, y, w, h, r) {
    var pw = Math.round(w), ph = Math.round(h), pr = Math.round(r);
    var c = cachedPiece("panel:" + pw + "x" + ph + ":" + pr + ":" + dpr + ":" + U, pw + 10, ph + 14, function () { woodPanelRaw(4, 4, pw, ph, pr); });
    ctx.drawImage(c, x - 4, y - 4, pw + 10, ph + 14);
  }
  function woodPanelRaw(x, y, w, h, r) {
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    rrect(ctx, x + 3, y + 6, w, h, r); ctx.fill();
    var g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, "#E2A55E"); g.addColorStop(1, "#B9773A");
    rrect(ctx, x, y, w, h, r);
    ctx.fillStyle = g; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.strokeStyle = "rgba(120,70,25,0.35)"; ctx.lineWidth = 2;
    for (var i = 1; i < 5; i++) { ctx.beginPath(); var yy = y + (h * i) / 5; ctx.moveTo(x, yy); ctx.bezierCurveTo(x + w * 0.3, yy - 4, x + w * 0.7, yy + 4, x + w, yy); ctx.stroke(); }
    ctx.fillStyle = "rgba(255,255,255,0.22)"; ctx.fillRect(x, y, w, 4 * U);
    ctx.restore();
    rrect(ctx, x, y, w, h, r);
    ctx.strokeStyle = "#4D2A0E"; ctx.lineWidth = 3.5 * U; ctx.stroke();
    ctx.restore();
  }
  function roundBtn(x, y, r, icon, fn, col) {
    var rr0 = Math.max(1, Math.round(r)), sz = rr0 * 2 + 12;
    var base = cachedPiece("btn:" + rr0 + ":" + (col || "") + ":" + dpr, sz, sz, function () {
      var cx0 = sz / 2 - 1, cy0 = sz / 2 - 2;
      ctx.fillStyle = "rgba(0,0,0,0.3)"; ell(ctx, cx0 + 2, cy0 + 4, rr0, rr0); ctx.fill();
      var g = ctx.createRadialGradient(cx0 - rr0 * 0.3, cy0 - rr0 * 0.4, rr0 * 0.1, cx0, cy0, rr0);
      g.addColorStop(0, shade(col || "#E8B96A", 0.25)); g.addColorStop(1, col || "#C9893A");
      ell(ctx, cx0, cy0, rr0, rr0); ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = "#4D2A0E"; ctx.lineWidth = Math.max(2.5, rr0 * 0.14); ctx.stroke();
    });
    ctx.save();
    ctx.drawImage(base, x - sz / 2 + 1, y - sz / 2 + 2, sz, sz);
    ctx.strokeStyle = "#FFFFFF"; ctx.fillStyle = "#FFFFFF"; ctx.lineWidth = r * 0.16; ctx.lineCap = "round"; ctx.lineJoin = "round";
    icon(x, y, r);
    ctx.restore();
    buttons.push({ x: x, y: y, r: r, fn: fn });
  }
  function iconBack(x, y, r) { ctx.beginPath(); ctx.moveTo(x + r * 0.2, y - r * 0.4); ctx.lineTo(x - r * 0.25, y); ctx.lineTo(x + r * 0.2, y + r * 0.4); ctx.strokeStyle = "#4D2A0E"; ctx.lineWidth = r * 0.3; ctx.stroke(); ctx.strokeStyle = "#fff"; ctx.lineWidth = r * 0.16; ctx.stroke(); }
  function iconRetry(x, y, r) {
    ctx.beginPath(); ctx.arc(x, y, r * 0.42, -Math.PI * 0.25, Math.PI * 1.35); ctx.strokeStyle = "#4D2A0E"; ctx.lineWidth = r * 0.3; ctx.stroke(); ctx.strokeStyle = "#fff"; ctx.lineWidth = r * 0.16; ctx.stroke();
    poly(ctx, [x + r * 0.42, y - r * 0.62, x + r * 0.5, y - r * 0.1, x + r * 0.05, y - r * 0.3]); ctx.fillStyle = "#fff"; ctx.fill();
  }
  function iconNext(x, y, r) { poly(ctx, [x - r * 0.25, y - r * 0.42, x + r * 0.42, y, x - r * 0.25, y + r * 0.42]); fillStroke(ctx, "#fff", "#4D2A0E", r * 0.1); }
  function iconMenu(x, y, r) { for (var i = -1; i <= 1; i++) { rrect(ctx, x - r * 0.38, y + i * r * 0.28 - r * 0.07, r * 0.76, r * 0.14, r * 0.07); fillStroke(ctx, "#fff", "#4D2A0E", r * 0.06); } }
  function iconSound(x, y, r) {
    poly(ctx, [x - r * 0.45, y - r * 0.15, x - r * 0.2, y - r * 0.15, x + r * 0.05, y - r * 0.4, x + r * 0.05, y + r * 0.4, x - r * 0.2, y + r * 0.15, x - r * 0.45, y + r * 0.15]);
    fillStroke(ctx, "#fff", "#4D2A0E", r * 0.08);
    ctx.lineWidth = r * 0.12;
    if (Au.isMuted()) { ctx.strokeStyle = "#FF5A6A"; ctx.beginPath(); ctx.moveTo(x + r * 0.2, y - r * 0.2); ctx.lineTo(x + r * 0.5, y + r * 0.2); ctx.moveTo(x + r * 0.5, y - r * 0.2); ctx.lineTo(x + r * 0.2, y + r * 0.2); ctx.stroke(); }
    else { ctx.strokeStyle = "#fff"; ctx.beginPath(); ctx.arc(x + r * 0.05, y, r * 0.3, -0.7, 0.7); ctx.stroke(); ctx.beginPath(); ctx.arc(x + r * 0.05, y, r * 0.5, -0.7, 0.7); ctx.stroke(); }
  }
  function bigStar(x, y, r, on, k) {
    var rr0 = Math.max(2, Math.round(r)), sz = rr0 * 2 + 8;
    var c = cachedPiece("star:" + rr0 + ":" + (on ? 1 : 0) + ":" + dpr, sz, sz, function () { bigStarRaw(sz / 2, sz / 2, rr0, on, 1); });
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    ctx.drawImage(c, -sz / 2, -sz / 2, sz, sz);
    ctx.restore();
  }
  function bigStarRaw(x, y, r, on, k) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    star5(ctx, 0, 0, r, 0.5);
    if (on) {
      var g = ctx.createRadialGradient(-r * 0.25, -r * 0.35, r * 0.05, 0, 0, r);
      g.addColorStop(0, "#FFF7C2"); g.addColorStop(0.5, "#FFD43B"); g.addColorStop(1, "#F2A20C");
      fillStroke(ctx, g, "#7A4A00", r * 0.12);
      star5(ctx, -r * 0.1, -r * 0.12, r * 0.35, 0.5); ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.fill();
    } else fillStroke(ctx, "#6B5A48", "#3A2A1A", r * 0.12);
    ctx.restore();
  }

  function drawHUD(t) {
    if (scene === "play" || scene === "result") {
      var r = BTN_R, top = SA.t + EDGE + r, left = SA.l + EDGE + r, right = W - SA.r - EDGE - r;
      roundBtn(left, top, r, iconBack, function () { scene = "levels"; sceneT = 0; game = null; Au.setIntensity(0); bakeBackdrop("day"); });
      roundBtn(left + r * 2 + GAP * 1.5, top, r, iconRetry, function () { startLevel(levelIdx); });
      roundBtn(right, top, r, iconSound, function () { Au.setMuted(!Au.isMuted()); });
      if (game) {
        // score block, right aligned against the sound button
        var sx = right - r - GAP * 2;
        var scoreMax = sx - (left + r * 3 + GAP * 4 + r * 2.4);
        txt(ctx, fmt(shownScore), sx, top - TS.cap * 0.45, fitSize(fmt(shownScore), TS.title, scoreMax), "#FFFFFF", "#2B1A12", "right");
        var best = save.best[levelIdx] || 0;
        if (best) txt(ctx, "BEST " + fmt(best), sx, top + TS.title * 0.62, TS.cap, "#FFE9A8", "#2B1A12", "right", { shadow: false });
        // gremlins left, next to the two buttons
        var gx = left + r * 4 + GAP * 4;
        var gs = gremSprite("imp", "idle"), gsc = (r * 1.5) / (gs.R * 2);
        ctx.save(); ctx.translate(gx, top + 2 * U); ctx.scale(gsc, gsc); blit(gs.c, -gs.cx, -gs.cy); ctx.restore();
        txt(ctx, "x" + game.gremsAlive(), gx + r * 0.9, top + U, TS.label, "#FFFFFF", "#2B1A12", "left");
      }
      if (game && scene === "play" && introT >= 1) {
        var bot = H - SA.b - EDGE - TS.body;
        if (game.state === "aim" && !aiming && loadT >= 1) {
          var msg = firstShotEver ? "Grab your Chi, pull back, let go" : "Tap mid-air for " + game.power;
          ctx.globalAlpha = 0.75 + Math.sin(t * 4) * 0.25;
          hintPill(msg, W / 2, bot);
          ctx.globalAlpha = 1;
        } else if (game.state === "flying" && !game.powerUsed && game.pets[0] && game.pets[0].hits === 0) {
          var pz = 1 + Math.sin(t * 14) * 0.06;
          ctx.save(); ctx.translate(W / 2, bot); ctx.scale(pz, pz);
          txt(ctx, "TAP!", 0, 0, TS.display, "#FFE14D", "#2B1A12", "center");
          ctx.restore();
        }
      }
      if (banner) {
        var bt = banner.t, inK = clamp(bt / 0.35, 0, 1), outK = clamp((bt - 1.6) / 0.4, 0, 1);
        var bw = Math.min(W - EDGE * 2, 400 * U), bh = TS.cap + TS.title + GAP * 4;
        var bx = W / 2 - bw / 2 + (1 - backOut(inK)) * -W + ease(outK) * W, by = snap(H * 0.24);
        woodPanel(bx, by, bw, bh, 16 * U);
        txt(ctx, banner.s1, bx + bw / 2, by + GAP * 1.5 + TS.cap / 2, TS.cap, "#FFE9A8", "#4D2A0E", "center", { shadow: false });
        txt(ctx, banner.s2, bx + bw / 2, by + GAP * 2.5 + TS.cap + TS.title / 2, TS.title, "#FFFFFF", "#4D2A0E", "center");
      }
    }
    if (scene === "result" && result) drawResult(t);
    if (scene === "title") drawTitle(t);
    if (scene === "levels") drawLevels(t);
    if (scene === "play") drawRotateCard(t);
  }

  // The largest size (up to `size`) at which `s` fits in `maxW`.
  function fitSize(s, size, maxW) {
    ctx.font = size + "px " + FONT;
    var w = ctx.measureText(s).width;
    return w <= maxW ? size : Math.max(10, Math.floor((size * maxW) / w));
  }
  // A phone that tips from upright to sideways, on a loop: the "turn your phone" glyph.
  function phoneGlyph(x, y, h, t) {
    var k = (t % 2.4) / 2.4, ang = k < 0.15 ? 0 : k < 0.55 ? ease((k - 0.15) / 0.4) * (Math.PI / 2) : k < 0.85 ? Math.PI / 2 : (1 - ease((k - 0.85) / 0.15)) * (Math.PI / 2);
    var w = h * 0.52;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-ang);
    rrect(ctx, -w / 2, -h / 2, w, h, w * 0.18);
    fillStroke(ctx, "#2B1A12", "#FFFFFF", Math.max(2, h * 0.07));
    rrect(ctx, -w / 2 + h * 0.08, -h / 2 + h * 0.1, w - h * 0.16, h - h * 0.24, w * 0.08);
    ctx.fillStyle = "#7AD0FF"; ctx.fill();
    ell(ctx, 0, h / 2 - h * 0.07, h * 0.035, h * 0.035); ctx.fillStyle = "#FFFFFF"; ctx.fill();
    ctx.restore();
    // the curved arrow showing which way to turn
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.arc(0, 0, h * 0.72, -Math.PI * 0.95, -Math.PI * 0.6);
    ctx.strokeStyle = "#FFD23F"; ctx.lineWidth = Math.max(2.5, h * 0.09); ctx.lineCap = "round"; ctx.stroke();
    var ax = Math.cos(-Math.PI * 0.6) * h * 0.72, ay = Math.sin(-Math.PI * 0.6) * h * 0.72;
    poly(ctx, [ax + h * 0.16, ay + h * 0.02, ax - h * 0.06, ay - h * 0.14, ax - h * 0.04, ay + h * 0.16]);
    ctx.fillStyle = "#FFD23F"; ctx.fill();
    ctx.restore();
  }
  // The title screen badge: glyph + one clear line.
  function rotateBadge(x, y, t) {
    var msg = "Turn your phone sideways";
    var sub = "for the best experience";
    var fs = TS.label, gh = TS.title * 1.4;
    ctx.font = fs + "px " + FONT;
    var tw = Math.max(ctx.measureText(msg).width, ctx.measureText(sub).width * (TS.cap / fs));
    var w = gh + GAP * 3 + tw + GAP * 4, h = Math.max(gh + GAP * 2, fs + TS.cap + GAP * 3);
    rrect(ctx, x - w / 2, y, w, h, h / 2);
    ctx.fillStyle = "rgba(20,12,8,0.7)"; ctx.fill();
    ctx.strokeStyle = "rgba(255,210,63,0.9)"; ctx.lineWidth = 2 * U; ctx.stroke();
    phoneGlyph(x - w / 2 + GAP * 2 + gh / 2, y + h / 2, gh * 0.78, t);
    var tx = x - w / 2 + GAP * 4 + gh;
    txt(ctx, msg, tx, y + h / 2 - TS.cap * 0.55, fs, "#FFFFFF", null, "left", { shadow: false });
    txt(ctx, sub, tx, y + h / 2 + fs * 0.6, TS.cap, "#FFE9A8", null, "left", { shadow: false });
  }
  // Full card shown when a level starts upright. Rotating the phone dismisses it on its own.
  var rotateCard = { seen: false, show: false, t: 0 };
  try { rotateCard.seen = sessionStorage.getItem("chishot:rot") === "1"; } catch (e) { /* storage blocked */ }
  function drawRotateCard(t) {
    if (!rotateCard.show) return;
    if (!portrait) { rotateCard.show = false; return; }
    rotateCard.t += frameDt;
    var k = clamp(rotateCard.t / 0.3, 0, 1);
    ctx.fillStyle = "rgba(10,12,24," + (0.72 * k).toFixed(2) + ")";
    ctx.fillRect(0, 0, W, H);
    var w = Math.min(W - EDGE * 2, 340 * U), gh = TS.display * 2.2;
    var h = GAP * 4 + gh + GAP * 4 + TS.title + GAP * 1.5 + TS.body * 2.6 + GAP * 4 + BTN_R * 1.6 + GAP * 3;
    var x = W / 2 - w / 2, y = (H - h) / 2 + (1 - backOut(k)) * 40 * U;
    woodPanel(x, y, w, h, 22 * U);
    var cy = y + GAP * 4 + gh / 2;
    phoneGlyph(W / 2, cy, gh * 0.72, t);
    cy += gh / 2 + GAP * 4 + TS.title / 2;
    txt(ctx, "TURN YOUR PHONE", W / 2, cy, fitSize("TURN YOUR PHONE", TS.title, w - GAP * 6), "#FFFFFF", "#3B1D0B", "center");
    cy += TS.title / 2 + GAP * 1.5 + TS.body / 2;
    txt(ctx, "Chi Shot plays best sideways:", W / 2, cy, TS.body, "#FFE9A8", "#4D2A0E", "center", { shadow: false });
    cy += TS.body * 1.3;
    txt(ctx, "bigger view, easier aim.", W / 2, cy, TS.body, "#FFE9A8", "#4D2A0E", "center", { shadow: false });
    cy += TS.body * 0.6 + GAP * 4 + BTN_R * 0.8;
    var bw = Math.min(w - GAP * 8, 220 * U), bh = BTN_R * 1.6;
    rrect(ctx, W / 2 - bw / 2, cy - bh / 2, bw, bh, bh / 2);
    fillStroke(ctx, "rgba(255,255,255,0.18)", "#FFFFFF", 2 * U);
    txt(ctx, "Play upright instead", W / 2, cy + U, TS.body, "#FFFFFF", null, "center", { shadow: false });
    buttons.push({ x: W / 2 - bw / 2, y: cy - bh / 2, w: bw, h: bh, fn: function () { rotateCard.show = false; } });
    // the whole card swallows taps so nothing behind it fires
    buttons.unshift({ x: 0, y: 0, w: W, h: H, fn: function () { } });
  }
  // A soft dark pill behind instructional text, so it reads on any sky.
  function hintPill(msg, x, y) {
    ctx.font = TS.body + "px " + FONT;
    var w = ctx.measureText(msg).width + GAP * 4, h = TS.body + GAP * 2;
    rrect(ctx, x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fillStyle = "rgba(20,12,8,0.55)";
    ctx.fill();
    txt(ctx, msg, x, y + U, TS.body, "#FFFFFF", null, "center", { shadow: false });
  }

  function drawTitle(t) {
    ctx.fillStyle = "rgba(10,20,40,0.12)";
    ctx.fillRect(0, 0, W, H);
    var safeT = SA.t + EDGE, safeB = H - SA.b - EDGE;
    var heroFace = Math.sin(t * 0.8) > 0.55 ? "aim" : Math.sin(t * 1.9) > 0.97 ? "blink" : "idle";
    var L, avail = safeB - safeT;
    var tagH = TS.body + GAP * 2;
    var infoH = TS.title + GAP + TS.cap + GAP * 2 + tagH; // name, number, power tag
    if (portrait) {
      var P = Math.min(W * 0.21, avail * 0.1);
      var wordH = P * 1.75; // CHI + SHOT lines
      var titleY = safeT + GAP * 2 + P / 2;
      // the rotate badge owns the bottom band; the call to action sits above it
      var badgeH = TS.title * 1.4 + GAP * 2;
      var ctaY = safeB - badgeH - GAP * 4 - TS.title / 2;
      var infoTop = ctaY - TS.title / 2 - GAP * 4 - infoH;
      var heroTop = titleY - P / 2 + wordH + GAP * 3, heroBot = infoTop - GAP * 4;
      // the pet's full visual height is ~1.75x its body (ears, sprout, hat and the bounce above it)
      var heroSize = Math.max(40, Math.min(W * 0.46, (heroBot - heroTop) / 1.75));
      L = { titleX: W / 2, titleY: titleY, P: P, heroX: W / 2, heroFeet: heroBot - ((heroBot - heroTop) - heroSize * 1.75) / 2, hero: heroSize, infoX: W / 2, infoY: infoTop + TS.title / 2, ctaY: ctaY };
    } else {
      // two columns: wordmark, identity and the call to action on the left, the hero on the right
      var P2 = Math.min(W * 0.085, avail * 0.17);
      var colH = P2 * 1.75 + GAP * 3 + infoH + GAP * 4 + TS.title;
      var top2 = safeT + Math.max(0, (avail - colH) / 2);
      L = {
        titleX: W * 0.33, titleY: top2 + P2 / 2, P: P2,
        heroX: W * 0.72, hero: Math.min(W * 0.28, (avail - GAP * 4) / 1.75), heroFeet: 0,
        infoX: W * 0.33, infoY: top2 + P2 * 1.75 + GAP * 3 + TS.title / 2,
        ctaY: top2 + colH - TS.title / 2,
      };
    }
    if (!portrait) L.heroFeet = safeT + avail / 2 + L.hero * 0.875;
    // wordmark: CHI over SHOT, one stroke weight relative to size
    ctx.save();
    ctx.translate(L.titleX, L.titleY);
    ctx.rotate(Math.sin(t * 1.5) * 0.015);
    txt(ctx, "CHI", 0, 0, L.P, "#FFD23F", "#3B1D0B", "center", { sw: L.P * 0.16 });
    txt(ctx, "SHOT", 0, L.P * 0.92, L.P * 0.72, "#FF6A3D", "#3B1D0B", "center", { sw: L.P * 0.72 * 0.16 });
    ctx.restore();
    // hero pet, bouncing with squash on landing
    var spr = petSprite(heroFace), sc = L.hero / (PET_R * 2 * PPM);
    var bounce = Math.abs(Math.sin(t * 2.6)), lift = bounce * L.hero * 0.22;
    var squash = bounce < 0.15 ? 1 + (0.15 - bounce) * 1.2 : 1;
    var feet = L.heroFeet;
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ell(ctx, L.heroX, feet, L.hero * 0.38 * (1 - bounce * 0.3), L.hero * 0.06); ctx.fill();
    ctx.save();
    ctx.translate(L.heroX, feet - lift);
    ctx.scale(sc * squash, sc / squash);
    blit(spr.c, -spr.cx, -spr.cy - PET_R * PPM);
    ctx.restore();
    // gremlins peeking up from the bottom corners
    var gsz = Math.min(W, H) * 0.3;
    for (var k = -1; k <= 1; k += 2) {
      var gsp = gremSprite(k < 0 ? "brute" : "imp", Math.sin(t * 1.3 + k) > 0.6 ? "laugh" : "idle");
      var gsc = gsz / (gsp.R * 2);
      ctx.save();
      ctx.translate(W / 2 + k * W * (portrait ? 0.36 : 0.42), H - SA.b + gsz * 0.18 + Math.sin(t * 2 + k) * 4 * U);
      ctx.scale(k < 0 ? gsc : -gsc, gsc);
      blit(gsp.c, -gsp.cx, -gsp.cy);
      ctx.restore();
    }
    // identity block: name, number, power tag, on the 8 pt grid
    var y = L.infoY;
    txt(ctx, BOOT.name || "", L.infoX, y, TS.title, "#FFFFFF", "#2B1A12", "center");
    y += TS.title / 2 + GAP + TS.cap / 2;
    txt(ctx, (BOOT.number || "").toUpperCase(), L.infoX, y, TS.cap, "#FFE9A8", "#2B1A12", "center", { shadow: false });
    y += TS.cap / 2 + GAP * 2;
    var tag = "YOUR POWER: " + (Core.POWERS[SHAPE] || "TURBO");
    ctx.font = TS.body + "px " + FONT;
    var tw = ctx.measureText(tag).width + GAP * 4, th = TS.body + GAP * 2;
    woodPanel(L.infoX - tw / 2, y, tw, th, th / 2);
    txt(ctx, tag, L.infoX, y + th / 2 + U, TS.body, "#FFFFFF", "#4D2A0E", "center", { shadow: false });
    var pulse = 1 + Math.sin(t * 5) * 0.05;
    ctx.save(); ctx.translate(L.infoX, L.ctaY); ctx.scale(pulse, pulse);
    txt(ctx, "TAP TO PLAY", 0, 0, TS.title, "#FFFFFF", "#2B1A12", "center");
    ctx.restore();
    if (portrait) rotateBadge(W / 2, L.ctaY + TS.title / 2 + GAP * 3, t, false);
  }

  function drawLevels(t) {
    ctx.fillStyle = "rgba(10,20,40,0.25)";
    ctx.fillRect(0, 0, W, H);
    var headY = SA.t + EDGE + BTN_R;
    roundBtn(SA.l + EDGE + BTN_R, headY, BTN_R, iconBack, function () { scene = "title"; sceneT = 0; });
    // total stars on the right; the header fits between equal side margins that clear both
    var tot = 0;
    for (var ti = 0; ti < Core.LEVELS.length; ti++) tot += save.stars[ti] || 0;
    var totS = tot + "/" + Core.LEVELS.length * 3, sr0 = TS.body * 0.62, rx = W - SA.r - EDGE - sr0;
    ctx.font = TS.body + "px " + FONT;
    var sideW = Math.max(BTN_R * 2 + GAP * 2, ctx.measureText(totS).width + sr0 * 2 + GAP * 3);
    var headMax = W - 2 * (Math.max(SA.l, SA.r) + EDGE + sideW);
    txt(ctx, "PICK A FORT", W / 2, headY, fitSize("PICK A FORT", TS.display, headMax), "#FFD23F", "#3B1D0B", "center");
    bigStar(rx, headY, sr0, true, 1);
    txt(ctx, totS, rx - sr0 - GAP, headY + U, TS.body, "#FFFFFF", "#3B1D0B", "right", { shadow: false });
    var n = Core.LEVELS.length, cols = portrait ? 2 : 5, rows = Math.ceil(n / cols);
    var gap = GAP * 2, availW = W - SA.l - SA.r - EDGE * 2, top = headY + BTN_R + GAP * 3, availH = H - SA.b - EDGE - top;
    // tiles fill the space: as wide as the columns allow, then as tall as the rows allow
    var tw = Math.min((availW - gap * (cols - 1)) / cols, 280 * U);
    var th = Math.min(tw / (portrait ? 1.1 : 1.45), (availH - (rows - 1) * gap) / rows);
    tw = Math.min(tw, th * 1.9);
    var gridH = rows * th + (rows - 1) * gap;
    top += Math.max(0, (availH - gridH) / 2);
    var gx = SA.l + EDGE + (availW - (cols * tw + (cols - 1) * gap)) / 2;
    var pad = Math.max(GAP * 1.5, tw * 0.08), numSize = Math.min(th * 0.34, TS.display * 1.1), starR = Math.min(th * 0.1, 14 * U);
    for (var i = 0; i < n; i++) {
      var c = i % cols, r = Math.floor(i / cols);
      var x = snap(gx + c * (tw + gap)), pop = clamp((sceneT - i * 0.05) / 0.3, 0, 1), y = snap(top + r * (th + gap) + (1 - backOut(pop)) * 24 * U);
      var open = unlocked(i);
      woodPanel(x, y, tw, th, 14 * U);
      if (!open) { rrect(ctx, x, y, tw, th, 14 * U); ctx.fillStyle = "rgba(45,22,6,0.45)"; ctx.fill(); }
      if (open) {
        txt(ctx, String(i + 1), x + pad, y + pad + numSize / 2, numSize, "#FFFFFF", "#4D2A0E", "left");
        for (var s2 = 0; s2 < 3; s2++) bigStar(x + tw - pad - starR - (2 - s2) * starR * 2.3, y + pad + starR, starR, (save.stars[i] || 0) > s2, 1);
        var nameSize = fitSize(Core.LEVELS[i].name, clamp(tw * 0.1, TS.cap, TS.label), tw - pad * 2);
        txt(ctx, Core.LEVELS[i].name, x + pad, y + th - pad - nameSize / 2, nameSize, "#FFE9A8", "#4D2A0E", "left", { shadow: false });
        (function (k) { buttons.push({ x: x, y: y, w: tw, h: th, fn: function () { startLevel(k); } }); })(i);
      } else {
        var lx = x + tw / 2, ly = y + th / 2, ls = Math.min(th * 0.18, 16 * U);
        ctx.lineWidth = ls * 0.38; ctx.strokeStyle = "#4D2A0E"; ctx.beginPath(); ctx.arc(lx, ly - ls * 0.55, ls * 0.7, Math.PI, 0); ctx.stroke();
        rrect(ctx, lx - ls, ly - ls * 0.5, ls * 2, ls * 1.6, ls * 0.35); fillStroke(ctx, "#8E5A22", "#4D2A0E", ls * 0.22);
        ell(ctx, lx, ly + ls * 0.2, ls * 0.22, ls * 0.22); ctx.fillStyle = "#4D2A0E"; ctx.fill();
        txt(ctx, String(i + 1), x + pad, y + pad + numSize * 0.35, numSize * 0.7, "rgba(255,255,255,0.55)", "#4D2A0E", "left", { shadow: false });
      }
    }
  }

  // ---------------------------------------------------------------- the FINALE
  // Beating the last fort is a show, not a panel: a sunburst, fireworks over the sky, a conga of
  // dancing Chis (the keeper's own, the middle one crowned), the King fleeing in a sweat, the title
  // slamming in, the stars counting up, and then the MORE FORTS COMING SOON sign dropping in on
  // its ropes. Tap to skip ahead to the sign.
  var fin = null;
  function drawFinale(t) {
    var r = result;
    if (!fin) {
      fin = { t: 0, rockets: [], sparks: [], nextRocket: 0.25, total: 0, shownTotal: 0, signed: false, played: false };
      for (var si = 0; si < Core.LEVELS.length; si++) fin.total += save.stars[si] || 0;
      Au.setIntensity(2);
    }
    var dt = frameDt;
    fin.t += dt;
    var T = fin.t;
    if (!fin.played) { fin.played = true; Au.win(); }
    // skip ahead on a tap
    buttons.push({ x: 0, y: 0, w: W, h: H, fn: function () { if (fin && fin.t < 4.2) fin.t = 4.2; } });

    // night sky wash + a slow sunburst behind everything
    ctx.fillStyle = "rgba(10,8,30," + Math.min(0.78, T * 1.4).toFixed(2) + ")";
    ctx.fillRect(0, 0, W, H);
    var cx = W / 2, cy = H * (portrait ? 0.34 : 0.36), rays = 16, R0 = Math.max(W, H);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(T * 0.25);
    ctx.globalAlpha = Math.min(0.35, T * 0.5);
    for (var i = 0; i < rays; i++) {
      ctx.rotate((Math.PI * 2) / rays);
      poly(ctx, [0, 0, -R0 * 0.09, -R0, R0 * 0.09, -R0]);
      ctx.fillStyle = i % 2 ? "#FFD23F" : "#FF8A3D";
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // fireworks
    fin.nextRocket -= dt;
    if (fin.nextRocket <= 0 && fin.rockets.length < 6) {
      fin.nextRocket = T < 5 ? rand(0.18, 0.4) : rand(0.6, 1.1);
      fin.rockets.push({ x: rand(W * 0.1, W * 0.9), y: H + 10, vy: -rand(H * 0.9, H * 1.25), ty: rand(H * 0.12, H * 0.45), col: ["#FFD23F", "#FF5C8A", "#7AF0FF", "#B6FF6A", "#FFFFFF", PAL.body][Math.floor(rand(0, 6))] });
      Au.firework(R() < 0.3);
    }
    for (i = fin.rockets.length - 1; i >= 0; i--) {
      var rk = fin.rockets[i];
      rk.y += rk.vy * dt;
      ell(ctx, rk.x, rk.y, 2.5 * U, 2.5 * U); ctx.fillStyle = "#FFF3C4"; ctx.fill();
      glowAt(rk.x, rk.y, 10 * U, "255,220,150", 0.6);
      if (rk.y <= rk.ty) {
        var n = 46, big = R() < 0.35;
        for (var k = 0; k < n; k++) {
          var a = (k / n) * Math.PI * 2 + rand(-0.05, 0.05), sp = (big ? 260 : 190) * U * rand(0.75, 1);
          fin.sparks.push({ x: rk.x, y: rk.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: rand(0.9, 1.4), col: k % 5 === 0 ? "#FFFFFF" : rk.col });
        }
        fin.rockets.splice(i, 1);
      }
    }
    for (i = fin.sparks.length - 1; i >= 0; i--) {
      var sk = fin.sparks[i];
      sk.t += dt;
      if (sk.t >= sk.life) { fin.sparks.splice(i, 1); continue; }
      sk.vx *= Math.exp(-dt * 1.8); sk.vy = sk.vy * Math.exp(-dt * 1.8) + 120 * U * dt;
      sk.x += sk.vx * dt; sk.y += sk.vy * dt;
      var fade = 1 - sk.t / sk.life;
      ctx.globalAlpha = fade;
      ell(ctx, sk.x, sk.y, 2.2 * U, 2.2 * U); ctx.fillStyle = sk.col; ctx.fill();
      ctx.globalAlpha = 1;
      if (i % 3 === 0) glowAt(sk.x, sk.y, 9 * U, "255,230,170", 0.35 * fade);
    }

    // the King flees across the bottom in a sweat
    if (T > 0.4 && T < 6) {
      var gk = gremSprite("king", "scared"), ksz = Math.min(W, H) * 0.22, ksc = ksz / (gk.R * 2);
      var kx = W * 0.15 + (T - 0.4) * W * 0.32, ky = H - SA.b - ksz * 0.55 - Math.abs(Math.sin(T * 14)) * ksz * 0.12;
      ctx.save(); ctx.translate(kx, ky); ctx.scale(-ksc, ksc); blit(gk.c, -gk.cx, -gk.cy); ctx.restore();
      ell(ctx, kx + ksz * 0.45, ky - ksz * 0.35, 4 * U, 6 * U); ctx.fillStyle = "#8FD3FF"; ctx.fill();
    }

    // a conga of dancing Chis, the middle one crowned
    var nd = portrait ? 3 : 5, dsz = Math.min(W / (nd + 1.2), H * 0.2), row = H - SA.b - EDGE - dsz * 0.62;
    for (var d = 0; d < nd; d++) {
      var appear = clamp((T - 0.8 - d * 0.12) / 0.35, 0, 1);
      if (appear <= 0) continue;
      var beat = T * 5.2 + d * 0.9, hop = Math.abs(Math.sin(beat)), sq = hop < 0.2 ? 1 + (0.2 - hop) * 1.4 : 1;
      var dx = W / 2 + (d - (nd - 1) / 2) * dsz * 1.12, dy = row - hop * dsz * 0.35 + (1 - backOut(appear)) * H * 0.4;
      var face = Math.sin(beat * 0.5 + d) > 0.2 ? "happy" : "yell";
      var spr = petSprite(face), psc = (dsz * 0.85) / (PET_R * 2 * PPM);
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(Math.sin(beat) * 0.22);
      ctx.scale(psc * sq, psc / sq);
      blit(spr.c, -spr.cx, -spr.cy);
      ctx.restore();
      if (d === Math.floor(nd / 2)) {
        // the champion's crown
        var cw = dsz * 0.36, cyy = dy - dsz * 0.5;
        ctx.save(); ctx.translate(dx, cyy); ctx.rotate(Math.sin(beat) * 0.22);
        poly(ctx, [-cw, 0, -cw, -cw * 0.9, -cw * 0.45, -cw * 0.45, 0, -cw * 1.15, cw * 0.45, -cw * 0.45, cw, -cw * 0.9, cw, 0]);
        fillStroke(ctx, "#FFD23F", "#7A4A00", Math.max(2, cw * 0.1));
        ell(ctx, 0, -cw * 0.35, cw * 0.15, cw * 0.15); ctx.fillStyle = "#FF2D55"; ctx.fill();
        ctx.restore();
      }
    }

    // the title slams in, then the tally
    var tk = clamp((T - 0.9) / 0.45, 0, 1);
    var sgE = ease(clamp((T - 4.2) / 0.7, 0, 1)), tight = !portrait;
    var tsz = fitSize("YOU BEAT THE KING!", TS.display * 1.35, W - EDGE * 4);
    var titleY = lerp(cy - TS.display * 0.6, SA.t + EDGE + BTN_R * 2 + GAP + tsz / 2, tight ? sgE : 0);
    if (tk > 0) {
      ctx.save();
      ctx.translate(cx, titleY);
      var sc = tk < 1 ? 2.2 - backOut(tk) * 1.2 : 1 + Math.sin(T * 3) * 0.025;
      ctx.scale(sc, sc);
      ctx.rotate(Math.sin(T * 2) * 0.02);
      txt(ctx, "YOU BEAT THE KING!", 0, 0, tsz, "#FFD23F", "#3B1D0B", "center", { sw: tsz * 0.2 });
      ctx.restore();
    }
    var sk2 = clamp((T - 2.0) / 0.4, 0, 1) * (tight ? 1 - sgE : 1);
    if (sk2 > 0) {
      fin.shownTotal = Math.min(fin.total, fin.shownTotal + dt * Math.max(8, fin.total));
      ctx.globalAlpha = sk2;
      txt(ctx, "ALL " + Core.LEVELS.length + " FORTS SMASHED", cx, cy + TS.display * 0.45, fitSize("ALL " + Core.LEVELS.length + " FORTS SMASHED", TS.title, W - EDGE * 4), "#FFFFFF", "#3B1D0B", "center");
      var tot = Math.round(fin.shownTotal) + " / " + Core.LEVELS.length * 3;
      ctx.font = TS.title + "px " + FONT;
      var tw = ctx.measureText(tot).width, sr = TS.title * 0.5;
      bigStar(cx - tw / 2 - sr - GAP, cy + TS.display * 0.45 + TS.title * 1.25, sr, true, 1);
      txt(ctx, tot, cx + sr / 2, cy + TS.display * 0.45 + TS.title * 1.25, TS.title, "#FFE9A8", "#3B1D0B", "center");
      ctx.globalAlpha = 1;
    }

    // MORE FORTS COMING SOON: the sign drops in on its ropes and swings to rest
    var sg = clamp((T - 4.2) / 0.7, 0, 1);
    if (sg > 0) {
      if (!fin.signed) { fin.signed = true; Au.star(2); addShake(6); }
      var sw = Math.min(W - EDGE * 2 - (tight ? BTN_R * 5 + GAP * 6 : 0), 420 * U), sh = TS.display + TS.title + GAP * 6;
      var sy0 = tight ? titleY + tsz / 2 + GAP * 2 : cy + TS.display * 0.45 + TS.title * 2.2;
      if (sy0 + sh > row - dsz * 0.6) sy0 = Math.max(titleY + tsz / 2 + GAP, row - dsz * 0.6 - sh);
      var drop = (1 - backOut(sg)) * -H * 0.6, swing = Math.sin(T * 3) * 0.035 * Math.exp(-(T - 4.2) * 0.6);
      ctx.save();
      ctx.translate(cx, sy0 + drop);
      ctx.rotate(swing);
      // ropes
      ctx.strokeStyle = "#5A3A1A"; ctx.lineWidth = 3 * U;
      ctx.beginPath(); ctx.moveTo(-sw * 0.38, 0); ctx.lineTo(-sw * 0.3, -H); ctx.moveTo(sw * 0.38, 0); ctx.lineTo(sw * 0.3, -H); ctx.stroke();
      woodPanel(-sw / 2, 0, sw, sh, 20 * U);
      var pulse = 1 + Math.sin(T * 4) * 0.04;
      ctx.save(); ctx.translate(0, GAP * 2.5 + TS.display / 2); ctx.scale(pulse, pulse);
      txt(ctx, "MORE FORTS", 0, 0, fitSize("MORE FORTS", TS.display, sw - GAP * 6), "#FFD23F", "#3B1D0B", "center");
      ctx.restore();
      txt(ctx, "COMING SOON", 0, GAP * 3.5 + TS.display + TS.title / 2, fitSize("COMING SOON", TS.title, sw - GAP * 6), "#FFFFFF", "#3B1D0B", "center");
      ctx.restore();
      // sparkles around the sign
      for (var q = 0; q < 6; q++) {
        var an = T * 1.3 + q, rx = sw * 0.55, ry = sh * 0.7;
        star5(ctx, cx + Math.cos(an) * rx, sy0 + drop + sh / 2 + Math.sin(an) * ry, 6 * U * (0.6 + 0.4 * Math.sin(T * 6 + q)), 0.45);
        ctx.fillStyle = q % 2 ? "#FFF3A6" : "#FFFFFF"; ctx.fill();
      }
      if (sg >= 1) {
        var list = [{ ic: iconMenu, fn: function () { fin = null; scene = "levels"; sceneT = 0; game = null; Au.setIntensity(0); bakeBackdrop("day"); } }, { ic: iconRetry, fn: function () { fin = null; startLevel(levelIdx); } }];
        var br2 = BTN_R * 1.15;
        if (tight) {
          for (var b = 0; b < list.length; b++) roundBtn(cx + (b === 0 ? -1 : 1) * (sw / 2 + GAP * 3 + br2), sy0 + sh / 2, br2, list[b].ic, list[b].fn);
        } else {
          var by = Math.min(sy0 + sh + GAP * 3 + br2, row - dsz * 0.75);
          for (var b2 = 0; b2 < list.length; b2++) roundBtn(cx + (b2 - 0.5) * (BTN_R * 2.3 + GAP * 3), by, br2, list[b2].ic, list[b2].fn);
        }
      }
    }
  }

  function drawResult(t) {
    var r = result, k = clamp(r.t / 0.35, 0, 1);
    if (r.final) { drawFinale(t); return; }
    ctx.fillStyle = "rgba(10,15,30," + (0.55 * k).toFixed(2) + ")";
    ctx.fillRect(0, 0, W, H);
    // the panel is laid out top to bottom on the grid; its height follows its content
    var w = Math.min(W - SA.l - SA.r - EDGE * 2, 360 * U);
    var titleH = TS.title, starsH = 92 * U, scoreH = TS.display, bestH = TS.body, btnR = BTN_R * 1.15;
    var finH = r.final ? TS.body * 2.4 + GAP : 0;
    var h = GAP * 3 + titleH + GAP * 2 + starsH + GAP * 2 + scoreH + GAP + bestH + finH + GAP * 3 + btnR;
    h = Math.min(h, H - SA.t - SA.b - EDGE * 2 - btnR);
    var x = W / 2 - w / 2, y = snap((H - h - btnR) / 2 - (1 - backOut(k)) * H * 0.4);
    woodPanel(x, y, w, h, 22 * U);
    var cy = y + GAP * 3 + titleH / 2;
    var head = r.final ? "YOU BEAT THE KING!" : r.won ? "LEVEL CLEARED!" : "THE GREMLINS WIN";
    txt(ctx, head, W / 2, cy, fitSize(head, TS.title, w - GAP * 6), r.won ? "#FFD23F" : "#FF8A7A", "#3B1D0B", "center");
    cy += titleH / 2 + GAP * 2 + starsH / 2;
    if (r.won) {
      var sr = starsH * 0.36, spread = Math.min(w * 0.26, sr * 2.6);
      for (var s = 0; s < 3; s++) {
        var on = s < r.stars;
        var appear = clamp((r.t - 0.6 - s * 0.4) / 0.28, 0, 1);
        var sxp = W / 2 + (s - 1) * spread, syp = cy + (s === 1 ? -sr * 0.3 : sr * 0.12);
        if (on && appear > 0 && r.starShown <= s) { r.starShown = s + 1; Au.star(s); r.bursts.push({ x: sxp, y: syp, t: 0 }); addShake(4); }
        var sk = on && appear > 0 ? (appear < 1 ? 1.6 - backOut(appear) * 0.6 : 1) : 1;
        bigStar(sxp, syp, s === 1 ? sr * 1.18 : sr, on && appear > 0, sk);
      }
    } else {
      // horns and ears reach well above the body, so the body is sized to leave the title clear
      var gs = gremSprite("brute", Math.sin(t * 12) > 0 ? "laugh" : "idle"), gsc = (starsH * 0.62) / (gs.R * 2);
      ctx.save(); ctx.translate(W / 2, cy + starsH * 0.16 + Math.sin(t * 18) * 2 * U); ctx.scale(gsc, gsc); blit(gs.c, -gs.cx, -gs.cy); ctx.restore();
    }
    cy += starsH / 2 + GAP * 2 + scoreH / 2;
    txt(ctx, fmt(r.score * clamp((r.t - 0.3) / 0.9, 0, 1)), W / 2, cy, TS.display, "#FFFFFF", "#3B1D0B", "center");
    cy += scoreH / 2 + GAP + bestH / 2;
    if (r.newBest && r.t > 1.3) txt(ctx, "NEW BEST!", W / 2, cy, TS.body, Math.sin(t * 10) > 0 ? "#B6FF6A" : "#FFFFFF", "#1E3A0E", "center", { shadow: false });
    else if (r.best) txt(ctx, "BEST " + fmt(r.best), W / 2, cy, TS.body, "#FFE9A8", "#4D2A0E", "center", { shadow: false });
    if (r.final) {
      // the end of the road, said plainly, with the total to chase
      var total = 0;
      for (var si = 0; si < Core.LEVELS.length; si++) total += save.stars[si] || 0;
      cy += bestH / 2 + GAP + TS.body / 2;
      txt(ctx, "All " + Core.LEVELS.length + " forts smashed!", W / 2, cy, TS.body, "#FFFFFF", "#4D2A0E", "center", { shadow: false });
      cy += TS.body * 1.3;
      txt(ctx, total + " / " + Core.LEVELS.length * 3 + " stars · more forts coming soon", W / 2, cy, fitSize(total + " / " + Core.LEVELS.length * 3 + " stars · more forts coming soon", TS.cap * 1.1, w - GAP * 4), "#FFE9A8", "#4D2A0E", "center", { shadow: false });
    }
    if (r.t > 1.0) {
      var bk = clamp((r.t - 1.0) / 0.3, 0, 1), br = btnR * backOut(bk);
      var hasNext = r.won && levelIdx + 1 < Core.LEVELS.length;
      var list = [{ ic: iconMenu, fn: function () { scene = "levels"; sceneT = 0; game = null; Au.setIntensity(0); bakeBackdrop("day"); } }, { ic: iconRetry, fn: function () { startLevel(levelIdx); } }];
      if (hasNext) list.push({ ic: iconNext, fn: function () { startLevel(levelIdx + 1); }, col: "#7CC63A" });
      var step = btnR * 2 + GAP * 3;
      for (var b = 0; b < list.length; b++) roundBtn(W / 2 + (b - (list.length - 1) / 2) * step, y + h, Math.max(1, br), list[b].ic, list[b].fn, list[b].col);
    }
    if (r.won) {
      if (!r.confetti) {
        r.confetti = [];
        var cols = ["#FFD23F", "#FF6A8A", "#7AF0FF", "#B6FF6A", "#FFFFFF", PAL.body];
        for (var c = 0; c < 80; c++) r.confetti.push({ x: rand(0, W), y: rand(-H * 0.6, -10), vy: rand(80, 170), vx: rand(-30, 30), ph: rand(0, 6), col: cols[c % cols.length], s: rand(5, 9) * U });
      }
      for (var q = 0; q < r.confetti.length; q++) {
        var cf = r.confetti[q];
        cf.y += cf.vy * frameDt; cf.x += (cf.vx + Math.sin(t * 4 + cf.ph) * 30) * frameDt;
        if (cf.y > H + 10) { cf.y = -10; cf.x = rand(0, W); }
        ctx.save(); ctx.translate(cf.x, cf.y); ctx.rotate(t * 5 + cf.ph); ctx.scale(1, Math.sin(t * 9 + cf.ph));
        ctx.fillStyle = cf.col; ctx.fillRect(-cf.s / 2, -cf.s / 4, cf.s, cf.s / 2);
        ctx.restore();
      }
    }
    for (var i = r.bursts.length - 1; i >= 0; i--) {
      var bu = r.bursts[i];
      bu.t += frameDt;
      if (bu.t > 0.5) { r.bursts.splice(i, 1); continue; }
      for (var a = 0; a < 10; a++) {
        var an = (a / 10) * Math.PI * 2, d = 30 * U + bu.t * 140 * U;
        star5(ctx, bu.x + Math.cos(an) * d, bu.y + Math.sin(an) * d, 6 * U * (1 - bu.t * 1.6), 0.45);
        ctx.fillStyle = a % 2 ? "#FFF3A6" : "#FFFFFF"; ctx.fill();
      }
    }
  }

  // ---------------------------------------------------------------- frame
  var lastT = 0, frameDt = 1 / 60;
  function frame(ts) {
    var dt = Math.min(0.05, lastT ? (ts - lastT) / 1000 : 0.016);
    lastT = ts;
    frameDt = dt;
    var t = ts / 1000;
    update(dt);
    buttons = [];
    shX = shake ? rand(-shake, shake) : 0;
    shY = shake ? rand(-shake, shake) : 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (scene === "title" || scene === "levels" || scene === "boot" || !game) {
      cam.zoom = portrait ? W / 17.5 : H / 12.5;
      cam.cx = Math.sin(t * 0.05) * 3 + 6;
      cam.cy = baseCy();
      drawBackdrop(t);
    } else {
      drawBackdrop(t);
      drawSlingBack();
      if (game.state === "aim" && introT >= 1 && loadT >= 1) { bandTo(TIP_B, pouchPos(), false); bandTo(TIP_F, pouchPos(), true); }
      for (var i = 0; i < game.ents.length; i++) drawEnt(game.ents[i], t);
      drawTrail();
      drawPets(t);
      drawSlingFront();
      drawParts();
    }
    if (flash > 0) {
      ctx.globalAlpha = Math.min(1, flash);
      ctx.fillStyle = flashCol;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    drawHUD(t);
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- boot
  var fontLoaded = false;
  function onFont() {
    fontLoaded = true;
    // TNT labels were baked with the fallback face; bake them again with the real one
    if (game) for (var i = 0; i < game.ents.length; i++) if (game.ents[i].kind === "tnt") game.ents[i].tex = null;
  }
  try {
    var ff = new FontFace("Lilita", "url(/game-assets/lilita.ttf?v=" + encodeURIComponent(BOOT.v || "1") + ")");
    ff.load().then(function (f) { document.fonts.add(f); onFont(); }).catch(function () { /* fallback face */ });
  } catch (e) { /* FontFace unsupported: fallback face */ }
  bakeSling();
  resize();
  var bootEl = document.getElementById("boot");
  if (bootEl) bootEl.parentNode.removeChild(bootEl);
  scene = "title";
  sceneT = 0;
  requestAnimationFrame(frame);

  // test hook for the automated screenshot pass
  window.__chi = {
    start: function (i) { Au.init(); startLevel(i); introT = 1; loadT = 1; },
    shoot: function (px2, py2) {
      if (!game || game.state !== "aim") return;
      pull = game.clampPull({ x: px2, y: py2 });
      aiming = true; mode = "aim"; aimId = -1; pointers[-1] = { x: 0, y: 0, sx: 0, sy: 0, t: 0, lx: 0, ly: 0, lt: 0 };
      endPointer({ pointerId: -1 }, false);
    },
    power: function () { if (game) game.usePower(); },
    scene: function () { return scene; },
    state: function () { return game ? game.state : null; },
    levels: function () { scene = "levels"; sceneT = 1; },
    cam: function () { return { cx: cam.cx, cy: cam.cy, zoom: cam.zoom, user: cam.user }; },
    fontLoaded: function () { return fontLoaded; },
    petScreen: function () { var p = pouchPos(); return W2S(p.x, p.y); },
    dismissRotate: function () { rotateCard.show = false; },
    finalPreview: function () { if (game) { levelIdx = Core.LEVELS.length - 1; game.score = 88400; showResult(true, 0); result.stars = 3; } },
    resultPreview: function (won) { if (game) { game.score = won ? 42100 : 9300; showResult(won, 0); if (won) result.stars = 3; } },
  };
})();
