/*
 * Art for CHI NIGHT: the CHI SHOT pet and gremlin bakers, copied verbatim from
 * server/game/chishot/chishot.js so the Chi looks like the same character in both games. If CHI SHOT's
 * pet or gremlin art changes, re-copy those blocks here.
 * Exposes window.ChiArt.
 */
(function () {
  "use strict";
  var BOOT = window.CHI;
  var TR = BOOT.traits || {};
  var PAL = BOOT.palette;
  var SHAPE = TR.shape || BOOT.shape || "Round";
  var PPM = 96;
  var RES = 2;
  var FONT = "'Lilita', 'Arial Rounded MT Bold', 'Arial Black', sans-serif";
  var Core = { PET_R: 0.55, GREMS: { imp: { r: 0.42 }, brute: { r: 0.74 }, king: { r: 1.0 }, sprint: { r: 0.42 }, spitter: { r: 0.42 }, elite: { r: 0.74 } } };
  var PET_R = Core.PET_R;
  function mk(w, h) {
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  function mkB(w, h) {
    var c = mk(w * RES, h * RES);
    c.getContext("2d").scale(RES, RES);
    return c;
  }
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
    // swarm-only kinds
    sprint: { body: "#E8762C", out: "#4A1A05", belly: "#FFB070", ear: "#FFD08A", horn: 0.55 },
    spitter: { body: "#23A39F", out: "#06302F", belly: "#7FE0D6", ear: "#E06A9A", horn: 0.7 },
    elite: { body: "#E8B528", out: "#4A3200", belly: "#FFE58A", ear: "#FF8AA6", horn: 1.05 },
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

  window.ChiArt = {
    PPM: PPM, RES: RES, PET_R: PET_R, GREMS: Core.GREMS, SHAPE: SHAPE, PAL: PAL, TR: TR,
    petSprite: petSprite, gremSprite: gremSprite, GT: GT,
    mk: mk, rrect: rrect, poly: poly, ell: ell, fillStroke: fillStroke, txt: txt, star5: star5,
    shade: shade, mixHex: mixHex, rgba: rgba, clamp: clamp, lerp: lerp, ease: ease, backOut: backOut, fmt: fmt, rng: rng,
  };
})();
