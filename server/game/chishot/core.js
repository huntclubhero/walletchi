/*
 * CHI SHOT core: physics, materials, damage, powers and the level set.
 * No drawing and no DOM here, so the levels can be simulated headless (see
 * server/scripts/chishot-levels-check.ts). Box2D via planck.js, y is UP,
 * units are metres, the ground is y = 0 and the sling stands at x = 0.
 */
(function (root) {
  "use strict";
  var pl = root.planck;

  var MATS = {
    wood: { density: 0.7, friction: 0.75, restitution: 0.04, hp: 7, score: 500 },
    stone: { density: 2.1, friction: 0.85, restitution: 0.02, hp: 18, score: 800 },
    glass: { density: 0.8, friction: 0.35, restitution: 0.08, hp: 1.8, score: 300 },
    tnt: { density: 0.6, friction: 0.7, restitution: 0.04, hp: 1.6, score: 1000 },
  };
  var GREMS = {
    imp: { r: 0.42, density: 0.9, hp: 3.6, score: 5000 },
    brute: { r: 0.74, density: 1.0, hp: 12, score: 8000 },
    king: { r: 1.0, density: 1.0, hp: 22, score: 15000 },
  };

  var PET_R = 0.55;
  var PET_DENSITY = 3;
  var SLING = { x: 0, y: 2.6 };
  var MAX_PULL = 2.2; // the pet follows the finger inside this circle (Angry Birds style)
  var VMAX = 21;
  var G = 10;
  var STEP = 1 / 60;
  var MIN_IMPULSE = 0.3; // below this a contact is a touch, not a hit
  var HIT_WINDOW = 3; // steps after a contact begins that its impulse counts as damage
  var GRACE_STEPS = 100; // the fort settles under gravity before anything can break
  var POWERS = { Round: "TURBO", Ears: "TRIPLE", Horns: "RAM", Tail: "SLAM" };
  // Every fort is authored around x = 14..22 and shifted this far toward the sling,
  // so a phone held upright frames the sling and the fort's front together.
  var LEVEL_DX = -2.5;

  // ---- level builder ------------------------------------------------------
  function Builder(game) {
    this.g = game;
  }
  Builder.prototype.box = function (x, y, w, h, mat, angle) {
    var m = MATS[mat];
    var body = this.g.world.createBody({ type: "dynamic", position: { x: x + LEVEL_DX, y: y }, angle: angle || 0 });
    body.createFixture(new pl.Box(w / 2, h / 2), { density: m.density, friction: m.friction, restitution: m.restitution });
    body.setAngularDamping(0.15);
    var e = { kind: mat === "tnt" ? "tnt" : "block", mat: mat, w: w, h: h, hp: m.hp, maxHp: m.hp, body: body, seed: this.g.ents.length * 7919 + 13 };
    body.setUserData(e);
    this.g.ents.push(e);
    return e;
  };
  Builder.prototype.tnt = function (x, y) {
    return this.box(x, y + 0.4, 0.8, 0.8, "tnt");
  };
  // Static rock pedestal: x is the centre, y the TOP surface.
  Builder.prototype.rock = function (x, top, w) {
    var h = top;
    var body = this.g.world.createBody({ type: "static", position: { x: x + LEVEL_DX, y: top - h / 2 } });
    body.createFixture(new pl.Box(w / 2, h / 2), { friction: 0.9 });
    var e = { kind: "rock", w: w, h: h, body: body, seed: this.g.ents.length * 104729 + 7 };
    body.setUserData(e);
    this.g.ents.push(e);
    return top;
  };
  // A gremlin standing on `floor` (its feet at that height).
  Builder.prototype.grem = function (x, floor, kind) {
    var k = GREMS[kind || "imp"];
    var body = this.g.world.createBody({ type: "dynamic", position: { x: x + LEVEL_DX, y: floor + k.r } });
    body.createFixture(new pl.Circle(k.r), { density: k.density, friction: 0.8, restitution: 0.1 });
    body.setAngularDamping(1.2);
    var e = { kind: "grem", type: kind || "imp", r: k.r, hp: k.hp, maxHp: k.hp, body: body, seed: this.g.ents.length * 31 + 5 };
    body.setUserData(e);
    this.g.ents.push(e);
    this.g.gremsTotal++;
    return e;
  };
  // Two posts and a slab: the basic Angry Birds bay. Returns the slab's top height.
  Builder.prototype.frame = function (cx, base, w, h, mat, slabMat) {
    var pw = 0.3, sh = 0.3;
    this.box(cx - w / 2 + pw / 2, base + h / 2, pw, h, mat);
    this.box(cx + w / 2 - pw / 2, base + h / 2, pw, h, mat);
    this.box(cx, base + h + sh / 2, w + 0.2, sh, slabMat || mat);
    return base + h + sh;
  };

  var LEVELS = [
    {
      name: "SNACK SHACK", shots: 3, theme: "day",
      build: function (b) {
        var top = b.frame(15, 0, 2.4, 1.6, "wood");
        b.grem(15, 0);
        b.grem(15, top);
      },
    },
    {
      name: "GLASS HOUSE", shots: 3, theme: "day",
      build: function (b) {
        var t1 = b.frame(14, 0, 2.2, 1.4, "glass", "wood");
        var t2 = b.frame(14, t1, 2.2, 1.4, "glass", "wood");
        b.grem(14, 0);
        b.grem(14, t1);
        b.grem(14, t2);
        b.frame(17.4, 0, 2.0, 1.2, "glass", "glass");
        b.grem(17.4, 0);
      },
    },
    {
      name: "TNT PARTY", shots: 3, theme: "day",
      build: function (b) {
        b.frame(14, 0, 2.4, 1.5, "wood");
        b.tnt(13.55, 0);
        b.grem(14.5, 0);
        var t1 = b.frame(17.6, 0, 2.2, 1.5, "wood");
        b.tnt(17.6, 0);
        var t2 = b.frame(17.6, t1, 2.2, 1.5, "wood");
        b.grem(17.6, t1);
        b.grem(17.6, t2);
        b.tnt(20.4, 0);
        b.grem(21.4, 0);
      },
    },
    {
      name: "ROCK FORT", shots: 3, theme: "sunset",
      build: function (b) {
        var top = b.rock(17, 1.5, 5.2);
        var a = b.frame(15.6, top, 2.0, 1.4, "stone", "wood");
        b.frame(18.4, top, 2.0, 1.4, "stone", "wood");
        b.grem(15.6, top);
        b.grem(18.4, top);
        b.grem(15.6, a);
        b.box(18.4, a + 0.35, 0.7, 0.7, "stone");
      },
    },
    {
      name: "TALL TOWER", shots: 3, theme: "sunset",
      build: function (b) {
        // a stone shield in front, a light wooden tower behind it, a brute hiding at the back
        b.box(14.6, 1.2, 0.6, 2.4, "stone");
        b.box(14.6, 2.65, 0.6, 0.5, "stone");
        var y = 0;
        var mats = ["wood", "wood", "glass"];
        for (var i = 0; i < mats.length; i++) {
          var next = b.frame(17.4, y, 2.2, 1.3, mats[i], "wood");
          b.grem(17.4, y);
          y = next;
        }
        b.grem(17.4, y);
        b.grem(20.2, 0, "brute");
      },
    },
    {
      name: "TWIN TOWERS", shots: 3, theme: "sunset",
      build: function (b) {
        var xs = [14.2, 20.2];
        for (var k = 0; k < 2; k++) {
          var y = 0;
          var mats = k === 0 ? ["wood", "glass", "wood"] : ["stone", "wood", "glass"];
          for (var i = 0; i < 3; i++) {
            var next = b.frame(xs[k], y, 2.0, 1.25, mats[i], "wood");
            if (i !== 1) b.grem(xs[k], y);
            y = next;
          }
          b.grem(xs[k], y);
        }
        b.grem(17.2, 0, "brute");
      },
    },
    {
      name: "THE BUNKER", shots: 3, theme: "night",
      build: function (b) {
        var t1 = b.frame(17, 0, 3.4, 1.7, "stone", "stone");
        b.grem(17, 0, "brute");
        var t2 = b.frame(17, t1, 2.4, 1.3, "glass", "wood");
        b.grem(17, t1);
        b.grem(17, t2);
        // a stone wall in front; the only TNT sits BEHIND the bunker, so it takes a lob to use it
        b.box(14.5, 0.9, 0.5, 1.8, "stone");
        b.box(14.5, 2.05, 0.5, 0.5, "stone");
        b.tnt(19.9, 0);
        b.frame(22.2, 0, 2.0, 1.4, "wood");
        b.grem(22.2, 0);
      },
    },
    {
      name: "GREMLIN KING", shots: 4, theme: "night",
      build: function (b) {
        var top = b.rock(20, 1.0, 6.4);
        b.frame(18.2, top, 2.2, 1.6, "stone", "stone");
        b.frame(21.8, top, 2.2, 1.6, "stone", "stone");
        b.box(20, top + 1.6 + 0.3 + 0.15, 6.6, 0.3, "wood");
        b.grem(20, top + 1.6 + 0.3 + 0.3, "king");
        b.grem(18.2, top);
        b.grem(21.8, top);
        b.tnt(20, top);
        b.frame(14.4, 0, 2.0, 1.4, "wood", "glass");
        b.grem(14.4, 0);
      },
    },
    {
      name: "IRON KEEP", shots: 3, theme: "night",
      build: function (b) {
        // a stone wall, then a two-storey stone keep: the brute sits in the vault
        b.box(14.2, 1.0, 0.6, 2.0, "stone");
        var t1 = b.frame(17.5, 0, 3.0, 1.7, "stone", "stone");
        b.grem(17.5, 0, "brute");
        var t2 = b.frame(17.5, t1, 2.4, 1.3, "stone", "wood");
        b.grem(17.5, t1);
        b.grem(17.5, t2);
        b.frame(21, 0, 2.2, 1.4, "glass", "stone");
        b.grem(21, 0);
      },
    },
    {
      name: "KING'S REVENGE", shots: 4, theme: "night",
      build: function (b) {
        // the King rebuilt on a raised throne, flanked by two brutes, a TNT trap beneath him
        var top = b.rock(19, 1.2, 7.2);
        b.box(14.4, 1.1, 0.6, 2.2, "stone");
        b.box(14.4, 2.45, 0.6, 0.5, "stone");
        b.frame(17.0, top, 2.4, 1.7, "stone", "stone");
        b.grem(17.0, top, "brute");
        b.frame(21.0, top, 2.4, 1.7, "stone", "stone");
        b.grem(21.0, top, "brute");
        b.tnt(22.85, top);
        var top2 = top + 1.7 + 0.3 + 0.3;
        b.box(19, top + 1.7 + 0.3 + 0.15, 6.6, 0.3, "wood");
        b.grem(19, top2, "king");
        b.grem(16.4, top2);
        b.grem(21.6, top2);
      },
    },
  ];

  // ---- the game ------------------------------------------------------------
  function Game(levelIndex, petShape, ev) {
    var self = this;
    this.ev = ev || {};
    this.level = LEVELS[levelIndex];
    this.levelIndex = levelIndex;
    this.power = POWERS[petShape] || "TURBO";
    this.world = new pl.World({ gravity: { x: 0, y: -G } });
    this.ents = [];
    this.gremsTotal = 0;
    this.gremsKilled = 0;
    this.blockScoreTotal = 0;
    this.score = 0;
    this.stepNo = 0;
    this.acc = 0;
    this.shotsLeft = this.level.shots;
    this.state = "aim"; // aim | flying | settle | won | lost
    this.pets = []; // pets in the air this shot
    this.spent = []; // pets from earlier shots, still lying in the world
    this.powerUsed = false;
    this.doneT = 0;
    this.settleT = 0;
    this.wonT = -1;
    this.queue = [];
    var ground = this.world.createBody();
    ground.createFixture(new pl.Edge({ x: -60, y: 0 }, { x: 160, y: 0 }), { friction: 0.9 });
    ground.setUserData({ kind: "ground" });

    this.level.build(new Builder(this));
    for (var i = 0; i < this.ents.length; i++) {
      var e = this.ents[i];
      if (e.kind === "block" || e.kind === "tnt") this.blockScoreTotal += MATS[e.mat].score;
    }
    var gremScore = 0;
    for (i = 0; i < this.ents.length; i++) if (this.ents[i].kind === "grem") gremScore += GREMS[this.ents[i].type].score;
    // Star thresholds: one star for winning, two for wrecking a good share of the fort,
    // three for wrecking most of it AND keeping a pet spare.
    this.stars = [gremScore, gremScore + Math.round(this.blockScoreTotal * 0.45), gremScore + Math.round(this.blockScoreTotal * 0.7) + 10000];

    // Let the fort settle under gravity BEFORE play starts, with no damage, so the
    // first shot can land the instant the player is ready.
    for (var s = 0; s < GRACE_STEPS; s++) {
      this.world.step(STEP, 8, 3);
      this.stepNo++;
    }
    // Then put the whole fort to SLEEP, perfectly still. Box2D stacks creep a hair every step and a
    // tall one will eventually tip over on its own if left awake; asleep, nothing moves until
    // something actually touches it (the pet, debris, a blast), which wakes it the normal way.
    this.freeze();

    this.world.on("begin-contact", function (c) {
      c.__t = self.stepNo;
    });
    this.world.on("post-solve", function (c, imp) {
      if (self.stepNo < GRACE_STEPS) return;
      if (c.__t === undefined || self.stepNo - c.__t > HIT_WINDOW) return;
      var ni = imp.normalImpulses, m = 0;
      for (var k = 0; k < ni.length; k++) if (ni[k] > m) m = ni[k];
      if (m < MIN_IMPULSE) return;
      var A = c.getFixtureA().getBody().getUserData();
      var B = c.getFixtureB().getBody().getUserData();
      self._hit(A, B, m);
      self._hit(B, A, m);
    });
  }

  Game.prototype.freeze = function () {
    for (var i = 0; i < this.ents.length; i++) {
      var e = this.ents[i];
      if (e.dead || e.kind === "rock") continue;
      e.body.setLinearVelocity({ x: 0, y: 0 });
      e.body.setAngularVelocity(0);
      e.body.setAwake(false);
    }
  };

  Game.prototype._hit = function (e, other, imp) {
    if (!e || e.dead) return;
    if (e.kind === "pet") {
      e.hits++;
      if (this.ev.petImpact) this.ev.petImpact(e, imp, other);
      return;
    }
    if (e.hp === undefined) return;
    var mult = 1;
    if (other && other.kind === "pet") mult = other.ram ? 2.4 : 1.05;
    var dmg = (imp - MIN_IMPULSE) * mult;
    e.hp -= dmg;
    if (this.ev.hit) this.ev.hit(e, dmg, imp, other);
    if (e.hp <= 0) this._kill(e);
  };

  Game.prototype._kill = function (e) {
    if (e.dead || e.dying) return;
    e.dying = true;
    this.queue.push(e);
  };

  Game.prototype._flush = function () {
    while (this.queue.length) {
      var e = this.queue.shift();
      if (e.dead) continue;
      e.dead = true;
      var p = e.body.getPosition();
      e.x = p.x; e.y = p.y; e.a = e.body.getAngle();
      this.world.destroyBody(e.body);
      if (e.kind === "grem") {
        this.gremsKilled++;
        this.score += GREMS[e.type].score;
        var last = this.gremsKilled >= this.gremsTotal;
        if (this.ev.killGrem) this.ev.killGrem(e, last, GREMS[e.type].score);
        if (last && this.wonT < 0 && this.state !== "lost") this.wonT = 0;
      } else if (e.kind === "tnt") {
        this.score += MATS.tnt.score;
        if (this.ev.breakBlock) this.ev.breakBlock(e, MATS.tnt.score);
        this._explode(p.x, p.y);
      } else if (e.kind === "block") {
        this.score += MATS[e.mat].score;
        if (this.ev.breakBlock) this.ev.breakBlock(e, MATS[e.mat].score);
      }
    }
  };

  Game.prototype._explode = function (x, y) {
    var R = 2.9;
    if (this.ev.explode) this.ev.explode(x, y, R);
    for (var i = 0; i < this.ents.length; i++) {
      var e = this.ents[i];
      if (e.dead || e.dying || e.kind === "rock") continue;
      var p = e.body.getPosition();
      var dx = p.x - x, dy = p.y - y, d = Math.sqrt(dx * dx + dy * dy);
      if (d > R) continue;
      var f = 1 - d / R;
      var n = d > 0.01 ? 1 / d : 0;
      var m = Math.min(e.body.getMass(), 4);
      e.body.applyLinearImpulse({ x: dx * n * 16 * f * m, y: (dy * n + 0.35) * 16 * f * m }, p, true);
      if (e.hp !== undefined) {
        e.hp -= 7 * f;
        if (this.ev.hit) this.ev.hit(e, 7 * f, 7 * f, null);
        if (e.hp <= 0) this._kill(e);
      }
    }
    for (var j = 0; j < this.pets.length; j++) {
      var pb = this.pets[j].body, pp = pb.getPosition();
      var ddx = pp.x - x, ddy = pp.y - y, dd = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dd < R && dd > 0.01) pb.applyLinearImpulse({ x: (ddx / dd) * 10 * (1 - dd / R), y: (ddy / dd) * 10 * (1 - dd / R) }, pp, true);
    }
  };

  // Launch velocity for a pull (metres, the drag offset from the pouch's rest point).
  Game.prototype.velocityFor = function (pull) {
    var len = Math.sqrt(pull.x * pull.x + pull.y * pull.y);
    var k = len > MAX_PULL ? MAX_PULL / len : 1;
    return { x: (-pull.x * k / MAX_PULL) * VMAX, y: (-pull.y * k / MAX_PULL) * VMAX };
  };
  Game.prototype.clampPull = function (pull) {
    var len = Math.sqrt(pull.x * pull.x + pull.y * pull.y);
    if (len <= MAX_PULL) return { x: pull.x, y: pull.y };
    return { x: (pull.x / len) * MAX_PULL, y: (pull.y / len) * MAX_PULL };
  };
  // Where the pet will be at time t for this pull (ballistic, for the aim preview).
  Game.prototype.preview = function (pull, n, dt) {
    var v = this.velocityFor(pull), p = this.clampPull(pull), out = [];
    var x0 = SLING.x + p.x, y0 = SLING.y + p.y;
    for (var i = 1; i <= n; i++) {
      var t = i * dt;
      out.push({ x: x0 + v.x * t, y: y0 + v.y * t - 0.5 * G * t * t });
    }
    return out;
  };

  Game.prototype._spawnPet = function (x, y, v) {
    var body = this.world.createBody({ type: "dynamic", position: { x: x, y: y }, bullet: true });
    body.createFixture(new pl.Circle(PET_R), { density: PET_DENSITY, friction: 0.6, restitution: 0.3, filterGroupIndex: -1 });
    body.setAngularDamping(0.8);
    body.setLinearVelocity(v);
    var e = { kind: "pet", body: body, t: 0, slowT: 0, done: false, hits: 0, px: x, py: y, pa: 0 };
    body.setUserData(e);
    this.pets.push(e);
    return e;
  };

  Game.prototype.launch = function (pull) {
    if (this.state !== "aim" || this.shotsLeft <= 0) return null;
    var p = this.clampPull(pull);
    var v = this.velocityFor(p);
    // Clear the previous shot's pets out of the world before the new one flies.
    for (var i = 0; i < this.spent.length; i++) if (!this.spent[i].removed) {
      this.spent[i].removed = true;
      if (this.ev.petGone) this.ev.petGone(this.spent[i]);
      this.world.destroyBody(this.spent[i].body);
    }
    this.spent = [];
    this.shotsLeft--;
    this.state = "flying";
    this.powerUsed = false;
    this.doneT = 0;
    this.settleT = 0;
    return this._spawnPet(SLING.x + p.x, SLING.y + p.y, v);
  };

  // The mid-flight tap. Each pet shape has its own power.
  Game.prototype.usePower = function () {
    if (this.state !== "flying" || this.powerUsed || !this.pets.length) return false;
    var lead = this.pets[0];
    if (lead.hits > 0) return false; // powers are for the air
    this.powerUsed = true;
    var b = lead.body, v = b.getLinearVelocity(), pos = b.getPosition();
    var sp = Math.sqrt(v.x * v.x + v.y * v.y) || 1;
    if (this.power === "TURBO") {
      b.setLinearVelocity({ x: (v.x / sp) * Math.max(sp * 1.9, 24), y: (v.y / sp) * Math.max(sp * 1.9, 24) });
    } else if (this.power === "TRIPLE") {
      // perpendicular to the flight path, far enough apart that the three never overlap
      var nx = -v.y / sp, ny = v.x / sp;
      for (var s = -1; s <= 1; s += 2) {
        var ang = s * 0.17, c = Math.cos(ang), si = Math.sin(ang);
        this._spawnPet(pos.x + nx * s * 1.25, pos.y + ny * s * 1.25, { x: v.x * c - v.y * si, y: v.x * si + v.y * c });
      }
    } else if (this.power === "RAM") {
      lead.ram = true;
      b.getFixtureList().setDensity(PET_DENSITY * 4);
      b.resetMassData();
      b.setLinearVelocity({ x: v.x * 1.25, y: v.y * 1.25 });
    } else if (this.power === "SLAM") {
      lead.ram = true;
      b.getFixtureList().setDensity(PET_DENSITY * 5);
      b.resetMassData();
      b.setLinearVelocity({ x: v.x * 0.2, y: -26 });
    }
    if (this.ev.power) this.ev.power(this.power, lead);
    return true;
  };

  Game.prototype.gremsAlive = function () {
    return this.gremsTotal - this.gremsKilled;
  };

  Game.prototype._maxSpeed = function () {
    var m = 0;
    for (var i = 0; i < this.ents.length; i++) {
      var e = this.ents[i];
      if (e.dead || e.kind === "rock") continue;
      var v = e.body.getLinearVelocity();
      var s = Math.abs(v.x) + Math.abs(v.y);
      if (s > m) m = s;
    }
    return m;
  };

  // Remember where every moving body was before this step, so the renderer can draw the exact
  // in-between position on 90/120 Hz screens instead of the 60 Hz physics stair-step.
  Game.prototype._snapshot = function () {
    var i, e, p;
    for (i = 0; i < this.ents.length; i++) {
      e = this.ents[i];
      if (e.dead || e.kind === "rock") continue;
      p = e.body.getPosition(); e.px = p.x; e.py = p.y; e.pa = e.body.getAngle();
    }
    var lists = [this.pets, this.spent];
    for (var k = 0; k < 2; k++) for (i = 0; i < lists[k].length; i++) {
      e = lists[k][i];
      if (e.removed) continue;
      p = e.body.getPosition(); e.px = p.x; e.py = p.y; e.pa = e.body.getAngle();
    }
  };
  // Interpolated position and angle of a body for drawing.
  Game.prototype.lerpPos = function (e) {
    var p = e.body.getPosition(), a = e.body.getAngle();
    if (e.px === undefined) return { x: p.x, y: p.y, a: a };
    var t = this.acc / STEP;
    if (t > 1) t = 1;
    return { x: e.px + (p.x - e.px) * t, y: e.py + (p.y - e.py) * t, a: e.pa + (a - e.pa) * t };
  };

  Game.prototype._fixedStep = function () {
    this._snapshot();
    this.world.step(STEP, 8, 3);
    this.stepNo++;
    this._flush();
    // Gremlins knocked off the world (or into the dirt) are done for.
    for (var i = 0; i < this.ents.length; i++) {
      var e = this.ents[i];
      if (e.dead || e.dying || e.kind !== "grem") continue;
      var p = e.body.getPosition();
      if (p.y < -3 || p.x > 140 || p.x < -40) this._kill(e);
    }
    this._flush();

    if (this.state === "flying") {
      var allDone = true;
      for (var j = 0; j < this.pets.length; j++) {
        var pe = this.pets[j];
        if (pe.done) continue;
        pe.t += STEP;
        var pv = pe.body.getLinearVelocity(), pp = pe.body.getPosition();
        var ps = Math.sqrt(pv.x * pv.x + pv.y * pv.y);
        pe.slowT = ps < 0.5 ? pe.slowT + STEP : 0;
        if (pe.hits > 0 && pe.body.getLinearDamping() < 0.1) pe.body.setLinearDamping(0.25);
        if (pe.slowT > 0.7 || pp.x > 120 || pp.x < -20 || pp.y < -5 || pe.t > 9) pe.done = true;
        else allDone = false;
      }
      if (allDone) {
        this.state = "settle";
        this.settleT = 0;
      }
    } else if (this.state === "settle") {
      this.settleT += STEP;
      var quiet = this._maxSpeed() < 0.25;
      // The next pet comes after the fort calms down (or 3.2 s). A LOSS waits longer, for a
      // truly still fort (or 7 s), so a gremlin crushed by a late-falling block still counts.
      var ready = this.shotsLeft > 0 ? quiet || this.settleT > 3.2 : quiet || this.settleT > 7;
      if (this.wonT < 0 && ready) {
        for (var k = 0; k < this.pets.length; k++) this.spent.push(this.pets[k]);
        this.pets = [];
        if (this.shotsLeft > 0) {
          this.state = "aim";
          if (this.ev.nextShot) this.ev.nextShot();
        } else {
          this.state = "lost";
          if (this.ev.lost) this.ev.lost();
        }
      }
    }

    if (this.wonT >= 0 && this.state !== "won") {
      this.wonT += STEP;
      if (this.wonT > 1.6) {
        this.state = "won";
        var bonus = this.shotsLeft * 10000;
        this.score += bonus;
        if (this.ev.won) this.ev.won(bonus);
      }
    }
  };

  // Advance by real seconds (already scaled for slow motion by the caller).
  Game.prototype.update = function (dt) {
    this.acc += Math.min(dt, 0.1);
    var n = 0;
    while (this.acc >= STEP && n < 6) {
      this._fixedStep();
      this.acc -= STEP;
      n++;
    }
  };

  Game.prototype.starsFor = function (score) {
    var s = 0;
    for (var i = 0; i < 3; i++) if (score >= this.stars[i]) s = i + 1;
    return s;
  };

  // The fort's horizontal extent, for the camera.
  Game.prototype.extent = function () {
    if (!this._ext) {
      var max = 10, front = 1e9, top = 4;
      for (var i = 0; i < this.ents.length; i++) {
        var e = this.ents[i];
        var p = e.body.getPosition();
        var half = e.w ? e.w / 2 : e.r || 0.5;
        var halfH = e.h ? e.h / 2 : e.r || 0.5;
        if (p.x + half > max) max = p.x + half;
        if (p.x - half < front) front = p.x - half;
        if (p.y + halfH > top) top = p.y + halfH;
      }
      // measured once, at the start: the camera frames the fort as it was built
      this._ext = { min: -4, max: max + 3, front: front, top: top };
    }
    return this._ext;
  };

  root.ChiCore = {
    Game: Game,
    LEVELS: LEVELS,
    MATS: MATS,
    GREMS: GREMS,
    POWERS: POWERS,
    PET_R: PET_R,
    SLING: SLING,
    MAX_PULL: MAX_PULL,
    VMAX: VMAX,
    G: G,
  };
})(typeof window !== "undefined" ? window : globalThis);
