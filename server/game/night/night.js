/*
 * CHI NIGHT. A WALLETCHI bullet heaven: the keeper's own Chi
 * survives a night of gremlins until dawn. One thumb: drag anywhere to move (the stick appears
 * under your thumb and follows it), the Chi attacks by itself, double tap (or the CHI button) fires
 * its shape power when the meter is full. Portrait and landscape show the same world area.
 * Pure fun, like CHI SHOT: no tokens, no chain, no season state. Best time lives in localStorage only.
 * An Apple Watch gets its own layout (WATCH MODE below) when the server allows it for this pet.
 */
(function () {
  "use strict";
  var A = window.ChiArt, BOOT = window.CHI;
  var PPM = A.PPM, RES = A.RES, SHAPE = A.SHAPE;
  var clamp = A.clamp, lerp = A.lerp, ell = A.ell, rrect = A.rrect, txt = A.txt, fmt = A.fmt, shade = A.shade, rgba = A.rgba;
  var FONT = "'Lilita', 'Arial Rounded MT Bold', 'Arial Black', sans-serif";
  var Q = new URLSearchParams(location.search);
  var FDT = 1 / 60, SHAKE_ON = true;
  try { SHAKE_ON = localStorage.getItem("gnight:shake") !== "0"; } catch (e) { /* storage blocked */ }
  // Test switches (?god=1, ?t=200, ?fps=1, ?autostart=1) work on the local preview only (BOOT.dev).
  var DEV = !!BOOT.dev;
  var DEBUG = { god: DEV && Q.get("god") === "1", fps: DEV && Q.get("fps") === "1", t0: DEV ? Number(Q.get("t") || 0) : 0, lvl: DEV ? Number(Q.get("lvl") || 0) : 0 };
  var TITLE = String(BOOT.title || "CHI NIGHT").toUpperCase(), T_SPLIT = TITLE.indexOf(" ");
  var TITLE_A = T_SPLIT > 0 ? TITLE.slice(0, T_SPLIT) : TITLE, TITLE_B = T_SPLIT > 0 ? TITLE.slice(T_SPLIT + 1) : "";

  // ---------------------------------------------------------------- canvas + UI unit
  var cvs = document.getElementById("c"), ctx = cvs.getContext("2d");
  var dpr = 1, W = 0, H = 0, portrait = true, PXM = 33, U = 1, SA = { t: 0, r: 0, b: 0, l: 0 };
  var VIEW_AREA = 300; // square metres on screen, the same in both orientations

  // ================================================================ WATCH MODE
  // An Apple Watch opens the pass link in watchOS Safari at about 160 to 205 CSS px a side. The
  // server says whether this pet may use the watch layout (BOOT.watch, set only for the pets in
  // GAME_WATCH_SERIALS, the list CHI SHOT shares); the page then switches on a screen under 260 px,
  // or with ?watch=1 for testing. Every other screen takes the untouched phone path, so a phone
  // renders exactly as before. On a wrist the VIEW zooms in (WATCH_PXM: the Chi is 22 px wide, a
  // gremlin 16, the king 75) while the SIMULATION keeps the phone's 300 square metre view for
  // spawning and star targeting, so the night plays out the same and only the camera is closer. The
  // thumb stick is the phone's (appears under the thumb, trails it, dead zone, capped radius) with
  // wrist geometry; the Chi still fights by itself and double tap still fires the CHI power. Fixed
  // type sizes fitted to the width, 44 px targets, a HUD cut to time, level, kills and XP, one tap
  // on the title to play, one card at a time on the level-up and chest screens. Nothing pans,
  // pinches or zooms, and the crown has nothing to scroll.
  var WATCH_MAX = 260;
  var WATCH = false;
  function watchWanted() {
    if (!BOOT.watch) return false;
    return Q.get("watch") === "1" || Math.min(window.innerWidth, window.innerHeight) < WATCH_MAX;
  }
  var WATCH_PXM = 22; // px per metre on a wrist
  var SIM_PXM = 33; // px per metre the phone formula gives this screen: the simulation's view
  var WT = { cap: 11, body: 13, label: 15, title: 19, display: 24 }, WEDGE = 8, WGAP = 6, WBTN = 22;
  var WB = []; // the wrist's tap targets, rebuilt every frame
  function fitSize(s, size, maxW) { ctx.font = size + "px " + FONT; var w = ctx.measureText(s).width; return w > maxW ? Math.max(7, (size * maxW) / w) : size; }
  function readSafe() {
    var cs = getComputedStyle(document.documentElement);
    var f = function (n) { return parseFloat(cs.getPropertyValue(n)) || 0; };
    SA = { t: f("--sat"), r: f("--sar"), b: f("--sab"), l: f("--sal") };
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cvs.width = Math.round(W * dpr); cvs.height = Math.round(H * dpr);
    portrait = H >= W;
    WATCH = watchWanted();
    U = clamp(Math.min(W, H) / 390, 0.82, 1.85);
    SIM_PXM = Math.sqrt((W * H) / VIEW_AREA);
    PXM = WATCH ? WATCH_PXM : SIM_PXM;
    readSafe();
    fitAll();
    bakeGround();
    bakeVignette();
  }

  // ---------------------------------------------------------------- tiny utils
  var R = A.rng((Date.now() ^ 0x5eed) & 0xffffff);
  function rand(a, b) { return a + (b - a) * R(); }
  function pick(arr) { return arr[Math.floor(R() * arr.length)]; }
  function mk(w, h) { return A.mk(w, h); }
  function backOut2(t, c1) { c1 = c1 || 1.4; var c3 = c1 + 1; t = clamp(t, 0, 1); return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function dist2(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

  // ---------------------------------------------------------------- sprites fitted to this screen
  // Every sprite is baked once by the CHI SHOT bakers, then re-baked at the exact on-screen pixel
  // size, so the frame loop is plain drawImage with no scaling filter work and no gradients.
  var FIT = {};
  function fitSprite(spr, worldR, extra) {
    var k = (PXM / PPM) * (worldR / (spr.R / PPM)) * dpr; // device px per design px
    var w = Math.max(2, Math.ceil((spr.c.width / RES) * k)), h = Math.max(2, Math.ceil((spr.c.height / RES) * k));
    var c = mk(w, h), g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(spr.c, 0, 0, w, h);
    if (extra) { g.save(); g.scale(k / 1, k / 1); extra(g, spr); g.restore(); }
    return { c: c, ox: (spr.cx / RES) * k / dpr * RES / RES, oy: 0, w: w / dpr, h: h / dpr, ax: (spr.cx * k) / dpr, ay: (spr.cy * k) / dpr };
  }
  function whiteOf(f) {
    var c = mk(f.c.width, f.c.height), g = c.getContext("2d");
    g.drawImage(f.c, 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, c.width, c.height);
    return { c: c, w: f.w, h: f.h, ax: f.ax, ay: f.ay };
  }
  function pupils(look) {
    return function (g, spr) {
      for (var i = 0; i < spr.eyes.length; i++) {
        var ey = spr.eyes[i];
        ell(g, spr.cx + ey.x * PPM + look * ey.r * PPM * 0.3, spr.cy + ey.y * PPM + ey.r * PPM * 0.15, ey.r * PPM * 0.17, ey.r * PPM * 0.58);
        g.fillStyle = "#1A0508";
        g.fill();
      }
    };
  }
  var KINDS = {
    imp: { art: "imp", r: 0.36, hp: 7, spd: 2.5, dmg: 5, xp: 1, mass: 1 },
    sprint: { art: "sprint", r: 0.3, hp: 4, spd: 4.3, dmg: 6, xp: 1, mass: 0.7 },
    spitter: { art: "spitter", r: 0.38, hp: 12, spd: 1.9, dmg: 6, xp: 3, mass: 1, ranged: true },
    brute: { art: "brute", r: 0.62, hp: 55, spd: 1.7, dmg: 14, xp: 5, mass: 4 },
    elite: { art: "elite", r: 0.85, hp: 420, spd: 2.1, dmg: 18, xp: 30, mass: 12, elite: true },
    king: { art: "king", r: 1.7, hp: 5200, spd: 1.9, dmg: 24, xp: 0, mass: 80, boss: true },
  };
  var PET_FACES = ["idle", "blink", "happy", "yell", "aim", "dizzy"];
  var PET_WR = 0.5;
  function fitAll() {
    FIT = { pet: {}, grem: {}, shadow: null };
    PET_FACES.forEach(function (f) { FIT.pet[f] = fitSprite(A.petSprite(f), PET_WR); });
    FIT.petWhite = whiteOf(FIT.pet.idle);
    Object.keys(KINDS).forEach(function (k) {
      var K = KINDS[k], base = A.gremSprite(K.art, "idle");
      var L = fitSprite(base, K.r, pupils(-1)), Rt = fitSprite(base, K.r, pupils(1));
      var o = { L: L, R: Rt, white: whiteOf(L) };
      if (K.boss) {
        var lg = A.gremSprite(K.art, "laugh"), hu = A.gremSprite(K.art, "hurt2");
        o.laugh = fitSprite(lg, K.r);
        o.hurt = fitSprite(hu, K.r, pupils(0));
      }
      FIT.grem[k] = o;
    });
    // soft contact shadow, one sprite for all
    var s = mk(64, 24), g = s.getContext("2d");
    var gr = g.createRadialGradient(32, 12, 0, 32, 12, 32);
    gr.addColorStop(0, "rgba(10,6,30,0.42)"); gr.addColorStop(1, "rgba(10,6,30,0)");
    g.setTransform(1, 0, 0, 0.375, 0, 0); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    FIT.shadow = s;
    bakeFX();
  }

  // glow + gem + projectile sprites
  var FX = {};
  function glow(col, size) {
    var c = mk(size, size), g = c.getContext("2d"), h = size / 2;
    var gr = g.createRadialGradient(h, h, 0, h, h, h);
    gr.addColorStop(0, "rgba(" + col + ",1)"); gr.addColorStop(0.35, "rgba(" + col + ",0.45)"); gr.addColorStop(1, "rgba(" + col + ",0)");
    g.fillStyle = gr; g.fillRect(0, 0, size, size);
    return c;
  }
  function bakeGem(body, light, dark, sizeM) {
    var px = Math.ceil(sizeM * PXM * dpr * 2.2), c = mk(px, px), g = c.getContext("2d"), h = px / 2, r = px * 0.3;
    g.lineJoin = "round";
    // a chubby candy-cut gem: kite with a bright top facet
    A.poly(g, [h, h - r * 1.25, h + r, h - r * 0.2, h, h + r * 1.2, h - r, h - r * 0.2]);
    A.fillStroke(g, body, dark, Math.max(1.5, r * 0.22));
    A.poly(g, [h, h - r * 1.05, h + r * 0.62, h - r * 0.22, h, h + r * 0.1, h - r * 0.62, h - r * 0.22]);
    g.fillStyle = light; g.fill();
    ell(g, h - r * 0.28, h - r * 0.55, r * 0.18, r * 0.1, -0.7); g.fillStyle = "rgba(255,255,255,0.9)"; g.fill();
    return c;
  }
  function bakeSeed() {
    var px = Math.ceil(0.5 * PXM * dpr), c = mk(px, px), g = c.getContext("2d"), h = px / 2, r = px * 0.26;
    g.lineJoin = "round";
    g.beginPath(); g.moveTo(h + r * 1.5, h); g.quadraticCurveTo(h, h - r * 1.2, h - r, h); g.quadraticCurveTo(h, h + r * 1.2, h + r * 1.5, h); g.closePath();
    A.fillStroke(g, "#FFE7A0", "#7A4B12", Math.max(1.2, r * 0.3));
    ell(g, h - r * 0.1, h - r * 0.25, r * 0.4, r * 0.15); g.fillStyle = "#ffffff"; g.fill();
    return c;
  }
  function bakeLeaf(scale) {
    var px = Math.ceil(0.9 * scale * PXM * dpr), c = mk(px, px), g = c.getContext("2d"), h = px / 2, r = px * 0.36;
    g.lineJoin = "round";
    g.beginPath(); g.moveTo(h - r, h); g.quadraticCurveTo(h, h - r * 0.8, h + r, h); g.quadraticCurveTo(h, h + r * 0.8, h - r, h); g.closePath();
    A.fillStroke(g, "#7FD45A", "#245A18", Math.max(1.4, r * 0.14));
    g.beginPath(); g.moveTo(h - r * 0.8, h); g.lineTo(h + r * 0.75, h); g.strokeStyle = "#3E8A2A"; g.lineWidth = Math.max(1, r * 0.08); g.stroke();
    ell(g, h - r * 0.2, h - r * 0.22, r * 0.25, r * 0.08, -0.2); g.fillStyle = "rgba(255,255,255,0.55)"; g.fill();
    return c;
  }
  function bakeBone() {
    var px = Math.ceil(1.0 * PXM * dpr), c = mk(px, px), g = c.getContext("2d"), h = px / 2, r = px * 0.3;
    g.lineJoin = "round"; g.lineCap = "round";
    g.beginPath(); g.moveTo(h - r, h); g.lineTo(h + r, h); g.strokeStyle = "#6B4A2A"; g.lineWidth = r * 0.62; g.stroke();
    g.strokeStyle = "#FFF4DC"; g.lineWidth = r * 0.42; g.stroke();
    [-1, 1].forEach(function (s) {
      [-1, 1].forEach(function (t) { ell(g, h + s * r, h + t * r * 0.22, r * 0.26, r * 0.26); A.fillStroke(g, "#FFF4DC", "#6B4A2A", r * 0.1); });
    });
    g.beginPath(); g.moveTo(h - r * 0.7, h); g.lineTo(h + r * 0.7, h); g.strokeStyle = "#FFF4DC"; g.lineWidth = r * 0.36; g.stroke();
    return c;
  }
  function bakeStar() {
    var px = Math.ceil(1.2 * PXM * dpr), c = mk(px, px), g = c.getContext("2d"), h = px / 2;
    g.lineJoin = "round";
    A.star5(g, h, h, px * 0.4, 0.5); A.fillStroke(g, "#FFE45C", "#8A5A00", px * 0.05);
    A.star5(g, h - px * 0.03, h - px * 0.04, px * 0.22, 0.5); g.fillStyle = "#FFF7C2"; g.fill();
    return c;
  }
  function bakeOrb() {
    // gremlin spit: a spiky magenta hazard with a dark core, never mistakable for a pickup
    var px = Math.ceil(0.6 * PXM * dpr), c = mk(px, px), g = c.getContext("2d"), h = px / 2, r = px * 0.36;
    g.lineJoin = "round";
    g.beginPath();
    for (var i = 0; i <= 16; i++) { var a = (i / 16) * Math.PI * 2, rr = i % 2 ? r * 0.68 : r; if (i) g.lineTo(h + Math.cos(a) * rr, h + Math.sin(a) * rr); else g.moveTo(h + rr, h); }
    g.closePath(); A.fillStroke(g, "#FF3FC8", "#3A0030", Math.max(1.5, px * 0.06));
    ell(g, h, h, r * 0.42, r * 0.42); g.fillStyle = "#2A0024"; g.fill();
    ell(g, h - r * 0.12, h - r * 0.14, r * 0.12, r * 0.12); g.fillStyle = "#FF9AE6"; g.fill();
    return c;
  }
  function bakeChest() {
    var px = Math.ceil(1.6 * PXM * dpr), c = mk(px, px), g = c.getContext("2d"), s = px / 100;
    g.lineJoin = "round";
    rrect(g, 14 * s, 40 * s, 72 * s, 46 * s, 8 * s); A.fillStroke(g, "#B8562A", "#3A1406", 4 * s);
    rrect(g, 10 * s, 24 * s, 80 * s, 26 * s, 10 * s); A.fillStroke(g, "#D9733A", "#3A1406", 4 * s);
    g.fillStyle = "#FFD04A"; g.fillRect(44 * s, 22 * s, 12 * s, 64 * s);
    g.strokeStyle = "#7A4A00"; g.lineWidth = 3 * s; g.strokeRect(44 * s, 22 * s, 12 * s, 64 * s);
    rrect(g, 40 * s, 44 * s, 20 * s, 16 * s, 4 * s); A.fillStroke(g, "#FFE680", "#7A4A00", 3 * s);
    ell(g, 26 * s, 32 * s, 8 * s, 3 * s, -0.2); g.fillStyle = "rgba(255,255,255,0.5)"; g.fill();
    return c;
  }
  function bakeBerry() {
    var px = Math.ceil(0.8 * PXM * dpr), c = mk(px, px), g = c.getContext("2d"), h = px / 2, r = px * 0.28;
    ell(g, h, h + r * 0.1, r, r); A.fillStroke(g, "#FF4D6D", "#6A0A1E", r * 0.18);
    ell(g, h - r * 0.35, h - r * 0.2, r * 0.25, r * 0.15, -0.6); g.fillStyle = "rgba(255,255,255,0.75)"; g.fill();
    ell(g, h + r * 0.2, h - r * 0.95, r * 0.45, r * 0.18, 0.4); A.fillStroke(g, "#6CC24A", "#245A18", r * 0.1);
    return c;
  }
  function bakeFX() {
    FX = {
      gem: [bakeGem("#59C8FF", "#BDEBFF", "#0E3F78", 0.42), bakeGem("#5BE07A", "#C9F7D3", "#0E5A24", 0.5), bakeGem("#FF6FB5", "#FFD0E8", "#6A0A3E", 0.62)],
      seed: bakeSeed(), leaf: bakeLeaf(1), leafBig: bakeLeaf(1.5), bone: bakeBone(), star: bakeStar(), orb: bakeOrb(), chest: bakeChest(), berry: bakeBerry(),
      gWarm: glow("255,210,90", 64), gBlue: glow("110,200,255", 64), gPink: glow("255,90,200", 64), gGreen: glow("130,255,120", 64), gWhite: glow("255,255,255", 64), gRed: glow("255,60,60", 64),
    };
  }
  function blitC(c, x, y, sizePx, rot, alpha) {
    var s = sizePx || c.width / dpr;
    var hgt = s * (c.height / c.width);
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    if (rot) { ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.drawImage(c, -s / 2, -hgt / 2, s, hgt); ctx.restore(); }
    else ctx.drawImage(c, x - s / 2, y - hgt / 2, s, hgt);
    if (alpha !== undefined) ctx.globalAlpha = 1;
  }
  function glowAt(c, x, y, r, a) {
    if (a <= 0.01) return;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, a);
    ctx.drawImage(c, x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------------------------------------------------------------- the ground: a moonlit meadow
  var GROUND = null, GT_M = 9; // tile size in metres
  function bakeGround() {
    var px = Math.round(GT_M * PXM * dpr), c = mk(px, px), g = c.getContext("2d"), r = A.rng(4242), m = PXM * dpr;
    g.fillStyle = "#2C3560"; g.fillRect(0, 0, px, px);
    // big soft patches of lighter and darker turf (tile-safe: wrapped draws)
    function wrap(fn) { for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) fn(ox * px, oy * px); }
    for (var i = 0; i < 9; i++) {
      var x = r() * px, y = r() * px, rr = (1.2 + r() * 2.2) * m, col = r() < 0.5 ? "rgba(70,86,140,0.35)" : "rgba(24,26,64,0.32)";
      wrap(function (ox, oy) { ell(g, x + ox, y + oy, rr * 1.3, rr, r() * 3); g.fillStyle = col; g.fill(); });
    }
    // grass tufts
    for (i = 0; i < 140; i++) {
      var gx = r() * px, gy = r() * px, n = 3 + Math.floor(r() * 3), hh = (0.12 + r() * 0.16) * m, col2 = r() < 0.6 ? "#3E4C82" : "#4C5E98";
      wrap(function (ox, oy) {
        g.strokeStyle = col2; g.lineWidth = Math.max(1, m * 0.035); g.lineCap = "round";
        for (var k = 0; k < n; k++) { g.beginPath(); g.moveTo(gx + ox + k * m * 0.05, gy + oy); g.quadraticCurveTo(gx + ox + k * m * 0.05 + m * 0.03, gy + oy - hh * 0.6, gx + ox + k * m * 0.07 + (k - n / 2) * m * 0.03, gy + oy - hh); g.stroke(); }
      });
    }
    // tiny flowers
    var FL = ["#FF9EC4", "#FFE06B", "#BFE4FF", "#C9A7FF"];
    for (i = 0; i < 26; i++) {
      var fx = r() * px, fy = r() * px, fc = FL[Math.floor(r() * FL.length)], fs = (0.05 + r() * 0.04) * m;
      wrap(function (ox, oy) {
        g.fillStyle = fc; g.globalAlpha = 0.75;
        for (var k = 0; k < 5; k++) { var a = (k / 5) * Math.PI * 2; ell(g, fx + ox + Math.cos(a) * fs, fy + oy + Math.sin(a) * fs, fs * 0.8, fs * 0.8); g.fill(); }
        g.globalAlpha = 1; ell(g, fx + ox, fy + oy, fs * 0.6, fs * 0.6); g.fillStyle = "#FFF3C4"; g.fill();
      });
    }
    // pebbles and glowing mushrooms
    for (i = 0; i < 10; i++) {
      var sx = r() * px, sy = r() * px, sr = (0.1 + r() * 0.14) * m;
      wrap(function (ox, oy) { ell(g, sx + ox, sy + oy, sr * 1.3, sr); A.fillStroke(g, "#5A628C", "#1E2244", Math.max(1, sr * 0.2)); ell(g, sx + ox - sr * 0.3, sy + oy - sr * 0.3, sr * 0.4, sr * 0.2); g.fillStyle = "rgba(255,255,255,0.25)"; g.fill(); });
    }
    for (i = 0; i < 5; i++) {
      var mx = r() * px, my = r() * px, ms = (0.14 + r() * 0.1) * m;
      wrap(function (ox, oy) {
        var gg = g.createRadialGradient(mx + ox, my + oy, 0, mx + ox, my + oy, ms * 4);
        gg.addColorStop(0, "rgba(120,255,220,0.22)"); gg.addColorStop(1, "rgba(120,255,220,0)");
        g.fillStyle = gg; g.fillRect(mx + ox - ms * 4, my + oy - ms * 4, ms * 8, ms * 8);
        g.fillStyle = "#E8F4FF"; g.fillRect(mx + ox - ms * 0.18, my + oy - ms * 0.2, ms * 0.36, ms * 0.7);
        g.beginPath(); g.arc(mx + ox, my + oy - ms * 0.2, ms * 0.6, Math.PI, 0); g.closePath(); A.fillStroke(g, "#5FF0C8", "#0E5A4A", Math.max(1, ms * 0.15));
      });
    }
    GROUND = c;
  }
  var VIG = null;
  function bakeVignette() {
    var c = mk(W * dpr / 2, H * dpr / 2), g = c.getContext("2d"), w = c.width, h = c.height;
    var gr = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.hypot(w, h) * 0.6);
    gr.addColorStop(0, "rgba(8,4,24,0)"); gr.addColorStop(1, "rgba(8,4,24,0.62)");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    VIG = c;
  }

  // ---------------------------------------------------------------- audio (synth, ambient session)
  var Au = (function () {
    var ac = null, master, sfx, music, noiseBuf, muted = false, last = {};
    function init() {
      if (ac) { if (ac.state !== "running") ac.resume(); return; }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { if (navigator.audioSession) navigator.audioSession.type = "ambient"; } catch (e) { /* older Safari */ }
      ac = new AC();
      var comp = ac.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 5;
      master = ac.createGain(); master.gain.value = 0.85; comp.connect(master); master.connect(ac.destination);
      sfx = ac.createGain(); sfx.gain.value = 0.7; sfx.connect(comp);
      music = ac.createGain(); music.gain.value = 0.26; music.connect(comp);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      var d = noiseBuf.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    function gate(name, gap) { var t = ac ? ac.currentTime : 0; if (last[name] && t - last[name] < gap) return false; last[name] = t; return true; }
    function tone(f, dur, type, vol, o) {
      if (!ac || muted) return;
      o = o || {};
      var t = ac.currentTime + (o.at || 0), osc = ac.createOscillator(), gn = ac.createGain();
      osc.type = type; osc.frequency.setValueAtTime(f, t);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + (o.slide || dur));
      gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(vol, t + 0.005); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gn); gn.connect(o.dest || sfx); osc.start(t); osc.stop(t + dur + 0.05);
    }
    function noise(dur, vol, type, f0, f1, o) {
      if (!ac || muted) return;
      o = o || {};
      var t = ac.currentTime + (o.at || 0), src = ac.createBufferSource(), fl = ac.createBiquadFilter(), gn = ac.createGain();
      src.buffer = noiseBuf; fl.type = type; fl.Q.value = o.q || 1; fl.frequency.setValueAtTime(f0, t);
      if (f1) fl.frequency.exponentialRampToValueAtTime(f1, t + dur);
      gn.gain.setValueAtTime(vol, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(fl); fl.connect(gn); gn.connect(o.dest || sfx); src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
    }
    var gemStep = 0, gemT = 0;
    var api = {
      init: init,
      shoot: function () { if (gate("shoot", 0.07)) tone(rand(820, 900), 0.06, "triangle", 0.05, { to: 500 }); },
      hit: function () { if (gate("hit", 0.035)) { noise(0.05, 0.18, "bandpass", 1400, 600, { q: 1.4 }); tone(rand(180, 220), 0.06, "sine", 0.12, { to: 90 }); } },
      pop: function () { if (gate("pop", 0.04)) { tone(rand(500, 640), 0.09, "sine", 0.12, { to: 1300, slide: 0.06 }); noise(0.06, 0.08, "highpass", 3000); } },
      gem: function () {
        if (!ac || !gate("gem", 0.03)) return;
        var t = ac.currentTime; if (t - gemT > 0.6) gemStep = 0; gemT = t;
        var sc = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
        tone(880 * Math.pow(2, sc[Math.min(sc.length - 1, gemStep)] / 12), 0.08, "sine", 0.06); gemStep += 1;
      },
      level: function () { [0, 4, 7, 12, 16].forEach(function (n, i) { tone(523 * Math.pow(2, n / 12), 0.22, "triangle", 0.12, { at: i * 0.06 }); }); },
      pickCard: function () { tone(660, 0.08, "square", 0.05); tone(990, 0.16, "triangle", 0.1, { at: 0.06 }); },
      hurt: function () { if (gate("hurt", 0.15)) { tone(300, 0.18, "sawtooth", 0.08, { to: 120 }); noise(0.12, 0.12, "lowpass", 900); } },
      boom: function (big) { noise(big ? 0.7 : 0.3, big ? 0.5 : 0.25, "lowpass", big ? 1600 : 2400, 80); tone(big ? 90 : 140, big ? 0.6 : 0.25, "sine", big ? 0.5 : 0.25, { to: 35 }); },
      whoosh: function () { noise(0.35, 0.22, "bandpass", 400, 3200, { q: 2 }); },
      warn: function () { [0, 0.5, 1.0].forEach(function (a) { tone(110, 0.4, "sawtooth", 0.09, { at: a, to: 98 }); tone(165, 0.4, "square", 0.04, { at: a }); }); },
      tick: function (i) { tone(1200 + i * 30, 0.03, "square", 0.04); },
      fanfare: function () { [0, 4, 7, 12, 7, 12, 16, 19, 24].forEach(function (n, i) { tone(392 * Math.pow(2, n / 12), 0.3, "triangle", 0.12, { at: i * 0.09 }); }); },
      setMute: function (m) { muted = m; if (master) master.gain.value = m ? 0 : 0.85; },
      get muted() { return muted; },
      musicTick: null,
    };
    // music: 132 BPM loop in D minor, layers added as the night gets worse
    var BPM = 132, ST = 60 / BPM / 4, nextT = 0, step = 0, timer = null, intensity = 0;
    var ROOT = [38, 34, 41, 36], CH = [[62, 65, 69], [58, 62, 65], [65, 69, 72], [60, 64, 67]], _ = null;
    var MEL = [[74, _, 72, _, 69, _, 72, _, 74, _, 77, _, 76, _, 72, _], [70, _, 72, _, 74, _, 77, _, 74, _, 72, _, 70, _, _, _], [77, _, 76, _, 72, _, 76, _, 77, _, 81, _, 79, _, 76, _], [76, _, 74, _, 72, _, 69, _, 72, _, _, _, 67, _, _, _]];
    function play(s, t) {
      var bar = Math.floor(s / 16) % 4, i = s % 16;
      function tn(f, d, ty, v, o) { o = o || {}; o.dest = music; o.at = t - ac.currentTime; tone(f, d, ty, v, o); }
      function nz(d, v, ty, f0, f1) { noise(d, v, ty, f0, f1, { dest: music, at: t - ac.currentTime }); }
      var m2f = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };
      if (i % 2 === 0) tn(m2f(ROOT[bar] + (i % 4 === 2 ? 12 : 0)), ST * 1.7, "triangle", 0.3);
      tn(m2f(CH[bar][i % 3] + 12), ST * 1.2, "sine", 0.05);
      if (i % 2 === 1) nz(0.03, 0.05, "highpass", 7000);
      if (intensity >= 1 && i % 4 === 0) tn(150, 0.14, "sine", 0.8, { to: 40, slide: 0.12 });
      if (intensity >= 1 && (i === 4 || i === 12)) nz(0.12, 0.25, "bandpass", 1800, 900);
      if (intensity >= 2 && MEL[bar][i] !== null) { tn(m2f(MEL[bar][i]), ST * 2.6, "sine", 0.16); tn(m2f(MEL[bar][i]) * 2, ST * 0.6, "triangle", 0.04); }
      if (intensity >= 3 && i % 2 === 0) nz(0.025, 0.06, "highpass", 9000);
    }
    api.music = function (on, lvl) {
      intensity = lvl || 0;
      if (!ac || muted) return;
      if (on && !timer) {
        nextT = ac.currentTime + 0.08;
        timer = setInterval(function () { while (nextT < ac.currentTime + 0.12) { play(step, nextT); step += 1; nextT += ST; } }, 25);
      } else if (!on && timer) { clearInterval(timer); timer = null; }
    };
    return api;
  })();

  // ---------------------------------------------------------------- items: weapons + treats
  // lv tables are indexed 0..4. Evolutions need the weapon at LV 5 plus its treat, and come from chests.
  var ITEMS = {
    seed: { name: "SEED SHOT", kind: "w", max: 5, desc: ["Spits seeds at the nearest gremlin.", "More damage.", "+1 seed.", "Faster spit. Pierces more.", "+1 seed, more damage."], evo: "sunflower", needs: "snack" },
    leaf: { name: "LEAF ORBIT", kind: "w", max: 5, desc: ["Two leaves circle your Chi.", "+1 leaf.", "Wider orbit, more damage.", "+1 leaf.", "+1 leaf, faster spin."], evo: "tornado", needs: "zoomies" },
    boop: { name: "BOOP WAVE", kind: "w", max: 5, desc: ["A shockwave boops everything back.", "Bigger wave.", "More damage.", "Faster boops.", "Huge wave."] },
    star: { name: "STAR DROP", kind: "w", max: 5, desc: ["Stars fall on random gremlins.", "+1 star.", "Bigger blast.", "+1 star.", "+1 star, more damage."] },
    bone: { name: "ZOOMERANG", kind: "w", max: 5, desc: ["A bone that flies out and comes back.", "More damage.", "+1 bone.", "Flies farther.", "+1 bone."] },
    sunflower: { name: "SUNFLOWER", kind: "e", max: 1, desc: ["SEED SHOT evolved. A spinning storm of exploding seeds."] },
    tornado: { name: "LEAF TORNADO", kind: "e", max: 1, desc: ["LEAF ORBIT evolved. A breathing whirlwind of big leaves."] },
    snack: { name: "SNACK POWER", kind: "p", max: 5, desc: ["+12% damage."] },
    zoomies: { name: "ZOOMIES", kind: "p", max: 5, desc: ["+10% move speed."] },
    heart: { name: "BIG HEART", kind: "p", max: 5, desc: ["+25 max health and slow healing."] },
    nose: { name: "SNIFFER", kind: "p", max: 5, desc: ["Pick up gems from farther away."] },
    paws: { name: "QUICK PAWS", kind: "p", max: 5, desc: ["Everything fires 8% faster."] },
    twin: { name: "DOUBLE TREAT", kind: "p", max: 2, desc: ["+1 to every seed, leaf, star and bone."] },
  };
  var SPECIALS = {
    Round: { name: "TURBO ROLL", desc: "Become a cannonball for 3 seconds." },
    Ears: { name: "TRIPLE ECHO", desc: "Three huge sound waves." },
    Horns: { name: "RAM RUSH", desc: "Three charging headbutts." },
    Tail: { name: "TAIL SLAM", desc: "Spin up and crater the ground." },
  };
  var SPECIAL = SPECIALS[SHAPE] || SPECIALS.Round;

  // icons for cards and the HUD
  var ICON = {};
  function icon(id) {
    if (ICON[id]) return ICON[id];
    var s = 96, c = mk(s, s), g = c.getContext("2d"), h = s / 2;
    g.lineJoin = "round"; g.lineCap = "round";
    var tmp;
    if (id === "seed" || id === "sunflower") {
      if (id === "sunflower") {
        for (var i = 0; i < 12; i++) { var a = (i / 12) * Math.PI * 2; ell(g, h + Math.cos(a) * 26, h + Math.sin(a) * 26, 14, 7, a); A.fillStroke(g, "#FFD23A", "#8A5A00", 3); }
        ell(g, h, h, 20, 20); A.fillStroke(g, "#7A4B12", "#3A1F04", 4);
        for (i = 0; i < 9; i++) { ell(g, h - 9 + (i % 3) * 9, h - 9 + Math.floor(i / 3) * 9, 2.5, 2.5); g.fillStyle = "#FFE7A0"; g.fill(); }
      } else {
        [[-14, 10, 0.4], [6, -6, -0.3], [16, 18, 0.9]].forEach(function (p) {
          g.save(); g.translate(h + p[0], h + p[1]); g.rotate(p[2]);
          g.beginPath(); g.moveTo(20, 0); g.quadraticCurveTo(0, -16, -14, 0); g.quadraticCurveTo(0, 16, 20, 0); g.closePath();
          A.fillStroke(g, "#FFE7A0", "#7A4B12", 4); ell(g, 0, -4, 6, 2.5); g.fillStyle = "#fff"; g.fill(); g.restore();
        });
      }
    } else if (id === "leaf" || id === "tornado") {
      var n = id === "tornado" ? 6 : 3;
      if (id === "tornado") { for (i = 0; i < 3; i++) { g.beginPath(); g.ellipse(h, h + 6 - i * 10, 34 - i * 8, 9, 0, 0, Math.PI * 2); g.strokeStyle = "rgba(190,255,190," + (0.5 + i * 0.15) + ")"; g.lineWidth = 4; g.stroke(); } }
      for (i = 0; i < n; i++) {
        var a2 = (i / n) * Math.PI * 2, rr = id === "tornado" ? 30 : 24;
        g.save(); g.translate(h + Math.cos(a2) * rr, h + Math.sin(a2) * rr); g.rotate(a2 + 1.6);
        g.beginPath(); g.moveTo(-16, 0); g.quadraticCurveTo(0, -13, 16, 0); g.quadraticCurveTo(0, 13, -16, 0); g.closePath();
        A.fillStroke(g, "#7FD45A", "#245A18", 3.5); g.restore();
      }
      if (id === "leaf") { ell(g, h, h, 9, 9); A.fillStroke(g, "#BCEE49", "#4A7010", 3); }
    } else if (id === "boop") {
      for (i = 0; i < 3; i++) { g.beginPath(); g.arc(h, h, 12 + i * 12, 0, Math.PI * 2); g.strokeStyle = ["#FFFFFF", "#9FE8FF", "#4FB8FF"][i]; g.lineWidth = 7 - i * 1.5; g.stroke(); }
    } else if (id === "star") {
      A.star5(g, h, h + 4, 36, 0.48); A.fillStroke(g, "#FFE45C", "#8A5A00", 5);
      A.star5(g, h - 3, h, 18, 0.5); g.fillStyle = "#FFF7C2"; g.fill();
      for (i = 0; i < 3; i++) { g.beginPath(); g.moveTo(h + 18 + i * 8, h - 30 + i * 6); g.lineTo(h + 30 + i * 8, h - 42 + i * 6); g.strokeStyle = "#FFF3A0"; g.lineWidth = 4; g.stroke(); }
    } else if (id === "bone") {
      g.save(); g.translate(h, h); g.rotate(-0.7);
      g.beginPath(); g.moveTo(-26, 0); g.lineTo(26, 0); g.strokeStyle = "#6B4A2A"; g.lineWidth = 20; g.stroke(); g.strokeStyle = "#FFF4DC"; g.lineWidth = 13; g.stroke();
      [-1, 1].forEach(function (sx) { [-1, 1].forEach(function (sy) { ell(g, sx * 28, sy * 8, 10, 10); A.fillStroke(g, "#FFF4DC", "#6B4A2A", 3.5); }); });
      g.beginPath(); g.moveTo(-22, 0); g.lineTo(22, 0); g.strokeStyle = "#FFF4DC"; g.lineWidth = 12; g.stroke(); g.restore();
    } else if (id === "snack") {
      ell(g, h, h, 32, 32); A.fillStroke(g, "#D99A4E", "#6A3A10", 5);
      [[-12, -10], [10, -14], [14, 8], [-6, 14], [-16, 4]].forEach(function (p) { ell(g, h + p[0], h + p[1], 5, 5); g.fillStyle = "#4A2408"; g.fill(); });
      ell(g, h - 12, h - 18, 9, 4, -0.5); g.fillStyle = "rgba(255,255,255,0.4)"; g.fill();
    } else if (id === "zoomies") {
      A.poly(g, [h + 6, h - 40, h - 20, h + 6, h - 2, h + 6, h - 8, h + 40, h + 22, h - 8, h + 2, h - 8]); A.fillStroke(g, "#FFE45C", "#8A5A00", 5);
    } else if (id === "heart") {
      g.beginPath(); g.moveTo(h, h + 34); g.bezierCurveTo(h - 44, h + 4, h - 30, h - 34, h, h - 14); g.bezierCurveTo(h + 30, h - 34, h + 44, h + 4, h, h + 34); g.closePath();
      A.fillStroke(g, "#FF4D6D", "#6A0A1E", 5); ell(g, h - 16, h - 12, 8, 5, -0.6); g.fillStyle = "rgba(255,255,255,0.6)"; g.fill();
    } else if (id === "nose") {
      ell(g, h, h + 4, 34, 26); A.fillStroke(g, "#FF8AA6", "#6A1A34", 5);
      ell(g, h - 12, h + 8, 7, 9, 0.3); g.fillStyle = "#6A1A34"; g.fill();
      ell(g, h + 12, h + 8, 7, 9, -0.3); g.fillStyle = "#6A1A34"; g.fill();
      ell(g, h - 10, h - 10, 12, 6, -0.3); g.fillStyle = "rgba(255,255,255,0.6)"; g.fill();
      [-1, 1].forEach(function (sd) { for (var q = 0; q < 2; q++) { g.beginPath(); g.arc(h + sd * 40, h - 22, 8 + q * 7, sd > 0 ? -2.2 : -0.9, sd > 0 ? -0.9 : 0.4 - 1.3); g.strokeStyle = "#FFD0DC"; g.lineWidth = 3.5; g.stroke(); } });
    } else if (id === "magnetOLD") {
      g.beginPath(); g.arc(h, h + 6, 30, Math.PI, 0); g.lineTo(h + 30, h + 20); g.lineTo(h + 14, h + 20); g.lineTo(h + 14, h + 6); g.arc(h, h + 6, 14, 0, Math.PI, true); g.lineTo(h - 14, h + 20); g.lineTo(h - 30, h + 20); g.closePath();
      A.fillStroke(g, "#FF5C6C", "#5A0A14", 5); g.fillStyle = "#DDE6F0"; g.fillRect(h - 30, h + 14, 16, 8); g.fillRect(h + 14, h + 14, 16, 8);
    } else if (id === "paws") {
      ell(g, h, h + 12, 20, 16); A.fillStroke(g, "#FFB3C7", "#7A2A44", 4);
      [[-22, -8], [-8, -22], [8, -22], [22, -8]].forEach(function (p) { ell(g, h + p[0], h + p[1], 8, 9); A.fillStroke(g, "#FFB3C7", "#7A2A44", 3.5); });
    } else if (id === "twin") {
      [[-14, 6], [14, -6]].forEach(function (p) { ell(g, h + p[0], h + p[1], 20, 20); A.fillStroke(g, "#59C8FF", "#0E3F78", 4.5); ell(g, h + p[0] - 6, h + p[1] - 7, 6, 3, -0.6); g.fillStyle = "#fff"; g.fill(); });
    } else if (id === "special") {
      tmp = FIT.pet.happy;
      g.drawImage(tmp.c, 0, 0, tmp.c.width, tmp.c.height, h - 40, h - 46, 80, 80 * tmp.c.height / tmp.c.width);
    }
    ICON[id] = c;
    return c;
  }

  // ---------------------------------------------------------------- game state
  var S = null; // the run
  var mode = "title"; // title | play | levelup | chest | dead | win | pause
  var best = 0;
  try { best = Number(localStorage.getItem("gnight:best:" + BOOT.serial) || 0); } catch (e) { /* storage blocked */ }

  function newRun() {
    S = {
      t: DEBUG.t0, kills: 0, lvl: 1, xp: 0, need: 5, rerolls: 2,
      p: { x: 0, y: 0, vx: 0, vy: 0, hp: 100, maxHp: 100, inv: 0, face: "idle", faceT: 0, blinkT: 2, step: 0, lean: 0, hurtFlash: 0, dead: false },
      st: { might: 1, speed: 4.1, pickup: 1.7, cdm: 1, amount: 0, regen: 0 },
      inv: { seed: 1 }, weapons: ["seed"], passives: [],
      cd: { seed: 0.4, boop: 1, star: 1, bone: 1 },
      E: [], P: [], EB: [], G: [], FXs: [], DN: [], drops: [],
      nextId: 1, spawnAcc: 0, events: {}, boss: null, special: { meter: 0, need: 45, active: 0, kind: SHAPE, t: 0, step: 0, dir: { x: 1, y: 0 } },
      cam: { x: 0, y: 0, shake: 0 }, decals: [], combo: { n: 0, last: -9, pop: 0, best: 0 }, xpShow: 0, xpFlash: 0, fly: [], sc: [], warnT: 0, nextMagnet: 350, hitStop: 0, slow: 1, slowT: 0, banner: null, milestone: 100, dawn: 0, killsAtBoss: 0,
    };
    for (var i = 1; i < DEBUG.lvl; i++) { S.lvl += 1; }
    if (DEBUG.t0 > 0) { S.inv = { seed: 5, leaf: 5, snack: 2, zoomies: 2, star: 3 }; S.weapons = ["seed", "leaf", "star"]; S.passives = ["snack", "zoomies"]; recalc(); }
  }
  function recalc() {
    var I = S.inv;
    S.st.might = 1 + 0.12 * (I.snack || 0);
    S.st.speed = 4.1 * (1 + 0.1 * (I.zoomies || 0));
    var mh = 100 + 25 * (I.heart || 0);
    if (mh > S.p.maxHp) S.p.hp += mh - S.p.maxHp;
    S.p.maxHp = mh;
    S.st.regen = 0.4 * (I.heart || 0);
    S.st.pickup = 1.7 * (1 + 0.35 * (I.nose || 0));
    S.st.cdm = Math.pow(0.92, I.paws || 0);
    S.st.amount = I.twin || 0;
  }

  // ---------------------------------------------------------------- spatial hash for the swarm
  var CELL = 1.4, grid = new Map();
  function gkey(cx, cy) { return (cx & 0xffff) | ((cy & 0xffff) << 16); }
  function rebuildGrid() {
    grid.clear();
    for (var i = 0; i < S.E.length; i++) {
      var e = S.E[i]; if (e.dead) continue;
      var k = gkey(Math.floor(e.x / CELL), Math.floor(e.y / CELL)), b = grid.get(k);
      if (!b) { b = []; grid.set(k, b); }
      b.push(e);
    }
  }
  function query(x, y, r, fn) {
    var x0 = Math.floor((x - r - 1) / CELL), x1 = Math.floor((x + r + 1) / CELL), y0 = Math.floor((y - r - 1) / CELL), y1 = Math.floor((y + r + 1) / CELL);
    for (var cx = x0; cx <= x1; cx++) for (var cy = y0; cy <= y1; cy++) {
      var b = grid.get(gkey(cx, cy)); if (!b) continue;
      for (var i = 0; i < b.length; i++) { var e = b[i]; if (!e.dead && dist2(x, y, e.x, e.y) < (r + e.r) * (r + e.r)) { if (fn(e) === false) return; } }
    }
  }
  function nearest(x, y, maxR, skip) {
    var bestE = null, bd = maxR * maxR;
    for (var i = 0; i < S.E.length; i++) {
      var e = S.E[i]; if (e.dead || (skip && skip.indexOf(e.id) >= 0)) continue;
      var d = dist2(x, y, e.x, e.y); if (d < bd) { bd = d; bestE = e; }
    }
    return bestE;
  }
  function viewHalf() { return { x: W / SIM_PXM / 2, y: H / SIM_PXM / 2 }; }

  // ---------------------------------------------------------------- spawning: the night's script
  var MAX_E = 420;
  function spawn(kind, x, y) {
    if (S.E.length >= MAX_E && !KINDS[kind].boss && !KINDS[kind].elite) return null;
    var K = KINDS[kind], hpScale = 1 + S.t / 150;
    var e = { id: S.nextId++, kind: kind, K: K, x: x, y: y, vx: 0, vy: 0, r: K.r, hp: K.hp * (K.boss || K.elite ? 1 : hpScale), maxHp: 0, flash: 0, kb: 0, dead: false, die: 0, ph: R() * 6.28, hitBy: {}, shootT: rand(1.5, 3), stun: 0, face: 1 };
    e.maxHp = e.hp;
    e.born = K.boss ? 0.6 : 0.32;
    if (Math.abs(x - S.p.x) < W / PXM / 2 + 1 && Math.abs(y - S.p.y) < H / PXM / 2 + 1) burst(x, y + K.r * 0.6, K.boss ? 30 : 5, ["#5A628C", "#7A86B8", "#3E4C82"], K.boss ? 6 : 2.5);
    S.E.push(e);
    return e;
  }
  function edgePoint(margin) {
    var v = viewHalf(), a = rand(0, Math.PI * 2);
    // bias toward where the Chi is heading so you run INTO them
    var sp = Math.hypot(S.p.vx, S.p.vy);
    if (sp > 0.5 && R() < 0.45) a = Math.atan2(S.p.vy, S.p.vx) + rand(-0.9, 0.9);
    var rx = v.x + margin, ry = v.y + margin, c = Math.cos(a), s = Math.sin(a), k = Math.min(rx / Math.abs(c || 1e-6), ry / Math.abs(s || 1e-6));
    return { x: S.p.x + c * k, y: S.p.y + s * k };
  }
  function ring(kind, n, radius) {
    for (var i = 0; i < n; i++) { var a = (i / n) * Math.PI * 2; spawn(kind, S.p.x + Math.cos(a) * radius, S.p.y + Math.sin(a) * radius); }
  }
  function banner(text, sub, col) { S.banner = { text: text, sub: sub || "", t: 0, col: col || "#FFD23A" }; }
  function once(key, at, fn) { if (!S.events[key] && S.t >= at) { S.events[key] = 1; fn(); } }
  function director(dt) {
    var t = S.t;
    // base trickle that ramps all night
    var rate = t < 30 ? 0.8 + t * 0.04 : t < 90 ? 2 + (t - 30) * 0.03 : t < 180 ? 3.8 + (t - 90) * 0.042 : 7.6 + (t - 180) * 0.05;
    if (S.boss && !S.boss.dead) rate *= 0.35;
    S.spawnAcc += rate * dt;
    while (S.spawnAcc >= 1) {
      S.spawnAcc -= 1;
      var p = edgePoint(1.2), roll = R(), kind = "imp";
      if (t > 40 && roll < 0.14) kind = "sprint";
      if (t > 70 && roll > 0.9) kind = "spitter";
      if (t > 110 && roll > 0.8 && roll <= 0.9) kind = "brute";
      if (kind === "sprint") { for (var k = 0; k < 3; k++) spawn("sprint", p.x + rand(-0.8, 0.8), p.y + rand(-0.8, 0.8)); }
      else spawn(kind, p.x, p.y);
    }
    once("w1", 45, function () { banner("SWARM!", "They're closing in"); ring("imp", 28, 9); });
    once("elite", 95, function () { banner("A GOLDEN GREMLIN", "It's carrying something"); var q = edgePoint(1.5); spawn("elite", q.x, q.y); });
    once("w2", 140, function () { banner("STAMPEDE!"); for (var i = 0; i < 6; i++) { var q2 = edgePoint(1); for (var j = 0; j < 5; j++) spawn("sprint", q2.x + rand(-1, 1), q2.y + rand(-1, 1)); } });
    once("w3", 180, function () { banner("BRUTES", "Helmets on"); ring("brute", 10, 10); });
    once("bossWarn", 222, function () { banner("SOMETHING BIG", "is waking up", "#FF5C6C"); Au.warn(); S.warnT = 2.4; });
    once("boss", 228, function () {
      var q = edgePoint(2.5); S.boss = spawn("king", q.x, q.y); S.boss.ai = { state: "walk", t: 2.5, n: 0 };
      banner("GREMLIN KING", "", "#FF5C6C"); Au.warn(); S.cam.shake = Math.max(S.cam.shake, 0.6);
    });
  }

  // ---------------------------------------------------------------- combat helpers
  function damage(e, amt, kx, ky, kb, src) {
    if (e.dead || e.die) return;
    var crit = R() < 0.08, d = amt * S.st.might * (crit ? 2 : 1);
    e.hp -= d; e.flash = 0.09;
    if (kb && !e.K.boss) { var m = kb / e.K.mass; e.vx += kx * m; e.vy += ky * m; e.kb = 0.12; }
    number(e.x + rand(-0.2, 0.2), e.y - e.r, d, crit);
    Au.hit();
    if (e.K.boss) S.hitStop = Math.max(S.hitStop, crit ? 0.035 : 0);
    if (e.hp <= 0) kill(e, src);
  }
  function kill(e) {
    e.die = 0.12; // squash + white, then pop
    S.kills += 1;
    var cb = S.combo;
    if (S.realT - cb.last < 1.3) cb.n += 1; else cb.n = 1;
    cb.last = S.realT; cb.pop = 1; if (cb.n > cb.best) cb.best = cb.n;
    if (cb.n === 50) banner("ON FIRE!", "x50 combo", "#FF9A3D"); else if (cb.n === 150) banner("UNSTOPPABLE!", "x150 combo", "#FF5CA8"); else if (cb.n === 300) banner("GREMLIN GRINDER!", "x300 combo", "#BCEE49");
    if (S.kills >= S.nextMagnet) { S.nextMagnet += 450; S.drops.push({ kind: "magnet", x: e.x, y: e.y, t: 0 }); }
    if (!S.special.active) S.special.meter = Math.min(S.special.need, S.special.meter + (e.K.boss ? 0 : e.K.elite ? 10 : 1));
    var xp = e.K.xp, tier = xp >= 25 ? 2 : xp >= 3 ? 1 : 0;
    if (xp) S.G.push({ x: e.x, y: e.y, v: xp, tier: tier, vx: rand(-1.5, 1.5), vy: rand(-2.5, -1), z: 0, vz: 3.2, pull: false, sp: 0 });
    if (e.kind === "brute" && R() < 0.07) S.drops.push({ kind: "berry", x: e.x, y: e.y, t: 0 });
    else if (e.kind === "brute" && R() < 0.03) S.drops.push({ kind: "magnet", x: e.x, y: e.y, t: 0 });
    if (e.K.elite) { S.drops.push({ kind: "chest", x: e.x, y: e.y, t: 0, src: "elite" }); S.hitStop = 0.12; S.cam.shake = 0.5; }
    if (e.K.boss) {
      S.drops.push({ kind: "chest", x: e.x, y: e.y, t: 0, src: "boss" });
      S.slow = 0.18; S.slowT = 1.4; S.cam.shake = 1; Au.boom(true);
      for (var i = 0; i < 30; i++) S.G.push({ x: e.x, y: e.y, v: 5, tier: 1, vx: rand(-6, 6), vy: rand(-6, 6), z: 0, vz: rand(3, 6), pull: false, sp: 0 });
      burst(e.x, e.y, 60, ["#FFD23A", "#FF5C6C", "#FFFFFF", "#BCEE49"], 9, true);
      banner("KING DOWN!", "Hold on till dawn", "#BCEE49");
      S.events.kingDown = S.t;
    }
    if (S.kills >= S.milestone) { banner(fmt(S.milestone) + " GREMLINS!", "", "#9FE8FF"); S.milestone = S.milestone < 500 ? S.milestone + 200 : S.milestone + 500; S.milestone = Math.round(S.milestone / 100) * 100; }
  }
  function number(x, y, v, crit) {
    // a busy screen stays readable: plain hits only show when nothing else just popped nearby
    if (!crit) { for (var i = S.DN.length - 1; i >= 0 && i >= S.DN.length - 12; i--) { var o = S.DN[i]; if (o.t < 0.18 && dist2(o.x, o.y, x, y) < 1.2) return; } }
    if (S.DN.length > 36) S.DN.shift();
    S.DN.push({ x: x, y: y, v: Math.round(v), crit: crit, t: 0, vx: rand(-0.6, 0.6) });
  }
  function pop(e) {
    var col = A.GT[e.K.art], n = e.r > 0.5 ? 9 : 5;
    for (var i = 0; i < n && S.FXs.length < 700; i++) {
      var a = (i / n) * Math.PI * 2 + rand(-0.3, 0.3), sp = rand(3, 6.5);
      S.FXs.push({ k: "chunk", x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5, t: 0, life: rand(0.28, 0.42), s: rand(0.07, 0.12) * (e.r / 0.36), col: i % 3 ? col.body : col.belly, out: col.out });
    }
    S.FXs.push({ k: "spark", x: e.x, y: e.y, t: 0, life: 0.22, s: e.r * 1.5 });
  }
  function burst(x, y, n, cols, speed, confetti) {
    for (var i = 0; i < n; i++) {
      if (S.FXs.length > 700) break;
      var a = rand(0, Math.PI * 2), sp = rand(0.3, 1) * speed;
      S.FXs.push({ k: confetti && R() < 0.5 ? "conf" : "puff", x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: rand(0.35, 0.8), s: rand(0.08, 0.2), col: pick(cols), rot: rand(0, 6), vr: rand(-12, 12) });
    }
  }
  function decal(x, y, r, life) { if (S.decals.length > 40) S.decals.shift(); S.decals.push({ x: x, y: y, r: r, t: 0, life: life || 6, rot: R() * 3 }); }
  function ringFx(x, y, r0, r1, life, col, lw) { S.FXs.push({ k: "ring", x: x, y: y, r0: r0, r1: r1, t: 0, life: life, col: col, lw: lw || 0.12 }); }
  function hurtPlayer(d) {
    if (S.p.inv > 0 || DEBUG.god || S.special.active && (SHAPE === "Round" || SHAPE === "Horns")) return;
    S.p.hp -= d; S.p.inv = 0.45; S.p.hurtFlash = 0.25; S.p.face = "yell"; S.p.faceT = 0.35;
    S.cam.shake = Math.max(S.cam.shake, 0.32); S.hitStop = 0.05; Au.hurt();
    if (navigator.vibrate) try { navigator.vibrate(12); } catch (e) { /* no haptics */ }
    if (S.p.hp <= 0) { S.p.hp = 0; S.p.dead = true; S.p.face = "dizzy"; S.slow = 0.25; S.slowT = 1.2; setTimeout(function () { endRun(false); }, 1100); }
  }

  // ---------------------------------------------------------------- weapons
  function lv(id) { return S.inv[id] || 0; }
  function fire(dt) {
    var p = S.p, cdm = S.st.cdm, amt = S.st.amount, i, a, e;
    // SEED SHOT / SUNFLOWER
    if (lv("sunflower")) {
      S.cd.seed -= dt;
      if (S.cd.seed <= 0) {
        S.cd.seed = 0.16 * cdm; S.spin = (S.spin || 0) + 0.42;
        for (i = 0; i < 3 + amt; i++) { a = S.spin + (i / (3 + amt)) * Math.PI * 2; shot(p.x, p.y, Math.cos(a) * 9, Math.sin(a) * 9, 20, 3, "sun"); }
        Au.shoot();
      }
    } else if (lv("seed")) {
      S.cd.seed -= dt;
      if (S.cd.seed <= 0) {
        var L = lv("seed") - 1;
        S.cd.seed = [0.62, 0.58, 0.54, 0.46, 0.4][L] * cdm;
        e = nearest(p.x, p.y, 11);
        var base = e ? Math.atan2(e.y - p.y, e.x - p.x) : Math.atan2(S.face.y, S.face.x);
        var n = [1, 1, 2, 2, 3][L] + amt, spread = 0.16;
        for (i = 0; i < n; i++) { a = base + (i - (n - 1) / 2) * spread; shot(p.x, p.y, Math.cos(a) * 11, Math.sin(a) * 11, [10, 13, 14, 16, 19][L], [1, 1, 1, 2, 2][L], "seed"); }
        Au.shoot();
        S.p.face = S.p.face === "idle" ? "aim" : S.p.face; S.p.faceT = Math.max(S.p.faceT, 0.12);
      }
    }
    // BOOP WAVE
    if (lv("boop")) {
      S.cd.boop -= dt;
      if (S.cd.boop <= 0) {
        L = lv("boop") - 1; S.cd.boop = [2.4, 2.2, 2.0, 1.8, 1.6][L] * cdm;
        var rad = [2.4, 2.8, 3.0, 3.3, 3.9][L], dmg = [12, 15, 19, 22, 28][L];
        ringFx(p.x, p.y, 0.3, rad, 0.35, "#9FE8FF", 0.16);
        query(p.x, p.y, rad, function (en) { var dx = en.x - p.x, dy = en.y - p.y, d = Math.hypot(dx, dy) || 1; damage(en, dmg, dx / d, dy / d, 7); });
      }
    }
    // STAR DROP
    if (lv("star")) {
      S.cd.star -= dt;
      if (S.cd.star <= 0) {
        L = lv("star") - 1; S.cd.star = [1.8, 1.7, 1.6, 1.5, 1.3][L] * cdm;
        var cnt = [1, 2, 2, 3, 4][L] + amt, v = viewHalf();
        for (i = 0; i < cnt; i++) {
          var tgt = null, tries = 0;
          while (!tgt && tries < 8) { tries += 1; var c = S.E[Math.floor(R() * S.E.length)]; if (c && !c.dead && Math.abs(c.x - p.x) < v.x && Math.abs(c.y - p.y) < v.y) tgt = c; }
          var tx = tgt ? tgt.x : p.x + rand(-v.x, v.x) * 0.7, ty = tgt ? tgt.y : p.y + rand(-v.y, v.y) * 0.7;
          S.P.push({ k: "star", x: tx, y: ty, t: -i * 0.08, fall: 0.38, r: [1.1, 1.2, 1.4, 1.45, 1.6][L], dmg: [24, 28, 34, 40, 50][L], done: false });
        }
      }
    }
    // ZOOMERANG
    if (lv("bone")) {
      S.cd.bone -= dt;
      if (S.cd.bone <= 0) {
        L = lv("bone") - 1; S.cd.bone = [1.6, 1.5, 1.4, 1.3, 1.2][L] * cdm;
        var bn = [1, 1, 2, 2, 3][L] + amt, ba = Math.atan2(S.face.y, S.face.x);
        for (i = 0; i < bn; i++) {
          a = ba + (i - (bn - 1) / 2) * 0.5;
          S.P.push({ k: "bone", x: p.x, y: p.y, vx: Math.cos(a) * 12, vy: Math.sin(a) * 12, t: 0, out: [0.5, 0.5, 0.5, 0.65, 0.65][L], dmg: [14, 18, 20, 24, 30][L], r: 0.4, hit: {}, rot: 0 });
        }
        Au.whoosh();
      }
    }
  }
  function shot(x, y, vx, vy, dmg, pierce, k) {
    if (S.P.length > 500) return;
    S.P.push({ k: k, x: x, y: y, vx: vx, vy: vy, t: 0, life: 1.2, dmg: dmg, pierce: pierce, r: k === "sun" ? 0.24 : 0.2, hitIds: [] });
  }
  function leaves(dt) {
    var p = S.p, n, rad, dmg, size, spd;
    if (lv("tornado")) {
      n = 8 + S.st.amount * 2; rad = 2.6 + Math.sin(S.t * 1.6) * 1.6; dmg = 22; size = 0.48; spd = 4.2;
    } else if (lv("leaf")) {
      var L = lv("leaf") - 1; n = [2, 3, 3, 4, 5][L] + S.st.amount; rad = [1.7, 1.8, 2.1, 2.1, 2.3][L]; dmg = [8, 10, 13, 14, 16][L]; size = 0.34; spd = [3.2, 3.2, 3.4, 3.4, 4.2][L];
    } else return;
    S.leafA = (S.leafA || 0) + spd * dt;
    S.leafPos = [];
    for (var i = 0; i < n; i++) {
      var a = S.leafA + (i / n) * Math.PI * 2, lx = p.x + Math.cos(a) * rad, ly = p.y + Math.sin(a) * rad;
      S.leafPos.push({ x: lx, y: ly, a: a });
      query(lx, ly, size, function (e) {
        if ((e.hitBy.leaf || 0) > S.t) return;
        e.hitBy.leaf = S.t + 0.45;
        var dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy) || 1;
        damage(e, dmg, dx / d, dy / d, 4);
      });
    }
  }
  function updateProjectiles(dt) {
    var p = S.p;
    for (var i = S.P.length - 1; i >= 0; i--) {
      var b = S.P[i];
      b.t += dt;
      if (b.k === "seed" || b.k === "sun") {
        b.x += b.vx * dt; b.y += b.vy * dt;
        if (b.t > b.life) { S.P.splice(i, 1); continue; }
        var gone = false;
        query(b.x, b.y, b.r, function (e) {
          if (b.hitIds.indexOf(e.id) >= 0) return;
          b.hitIds.push(e.id);
          var sp = Math.hypot(b.vx, b.vy) || 1;
          damage(e, b.dmg, b.vx / sp, b.vy / sp, 2.5);
          if (b.k === "sun") { query(b.x, b.y, 0.9, function (e2) { if (e2 !== e) damage(e2, b.dmg * 0.5, 0, 0, 0); }); ringFx(b.x, b.y, 0.1, 0.9, 0.2, "#FFD23A", 0.1); }
          if (S.FXs.length < 600) S.FXs.push({ k: "spark", x: b.x, y: b.y, t: 0, life: 0.12, s: 0.35 });
          if (b.pierce <= 0) { gone = true; return false; }
          b.pierce -= 1;
        });
        if (gone) S.P.splice(i, 1);
      } else if (b.k === "star") {
        if (b.t >= b.fall && !b.done) {
          b.done = true;
          ringFx(b.x, b.y, 0.2, b.r, 0.3, "#FFE45C", 0.18); decal(b.x, b.y, b.r * 0.5, 3);
          burst(b.x, b.y, 10, ["#FFE45C", "#FFF7C2", "#FFFFFF"], 6);
          query(b.x, b.y, b.r, function (e) { var dx = e.x - b.x, dy = e.y - b.y, d = Math.hypot(dx, dy) || 1; damage(e, b.dmg, dx / d, dy / d, 5); });
          S.cam.shake = Math.max(S.cam.shake, 0.12); Au.pop();
        }
        if (b.t > b.fall + 0.25) S.P.splice(i, 1);
      } else if (b.k === "bone") {
        b.rot += dt * 18;
        if (b.t > b.out) { var dx = p.x - b.x, dy = p.y - b.y, d = Math.hypot(dx, dy) || 1; b.vx += (dx / d) * 40 * dt; b.vy += (dy / d) * 40 * dt; var sp2 = Math.hypot(b.vx, b.vy); if (sp2 > 14) { b.vx *= 14 / sp2; b.vy *= 14 / sp2; } if (d < 0.6 && b.t > b.out + 0.2) { S.P.splice(i, 1); continue; } }
        b.x += b.vx * dt; b.y += b.vy * dt;
        if (b.t > 3.5) { S.P.splice(i, 1); continue; }
        query(b.x, b.y, b.r, function (e) { if ((b.hit[e.id] || 0) > b.t) return; b.hit[e.id] = b.t + 0.3; var s3 = Math.hypot(b.vx, b.vy) || 1; damage(e, b.dmg, b.vx / s3, b.vy / s3, 3); });
      }
    }
    // gremlin spit
    for (i = S.EB.length - 1; i >= 0; i--) {
      var o = S.EB[i]; o.t += dt; o.x += o.vx * dt; o.y += o.vy * dt;
      if (o.t > 4) { S.EB.splice(i, 1); continue; }
      if (dist2(o.x, o.y, p.x, p.y) < (0.2 + PET_WR * 0.8) * (0.2 + PET_WR * 0.8)) { hurtPlayer(o.dmg); S.EB.splice(i, 1); }
    }
  }

  // ---------------------------------------------------------------- the CHI power (shape special)
  function trySpecial() {
    var sp = S.special;
    if (mode !== "play" || sp.active || sp.meter < sp.need || S.p.dead) return;
    sp.meter = 0; sp.need = Math.round(sp.need * 1.25 + 10); sp.t = 0; sp.step = 0;
    var d = Math.hypot(S.p.vx, S.p.vy);
    sp.dir = d > 0.2 ? { x: S.p.vx / d, y: S.p.vy / d } : { x: S.face.x, y: S.face.y };
    sp.active = SHAPE === "Round" ? 3 : SHAPE === "Horns" ? 2.1 : SHAPE === "Tail" ? 1.3 : 1.6;
    S.hitStop = 0.09; S.slow = 0.3; S.slowT = 0.25;
    S.p.face = "yell"; S.p.faceT = 0.6;
    banner(SPECIAL.name, "", "#BCEE49");
    Au.whoosh();
    if (navigator.vibrate) try { navigator.vibrate(25); } catch (e) { /* no haptics */ }
  }
  function updateSpecial(dt) {
    var sp = S.special, p = S.p;
    if (!sp.active) return;
    sp.t += dt; sp.active -= dt;
    if (SHAPE === "Ears") {
      var marks = [0.05, 0.5, 0.95];
      while (sp.step < 3 && sp.t >= marks[sp.step]) {
        var rad = 4 + sp.step * 1.6;
        ringFx(p.x, p.y, 0.4, rad, 0.5, "#BCEE49", 0.3); ringFx(p.x, p.y, 0.2, rad * 0.8, 0.45, "#FFFFFF", 0.12);
        query(p.x, p.y, rad, function (e) { var dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy) || 1; damage(e, 70, dx / d, dy / d, 14); e.stun = 0.6; });
        S.cam.shake = Math.max(S.cam.shake, 0.45); Au.boom(false);
        sp.step += 1;
      }
    } else if (SHAPE === "Tail") {
      if (sp.t > 0.85 && sp.step === 0) {
        sp.step = 1;
        ringFx(p.x, p.y, 0.5, 5, 0.6, "#FFD23A", 0.35); decal(p.x, p.y, 3.4, 9); burst(p.x, p.y, 40, ["#C9A27A", "#8A6A4A", "#FFE7A0"], 8);
        query(p.x, p.y, 5, function (e) { var dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy) || 1; damage(e, 160, dx / d, dy / d, 10); e.stun = 1.2; });
        S.cam.shake = 0.9; S.hitStop = 0.12; Au.boom(true);
      }
    } else if (SHAPE === "Horns") {
      var phase = Math.floor(sp.t / 0.7);
      if (phase > sp.step - 1 && phase < 3 && sp.step <= phase) {
        sp.step = phase + 1;
        if (phase > 0) { ringFx(p.x, p.y, 0.3, 2.6, 0.3, "#FFFFFF", 0.2); query(p.x, p.y, 2.6, function (e) { damage(e, 60, 0, 0, 0); }); Au.boom(false); }
        var d2 = Math.hypot(S.input.x, S.input.y); if (d2 > 0.2) sp.dir = { x: S.input.x / d2, y: S.input.y / d2 };
      }
      var spd = 15;
      p.x += sp.dir.x * spd * dt; p.y += sp.dir.y * spd * dt;
      query(p.x, p.y, 0.9, function (e) { if ((e.hitBy.ram || 0) > S.t) return; e.hitBy.ram = S.t + 0.5; damage(e, 55, sp.dir.x, sp.dir.y, 18); });
      if (R() < 0.6) S.FXs.push({ k: "puff", x: p.x - sp.dir.x * 0.4, y: p.y - sp.dir.y * 0.4, vx: rand(-1, 1), vy: rand(-1, 1), t: 0, life: 0.4, s: 0.18, col: "#E8E0FF" });
    } else {
      // Round: TURBO ROLL
      query(p.x, p.y, 0.95, function (e) { if ((e.hitBy.roll || 0) > S.t) return; e.hitBy.roll = S.t + 0.3; var dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy) || 1; damage(e, 45, dx / d, dy / d, 16); });
      if (R() < 0.7) S.FXs.push({ k: "puff", x: p.x, y: p.y + 0.3, vx: rand(-1, 1), vy: rand(-1, 0), t: 0, life: 0.35, s: 0.16, col: "#E8E0FF" });
    }
    if (sp.active <= 0) { sp.active = 0; }
  }

  // ---------------------------------------------------------------- input: one thumb
  var INP = { id: null, ox: 0, oy: 0, x: 0, y: 0, active: false, lastTap: 0, lastX: 0, lastY: 0, keys: {} };
  var STICK_R = 54;
  function uiHit(x, y) {
    var b = btns(), i;
    for (i = 0; i < b.length; i++) if (b[i].on && Math.hypot(x - b[i].x, y - b[i].y) < b[i].r + 8) return b[i];
    return null;
  }
  function btns() {
    var r = Math.max(22, 22 * U), list = [];
    var ready = S && S.special.meter >= S.special.need && !S.special.active;
    if (WATCH) {
      list.push({ id: "pause", x: W - SA.r - WEDGE - WBTN, y: SA.t + WEDGE + WBTN, r: WBTN, on: mode === "play" });
      list.push({ id: "chi", x: W - SA.r - WEDGE - WBTN, y: H - SA.b - WEDGE - WBTN, r: WBTN, on: mode === "play" && ready });
      return list;
    }
    list.push({ id: "pause", x: W - SA.r - 16 * U - r, y: SA.t + 16 * U + r + 22 * U, r: r, on: mode === "play" });
    var cr = 34 * U;
    list.push({ id: "chi", x: W - SA.r - 20 * U - cr, y: H - SA.b - 24 * U - cr, r: cr, on: mode === "play" && ready });
    return list;
  }
  // The stick's rim: a thumb on a wrist reaches full tilt in about 14 px of travel.
  function stickR() { return WATCH ? 26 : STICK_R * U; }
  window.addEventListener("pointerdown", function (ev) {
    Au.init();
    var x = ev.clientX, y = ev.clientY;
    if (mode !== "play") { uiTap(x, y, ev); return; }
    var b = uiHit(x, y);
    if (b) { if (b.id === "pause") { mode = "pause"; Au.music(false); } else if (b.id === "chi") trySpecial(); return; }
    // double tap anywhere = CHI power
    var now = performance.now();
    if (now - INP.lastTap < 300 && Math.hypot(x - INP.lastX, y - INP.lastY) < 60) trySpecial();
    INP.lastTap = now; INP.lastX = x; INP.lastY = y;
    if (INP.id !== null) return;
    INP.id = ev.pointerId; INP.ox = x; INP.oy = y; INP.x = x; INP.y = y; INP.active = true;
    try { cvs.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
  });
  window.addEventListener("pointermove", function (ev) {
    if (ev.pointerId !== INP.id) return;
    INP.x = ev.clientX; INP.y = ev.clientY;
    // the stick base trails the thumb past its rim, so direction changes never need a long swipe back
    var dx = INP.x - INP.ox, dy = INP.y - INP.oy, d = Math.hypot(dx, dy), R0 = stickR();
    if (d > R0) { INP.ox = INP.x - (dx / d) * R0; INP.oy = INP.y - (dy / d) * R0; }
  });
  function release(ev) { if (ev.pointerId === INP.id) { INP.id = null; INP.active = false; } }
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("keydown", function (e) { INP.keys[e.key.toLowerCase()] = true; if (e.key === " ") trySpecial(); if (e.key === "Escape" && mode === "play") mode = "pause"; Au.init(); });
  window.addEventListener("keyup", function (e) { INP.keys[e.key.toLowerCase()] = false; });
  function readStick() {
    var kx = (INP.keys.d || INP.keys.arrowright ? 1 : 0) - (INP.keys.a || INP.keys.arrowleft ? 1 : 0);
    var ky = (INP.keys.s || INP.keys.arrowdown ? 1 : 0) - (INP.keys.w || INP.keys.arrowup ? 1 : 0);
    if (kx || ky) { var kd = Math.hypot(kx, ky); return { x: kx / kd, y: ky / kd }; }
    if (!INP.active) return { x: 0, y: 0 };
    var dx = INP.x - INP.ox, dy = INP.y - INP.oy, d = Math.hypot(dx, dy), dead = WATCH ? 4 : 6 * U, R0 = stickR();
    if (d < dead) return { x: 0, y: 0 };
    var m = clamp((d - dead) / (R0 * 0.55), 0.35, 1);
    return { x: (dx / d) * m, y: (dy / d) * m };
  }
  document.addEventListener("visibilitychange", function () { if (document.hidden && mode === "play") { mode = "pause"; Au.music(false); } });

  // ---------------------------------------------------------------- level up + chests
  var CARDS = null; // { list, t, armedAt, picked, pickT }
  function gainXp(v) {
    S.xp += v;
    while (S.xp >= S.need) { S.xp -= S.need; S.lvl += 1; S.need = Math.round(4 + S.lvl * 2 + Math.pow(S.lvl, 1.25)); S.pendingLv = (S.pendingLv || 0) + 1; }
  }
  function offerable() {
    var out = [];
    Object.keys(ITEMS).forEach(function (id) {
      var it = ITEMS[id]; if (it.kind === "e") return;
      var cur = lv(id);
      if (id === "seed" && lv("sunflower")) return;
      if (id === "leaf" && lv("tornado")) return;
      if (cur >= it.max) return;
      if (!cur && it.kind === "w" && S.weapons.length >= 4) return;
      if (!cur && it.kind === "p" && S.passives.length >= 4) return;
      out.push(id);
    });
    return out;
  }
  function rollCards(n) {
    var pool = offerable(), list = [];
    // owned items are twice as likely, so builds come together
    var weighted = [];
    pool.forEach(function (id) { weighted.push(id); if (lv(id)) weighted.push(id); });
    while (list.length < n && weighted.length) { var id = pick(weighted); list.push(id); weighted = weighted.filter(function (x) { return x !== id; }); }
    if (!list.length) list.push("heal");
    return list;
  }
  function openLevelUp() {
    mode = "levelup";
    CARDS = { list: rollCards(R() < 0.12 ? 4 : 3), t: 0, armedAt: 0.45, picked: -1, pickT: 0 };
    INP.id = null; INP.active = false; // the thumb that was steering must lift and tap again
    S.banner = null;
  }
  function flyTo(id, x, y, s) { if (WATCH) return; if (ITEMS[id]) S.fly.push({ id: id, x: x, y: y, s: s, t: 0 }); }
  function grant(id) {
    if (id === "heal") { S.p.hp = Math.min(S.p.maxHp, S.p.hp + 40); return; }
    var it = ITEMS[id];
    if (it.kind === "e") {
      var from = id === "sunflower" ? "seed" : "leaf";
      delete S.inv[from]; S.weapons[S.weapons.indexOf(from)] = id; S.inv[id] = 1;
    } else {
      if (!lv(id)) { if (it.kind === "w") S.weapons.push(id); else S.passives.push(id); }
      S.inv[id] = lv(id) + 1;
    }
    recalc();
  }
  function evoReady() {
    var out = [];
    if (lv("seed") >= 5 && lv("snack")) out.push("sunflower");
    if (lv("leaf") >= 5 && lv("zoomies")) out.push("tornado");
    return out;
  }
  var CHEST = null;
  function openChest(src) {
    mode = "chest";
    var evo = evoReady(), prize;
    if (evo.length) prize = [evo[0]];
    else { prize = rollCards(src === "boss" ? 3 : 1); }
    CHEST = { t: 0, src: src, prize: prize, evo: !!evo.length, done: false, ticks: 0 };
    INP.id = null; INP.active = false;
    Au.music(false);
  }

  // ---------------------------------------------------------------- the step
  var face = { x: 1, y: 0 };
  function step(dt) {
    var p = S.p;
    S.face = face;
    S.input = readStick();
    if (S.slowT > 0) { S.slowT -= dt; if (S.slowT <= 0) S.slow = 1; }
    var sdt = dt * (S.slowT > 0 ? S.slow : 1);
    if (S.hitStop > 0) { S.hitStop -= dt; sdt = 0; }
    S.realT = (S.realT || 0) + dt;
    if (!p.dead) S.t += sdt;
    if (S.banner) S.banner.t += dt;
    S.cam.shake = Math.max(0, S.cam.shake - dt * 2.2);
    if (sdt <= 0) return;

    // move the Chi
    if (!p.dead) {
      var inp = S.input, spd = S.st.speed * (S.special.active && SHAPE === "Round" ? 2.4 : 1);
      if (!(S.special.active && SHAPE === "Horns") && !(S.special.active && SHAPE === "Tail")) {
        var tvx = inp.x * spd, tvy = inp.y * spd, k = 1 - Math.exp(-sdt * 18);
        p.vx += (tvx - p.vx) * k; p.vy += (tvy - p.vy) * k;
        p.x += p.vx * sdt; p.y += p.vy * sdt;
      } else { p.vx *= 0.8; p.vy *= 0.8; }
      var mv = Math.hypot(p.vx, p.vy);
      if (mv > 0.3) { face.x = p.vx / mv; face.y = p.vy / mv; }
      p.step += sdt * (4 + mv * 2.4) * (mv > 0.3 ? 1 : 0.35);
      p.lean = lerp(p.lean, clamp(p.vx / S.st.speed, -1, 1) * 0.14, 1 - Math.exp(-sdt * 10));
      p.inv = Math.max(0, p.inv - sdt); p.hurtFlash = Math.max(0, p.hurtFlash - sdt);
      p.hp = Math.min(p.maxHp, p.hp + S.st.regen * sdt);
      p.faceT -= sdt;
      if (p.faceT <= 0) { p.face = "idle"; p.blinkT -= sdt; if (p.blinkT <= 0) { p.face = "blink"; p.faceT = 0.12; p.blinkT = rand(2, 4.5); } }
    }

    director(sdt);
    rebuildGrid();
    if (!p.dead) { fire(sdt); leaves(sdt); updateSpecial(sdt); }
    updateProjectiles(sdt);

    // the swarm
    var boss = S.boss;
    for (var i = S.E.length - 1; i >= 0; i--) {
      var e = S.E[i];
      if (e.die) { e.die -= sdt; if (e.die <= 0) { e.dead = true; pop(e); Au.pop(); S.E.splice(i, 1); } continue; }
      if (e.born > 0) { e.born -= sdt; if (e.born > 0.12) continue; }
      e.flash = Math.max(0, e.flash - sdt); e.kb = Math.max(0, e.kb - sdt); e.stun = Math.max(0, e.stun - sdt);
      var dx = p.x - e.x, dy = p.y - e.y, d = Math.hypot(dx, dy) || 1;
      if (e === boss) { bossAI(e, sdt, dx, dy, d); }
      else if (e.stun <= 0) {
        var want = e.K.spd * (1 + S.t / 600);
        if (e.K.ranged) {
          if (d < 6) want = -0.6;
          e.shootT -= sdt;
          if (e.shootT <= 0 && d < 9) { e.shootT = rand(2.4, 3.2); S.EB.push({ x: e.x, y: e.y, vx: (dx / d) * 4.2, vy: (dy / d) * 4.2, t: 0, dmg: 9 }); }
        }
        if (e.kb <= 0) { var k2 = 1 - Math.exp(-sdt * 6); e.vx += ((dx / d) * want - e.vx) * k2; e.vy += ((dy / d) * want - e.vy) * k2; }
      }
      e.vx *= e.kb > 0 ? 0.9 : 1; e.vy *= e.kb > 0 ? 0.9 : 1;
      e.x += e.vx * sdt; e.y += e.vy * sdt;
      e.face = dx < 0 ? -1 : 1;
      // keep the swarm from stacking into one blob
      if (!e.K.boss) {
        var ex = e;
        query(e.x, e.y, e.r * 0.9, function (o) {
          if (o === ex || o.K.boss) return;
          var ox = ex.x - o.x, oy = ex.y - o.y, od = Math.hypot(ox, oy) || 0.01, push = (ex.r + o.r - od) * 0.5;
          if (push > 0) { var wr = o.K.mass / (o.K.mass + ex.K.mass); ex.x += (ox / od) * push * wr; ex.y += (oy / od) * push * wr; }
        });
      }
      // contact
      if (!p.dead && d < e.r + PET_WR * 0.8) hurtPlayer(e.K.dmg);
      // far behind: recycle to the front so the pressure stays on
      if (!e.K.boss && !e.K.elite && d > 26) { var q = edgePoint(1); e.x = q.x; e.y = q.y; }
    }

    // gems
    var pr = S.st.pickup;
    for (i = S.G.length - 1; i >= 0; i--) {
      var g = S.G[i];
      if (g.vz || g.z > 0) { g.z += g.vz * sdt; g.vz -= 14 * sdt; g.x += g.vx * sdt; g.y += g.vy * sdt; if (g.z <= 0) { g.z = 0; g.vz = 0; g.vx = 0; g.vy = 0; } }
      var gd = Math.hypot(p.x - g.x, p.y - g.y);
      if (!g.pull && (gd < pr || S.vacuum)) g.pull = true;
      if (g.pull && !p.dead) {
        // a little hop away first, then the vacuum: the VS gem feel
        g.sp = Math.min(22, g.sp + sdt * 40);
        var pull = g.sp - 2.5;
        g.x += ((p.x - g.x) / (gd || 1)) * pull * sdt; g.y += ((p.y - g.y) / (gd || 1)) * pull * sdt;
        if (gd < 0.45) { gainXp(g.v); Au.gem(); S.G.splice(i, 1); }
      }
    }
    if (S.vacuum) { S.vacuum -= sdt; if (S.vacuum <= 0) S.vacuum = 0; }
    if (S.G.length > 400) { var merged = S.G.splice(0, 100); var tot = 0; merged.forEach(function (m) { tot += m.v; }); S.G.push({ x: merged[0].x, y: merged[0].y, v: tot, tier: 2, vx: 0, vy: 0, z: 0, vz: 0, pull: false, sp: 0 }); }

    // drops
    for (i = S.drops.length - 1; i >= 0; i--) {
      var dr = S.drops[i]; dr.t += sdt;
      if (Math.hypot(p.x - dr.x, p.y - dr.y) < 0.9 && dr.t > 0.4 && !p.dead) {
        S.drops.splice(i, 1);
        if (dr.kind === "berry") { p.hp = Math.min(p.maxHp, p.hp + 30); number(p.x, p.y - 0.8, 30, false); Au.level(); }
        else if (dr.kind === "chest") openChest(dr.src);
        else if (dr.kind === "magnet") { S.vacuum = 2.5; banner("SNIIIFF!", "Every gem is yours", "#FF8AA6"); ringFx(p.x, p.y, 0.3, 14, 0.8, "#FF8AA6", 0.2); Au.whoosh(); S.G.forEach(function (g) { g.sp = 6; }); }
      }
    }

    // fx
    for (i = S.FXs.length - 1; i >= 0; i--) {
      var f = S.FXs[i]; f.t += sdt;
      if (f.t >= f.life) { S.FXs.splice(i, 1); continue; }
      if (f.k !== "ring" && f.k !== "spark") { f.x += f.vx * sdt; f.y += f.vy * sdt; if (f.k === "chunk") f.vy += 14 * sdt; else { f.vx *= 0.92; f.vy *= 0.92; } if (f.k === "conf") { f.vy += 6 * sdt; f.rot += f.vr * sdt; } }
    }
    for (i = S.DN.length - 1; i >= 0; i--) { var n = S.DN[i]; n.t += dt; if (n.t > 0.7) S.DN.splice(i, 1); }
    for (i = S.decals.length - 1; i >= 0; i--) { S.decals[i].t += sdt; if (S.decals[i].t > S.decals[i].life) S.decals.splice(i, 1); }
    S.combo.pop = Math.max(0, S.combo.pop - dt * 5); S.xpFlash = Math.max(0, S.xpFlash - dt); S.warnT = Math.max(0, S.warnT - dt);

    // dawn
    if (S.events.kingDown && S.t > Math.max(300, S.events.kingDown + 20)) { endRun(true); return; }
    if (S.lvlFx > 0) { S.lvlFx -= dt; if (S.lvlFx <= 0 && mode === "play") openLevelUp(); }
    else if (S.pendingLv && !p.dead && mode === "play" && !S.special.active) {
      // the beat before the cards: a flash of light off the Chi and a breath of slow motion
      S.pendingLv -= 1; S.lvlFx = 0.32; S.slow = 0.2; S.slowT = 0.32; S.xpFlash = 0.5;
      ringFx(p.x, p.y, 0.3, 3.2, 0.45, "#59C8FF", 0.22); ringFx(p.x, p.y, 0.2, 2.2, 0.35, "#FFFFFF", 0.12);
      burst(p.x, p.y, 22, ["#59C8FF", "#BDEBFF", "#FFFFFF", "#FFE45C"], 7, true);
      p.face = "happy"; p.faceT = 0.8; Au.level();
    }
    Au.music(true, S.t > 200 ? 3 : S.t > 100 ? 2 : S.t > 20 ? 1 : 0);
  }
  function bossAI(e, dt, dx, dy, d) {
    var ai = e.ai; ai.t -= dt;
    if (ai.state === "walk") {
      var k = 1 - Math.exp(-dt * 3); e.vx += ((dx / d) * e.K.spd - e.vx) * k; e.vy += ((dy / d) * e.K.spd - e.vy) * k;
      if (ai.t <= 0) {
        ai.n += 1;
        var r = ai.n % 3;
        if (r === 1) { ai.state = "slamWind"; ai.t = 1.0; ai.tx = S.p.x; ai.ty = S.p.y; }
        else if (r === 2) { ai.state = "chargeWind"; ai.t = 0.85; ai.dx = dx / d; ai.dy = dy / d; }
        else { ai.state = "summon"; ai.t = 1.2; }
        e.vx = 0; e.vy = 0;
      }
    } else if (ai.state === "slamWind") {
      // hop to the marked spot
      e.vx = 0; e.vy = 0;
      if (ai.t <= 0) {
        e.x = lerp(e.x, ai.tx, 0.85); e.y = lerp(e.y, ai.ty, 0.85);
        ringFx(e.x, e.y, 0.5, 3.4, 0.45, "#FF5C6C", 0.35); decal(e.x, e.y, 2.6, 9); burst(e.x, e.y, 30, ["#8A6A4A", "#C9A27A", "#FF5C6C"], 7);
        if (Math.hypot(S.p.x - e.x, S.p.y - e.y) < 3.4) hurtPlayer(26);
        S.cam.shake = 0.8; Au.boom(true);
        ai.state = "walk"; ai.t = 2.2;
      }
    } else if (ai.state === "chargeWind") {
      e.vx = 0; e.vy = 0;
      if (ai.t <= 0) { ai.state = "charge"; ai.t = 0.9; Au.whoosh(); }
    } else if (ai.state === "charge") {
      e.vx = ai.dx * 13; e.vy = ai.dy * 13;
      if (R() < 0.8) S.FXs.push({ k: "puff", x: e.x, y: e.y + 1, vx: rand(-1, 1), vy: rand(-1, 0), t: 0, life: 0.5, s: 0.3, col: "#C9A27A" });
      if (ai.t <= 0) { ai.state = "walk"; ai.t = 2; e.vx = 0; e.vy = 0; }
    } else if (ai.state === "summon") {
      e.vx = 0; e.vy = 0;
      if (ai.t <= 0) { ring("imp", 18, 7.5); ai.state = "walk"; ai.t = 2.4; }
    }
  }
  function endRun(win) {
    if (mode === "dead" || mode === "win") return;
    mode = win ? "win" : "dead";
    S.endT = 0;
    Au.music(false);
    if (win) Au.fanfare();
    var score = Math.round(S.t);
    S.newBest = score > best && best > 0;
    if (score > best) { best = score; try { localStorage.setItem("gnight:best:" + BOOT.serial, String(best)); } catch (e) { /* storage blocked */ } }
  }

  // ---------------------------------------------------------------- drawing
  function W2S(x, y) { return { x: (x - S.cam.x) * PXM + W / 2, y: (y - S.cam.y) * PXM + H / 2 }; }
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    WB.length = 0;
    if (!S) { drawTitle(); return; }
    var p = S.p, cam = S.cam;
    // camera: a touch of lead toward where you're heading
    var ck = 1 - Math.exp(-FDT * 11); cam.x = lerp(cam.x, p.x + p.vx * 0.12, ck); cam.y = lerp(cam.y, p.y + p.vy * 0.12, ck);
    var sh = Math.min(1, cam.shake), amp, amp = SHAKE_ON ? sh * sh * 9 * U : 0, sx = Math.sin(S.realT * 61) * amp, sy = Math.cos(S.realT * 53) * amp;
    ctx.save(); ctx.translate(sx, sy);
    drawGround();
    // scorch marks and craters linger, then fade: the night remembers the fight
    for (i = 0; i < S.decals.length; i++) {
      var dc = S.decals[i], ds = W2S(dc.x, dc.y), da = Math.min(1, (dc.life - dc.t) / 1.5) * 0.26;
      ell(ctx, ds.x, ds.y, dc.r * PXM, dc.r * PXM * 0.62, 0); ctx.fillStyle = "rgba(12,8,30," + da + ")"; ctx.fill();
      ell(ctx, ds.x, ds.y, dc.r * PXM * 0.62, dc.r * PXM * 0.38, 0); ctx.fillStyle = "rgba(255,170,90," + da * 0.25 * Math.max(0, 1 - dc.t / 2) + ")"; ctx.fill();
    }
    // the Chi's ground ring, so it never gets lost in the crowd
    var gs0 = W2S(p.x, p.y), grr = PET_WR * PXM * 1.25;
    ell(ctx, gs0.x, gs0.y + PET_WR * PXM * 0.8, grr, grr * 0.42, 0); ctx.strokeStyle = "rgba(188,238,73,0.55)"; ctx.lineWidth = 2.5 * U; ctx.stroke();
    ctx.beginPath(); ctx.arc(gs0.x + face.x * grr, gs0.y + PET_WR * PXM * 0.8 + face.y * grr * 0.42, 3.5 * U, 0, Math.PI * 2); ctx.fillStyle = "rgba(188,238,73,0.9)"; ctx.fill();
    var i, s, e;
    // telegraphs under everything
    if (S.boss && !S.boss.dead && S.boss.ai) {
      var ai = S.boss.ai;
      if (ai.state === "slamWind") { s = W2S(ai.tx, ai.ty); var k = 1 - ai.t / 1.0; ctx.beginPath(); ctx.arc(s.x, s.y, 3.4 * PXM, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,60,80,0.16)"; ctx.fill(); ctx.strokeStyle = "rgba(255,90,110,0.85)"; ctx.lineWidth = 3 * U; ctx.stroke(); ctx.beginPath(); ctx.arc(s.x, s.y, 3.4 * PXM * k, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,60,80,0.22)"; ctx.fill(); }
      if (ai.state === "chargeWind") { s = W2S(S.boss.x, S.boss.y); ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(Math.atan2(ai.dy, ai.dx)); ctx.fillStyle = "rgba(255,60,80," + (0.18 + 0.15 * Math.sin(S.realT * 30)) + ")"; ctx.fillRect(0, -1.5 * PXM, 12 * PXM, 3 * PXM); ctx.restore(); }
    }
    // star shadows
    for (i = 0; i < S.P.length; i++) { var b = S.P[i]; if (b.k === "star" && !b.done && b.t > -0.01) { s = W2S(b.x, b.y); var kk = clamp(b.t / b.fall, 0, 1); ell(ctx, s.x, s.y, b.r * PXM * (0.4 + 0.6 * kk), b.r * PXM * 0.45 * (0.4 + 0.6 * kk)); ctx.fillStyle = "rgba(255,230,90," + (0.12 + kk * 0.2) + ")"; ctx.fill(); } }
    // gems
    for (i = 0; i < S.G.length; i++) {
      var g = S.G[i]; s = W2S(g.x, g.y);
      if (s.x < -20 || s.y < -20 || s.x > W + 20 || s.y > H + 20) continue;
      var gs = [0.42, 0.5, 0.62][g.tier] * PXM * 1.1;
      if (g.tier > 0) glowAt(g.tier === 2 ? FX.gPink : FX.gGreen, s.x, s.y, gs * 0.9, 0.35);
      blitC(FX.gem[g.tier], s.x, s.y - g.z * PXM * 0.4 + Math.sin(S.realT * 5 + g.x) * 1.5, gs * 2.2 / 2.2 * 2.2 / 2);
    }
    // drops
    for (i = 0; i < S.drops.length; i++) {
      var dr = S.drops[i]; s = W2S(dr.x, dr.y);
      if (dr.kind === "chest") { glowAt(FX.gWarm, s.x, s.y, 1.6 * PXM, 0.45 + 0.2 * Math.sin(S.realT * 6)); blitC(FX.chest, s.x, s.y - Math.abs(Math.sin(S.realT * 4)) * 6, 1.4 * PXM); }
      else if (dr.kind === "magnet") { glowAt(FX.gPink, s.x, s.y, 1.2 * PXM, 0.45 + 0.2 * Math.sin(S.realT * 7)); var ni = icon("nose"), nb = Math.abs(Math.sin(S.realT * 5)) * 5; ctx.drawImage(ni, s.x - 0.55 * PXM, s.y - 0.55 * PXM - nb, 1.1 * PXM, 1.1 * PXM); }
      else blitC(FX.berry, s.x, s.y - Math.abs(Math.sin(S.realT * 5)) * 4, 0.7 * PXM);
    }
    // shadows then bodies, back to front
    var list = S.E.slice();
    list.push(p);
    list.sort(function (a, b2) { return a.y - b2.y; });
    for (i = 0; i < list.length; i++) {
      e = list[i]; s = W2S(e.x, e.y);
      var rr = e === p ? PET_WR : e.r;
      if (s.x < -rr * PXM * 3 || s.x > W + rr * PXM * 3 || s.y < -rr * PXM * 3 || s.y > H + rr * PXM * 3) continue;
      ctx.drawImage(FIT.shadow, s.x - rr * PXM * 1.05, s.y + rr * PXM * 0.62, rr * PXM * 2.1, rr * PXM * 0.8);
    }
    for (i = 0; i < list.length; i++) {
      e = list[i];
      if (e === p) { drawPet(); continue; }
      s = W2S(e.x, e.y);
      if (s.x < -e.r * PXM * 3 || s.x > W + e.r * PXM * 3 || s.y < -e.r * PXM * 3 || s.y > H + e.r * PXM * 3) continue;
      var F = FIT.grem[e.kind], spr = e.face < 0 ? F.L : F.R;
      if (e.K.boss) { var st = e.ai.state; spr = st === "summon" ? F.laugh : e.hp < e.maxHp * 0.35 ? F.hurt : spr; }
      var wob = Math.sin(S.realT * (e.kind === "sprint" ? 16 : 9) + e.ph), sqx = 1 + wob * 0.05, sqy = 1 - wob * 0.05, hop = Math.abs(wob) * e.r * PXM * 0.12;
      if (e.born > 0) { var bk = backOut2(1 - e.born / (e.K.boss ? 0.6 : 0.32), 2.2); sqx *= Math.max(0.01, bk * 0.9); sqy *= Math.max(0.01, bk * 1.1); hop = 0; }
      if (e.die) { var dk = 1 - e.die / 0.12; sqx = 1 + dk * 0.45; sqy = 1 - dk * 0.5; hop = 0; }
      if (e.K.boss && e.ai.state === "slamWind") { var up = Math.sin(clamp(1 - e.ai.t, 0, 1) * Math.PI); hop = up * 2.2 * PXM; sqy = 1 + up * 0.15; sqx = 1 - up * 0.1; }
      if (e.K.boss && e.ai.state === "chargeWind") { sqx = 1.12; sqy = 0.88; }
      ctx.save();
      ctx.translate(s.x, s.y + e.r * PXM * 0.9 - hop);
      ctx.scale(sqx, sqy);
      ctx.drawImage(spr.c, -spr.ax, -spr.ay - e.r * PXM * 0.9, spr.w, spr.h);
      if (e.flash > 0 || e.die) { ctx.globalAlpha = e.die ? 0.75 : 0.7; ctx.drawImage(F.white.c, -spr.ax, -spr.ay - e.r * PXM * 0.9, spr.w, spr.h); ctx.globalAlpha = 1; }
      ctx.restore();
      if (e.K.elite) glowAt(FX.gWarm, s.x, s.y, e.r * PXM * 2.2, 0.25 + 0.1 * Math.sin(S.realT * 5));
      if (e.stun > 0) { ctx.fillStyle = "#FFE45C"; for (var z = 0; z < 3; z++) { var za = S.realT * 6 + z * 2.1; A.star5(ctx, s.x + Math.cos(za) * e.r * PXM * 0.8, s.y - e.r * PXM * 1.4 + Math.sin(za) * 4, 4 * U, 0.5); ctx.fill(); } }
    }
    // leaves
    if (S.leafPos) for (i = 0; i < S.leafPos.length; i++) { var lp = S.leafPos[i]; s = W2S(lp.x, lp.y); var big = !!lv("tornado"); if (big) glowAt(FX.gGreen, s.x, s.y, 0.7 * PXM, 0.2); blitC(big ? FX.leafBig : FX.leaf, s.x, s.y, (big ? 1.35 : 0.9) * PXM, lp.a + 1.57); }
    // projectiles
    for (i = 0; i < S.P.length; i++) {
      b = S.P[i]; s = W2S(b.x, b.y);
      if (b.k === "seed" || b.k === "sun") { glowAt(FX.gWarm, s.x, s.y, (b.k === "sun" ? 0.55 : 0.4) * PXM, 0.4); blitC(FX.seed, s.x, s.y, (b.k === "sun" ? 0.62 : 0.5) * PXM, Math.atan2(b.vy, b.vx)); }
      else if (b.k === "bone") { blitC(FX.bone, s.x, s.y, 0.95 * PXM, b.rot); }
      else if (b.k === "star" && !b.done && b.t > 0) { var fk = clamp(b.t / b.fall, 0, 1), fy = s.y - (1 - fk) * 9 * PXM; glowAt(FX.gWarm, s.x, fy, 0.9 * PXM, 0.5); blitC(FX.star, s.x, fy, 1.1 * PXM, S.realT * 8); }
    }
    // particles
    for (i = 0; i < S.FXs.length; i++) {
      var f = S.FXs[i], kf = f.t / f.life; s = W2S(f.x, f.y);
      if (f.k === "ring") { ctx.beginPath(); ctx.arc(s.x, s.y, lerp(f.r0, f.r1, 1 - Math.pow(1 - kf, 3)) * PXM, 0, Math.PI * 2); ctx.strokeStyle = f.col; ctx.globalAlpha = 1 - kf; ctx.lineWidth = f.lw * PXM * (1 - kf * 0.6); ctx.stroke(); ctx.globalAlpha = 1; }
      else if (f.k === "chunk") { var cr = f.s * PXM * (1 - kf * 0.6); ell(ctx, s.x, s.y, cr, cr); ctx.fillStyle = f.col; ctx.fill(); ctx.strokeStyle = f.out; ctx.lineWidth = Math.max(1, cr * 0.35); ctx.stroke(); }
      else if (f.k === "spark") { var sr = f.s * PXM * (0.4 + kf * 0.9); ctx.globalAlpha = 1 - kf; A.star5(ctx, s.x, s.y, sr, 0.28); ctx.fillStyle = "#FFFFFF"; ctx.fill(); ctx.globalAlpha = 1; }
      else if (f.k === "conf") { ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(f.rot); ctx.fillStyle = f.col; ctx.globalAlpha = 1 - kf; ctx.fillRect(-f.s * PXM * 0.6, -f.s * PXM * 0.3, f.s * PXM * 1.2, f.s * PXM * 0.6); ctx.restore(); ctx.globalAlpha = 1; }
      else { ell(ctx, s.x, s.y, f.s * PXM * (1 + kf), f.s * PXM * (1 + kf)); ctx.fillStyle = f.col; ctx.globalAlpha = (1 - kf) * 0.6; ctx.fill(); ctx.globalAlpha = 1; }
    }
    // enemy spit always reads on top of our own effects
    for (i = 0; i < S.EB.length; i++) { var o = S.EB[i]; s = W2S(o.x, o.y); glowAt(FX.gPink, s.x, s.y, 0.6 * PXM, 0.6); blitC(FX.orb, s.x, s.y, 0.5 * PXM, S.realT * 6); }
    // fireflies drift a little faster than the ground: depth for free
    for (i = 0; i < 22; i++) {
      var fxw = W + 80, fyh = H + 80, ffx = ((i * 197.3 + Math.sin(S.realT * 0.4 + i) * 40 - S.cam.x * PXM * 1.18) % fxw + fxw) % fxw - 40, ffy = ((i * 131.7 + Math.cos(S.realT * 0.33 + i * 1.7) * 40 - S.cam.y * PXM * 1.18) % fyh + fyh) % fyh - 40;
      var fl = 0.5 + 0.5 * Math.sin(S.realT * (1.5 + (i % 5) * 0.4) + i);
      glowAt(i % 3 ? FX.gWarm : FX.gGreen, ffx, ffy, 9 * U, 0.25 + fl * 0.45);
      ctx.fillStyle = "rgba(255,250,200," + (0.4 + fl * 0.6) + ")"; ctx.fillRect(ffx - 1.2, ffy - 1.2, 2.4, 2.4);
    }
    // damage numbers
    for (i = 0; i < S.DN.length; i++) {
      var dn = S.DN[i], k3 = dn.t / 0.7; s = W2S(dn.x + dn.vx * dn.t, dn.y);
      var pop = dn.t < 0.1 ? 1 + (1 - dn.t / 0.1) * 0.6 : 1, sz = (dn.crit ? 21 : 13) * U * pop;
      ctx.globalAlpha = k3 > 0.7 ? (1 - k3) / 0.3 : 1;
      txt(ctx, String(dn.v), s.x, s.y - dn.t * 34 * U, sz, dn.crit ? "#FFE45C" : "#FFFFFF", "#2A0A14", "center", { shadow: false, sw: sz * 0.28 });
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    // night to dawn
    var dawnK = clamp((S.t - 240) / 80, 0, 1);
    if (VIG) ctx.drawImage(VIG, 0, 0, W, H);
    if (dawnK > 0) { ctx.fillStyle = "rgba(255,170,120," + dawnK * 0.16 + ")"; ctx.fillRect(0, 0, W, H); }
    var lowHp = p.hp / p.maxHp;
    if (lowHp < 0.3 && !p.dead) { var hb = Math.pow(Math.max(0, Math.sin(S.realT * 7.5)), 6) * (0.3 - lowHp) * 2.2; drawEdge("255,40,70", 0.25 + hb); }
    if (S.warnT > 0) drawEdge("255,40,70", 0.55 * Math.abs(Math.sin(S.warnT * 5)));
    if (p.hurtFlash > 0) { ctx.fillStyle = "rgba(255,40,70," + p.hurtFlash * 0.6 + ")"; ctx.fillRect(0, 0, W, H); }
    drawStick();
    if (mode !== "dead" && mode !== "win") drawHUD();
    if (mode === "levelup") drawLevelUp();
    if (mode === "chest") drawChest();
    if (mode === "pause") drawPause();
    if (mode === "dead" || mode === "win") drawEnd();
    drawConfetti();
  }
  var EDGE = {};
  function drawEdge(col, a) {
    if (a <= 0.01) return;
    if (!EDGE[col] || EDGE[col].w !== W || EDGE[col].h !== H) {
      var c = mk(W / 2, H / 2), g = c.getContext("2d"), gr = g.createRadialGradient(W / 4, H / 4, Math.min(W, H) * 0.22, W / 4, H / 4, Math.hypot(W, H) * 0.3);
      gr.addColorStop(0, "rgba(" + col + ",0)"); gr.addColorStop(1, "rgba(" + col + ",1)");
      g.fillStyle = gr; g.fillRect(0, 0, W / 2, H / 2);
      EDGE[col] = { c: c, w: W, h: H };
    }
    ctx.globalAlpha = Math.min(1, a); ctx.drawImage(EDGE[col].c, 0, 0, W, H); ctx.globalAlpha = 1;
  }
  function drawGround() {
    // where the world origin lands on screen, wrapped into [-tile, 0) so tiles always cover every edge,
    // whichever side of the start the camera has wandered to
    var tile = GT_M * PXM, sx0 = W / 2 - S.cam.x * PXM, sy0 = H / 2 - S.cam.y * PXM;
    var ox = (((sx0 % tile) + tile) % tile) - tile, oy = (((sy0 % tile) + tile) % tile) - tile;
    for (var x = ox; x < W + tile; x += tile) for (var y = oy; y < H + tile; y += tile) ctx.drawImage(GROUND, x, y, tile + 0.5, tile + 0.5);
  }
  function drawPet() {
    var p = S.p, s = W2S(p.x, p.y), sp = S.special;
    var F = FIT.pet[p.face] || FIT.pet.idle;
    var moving = Math.hypot(p.vx, p.vy) > 0.3;
    var bob = Math.sin(p.step), hop = moving ? Math.abs(bob) * PET_WR * PXM * 0.28 : 0;
    var sqx = 1 + (moving ? -Math.abs(bob) * 0.06 : Math.sin(S.realT * 3) * 0.02), sqy = 1 + (moving ? Math.abs(bob) * 0.08 : -Math.sin(S.realT * 3) * 0.02);
    var rot = p.lean;
    if (sp.active && SHAPE === "Round") { rot = S.realT * 22; hop = 0; F = FIT.pet.yell; }
    if (sp.active && SHAPE === "Tail") { rot = sp.t < 0.85 ? sp.t * sp.t * 40 : 0; hop = sp.t < 0.85 ? Math.sin((sp.t / 0.85) * Math.PI) * 1.4 * PXM : 0; }
    if (sp.active && SHAPE === "Horns") { rot = Math.atan2(sp.dir.y, sp.dir.x) * 0.25; sqx = 1.15; sqy = 0.9; }
    if (p.dead) { rot = Math.sin(S.realT * 3) * 0.3; }
    if (p.inv > 0 && Math.floor(S.realT * 20) % 2 === 0 && !p.dead) ctx.globalAlpha = 0.55;
    // CHI READY: a breathing halo so you know to double tap
    if (sp.meter >= sp.need && !sp.active) glowAt(FX.gGreen, s.x, s.y, PET_WR * PXM * (2.6 + Math.sin(S.realT * 6) * 0.3), 0.45);
    if (sp.active) glowAt(FX.gGreen, s.x, s.y, PET_WR * PXM * 3, 0.5);
    ctx.save();
    ctx.translate(s.x, s.y + PET_WR * PXM * 0.9 - hop);
    ctx.rotate(rot);
    ctx.scale(sqx, sqy);
    ctx.drawImage(F.c, -F.ax, -F.ay - PET_WR * PXM * 0.9, F.w, F.h);
    if (p.hurtFlash > 0.15) { ctx.globalAlpha = 0.7; ctx.drawImage(FIT.petWhite.c, -F.ax, -F.ay - PET_WR * PXM * 0.9, F.w, F.h); }
    ctx.restore();
    ctx.globalAlpha = 1;
    // health under the Chi
    var bw = 1.2 * PXM, bh = Math.max(5, 0.13 * PXM), bx = s.x - bw / 2, by = s.y + PET_WR * PXM * 1.15;
    rrect(ctx, bx - 1.5, by - 1.5, bw + 3, bh + 3, bh); ctx.fillStyle = "#1A0F2E"; ctx.fill();
    rrect(ctx, bx, by, Math.max(bh, bw * (p.hp / p.maxHp)), bh, bh / 2); ctx.fillStyle = p.hp / p.maxHp < 0.3 ? "#FF4D6D" : "#7BEA5A"; ctx.fill();
  }
  function drawStick() {
    if (!INP.active || mode !== "play") return;
    var R0 = stickR();
    ctx.beginPath(); ctx.arc(INP.ox, INP.oy, R0, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.lineWidth = 2.5 * U; ctx.stroke();
    var dx = INP.x - INP.ox, dy = INP.y - INP.oy, d = Math.hypot(dx, dy), m = Math.min(d, R0);
    var kx = INP.ox + (d ? (dx / d) * m : 0), ky = INP.oy + (d ? (dy / d) * m : 0);
    ctx.beginPath(); ctx.arc(kx, ky, R0 * 0.42, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.fill();
  }
  function drawHUD() {
    if (WATCH) { drawHUDWatch(); return; }
    var top = SA.t + 10 * U, l = SA.l + 14 * U, r = W - SA.r - 14 * U;
    // XP bar
    var bh = 12 * U, bw = r - l;
    rrect(ctx, l, top, bw, bh, bh / 2); ctx.fillStyle = "rgba(10,6,30,0.75)"; ctx.fill();
    var xr = S.xp / S.need; if (xr < S.xpShow - 0.02) S.xpShow = 0; S.xpShow = lerp(S.xpShow, xr, 1 - Math.exp(-FDT * 14));
    rrect(ctx, l + 2, top + 2, Math.max(bh - 4, (bw - 4) * S.xpShow), bh - 4, (bh - 4) / 2); ctx.fillStyle = S.xpFlash > 0 ? A.mixHex("#59C8FF", "#FFFFFF", Math.min(1, S.xpFlash * 2)) : "#59C8FF"; ctx.fill();
    rrect(ctx, l + 4, top + 3, Math.max(0, (bw - 8) * S.xpShow), (bh - 4) * 0.35, 3); ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.fill();
    // level badge
    txt(ctx, "LV " + S.lvl, l + 4 * U, top + bh + 18 * U, 20 * U, "#FFFFFF", "#160B2B", "left");
    // timer
    var tt = Math.floor(S.t), mm = Math.floor(tt / 60), ss = tt % 60;
    txt(ctx, mm + ":" + (ss < 10 ? "0" : "") + ss, W / 2, top + bh + 22 * U, 30 * U, "#FFFFFF", "#160B2B", "center");
    // kills
    var kc = FIT.grem.imp.R, ks = 22 * U;
    txt(ctx, fmt(S.kills), r - 44 * U - 30 * U, top + bh + 18 * U, 20 * U, "#FFFFFF", "#160B2B", "right");
    ctx.drawImage(kc.c, r - 44 * U - 28 * U, top + bh + 18 * U - ks * 0.62, ks * kc.w / kc.h, ks);
    // combo
    var cbn = S.combo, live = S.realT - cbn.last < 1.3 && cbn.n >= 10;
    if (live) {
      var ccol = cbn.n >= 150 ? "#FF5CA8" : cbn.n >= 50 ? "#FF9A3D" : "#FFE45C", csz = (18 + Math.min(10, cbn.n / 30)) * U * (1 + cbn.pop * 0.25);
      ctx.globalAlpha = Math.min(1, (1.3 - (S.realT - cbn.last)) * 3);
      var pb = btns()[0]; txt(ctx, "x" + cbn.n, r, pb.y + pb.r + 18 * U, csz, ccol, "#160B2B", "right");
      ctx.globalAlpha = 1;
    }
    // owned items
    var ix = l, iy = top + bh + 40 * U, is = 26 * U;
    S.weapons.concat(S.passives).forEach(function (id, n) {
      var x = ix + (n % 8) * (is + 4 * U);
      if (S.fly.some(function (f) { return f.id === id && f.t < 0.5; })) return;
      rrect(ctx, x, iy, is, is, 7 * U); ctx.fillStyle = ITEMS[id].kind === "p" ? "rgba(40,70,140,0.8)" : ITEMS[id].kind === "e" ? "rgba(140,40,120,0.85)" : "rgba(120,70,20,0.8)"; ctx.fill();
      ctx.drawImage(icon(id), x + 2, iy + 2, is - 4, is - 4);
    });
    // boss bar
    if (S.boss && !S.boss.dead && !S.boss.die) {
      var by = iy + is + 14 * U, bbw = Math.min(bw, 420 * U), bbx = W / 2 - bbw / 2;
      txt(ctx, "GREMLIN KING", W / 2, by, 16 * U, "#FFD6DC", "#3A0610", "center");
      rrect(ctx, bbx, by + 12 * U, bbw, 12 * U, 6 * U); ctx.fillStyle = "rgba(30,4,10,0.85)"; ctx.fill();
      rrect(ctx, bbx + 2, by + 14 * U, Math.max(8, (bbw - 4) * (S.boss.hp / S.boss.maxHp)), 8 * U, 4 * U); ctx.fillStyle = "#FF4D6D"; ctx.fill();
    }
    // picked items fly home to their slot
    for (var fi = S.fly.length - 1; fi >= 0; fi--) {
      var fy2 = S.fly[fi]; fy2.t += FDT;
      var slot = S.weapons.concat(S.passives).indexOf(fy2.id);
      if (slot < 0 || fy2.t > 0.75) { S.fly.splice(fi, 1); continue; }
      var tx2 = ix + (slot % 8) * (is + 4 * U) + is / 2, ty2 = iy + is / 2, fk = clamp(fy2.t / 0.5, 0, 1), fe = 1 - Math.pow(1 - fk, 3);
      var fxp = lerp(fy2.x, tx2, fe), fyp = lerp(fy2.y, ty2, fe) - Math.sin(fk * Math.PI) * 60 * U, fsz = lerp(fy2.s, is, fe);
      if (fk >= 1) { var ring2 = (fy2.t - 0.5) / 0.25; ctx.beginPath(); ctx.arc(tx2, ty2, is * (0.6 + ring2), 0, Math.PI * 2); ctx.strokeStyle = "rgba(255,255,255," + (1 - ring2) + ")"; ctx.lineWidth = 3 * U; ctx.stroke(); continue; }
      glowAt(FX.gWhite, fxp, fyp, fsz, 0.5);
      ctx.drawImage(icon(fy2.id), fxp - fsz / 2, fyp - fsz / 2, fsz, fsz);
    }
    // pause button
    var B = btns();
    if (B[0].on) { ctx.beginPath(); ctx.arc(B[0].x, B[0].y, B[0].r, 0, Math.PI * 2); ctx.fillStyle = "rgba(10,6,30,0.6)"; ctx.fill(); ctx.fillStyle = "#FFFFFF"; ctx.fillRect(B[0].x - 7 * U, B[0].y - 8 * U, 5 * U, 16 * U); ctx.fillRect(B[0].x + 2 * U, B[0].y - 8 * U, 5 * U, 16 * U); }
    // CHI meter (always visible, bottom right)
    var cb = B[1], sp = S.special, k = sp.active ? 1 : sp.meter / sp.need, ready = k >= 1 && !sp.active;
    var cx = W - SA.r - 20 * U - 34 * U, cy = H - SA.b - 24 * U - 34 * U, cr = 34 * U;
    ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.fillStyle = ready ? "rgba(90,160,30,0.9)" : "rgba(10,6,30,0.6)"; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, cr - 3 * U, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.strokeStyle = "#BCEE49"; ctx.lineWidth = 5 * U; ctx.lineCap = "round"; ctx.stroke(); ctx.lineCap = "butt";
    var pf = FIT.pet.happy, ps = cr * 1.25;
    ctx.globalAlpha = ready ? 1 : 0.55;
    ctx.drawImage(pf.c, cx - ps / 2, cy - ps * 0.62, ps, ps * pf.h / pf.w);
    ctx.globalAlpha = 1;
    if (ready) {
      var pulse = 1 + Math.sin(S.realT * 8) * 0.06;
      txt(ctx, "DOUBLE TAP", cx, cy - cr - 14 * U, 15 * U * pulse, "#BCEE49", "#1A2A05", "center");
      if (cb.on) {} // tap target is live
    } else {
      txt(ctx, "CHI", cx, cy + cr * 0.62, 13 * U, "#FFFFFF", "#160B2B", "center");
    }
    // banner
    if (S.banner && mode === "play") {
      var bt = S.banner.t, life = 2.2;
      if (bt > life) S.banner = null;
      else {
        var ins = bt < 0.25 ? A.backOut(bt / 0.25) : 1, outA = bt > life - 0.3 ? (life - bt) / 0.3 : 1;
        ctx.globalAlpha = Math.max(0, outA);
        var yb = H * (portrait ? 0.3 : 0.32);
        txt(ctx, S.banner.text, W / 2, yb, 40 * U * ins, S.banner.col, "#160B2B", "center");
        if (S.banner.sub) txt(ctx, S.banner.sub, W / 2, yb + 34 * U, 18 * U, "#FFFFFF", "#160B2B", "center");
        ctx.globalAlpha = 1;
      }
    }
    if (DEBUG.fps) { txt(ctx, (fpsShow | 0) + " fps  " + S.E.length + " gremlins  " + S.P.length + " shots", l, H - SA.b - 16 * U, 13 * U, "#FFFFFF", "#000", "left"); }
  }
  function cardRects(n) {
    var rects = [], gap = 12 * U;
    if (portrait) {
      var w = Math.min(W - SA.l - SA.r - 32 * U, 380 * U), h = 96 * U, tot = n * h + (n - 1) * gap, y0 = H * 0.52 - tot / 2;
      for (var i = 0; i < n; i++) rects.push({ x: W / 2 - w / 2, y: y0 + i * (h + gap), w: w, h: h });
    } else {
      var w2 = Math.min((W - SA.l - SA.r - 48 * U - (n - 1) * gap) / n, 230 * U), h2 = Math.min(H * 0.56, 250 * U), tot2 = n * w2 + (n - 1) * gap, x0 = W / 2 - tot2 / 2;
      for (i = 0; i < n; i++) rects.push({ x: x0 + i * (w2 + gap), y: H * 0.56 - h2 / 2, w: w2, h: h2 });
    }
    return rects;
  }
  function drawCard(id, rc, k, sel) {
    var it = ITEMS[id] || { name: "SNACK BREAK", kind: "h", desc: ["Heal 40."] }, cur = lv(id);
    var col = it.kind === "w" ? ["#FFE6A8", "#B8701E"] : it.kind === "p" ? ["#C9E4FF", "#2F5FA8"] : it.kind === "e" ? ["#FFD0F2", "#A0287A"] : ["#FFD0D8", "#A02840"];
    ctx.save();
    var cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2, kk = clamp(k, 0, 1), sc = backOut2(kk, 1.5) * (sel ? 1.06 : 1);
    if (kk <= 0) { ctx.restore(); return; }
    ctx.globalAlpha = Math.min(1, kk * 3) * (CARDS && CARDS.picked >= 0 && !sel ? Math.max(0, 1 - CARDS.pickT * 5) : 1);
    ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
    rrect(ctx, rc.x, rc.y + 5 * U, rc.w, rc.h, 18 * U); ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fill();
    rrect(ctx, rc.x, rc.y, rc.w, rc.h, 18 * U); ctx.fillStyle = col[0]; ctx.fill(); ctx.strokeStyle = col[1]; ctx.lineWidth = 4 * U; ctx.stroke();
    var isz = portrait ? rc.h - 24 * U : Math.min(rc.w * 0.5, rc.h * 0.36);
    var ixx = portrait ? rc.x + 12 * U : cx - isz / 2, iyy = portrait ? rc.y + 12 * U : rc.y + 16 * U;
    rrect(ctx, ixx, iyy, isz, isz, 14 * U); ctx.fillStyle = rgba(col[1], 0.18); ctx.fill();
    ctx.drawImage(icon(id === "heal" ? "heart" : id), ixx + 4, iyy + 4, isz - 8, isz - 8);
    var tx = portrait ? ixx + isz + 12 * U : cx, ty = portrait ? rc.y + 26 * U : iyy + isz + 22 * U, al = portrait ? "left" : "center";
    txt(ctx, it.name, tx, ty, 20 * U, "#FFFFFF", col[1], al, { sw: 5 * U });
    var tag = it.kind === "e" ? "EVOLUTION!" : cur ? "LV " + (cur + 1) : "NEW!";
    ctx.font = 13 * U + "px " + FONT; ctx.textAlign = al; ctx.fillStyle = col[1];
    var tagX = portrait ? rc.x + rc.w - 14 * U : cx;
    ctx.textAlign = portrait ? "right" : "center";
    ctx.fillText(tag, tagX, portrait ? ty : ty + 20 * U);
    var d = it.desc[Math.min(cur, it.desc.length - 1)] || it.desc[0];
    ctx.font = "600 " + 14 * U + "px ui-rounded, system-ui, -apple-system, sans-serif"; ctx.fillStyle = "#2A1A14"; ctx.textAlign = al;
    wrapText(d, tx, portrait ? ty + 24 * U : ty + 44 * U, portrait ? rc.x + rc.w - tx - 14 * U : rc.w - 24 * U, 18 * U, al);
    if (it.max > 1) { for (var i = 0; i < it.max; i++) { var px = portrait ? rc.x + rc.w - 14 * U - (it.max - i) * 13 * U : cx - (it.max * 13 * U) / 2 + i * 13 * U + 2; var py = portrait ? rc.y + rc.h - 18 * U : rc.y + rc.h - 22 * U; ell(ctx, px + 5 * U, py, 4.5 * U, 4.5 * U); ctx.fillStyle = i <= cur ? (i === cur ? "#FFFFFF" : col[1]) : rgba(col[1], 0.2); ctx.fill(); if (i === cur) { ctx.strokeStyle = col[1]; ctx.lineWidth = 2; ctx.stroke(); } } }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  function wrapText(s, x, y, maxW, lh, al) {
    var words = s.split(" "), line = "", yy = y;
    ctx.textAlign = al; ctx.textBaseline = "middle";
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + " " + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, yy); line = words[i]; yy += lh; } else line = test;
    }
    if (line) ctx.fillText(line, x, yy);
  }
  function drawLevelUp() {
    if (WATCH) { drawLevelUpWatch(); return; }
    var C = CARDS; C.t += FDT;
    ctx.fillStyle = "rgba(14,6,34," + Math.min(0.72, C.t * 3) + ")"; ctx.fillRect(0, 0, W, H);
    var rects = cardRects(C.list.length);
    var ty = rects[0].y - 46 * U;
    txt(ctx, "LEVEL UP!", W / 2, ty, 40 * U * (C.t < 0.3 ? A.backOut(C.t / 0.3) : 1), "#FFD23A", "#160B2B", "center");
    for (var i = 0; i < C.list.length; i++) drawCard(C.list[i], rects[i], (C.t - 0.08 * i) / 0.28, C.picked === i);
    var last = rects[rects.length - 1], ry = portrait ? last.y + last.h + 34 * U : last.y + last.h + 30 * U;
    if (S.rerolls > 0) { rrect(ctx, W / 2 - 80 * U, ry - 22 * U, 160 * U, 44 * U, 22 * U); ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fill(); txt(ctx, "REROLL (" + S.rerolls + ")", W / 2, ry, 17 * U, "#FFFFFF", "#160B2B", "center"); }
    if (C.picked >= 0) { C.pickT += FDT; if (C.pickT > 0.22) { var prc = rects[C.picked], pid = C.list[C.picked]; grant(pid); flyTo(pid, portrait ? prc.x + 12 * U + (prc.h - 24 * U) / 2 : prc.x + prc.w / 2, portrait ? prc.y + prc.h / 2 : prc.y + 16 * U + Math.min(prc.w * 0.5, prc.h * 0.36) / 2, portrait ? prc.h - 24 * U : Math.min(prc.w * 0.5, prc.h * 0.36)); CARDS = null; mode = "play"; S.slow = 0.35; S.slowT = 0.35; } }
  }
  // screen-space confetti for the big moments (chest, dawn, new best)
  function confetti(n, x, y, spread) {
    var cols = ["#FFD23A", "#FF6FB5", "#59C8FF", "#BCEE49", "#FFFFFF", "#FF9A3D"];
    for (var i = 0; i < n; i++) {
      var a = -Math.PI / 2 + rand(-spread, spread), sp = rand(260, 720) * U;
      S.sc.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, rot: rand(0, 6), vr: rand(-14, 14), col: pick(cols), w: rand(6, 11) * U, h: rand(3, 6) * U, t: 0 });
    }
    if (S.sc.length > 500) S.sc.splice(0, S.sc.length - 500);
  }
  function drawConfetti() {
    if (!S || !S.sc.length) return;
    for (var i = S.sc.length - 1; i >= 0; i--) {
      var c = S.sc[i]; c.t += FDT;
      c.vy += 900 * U * FDT; c.vx *= Math.pow(0.35, FDT); c.vy = Math.min(c.vy, 380 * U);
      c.x += c.vx * FDT + Math.sin(c.t * 7 + i) * 0.6; c.y += c.vy * FDT; c.rot += c.vr * FDT;
      if (c.y > H + 30 || c.t > 5) { S.sc.splice(i, 1); continue; }
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.rot); ctx.scale(1, Math.abs(Math.cos(c.t * 9 + i)));
      ctx.fillStyle = c.col; ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h); ctx.restore();
    }
  }
  function rays(cx, cy, a, col, spin) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate((S ? S.realT : titleT) * (spin || 0.5));
    ctx.globalCompositeOperation = "lighter";
    var L = Math.hypot(W, H);
    for (var i = 0; i < 14; i++) { ctx.rotate(Math.PI / 7); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L, -L * 0.09); ctx.lineTo(L, L * 0.09); ctx.closePath(); ctx.fillStyle = "rgba(" + col + "," + a + ")"; ctx.fill(); }
    ctx.restore(); ctx.globalCompositeOperation = "source-over";
  }
  var REEL_IDS = ["seed", "leaf", "boop", "star", "bone", "snack", "zoomies", "heart", "nose", "paws", "twin", "sunflower", "tornado"];
  function drawChest() {
    var C = CHEST; C.t += FDT;
    var n = C.prize.length, OPEN = 1.0, STOP = OPEN + 1.1, REVEAL = STOP + 0.28 * (n - 1) + 0.25;
    ctx.fillStyle = "rgba(14,6,34," + Math.min(0.82, C.t * 2) + ")"; ctx.fillRect(0, 0, W, H);
    var cx = W / 2, cy = H * (portrait ? 0.56 : 0.6), cs = Math.min(W, H) * 0.34;
    if (C.t < OPEN) {
      // the chest rattles harder and harder, light leaking from the seams
      var k = C.t / OPEN, sh = k * k * 9 * U;
      glowAt(FX.gWarm, cx, cy, cs * (0.8 + k * 1.2), 0.3 + k * 0.6);
      blitC(FX.chest, cx + Math.sin(C.t * 70) * sh, cy + Math.cos(C.t * 57) * sh, cs * (1 + k * 0.12));
      if (Math.floor(C.t * (8 + k * 14)) > C.ticks) { C.ticks += 1; Au.tick(C.ticks % 12); }
      txt(ctx, C.src === "boss" ? "THE KING DROPPED SOMETHING" : "TREASURE", cx, H * 0.2, 22 * U, "#FFD23A", "#160B2B", "center");
      return;
    }
    if (!C.opened) { C.opened = true; Au.boom(false); S.cam.shake = 0.3; confetti(40, cx, cy, 0.6); }
    var since = C.t - OPEN;
    rays(cx, cy - cs * 0.3, 0.07 * Math.min(1, since * 3), C.evo ? "255,120,210" : "255,210,90", 0.45);
    glowAt(C.evo ? FX.gPink : FX.gWarm, cx, cy - cs * 0.3, cs * 1.6, 0.55);
    if (C.t < REVEAL + 0.2) blitC(FX.chest, cx, cy + cs * 0.25 + Math.max(0, C.t - REVEAL) * 600 * U, cs * 0.8, 0, Math.max(0, 1 - Math.max(0, C.t - REVEAL) * 5));
    if (C.t < REVEAL) {
      // VS-style slot reels: icons whirl, slow down and land one after another
      var rw = Math.min(88 * U, (W - 48 * U) / n - 10 * U), gap = 12 * U, x0 = cx - (n * rw + (n - 1) * gap) / 2, ry = cy - cs * 0.55;
      for (var i = 0; i < n; i++) {
        var stopAt = STOP + i * 0.28, rx = x0 + i * (rw + gap);
        rrect(ctx, rx, ry - rw / 2, rw, rw, 16 * U); ctx.fillStyle = "#FFF6E0"; ctx.fill(); ctx.strokeStyle = "#B8701E"; ctx.lineWidth = 4 * U; ctx.stroke();
        ctx.save(); rrect(ctx, rx + 4 * U, ry - rw / 2 + 4 * U, rw - 8 * U, rw - 8 * U, 12 * U); ctx.clip();
        if (C.t < stopAt) {
          var spd = 14 * Math.pow(Math.max(0.05, (stopAt - C.t) / (stopAt - OPEN)), 0.7), pos = (C.t * spd + i * 3.3);
          var idx = Math.floor(pos), off = (pos - idx) * rw;
          for (var j = -1; j <= 1; j++) { var id = REEL_IDS[(idx + j + REEL_IDS.length * 9 + i * 4) % REEL_IDS.length]; ctx.drawImage(icon(id), rx + 10 * U, ry - rw / 2 + 10 * U + j * rw + off - rw * 0.0, rw - 20 * U, rw - 20 * U); }
          if (C.lastTick !== idx + i * 1000) { C.lastTick = idx + i * 1000; Au.tick(idx % 8); }
        } else {
          var land = clamp((C.t - stopAt) / 0.25, 0, 1), bump = Math.sin(land * Math.PI) * 6 * U;
          ctx.drawImage(icon(C.prize[i] === "heal" ? "heart" : C.prize[i]), rx + 10 * U, ry - rw / 2 + 10 * U - bump, rw - 20 * U, rw - 20 * U);
          if (!C["landed" + i]) { C["landed" + i] = true; Au.pickCard(); }
        }
        ctx.restore();
      }
      txt(ctx, "OPENING...", cx, H * 0.2, 26 * U, "#FFFFFF", "#160B2B", "center");
      return;
    }
    if (!C.boomed) { C.boomed = true; Au.fanfare(); confetti(C.evo ? 140 : 80, cx, cy, 1.2); S.cam.shake = 0.5; }
    var k2 = C.t - REVEAL;
    if (WATCH) { drawChestRevealWatch(C, k2, n, cx); return; }
    txt(ctx, C.evo ? "EVOLUTION!" : "TREASURE!", cx, H * 0.17 + SA.t * 0.5, 46 * U * backOut2(k2 / 0.3, 2), C.evo ? "#FF6FB5" : "#FFD23A", "#160B2B", "center");
    for (i = 0; i < n; i++) {
      var w = portrait ? Math.min(W - 48 * U, 360 * U) : Math.min(230 * U, (W - 60 * U) / n), h = portrait ? 100 * U : Math.min(230 * U, H * 0.5);
      var tot = portrait ? n * h + (n - 1) * 10 * U : n * w + (n - 1) * 12 * U, mid = portrait ? H * 0.5 : H * 0.53;
      var rc = portrait ? { x: cx - w / 2, y: mid - tot / 2 + i * (h + 10 * U), w: w, h: h } : { x: cx - tot / 2 + i * (w + 12 * U), y: mid - h / 2, w: w, h: h };
      drawCard(C.prize[i], rc, (k2 - i * 0.18) / 0.32, false);
    }
    C.ready = k2 > 0.6 + n * 0.18;
    if (C.ready) txt(ctx, "TAP TO KEEP GOING", cx, H - SA.b - (portrait ? 56 : 22) * U, 18 * U * (1 + Math.sin(C.t * 6) * 0.04), "#FFFFFF", "#160B2B", "center");
  }
  function pauseBtns() {
    if (WATCH) return pauseBtnsWatch();
    var w = Math.min(260 * U, W - 64 * U), h = 52 * U, y0 = H * 0.46;
    return [
      { id: "resume", x: W / 2 - w / 2, y: y0, w: w, h: h, label: "RESUME", fill: "#7BEA5A", ink: "#1A4A08" },
      { id: "sound", x: W / 2 - w / 2, y: y0 + h + 14 * U, w: w, h: h * 0.85, label: "SOUND " + (Au.muted ? "OFF" : "ON"), fill: "rgba(255,255,255,0.14)", ink: "#160B2B" },
      { id: "shake", x: W / 2 - w / 2, y: y0 + h * 1.85 + 26 * U, w: w, h: h * 0.85, label: "SCREEN SHAKE " + (SHAKE_ON ? "ON" : "OFF"), fill: "rgba(255,255,255,0.14)", ink: "#160B2B" },
    ];
  }
  function drawPause() {
    if (WATCH) { drawPauseWatch(); return; }
    ctx.fillStyle = "rgba(14,6,34,0.78)"; ctx.fillRect(0, 0, W, H);
    var pf = FIT.pet.blink, ps = Math.min(W, H) * 0.22;
    ctx.drawImage(pf.c, W / 2 - ps / 2, H * 0.14, ps, ps * pf.h / pf.w);
    txt(ctx, "PAUSED", W / 2, H * 0.38, 44 * U, "#FFFFFF", "#160B2B", "center");
    pauseBtns().forEach(function (b) {
      rrect(ctx, b.x, b.y, b.w, b.h, b.h / 2); ctx.fillStyle = b.fill; ctx.fill();
      if (b.id === "resume") { ctx.strokeStyle = b.ink; ctx.lineWidth = 4 * U; ctx.stroke(); }
      txt(ctx, b.label, W / 2, b.y + b.h / 2, (b.id === "resume" ? 24 : 16) * U, "#FFFFFF", b.ink, "center");
    });
  }
  function endButton() { var w = 210 * U, h = 58 * U; return { x: W / 2 - w / 2, y: portrait ? H * 0.8 : H * 0.84 - h / 2, w: w, h: h }; }
  function drawEnd() {
    if (WATCH) { drawEndWatch(); return; }
    S.endT += FDT;
    var win = mode === "win", t = S.endT, k = Math.min(1, t * 2);
    ctx.fillStyle = win ? "rgba(36,14,58," + 0.8 * k + ")" : "rgba(14,6,34," + 0.86 * k + ")"; ctx.fillRect(0, 0, W, H);
    var land = !portrait, petY = land ? H * 0.12 : H * 0.12, ps = Math.min(W, H) * (land ? 0.3 : 0.34);
    var pcx = land ? W * 0.27 : W / 2;
    if (win) {
      // the sun comes up behind the Chi
      var rise = backOut2(clamp(t / 1.2, 0, 1), 0.8), sy = lerp(H * 0.9, petY + ps * 0.55, rise);
      var sg = ctx.createRadialGradient(pcx, sy, 0, pcx, sy, ps * 1.1);
      sg.addColorStop(0, "rgba(255,240,170,0.95)"); sg.addColorStop(0.45, "rgba(255,180,90,0.55)"); sg.addColorStop(1, "rgba(255,120,90,0)");
      ctx.fillStyle = sg; ctx.fillRect(pcx - ps * 1.2, sy - ps * 1.2, ps * 2.4, ps * 2.4);
      rays(pcx, sy, 0.06 * k, "255,220,140", 0.25);
      if (!S.endConf) { S.endConf = true; confetti(160, W / 2, H * 0.65, 1.3); }
      if (t > 1 && t < 6 && Math.floor(t * 4) !== Math.floor((t - FDT) * 4)) confetti(14, rand(0, W), H + 10, 0.4);
    }
    var pf = FIT.pet[win ? "happy" : "dizzy"], hopY = win ? Math.abs(Math.sin(t * 5)) * 10 * U : 0;
    ctx.drawImage(pf.c, pcx - ps / 2, petY - hopY, ps, ps * pf.h / pf.w);
    if (!win) for (var z = 0; z < 4; z++) { var za = t * 3 + z * 1.57; ctx.fillStyle = "#FFE45C"; A.star5(ctx, pcx + Math.cos(za) * ps * 0.38, petY + ps * 0.12 + Math.sin(za) * ps * 0.08, 7 * U, 0.5); ctx.fill(); }
    var colX = land ? W * 0.66 : W / 2, y = land ? H * 0.2 : H * 0.5;
    txt(ctx, win ? "DAWN!" : "KNOCKED OUT", colX, y, 46 * U * backOut2(t / 0.35, 2), win ? "#FFE45C" : "#FF8AA6", "#160B2B", "center");
    txt(ctx, win ? BOOT.name + " survived the night" : BOOT.name + " needs a nap", colX, y + 38 * U, 18 * U, "#FFFFFF", "#160B2B", "center");
    // stats count up one by one, with a tick per beat
    var rows = [["TIME", Math.floor(S.t), "time"], ["GREMLINS", S.kills, "n"], ["LEVEL", S.lvl, "n"], ["BEST COMBO", S.combo.best, "x"]];
    var rowH = 30 * U, ry0 = y + 82 * U, rw = Math.min(300 * U, (land ? W * 0.5 : W) - 48 * U);
    for (var i = 0; i < rows.length; i++) {
      var st = 0.5 + i * 0.35, rk = clamp((t - st) / 0.6, 0, 1); if (t < st) continue;
      var v = Math.round(rows[i][1] * (1 - Math.pow(1 - rk, 3))), shown = rows[i][2] === "time" ? Math.floor(v / 60) + ":" + (v % 60 < 10 ? "0" : "") + (v % 60) : rows[i][2] === "x" ? "x" + v : fmt(v);
      var yy = ry0 + i * rowH, al = clamp((t - st) * 5, 0, 1);
      ctx.globalAlpha = al;
      ctx.font = 16 * U + "px " + FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.fillText(rows[i][0], colX - rw / 2, yy);
      txt(ctx, shown, colX + rw / 2, yy, 20 * U, "#FFD23A", "#160B2B", "right");
      ctx.globalAlpha = 1;
      if (rk < 1 && Math.floor(t * 20) !== Math.floor((t - FDT) * 20)) Au.tick(i * 2);
    }
    var bAt = 0.5 + rows.length * 0.35 + 0.5;
    if (S.newBest && t > bAt) {
      var bk = backOut2((t - bAt) / 0.35, 2.5), bx = colX + rw / 2 - 10 * U, by = y - 30 * U;
      if (!S.bestFx) { S.bestFx = true; confetti(60, bx, by, 1); Au.fanfare(); }
      ctx.save(); ctx.translate(bx, by); ctx.rotate(0.2 + Math.sin(t * 3) * 0.05); ctx.scale(bk, bk);
      A.star5(ctx, 0, 0, 40 * U, 0.72); A.fillStroke(ctx, "#FF5CA8", "#5A0A3E", 4 * U);
      txt(ctx, "NEW", 0, -8 * U, 14 * U, "#FFFFFF", "#5A0A3E", "center", { shadow: false }); txt(ctx, "BEST", 0, 9 * U, 14 * U, "#FFFFFF", "#5A0A3E", "center", { shadow: false });
      ctx.restore();
    }
    if (t > bAt) {
      var B = endButton(), bp = backOut2((t - bAt) / 0.3, 1.8), pulse = 1 + Math.sin(t * 5) * 0.025;
      var bcx = land ? colX : W / 2;
      ctx.save(); ctx.translate(bcx, B.y + B.h / 2); ctx.scale(bp * pulse, bp * pulse);
      rrect(ctx, -B.w / 2, -B.h / 2 + 5 * U, B.w, B.h, B.h / 2); ctx.fillStyle = "#1A4A08"; ctx.fill();
      rrect(ctx, -B.w / 2, -B.h / 2, B.w, B.h, B.h / 2); ctx.fillStyle = "#7BEA5A"; ctx.fill(); ctx.strokeStyle = "#1A4A08"; ctx.lineWidth = 4 * U; ctx.stroke();
      rrect(ctx, -B.w / 2 + 10 * U, -B.h / 2 + 6 * U, B.w - 20 * U, B.h * 0.32, B.h * 0.16); ctx.fillStyle = "rgba(255,255,255,0.3)"; ctx.fill();
      txt(ctx, win ? "PLAY AGAIN" : "AGAIN", 0, 0, 26 * U, "#FFFFFF", "#1A4A08", "center");
      ctx.restore();
      S.endBtnX = bcx;
    }
  }
  var titleT = 0;
  function drawTitle() {
    if (WATCH) { drawTitleWatch(); return; }
    titleT += FDT;
    var t = titleT, land = !portrait;
    if (GROUND) { var tile = GT_M * PXM; for (var x = -((t * 14) % tile); x < W; x += tile) for (var y = -((t * 8) % tile); y < H; y += tile) ctx.drawImage(GROUND, x, y, tile + 0.5, tile + 0.5); }
    ctx.fillStyle = "rgba(14,6,34,0.3)"; ctx.fillRect(0, 0, W, H);
    // the hero shot: a big moon, the Chi standing its ground, the horde circling closer
    var cx = land ? W * 0.64 : W / 2, cy = land ? H * 0.5 : H * 0.47, ps = Math.min(W, H) * (land ? 0.3 : 0.38);
    var moonR = ps * 1.15, my = cy - ps * 0.25;
    var mg = ctx.createRadialGradient(cx, my, 0, cx, my, moonR * 2.2);
    mg.addColorStop(0, "rgba(255,244,214,0.55)"); mg.addColorStop(0.35, "rgba(190,170,255,0.22)"); mg.addColorStop(1, "rgba(120,100,220,0)");
    ctx.fillStyle = mg; ctx.fillRect(cx - moonR * 2.2, my - moonR * 2.2, moonR * 4.4, moonR * 4.4);
    ctx.beginPath(); ctx.arc(cx, my, moonR * 0.62, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,246,220,0.16)"; ctx.fill();
    rays(cx, my, 0.035, "220,200,255", 0.12);
    var ringR = ps * (land ? 1.3 : 1.08), squash = land ? 0.78 : 0.8, list = [];
    for (var i = 0; i < 12; i++) {
      var a = t * 0.35 + (i / 12) * Math.PI * 2, kind = i % 4 === 0 ? "brute" : i % 3 === 0 ? "sprint" : i === 5 ? "spitter" : "imp";
      var breathe = 1 - 0.06 * (0.5 + 0.5 * Math.sin(t * 1.3));
      list.push({ kind: kind, x: cx + Math.cos(a) * ringR * breathe, y: cy + ps * 0.15 + Math.sin(a) * ringR * squash * breathe, i: i, a: a });
    }
    list.sort(function (p1, p2) { return p1.y - p2.y; });
    var hero = { hero: true, y: cy + ps * 0.15 };
    var drawn = false;
    function drawHero() {
      var pf = FIT.pet[Math.floor(t * 0.6) % 5 === 4 ? "aim" : Math.floor(t * 1.7) % 9 === 8 ? "blink" : "idle"];
      var hop = Math.abs(Math.sin(t * 3.2)) * ps * 0.05, sq = 1 + Math.sin(t * 6.4) * 0.025;
      ctx.drawImage(FIT.shadow, cx - ps * 0.42, cy + ps * 0.32, ps * 0.84, ps * 0.22);
      glowAt(FX.gGreen, cx, cy, ps * 0.9, 0.22);
      ctx.save(); ctx.translate(cx, cy + ps * 0.4); ctx.scale(1 / sq, sq);
      ctx.drawImage(pf.c, -ps / 2, -ps * 0.4 - ps * 0.62 - hop, ps, ps * pf.h / pf.w);
      ctx.restore();
    }
    for (i = 0; i < list.length; i++) {
      var g = list[i];
      if (!drawn && g.y > hero.y) { drawHero(); drawn = true; }
      var F = FIT.grem[g.kind], spr = g.x > cx ? F.L : F.R, sc = (land ? 1.5 : 1.7) * (0.85 + 0.15 * (g.y - cy + ringR) / (ringR * 2)), bob = Math.abs(Math.sin(t * 7 + g.i)) * 6 * U;
      ctx.drawImage(FIT.shadow, g.x - spr.w * sc * 0.3, g.y + spr.h * sc * 0.18, spr.w * sc * 0.6, spr.h * sc * 0.14);
      ctx.drawImage(spr.c, g.x - spr.ax * sc, g.y - spr.ay * sc - bob, spr.w * sc, spr.h * sc);
    }
    if (!drawn) drawHero();
    for (i = 0; i < 18; i++) {
      var fx = (i * 211.7 + Math.sin(t * 0.5 + i) * 30) % W, fy = (i * 97.3 + Math.cos(t * 0.4 + i) * 30 + t * 6) % H, fl = 0.5 + 0.5 * Math.sin(t * 2 + i);
      glowAt(i % 3 ? FX.gWarm : FX.gGreen, fx, fy, 8 * U, 0.2 + fl * 0.4);
    }
    if (VIG) ctx.drawImage(VIG, 0, 0, W, H);
    // logo
    var lx = land ? SA.l + (W * 0.64 - ringR - SA.l) / 2 : W / 2;
    var ty = (land ? H * 0.26 : H * 0.1) + SA.t, ls = (land ? 44 : 50) * U * (1 + Math.sin(t * 2) * 0.012);
    // a short first word ("CHI") is set bigger so the two lines of the logo weigh the same
    var la = TITLE_A.length <= 4 ? ls * 1.32 : ls;
    txt(ctx, TITLE_A, lx, ty - (la - ls) * 0.35, la, "#FFD23A", "#160B2B", "center", { sw: la * 0.2 });
    if (TITLE_B) txt(ctx, TITLE_B, lx, ty + ls * 0.98, ls * 1.12, "#FF8A3D", "#160B2B", "center", { sw: ls * 0.22 });
    if (!land) txt(ctx, BOOT.name.toUpperCase() + "  " + BOOT.number, W / 2, ty + ls * 1.75, 15 * U, "#FFFFFF", "#160B2B", "center");
    // how to play + the button
    var by = land ? H - SA.b - 34 * U : H * 0.78;
    var bw = 220 * U, bh = 60 * U, bcy = land ? by : by + 62 * U;
    if (!land) {
      txt(ctx, "Drag anywhere to move. Your Chi fights by itself.", W / 2, by, 15 * U, "#FFFFFF", "#160B2B", "center", { sw: 4 * U });
      txt(ctx, "Double tap for " + SPECIAL.name + ".", W / 2, by + 22 * U, 15 * U, "#BCEE49", "#160B2B", "center", { sw: 4 * U });
    } else {
      txt(ctx, BOOT.name.toUpperCase() + "  " + BOOT.number, lx, ty + ls * 1.8, 14 * U, "#FFFFFF", "#160B2B", "center", { sw: 4 * U });
      txt(ctx, "Drag to move. Double tap for " + SPECIAL.name + ".", lx, H - SA.b - 20 * U, 13 * U, "#BCEE49", "#160B2B", "center", { sw: 4 * U });
      bcy = ty + ls * 1.8 + 52 * U; bw = 200 * U; bh = 54 * U;
    }
    var pulse = 1 + Math.sin(t * 5) * 0.03;
    ctx.save(); ctx.translate(lx, bcy); ctx.scale(pulse, pulse);
    rrect(ctx, -bw / 2, -bh / 2 + 5 * U, bw, bh, bh / 2); ctx.fillStyle = "#1A4A08"; ctx.fill();
    rrect(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2); ctx.fillStyle = "#7BEA5A"; ctx.fill(); ctx.strokeStyle = "#1A4A08"; ctx.lineWidth = 4 * U; ctx.stroke();
    rrect(ctx, -bw / 2 + 12 * U, -bh / 2 + 6 * U, bw - 24 * U, bh * 0.3, bh * 0.15); ctx.fillStyle = "rgba(255,255,255,0.3)"; ctx.fill();
    txt(ctx, "PLAY", 0, 0, 28 * U, "#FFFFFF", "#1A4A08", "center");
    ctx.restore();
    if (best > 0) txt(ctx, "BEST " + Math.floor(best / 60) + ":" + (best % 60 < 10 ? "0" : "") + (best % 60), lx, bcy + bh / 2 + 18 * U, 14 * U, "#FFD23A", "#160B2B", "center");
  }

  // ================================================================ watch screens
  // Tap targets on a wrist are collected here every frame ({ x, y, w, h, fn } or { x, y, r, fn }),
  // so one hit test serves every screen and the screenshot pass can audit every target.
  function wbRect(x, y, w, h, fn) { WB.push({ x: x, y: y, w: w, h: h, fn: fn }); }
  function wbHit(b, x, y) {
    if (b.r) return Math.hypot(x - b.x, y - b.y) < b.r + 6;
    return x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4;
  }
  // A 44 px round button; iconFn(x, y, r) draws its glyph.
  function wRound(x, y, iconFn, fn) {
    var r = WBTN;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = "rgba(10,6,30,0.72)"; ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 2; ctx.stroke();
    iconFn(x, y, r);
    WB.push({ x: x, y: y, r: r, fn: fn });
  }
  function wIconPrev(x, y, r) { A.poly(ctx, [x + r * 0.22, y - r * 0.4, x - r * 0.36, y, x + r * 0.22, y + r * 0.4]); ctx.fillStyle = "#FFFFFF"; ctx.fill(); }
  function wIconNext(x, y, r) { A.poly(ctx, [x - r * 0.22, y - r * 0.4, x + r * 0.36, y, x - r * 0.22, y + r * 0.4]); ctx.fillStyle = "#FFFFFF"; ctx.fill(); }
  // A 44 px tall pill from x0 to x1. No fn = drawn but not a target (a pick that is not armed yet).
  function wPill(x0, x1, cy, label, fn, fill, ink) {
    var w = x1 - x0, h = WBTN * 2;
    ink = ink || "#1A4A08";
    rrect(ctx, x0, cy - h / 2 + 3, w, h, h / 2); ctx.fillStyle = ink; ctx.fill();
    rrect(ctx, x0, cy - h / 2, w, h, h / 2); ctx.fillStyle = fill || "#7BEA5A"; ctx.fill(); ctx.strokeStyle = ink; ctx.lineWidth = 2.5; ctx.stroke();
    txt(ctx, label, x0 + w / 2, cy + 1, fitSize(label, WT.label, w - WGAP * 2), "#FFFFFF", ink, "center");
    if (fn) wbRect(x0, cy - h / 2, w, h, fn);
  }
  // The pet drawn from its design bake (not the world-fitted one), so a hero shot stays crisp.
  function wHero(face, x, y, ps) {
    var spr = A.petSprite(face), k = ps / (spr.R * 2);
    ctx.drawImage(spr.c, x - spr.cx * k, y - spr.cy * k, (spr.c.width / RES) * k, (spr.c.height / RES) * k);
  }
  function startRun() { newRun(); mode = "play"; Au.music(true, 0); }
  function cardColors(it) { return it.kind === "w" ? ["#FFE6A8", "#B8701E"] : it.kind === "p" ? ["#C9E4FF", "#2F5FA8"] : it.kind === "e" ? ["#FFD0F2", "#A0287A"] : ["#FFD0D8", "#A02840"]; }
  // Play HUD on a wrist: time, level and kills stacked top left, a thin XP bar under them, the
  // pause button top right, the CHI meter bottom right (a full 44 px button once it is ready).
  // Owned-item icons and the GREMLIN KING title stay on the phone; the boss keeps a bar. The
  // overlays (level up, chest, pause) fill a wrist, so the HUD only draws while playing.
  function drawHUDWatch() {
    if (mode !== "play") return;
    var l = SA.l + WEDGE, r = W - SA.r - WEDGE, top = SA.t + WEDGE;
    var B = btns(), pb = B[0], cb = B[1];
    var tt = Math.floor(S.t), mm = Math.floor(tt / 60), ss = tt % 60;
    txt(ctx, mm + ":" + (ss < 10 ? "0" : "") + ss, l, top + WT.title / 2, WT.title, "#FFFFFF", "#160B2B", "left");
    var y2 = top + WT.title + WGAP * 0.5 + WT.cap / 2, lvS = "LV " + S.lvl;
    txt(ctx, lvS, l, y2, WT.cap, "#FFFFFF", "#160B2B", "left");
    var kc = FIT.grem.imp.R, ks = WT.cap * 1.2, kx = l + ctx.measureText(lvS).width + WGAP * 1.5, kw = ks * kc.w / kc.h;
    ctx.drawImage(kc.c, kx, y2 - ks * 0.62, kw, ks);
    txt(ctx, fmt(S.kills), kx + kw + 3, y2, WT.cap, "#FFFFFF", "#160B2B", "left");
    // XP bar
    var by = top + WBTN * 2 + WGAP * 0.5, bh = 4, bw = r - l;
    rrect(ctx, l, by, bw, bh, 2); ctx.fillStyle = "rgba(10,6,30,0.75)"; ctx.fill();
    var xr = S.xp / S.need; if (xr < S.xpShow - 0.02) S.xpShow = 0; S.xpShow = lerp(S.xpShow, xr, 1 - Math.exp(-FDT * 14));
    rrect(ctx, l + 1, by + 1, Math.max(bh - 2, (bw - 2) * S.xpShow), bh - 2, 1); ctx.fillStyle = S.xpFlash > 0 ? A.mixHex("#59C8FF", "#FFFFFF", Math.min(1, S.xpFlash * 2)) : "#59C8FF"; ctx.fill();
    // combo
    var cbn = S.combo, live = S.realT - cbn.last < 1.3 && cbn.n >= 10;
    if (live) {
      var ccol = cbn.n >= 150 ? "#FF5CA8" : cbn.n >= 50 ? "#FF9A3D" : "#FFE45C", csz = WT.body * (1 + cbn.pop * 0.25);
      ctx.globalAlpha = Math.min(1, (1.3 - (S.realT - cbn.last)) * 3);
      txt(ctx, "x" + cbn.n, r, by + bh + WGAP + csz / 2, csz, ccol, "#160B2B", "right");
      ctx.globalAlpha = 1;
    }
    // boss bar along the bottom, left of the CHI button
    if (S.boss && !S.boss.dead && !S.boss.die) {
      var bbw = cb.x - cb.r - WGAP - l, bby = H - SA.b - WEDGE - 5;
      txt(ctx, "GREMLIN KING", l, bby - WGAP - WT.cap / 2, fitSize("GREMLIN KING", WT.cap, bbw), "#FFD6DC", "#3A0610", "left", { shadow: false });
      rrect(ctx, l, bby, bbw, 5, 2.5); ctx.fillStyle = "rgba(30,4,10,0.85)"; ctx.fill();
      rrect(ctx, l + 1, bby + 1, Math.max(3, (bbw - 2) * (S.boss.hp / S.boss.maxHp)), 3, 1.5); ctx.fillStyle = "#FF4D6D"; ctx.fill();
    }
    // pause
    if (pb.on) { ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r, 0, Math.PI * 2); ctx.fillStyle = "rgba(10,6,30,0.6)"; ctx.fill(); ctx.fillStyle = "#FFFFFF"; ctx.fillRect(pb.x - 6, pb.y - 7, 4, 14); ctx.fillRect(pb.x + 2, pb.y - 7, 4, 14); }
    // CHI meter
    var sp = S.special, k = sp.active ? 1 : sp.meter / sp.need, ready = k >= 1 && !sp.active, cr = ready ? cb.r : 14;
    ctx.beginPath(); ctx.arc(cb.x, cb.y, cr, 0, Math.PI * 2); ctx.fillStyle = ready ? "rgba(90,160,30,0.9)" : "rgba(10,6,30,0.6)"; ctx.fill();
    ctx.beginPath(); ctx.arc(cb.x, cb.y, cr - 2.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.strokeStyle = "#BCEE49"; ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.stroke(); ctx.lineCap = "butt";
    var pf = FIT.pet.happy, ps = cr * 1.25;
    ctx.globalAlpha = ready ? 1 : 0.55;
    ctx.drawImage(pf.c, cb.x - ps / 2, cb.y - ps * 0.62, ps, ps * pf.h / pf.w);
    ctx.globalAlpha = 1;
    if (ready) { var pulse = 1 + Math.sin(S.realT * 8) * 0.06; txt(ctx, "DOUBLE TAP", cb.x + cb.r, cb.y - cb.r - WGAP - WT.cap / 2, WT.cap * pulse, "#BCEE49", "#1A2A05", "right"); }
    // banner
    if (S.banner && mode === "play") {
      var bt = S.banner.t, life = 2.2;
      if (bt > life) S.banner = null;
      else {
        var ins = bt < 0.25 ? A.backOut(bt / 0.25) : 1, outA = bt > life - 0.3 ? (life - bt) / 0.3 : 1;
        ctx.globalAlpha = Math.max(0, outA);
        var yb = H * 0.3, bsz = fitSize(S.banner.text, WT.display, r - l);
        txt(ctx, S.banner.text, W / 2, yb, bsz * ins, S.banner.col, "#160B2B", "center");
        if (S.banner.sub) txt(ctx, S.banner.sub, W / 2, yb + bsz * 0.5 + WT.cap * 0.7, fitSize(S.banner.sub, WT.cap, r - l), "#FFFFFF", "#160B2B", "center");
        ctx.globalAlpha = 1;
      }
    }
  }
  // Title on a wrist: the wordmark, the pet's name, the moon with the Chi and a small ring of
  // gremlins, TAP TO PLAY. The whole screen is the button.
  function drawTitleWatch() {
    titleT += FDT;
    var t = titleT;
    if (GROUND) { var tile = GT_M * PXM; for (var x = -((t * 14) % tile); x < W; x += tile) for (var y = -((t * 8) % tile); y < H; y += tile) ctx.drawImage(GROUND, x, y, tile + 0.5, tile + 0.5); }
    ctx.fillStyle = "rgba(14,6,34,0.3)"; ctx.fillRect(0, 0, W, H);
    var l = SA.l + WEDGE, r = W - SA.r - WEDGE, safeT = SA.t + WEDGE, safeB = H - SA.b - WEDGE, cx = W / 2;
    var la = WT.display * 1.3, lb = WT.display * 1.1, yA = safeT + la * 0.45, yB = yA + WT.display * 1.02;
    var nameY = yB + lb * 0.5 + WGAP * 0.5 + WT.cap * 0.5;
    var ctaY = safeB - WT.title / 2, bestY = ctaY - WT.title / 2 - WGAP * 0.5 - WT.cap / 2;
    var heroTop = nameY + WT.cap / 2 + WGAP, heroBot = (best > 0 ? bestY - WT.cap / 2 : ctaY - WT.title / 2) - WGAP;
    var hcy = (heroTop + heroBot) / 2, ps = clamp((heroBot - heroTop) * 0.58, 22, 64), moonR = Math.min(W * 0.3, (heroBot - heroTop) * 0.5);
    var mg = ctx.createRadialGradient(cx, hcy, 0, cx, hcy, moonR * 2.2);
    mg.addColorStop(0, "rgba(255,244,214,0.55)"); mg.addColorStop(0.35, "rgba(190,170,255,0.22)"); mg.addColorStop(1, "rgba(120,100,220,0)");
    ctx.fillStyle = mg; ctx.fillRect(cx - moonR * 2.2, hcy - moonR * 2.2, moonR * 4.4, moonR * 4.4);
    ctx.beginPath(); ctx.arc(cx, hcy - ps * 0.1, moonR * 0.62, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,246,220,0.16)"; ctx.fill();
    // a small ring of gremlins circling the Chi, drawn back to front around the hero
    var ringR = Math.min(W * 0.36, ps * 1.15), list = [];
    for (var i = 0; i < 7; i++) {
      var a = t * 0.35 + (i / 7) * Math.PI * 2, kind = i === 0 ? "brute" : i === 3 ? "sprint" : i === 5 ? "spitter" : "imp";
      list.push({ kind: kind, x: cx + Math.cos(a) * ringR, y: hcy + ps * 0.2 + Math.sin(a) * ringR * 0.55, i: i });
    }
    list.sort(function (p1, p2) { return p1.y - p2.y; });
    var heroY = hcy + ps * 0.2, drawn = false;
    function drawHero() {
      var face = Math.floor(t * 0.6) % 5 === 4 ? "aim" : Math.floor(t * 1.7) % 9 === 8 ? "blink" : "idle";
      var hop = Math.abs(Math.sin(t * 3.2)) * ps * 0.05;
      ctx.drawImage(FIT.shadow, cx - ps * 0.42, heroY + ps * 0.3, ps * 0.84, ps * 0.22);
      glowAt(FX.gGreen, cx, hcy, ps * 0.9, 0.22);
      wHero(face, cx, hcy - hop, ps);
    }
    for (i = 0; i < list.length; i++) {
      var g = list[i];
      if (!drawn && g.y > heroY) { drawHero(); drawn = true; }
      var F = FIT.grem[g.kind], spr = g.x > cx ? F.L : F.R, bob = Math.abs(Math.sin(t * 7 + g.i)) * 3;
      ctx.drawImage(FIT.shadow, g.x - spr.w * 0.3, g.y + spr.h * 0.18, spr.w * 0.6, spr.h * 0.14);
      ctx.drawImage(spr.c, g.x - spr.ax, g.y - spr.ay - bob, spr.w, spr.h);
    }
    if (!drawn) drawHero();
    for (i = 0; i < 10; i++) {
      var fx = (i * 211.7 + Math.sin(t * 0.5 + i) * 30) % W, fy = (i * 97.3 + Math.cos(t * 0.4 + i) * 30 + t * 6) % H, fl = 0.5 + 0.5 * Math.sin(t * 2 + i);
      glowAt(i % 3 ? FX.gWarm : FX.gGreen, fx, fy, 6, 0.2 + fl * 0.4);
    }
    if (VIG) ctx.drawImage(VIG, 0, 0, W, H);
    var wob = 1 + Math.sin(t * 2) * 0.012;
    txt(ctx, TITLE_A, cx, yA, fitSize(TITLE_A, la, r - l) * wob, "#FFD23A", "#160B2B", "center", { sw: la * 0.2 });
    if (TITLE_B) txt(ctx, TITLE_B, cx, yB, fitSize(TITLE_B, lb, r - l) * wob, "#FF8A3D", "#160B2B", "center", { sw: lb * 0.22 });
    var nm = BOOT.name.toUpperCase() + "  " + BOOT.number;
    txt(ctx, nm, cx, nameY, fitSize(nm, WT.cap, r - l), "#FFFFFF", "#160B2B", "center");
    if (best > 0) txt(ctx, "BEST " + Math.floor(best / 60) + ":" + (best % 60 < 10 ? "0" : "") + (best % 60), cx, bestY, WT.cap, "#FFD23A", "#160B2B", "center");
    var pulse = 1 + Math.sin(t * 5) * 0.05;
    txt(ctx, "TAP TO PLAY", cx, ctaY, fitSize("TAP TO PLAY", WT.title, r - l) * pulse, "#FFFFFF", "#160B2B", "center");
    wbRect(0, 0, W, H, startRun);
  }
  // Level up on a wrist: one card at a time, prev and next arrows, a TAKE pill. The card itself is
  // a target too. Rerolls stay on the phone (no room for a third 44 px control).
  function drawLevelUpWatch() {
    var C = CARDS; C.t += FDT;
    if (C.w === undefined) C.w = 0;
    ctx.fillStyle = "rgba(14,6,34," + Math.min(0.72, C.t * 3) + ")"; ctx.fillRect(0, 0, W, H);
    var n = C.list.length, i = clamp(C.w, 0, n - 1);
    var l = SA.l + WEDGE, r = W - SA.r - WEDGE, top = SA.t + WEDGE, headY = top + WT.title / 2;
    txt(ctx, "LEVEL UP!", l, headY, WT.title * (C.t < 0.3 ? A.backOut(C.t / 0.3) : 1), "#FFD23A", "#160B2B", "left");
    txt(ctx, (i + 1) + "/" + n, r, headY, WT.body, "#FFFFFF", "#160B2B", "right");
    var rowY = H - SA.b - WEDGE - WBTN, cy0 = top + WT.title + WGAP, ch = rowY - WBTN - WGAP - cy0;
    var rc = { x: l, y: cy0 + Math.max(0, (ch - 130) / 2), w: r - l, h: Math.min(ch, 130) };
    drawCardWatch(C.list[i], rc, (C.t - 0.05) / 0.28, C.picked === i);
    var armed = C.t >= C.armedAt && C.picked < 0;
    var take = function () { pickWatch(i); };
    if (armed) wbRect(rc.x, rc.y, rc.w, rc.h, take);
    if (i > 0) wRound(l + WBTN, rowY, wIconPrev, function () { C.w = i - 1; });
    if (i < n - 1) wRound(r - WBTN, rowY, wIconNext, function () { C.w = i + 1; });
    wPill(l + WBTN * 2 + WGAP, r - WBTN * 2 - WGAP, rowY, "TAKE", armed ? take : null);
    if (C.picked >= 0) { C.pickT += FDT; if (C.pickT > 0.22) { grant(C.list[C.picked]); CARDS = null; mode = "play"; S.slow = 0.35; S.slowT = 0.35; } }
  }
  function pickWatch(i) { if (CARDS && CARDS.picked < 0 && CARDS.t >= CARDS.armedAt) { CARDS.picked = i; CARDS.pickT = 0; Au.pickCard(); } }
  function drawCardWatch(id, rc, k, sel) {
    var it = ITEMS[id] || { name: "SNACK BREAK", kind: "h", desc: ["Heal 40."], max: 1 }, cur = lv(id), col = cardColors(it);
    var kk = clamp(k, 0, 1); if (kk <= 0) return;
    ctx.save();
    var cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2, sc = backOut2(kk, 1.5) * (sel ? 1.04 : 1);
    ctx.globalAlpha = Math.min(1, kk * 3);
    ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
    rrect(ctx, rc.x, rc.y + 3, rc.w, rc.h, 12); ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fill();
    rrect(ctx, rc.x, rc.y, rc.w, rc.h, 12); ctx.fillStyle = col[0]; ctx.fill(); ctx.strokeStyle = col[1]; ctx.lineWidth = 3; ctx.stroke();
    var pad = WGAP, isz = Math.min(34, rc.h * 0.36);
    rrect(ctx, rc.x + pad, rc.y + pad, isz, isz, 9); ctx.fillStyle = rgba(col[1], 0.18); ctx.fill();
    ctx.drawImage(icon(id === "heal" ? "heart" : id), rc.x + pad + 3, rc.y + pad + 3, isz - 6, isz - 6);
    var tx = rc.x + pad + isz + WGAP, tw = rc.x + rc.w - pad - tx;
    txt(ctx, it.name, tx, rc.y + pad + WT.label * 0.55, fitSize(it.name, WT.label, tw), "#FFFFFF", col[1], "left", { sw: 3.5 });
    var tag = it.kind === "e" ? "EVOLUTION!" : cur ? "LV " + (cur + 1) : "NEW!";
    ctx.font = WT.cap + "px " + FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = col[1];
    ctx.fillText(tag, tx, rc.y + pad + WT.label * 1.1 + WT.cap * 0.65);
    var d = it.desc[Math.min(cur, it.desc.length - 1)] || it.desc[0];
    ctx.font = "600 " + WT.cap + "px ui-rounded, system-ui, -apple-system, sans-serif"; ctx.fillStyle = "#2A1A14";
    wrapText(d, rc.x + pad, rc.y + pad + isz + WGAP + WT.cap * 0.6, rc.w - pad * 2, WT.cap * 1.25, "left");
    if (it.max > 1) { for (var i = 0; i < it.max; i++) { var px = rc.x + rc.w - pad - (it.max - i) * 10 + 4, py = rc.y + rc.h - pad - 4; ell(ctx, px, py, 3.5, 3.5); ctx.fillStyle = i <= cur ? (i === cur ? "#FFFFFF" : col[1]) : rgba(col[1], 0.2); ctx.fill(); if (i === cur) { ctx.strokeStyle = col[1]; ctx.lineWidth = 1.5; ctx.stroke(); } } }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  // A chest prize on a wrist: one compact row per item (icon, name, level), then TAP TO KEEP GOING
  // with the whole screen as the button.
  function drawCardRowWatch(id, rc, k) {
    var it = ITEMS[id] || { name: "SNACK BREAK", kind: "h" }, cur = lv(id), col = cardColors(it);
    var kk = clamp(k, 0, 1); if (kk <= 0) return;
    ctx.save();
    var cx = rc.x + rc.w / 2, cy = rc.y + rc.h / 2, sc = backOut2(kk, 1.5);
    ctx.globalAlpha = Math.min(1, kk * 3);
    ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
    rrect(ctx, rc.x, rc.y, rc.w, rc.h, 10); ctx.fillStyle = col[0]; ctx.fill(); ctx.strokeStyle = col[1]; ctx.lineWidth = 2.5; ctx.stroke();
    var isz = rc.h - 8;
    rrect(ctx, rc.x + 4, rc.y + 4, isz, isz, 7); ctx.fillStyle = rgba(col[1], 0.18); ctx.fill();
    ctx.drawImage(icon(id === "heal" ? "heart" : id), rc.x + 6, rc.y + 6, isz - 4, isz - 4);
    var tx = rc.x + 4 + isz + WGAP, tw = rc.x + rc.w - 6 - tx;
    txt(ctx, it.name, tx, cy - WT.cap * 0.55, fitSize(it.name, WT.body, tw), "#FFFFFF", col[1], "left", { sw: 3 });
    var tag = it.kind === "e" ? "EVOLUTION!" : cur ? "LV " + (cur + 1) : "NEW!";
    ctx.font = WT.cap + "px " + FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = col[1]; ctx.fillText(tag, tx, cy + WT.cap * 0.6);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  function keepGoing() {
    if (!(mode === "chest" && CHEST && CHEST.ready)) return;
    CHEST.prize.forEach(function (id) { grant(id); });
    CHEST = null; mode = "play"; S.slow = 0.35; S.slowT = 0.35;
  }
  function drawChestRevealWatch(C, k2, n, cx) {
    var l = SA.l + WEDGE, r = W - SA.r - WEDGE, top = SA.t + WEDGE;
    var head = C.evo ? "EVOLUTION!" : "TREASURE!";
    txt(ctx, head, cx, top + WT.title / 2, fitSize(head, WT.title, r - l) * backOut2(k2 / 0.3, 2), C.evo ? "#FF6FB5" : "#FFD23A", "#160B2B", "center");
    var rowH = 38, gap = WGAP, tot = n * rowH + (n - 1) * gap, y0 = top + WT.title + WGAP * 2;
    var footY = H - SA.b - WEDGE - WT.body / 2, avail = footY - WT.body / 2 - WGAP - y0;
    if (tot > avail) { rowH = Math.max(26, (avail - (n - 1) * gap) / n); tot = n * rowH + (n - 1) * gap; }
    y0 += Math.max(0, (avail - tot) / 2);
    for (var i = 0; i < n; i++) drawCardRowWatch(C.prize[i], { x: l, y: y0 + i * (rowH + gap), w: r - l, h: rowH }, (k2 - i * 0.18) / 0.32);
    C.ready = k2 > 0.6 + n * 0.18;
    if (C.ready) {
      txt(ctx, "TAP TO KEEP GOING", cx, footY, fitSize("TAP TO KEEP GOING", WT.body, r - l) * (1 + Math.sin(C.t * 6) * 0.04), "#FFFFFF", "#160B2B", "center");
      wbRect(0, 0, W, H, keepGoing);
    }
  }
  // Pause on a wrist: three full-width 44 px pills, anchored to the bottom.
  function pauseBtnsWatch() {
    var l = SA.l + WEDGE, r = W - SA.r - WEDGE, h = WBTN * 2, y2 = H - SA.b - WEDGE - h, y1 = y2 - WGAP - h, y0 = y1 - WGAP - h;
    return [
      { id: "resume", x: l, y: y0, w: r - l, h: h, label: "RESUME", fill: "#7BEA5A", ink: "#1A4A08" },
      { id: "sound", x: l, y: y1, w: r - l, h: h, label: "SOUND " + (Au.muted ? "OFF" : "ON"), fill: "rgba(255,255,255,0.14)", ink: "#160B2B" },
      { id: "shake", x: l, y: y2, w: r - l, h: h, label: "SHAKE " + (SHAKE_ON ? "ON" : "OFF"), fill: "rgba(255,255,255,0.14)", ink: "#160B2B" },
    ];
  }
  function pauseTap(id) {
    if (id === "sound") { Au.setMute(!Au.muted); return; }
    if (id === "shake") { SHAKE_ON = !SHAKE_ON; try { localStorage.setItem("gnight:shake", SHAKE_ON ? "1" : "0"); } catch (e) { /* storage blocked */ } return; }
    if (id === "resume") mode = "play";
  }
  function drawPauseWatch() {
    ctx.fillStyle = "rgba(14,6,34,0.78)"; ctx.fillRect(0, 0, W, H);
    var top = SA.t + WEDGE, B = pauseBtnsWatch();
    txt(ctx, "PAUSED", W / 2, top + WT.title / 2, WT.title, "#FFFFFF", "#160B2B", "center");
    var ps = Math.min(44, B[0].y - WGAP - (top + WT.title + WGAP));
    if (ps >= 20) wHero("blink", W / 2, top + WT.title + WGAP + ps / 2, ps);
    B.forEach(function (b) {
      rrect(ctx, b.x, b.y, b.w, b.h, b.h / 2); ctx.fillStyle = b.fill; ctx.fill();
      if (b.id === "resume") { ctx.strokeStyle = b.ink; ctx.lineWidth = 2.5; ctx.stroke(); }
      txt(ctx, b.label, W / 2, b.y + b.h / 2 + 1, fitSize(b.label, b.id === "resume" ? WT.label : WT.body, b.w - WGAP * 2), "#FFFFFF", b.ink, "center");
      wbRect(b.x, b.y, b.w, b.h, function () { pauseTap(b.id); });
    });
  }
  // The end of a night on a wrist: the verdict, the Chi, three stats counting up, AGAIN. The best
  // combo row stays on the phone.
  function drawEndWatch() {
    S.endT += FDT;
    var win = mode === "win", t = S.endT, k = Math.min(1, t * 2);
    ctx.fillStyle = win ? "rgba(36,14,58," + 0.8 * k + ")" : "rgba(14,6,34," + 0.86 * k + ")"; ctx.fillRect(0, 0, W, H);
    var l = SA.l + WEDGE, r = W - SA.r - WEDGE, top = SA.t + WEDGE, cx = W / 2;
    var rows = [["TIME", Math.floor(S.t), "time"], ["GREMLINS", S.kills, "n"], ["LEVEL", S.lvl, "n"]];
    var rowH = WT.body + 4, btnH = WBTN * 2, btnY = H - SA.b - WEDGE - btnH;
    var titleY = top + WT.title / 2, subY = titleY + WT.title / 2 + 2 + WT.cap / 2;
    var rowsTop = btnY - WGAP - rows.length * rowH;
    var petTop = subY + WT.cap / 2 + 3, petBot = rowsTop - 3, ps = clamp(petBot - petTop, 0, 44), pcy = (petTop + petBot) / 2;
    if (win) {
      var rise = backOut2(clamp(t / 1.2, 0, 1), 0.8), sy = lerp(H * 0.9, pcy + ps * 0.3, rise);
      var sg = ctx.createRadialGradient(cx, sy, 0, cx, sy, ps * 1.3);
      sg.addColorStop(0, "rgba(255,240,170,0.95)"); sg.addColorStop(0.45, "rgba(255,180,90,0.55)"); sg.addColorStop(1, "rgba(255,120,90,0)");
      ctx.fillStyle = sg; ctx.fillRect(cx - ps * 1.4, sy - ps * 1.4, ps * 2.8, ps * 2.8);
      rays(cx, sy, 0.06 * k, "255,220,140", 0.25);
      if (!S.endConf) { S.endConf = true; confetti(90, W / 2, H * 0.65, 1.3); }
      if (t > 1 && t < 6 && Math.floor(t * 4) !== Math.floor((t - FDT) * 4)) confetti(8, rand(0, W), H + 10, 0.4);
    }
    var hopY = win ? Math.abs(Math.sin(t * 5)) * 4 : 0;
    if (ps >= 16) wHero(win ? "happy" : "dizzy", cx, pcy - hopY, ps);
    if (!win && ps >= 16) for (var z = 0; z < 3; z++) { var za = t * 3 + z * 2.1; ctx.fillStyle = "#FFE45C"; A.star5(ctx, cx + Math.cos(za) * ps * 0.5, pcy - ps * 0.3 + Math.sin(za) * ps * 0.1, 4, 0.5); ctx.fill(); }
    var head = win ? "DAWN!" : "KNOCKED OUT";
    txt(ctx, head, cx, titleY, fitSize(head, WT.title, r - l) * backOut2(t / 0.35, 2), win ? "#FFE45C" : "#FF8AA6", "#160B2B", "center");
    var sub = win ? BOOT.name + " survived the night" : BOOT.name + " needs a nap";
    txt(ctx, sub, cx, subY, fitSize(sub, WT.cap, r - l), "#FFFFFF", "#160B2B", "center");
    for (var i = 0; i < rows.length; i++) {
      var st = 0.5 + i * 0.35, rk = clamp((t - st) / 0.6, 0, 1); if (t < st) continue;
      var v = Math.round(rows[i][1] * (1 - Math.pow(1 - rk, 3))), shown = rows[i][2] === "time" ? Math.floor(v / 60) + ":" + (v % 60 < 10 ? "0" : "") + (v % 60) : fmt(v);
      var yy = rowsTop + i * rowH + rowH / 2;
      ctx.globalAlpha = clamp((t - st) * 5, 0, 1);
      ctx.font = WT.cap + "px " + FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.fillText(rows[i][0], l, yy);
      txt(ctx, shown, r, yy, WT.body, "#FFD23A", "#160B2B", "right");
      ctx.globalAlpha = 1;
      if (rk < 1 && Math.floor(t * 20) !== Math.floor((t - FDT) * 20)) Au.tick(i * 2);
    }
    var bAt = 0.5 + rows.length * 0.35 + 0.5;
    if (S.newBest && t > bAt) {
      var bk = backOut2((t - bAt) / 0.35, 2.5), bx = cx + ps * 0.5 + 16, bby = pcy - ps * 0.25;
      if (!S.bestFx) { S.bestFx = true; confetti(40, bx, bby, 1); Au.fanfare(); }
      ctx.save(); ctx.translate(bx, bby); ctx.rotate(0.2 + Math.sin(t * 3) * 0.05); ctx.scale(bk, bk);
      A.star5(ctx, 0, 0, 16, 0.72); A.fillStroke(ctx, "#FF5CA8", "#5A0A3E", 2);
      txt(ctx, "NEW", 0, -4, 7, "#FFFFFF", "#5A0A3E", "center", { shadow: false, sw: 2 }); txt(ctx, "BEST", 0, 4, 7, "#FFFFFF", "#5A0A3E", "center", { shadow: false, sw: 2 });
      ctx.restore();
    }
    if (t > bAt) {
      var bp = backOut2((t - bAt) / 0.3, 1.8) * (1 + Math.sin(t * 5) * 0.025), bcy = btnY + btnH / 2;
      ctx.save(); ctx.translate(cx, bcy); ctx.scale(bp, bp); ctx.translate(-cx, -bcy);
      wPill(l, r, bcy, win ? "PLAY AGAIN" : "AGAIN", startRun);
      ctx.restore();
    }
  }

  function uiTap(x, y) {
    if (WATCH) {
      for (var wi = WB.length - 1; wi >= 0; wi -= 1) if (wbHit(WB[wi], x, y)) { WB[wi].fn(); return; }
      return;
    }
    if (mode === "title") { newRun(); mode = "play"; Au.music(true, 0); return; }
    if (mode === "pause") {
      var hit = null; pauseBtns().forEach(function (b) { if (x >= b.x && x <= b.x + b.w && y >= b.y - 6 && y <= b.y + b.h + 6) hit = b.id; });
      if (hit === "sound") { Au.setMute(!Au.muted); return; }
      if (hit === "shake") { SHAKE_ON = !SHAKE_ON; try { localStorage.setItem("gnight:shake", SHAKE_ON ? "1" : "0"); } catch (e) { /* storage blocked */ } return; }
      if (hit === "resume") { mode = "play"; }
      return;
    }
    if (mode === "levelup" && CARDS && CARDS.picked < 0) {
      if (CARDS.t < CARDS.armedAt) return;
      var rects = cardRects(CARDS.list.length);
      for (var i = 0; i < rects.length; i++) { var rc = rects[i]; if (x >= rc.x && x <= rc.x + rc.w && y >= rc.y && y <= rc.y + rc.h) { CARDS.picked = i; CARDS.pickT = 0; Au.pickCard(); return; } }
      var last = rects[rects.length - 1], ry = portrait ? last.y + last.h + 34 * U : last.y + last.h + 30 * U;
      if (S.rerolls > 0 && Math.abs(y - ry) < 26 * U && Math.abs(x - W / 2) < 90 * U) { S.rerolls -= 1; CARDS.list = rollCards(CARDS.list.length); CARDS.t = 0.1; Au.tick(4); }
      return;
    }
    if (mode === "chest" && CHEST && CHEST.ready) { var cn = CHEST.prize.length; CHEST.prize.forEach(function (id, i) { grant(id); flyTo(id, W / 2, H * 0.5 + (i - (cn - 1) / 2) * 60 * U, 70 * U); }); CHEST = null; mode = "play"; S.slow = 0.35; S.slowT = 0.35; return; }
    if ((mode === "dead" || mode === "win") && S.endBtnX !== undefined) { var EB2 = endButton(); if (Math.abs(x - S.endBtnX) < EB2.w / 2 + 8 && y > EB2.y - 8 && y < EB2.y + EB2.h + 8) { newRun(); mode = "play"; Au.music(true, 0); } }
  }

  // ---------------------------------------------------------------- loop
  var lastT = 0, FIXED = 1 / 60, fpsShow = 60, fpsAcc = 0, fpsN = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.1, (now - (lastT || now)) / 1000); lastT = now;
    fpsAcc += dt; fpsN += 1; if (fpsAcc > 0.5) { fpsShow = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    var t0 = performance.now();
    FDT = dt;
    // variable step, split into slices of at most 1/60 s: smooth on 60, 90 and 120 Hz screens alike
    if (mode === "play") { var n = Math.max(1, Math.ceil(dt / FIXED - 0.01)), h = dt / n; for (var si = 0; si < n && mode === "play"; si++) step(h); PERF.step = PERF.step * 0.95 + ((performance.now() - t0) / n) * 0.05; }
    else if (S && (mode === "chest" || mode === "dead" || mode === "win")) { // keep the confetti alive behind overlays
      for (var i = S.FXs.length - 1; i >= 0; i--) { var f = S.FXs[i]; f.t += dt; if (f.t >= f.life) S.FXs.splice(i, 1); else if (f.k !== "ring") { f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 0.94; f.vy *= 0.94; } }
      S.realT += dt;
    }
    var t1 = performance.now();
    draw();
    PERF.draw = PERF.draw * 0.95 + (performance.now() - t1) * 0.05;
  }
  var PERF = { step: 0, draw: 0 };
  var resizeQueued = false;
  window.addEventListener("resize", function () { if (resizeQueued) return; resizeQueued = true; requestAnimationFrame(function () { resizeQueued = false; if (window.innerWidth !== W || window.innerHeight !== H) resize(); }); });
  var PET_WRr = PET_WR; // eslint quiet
  void PET_WRr;
  function boot() {
    resize();
    document.getElementById("boot").style.display = "none";
    requestAnimationFrame(frame);
    if (!DEV) return;
    if (Q.get("autostart") === "1") { newRun(); mode = "play"; }
    window.__GN = { get S() { return S; }, get mode() { return mode; }, setMode: function (m) { mode = m; }, openLevelUp: function () { openLevelUp(); }, openChest: openChest, grant: function (id) { grant(id); }, trySpecial: trySpecial, INP: INP, get cards() { return CARDS && CARDS.list; }, pick: function (i) { if (CARDS && CARDS.picked < 0) { CARDS.picked = i; CARDS.pickT = 0; } }, PERF: PERF, spawn: function (k, n) { for (var i = 0; i < n; i++) { var a = Math.random() * 6.28, r = 4 + Math.random() * 8; spawn(k, S.p.x + Math.cos(a) * r, S.p.y + Math.sin(a) * r); } } };
    // for the watch screenshot pass (scripts/night-watch-shots.ts)
    window.__GN.watch = function () { return WATCH; };
    window.__GN.size = function () { return { W: W, H: H }; };
    window.__GN.buttons = function () {
      var out = WB.map(function (b) { return b.r ? { x: b.x - b.r, y: b.y - b.r, w: b.r * 2, h: b.r * 2 } : { x: b.x, y: b.y, w: b.w, h: b.h }; });
      if (mode === "play") btns().forEach(function (b) { if (b.on) out.push({ x: b.x - b.r, y: b.y - b.r, w: b.r * 2, h: b.r * 2 }); });
      return out;
    };
  }
  try {
    var ff = new FontFace("Lilita", "url(" + (BOOT.font || "lilita.ttf") + ")");
    ff.load().then(function (f) { document.fonts.add(f); boot(); }, boot);
  } catch (e) { boot(); }
})();
