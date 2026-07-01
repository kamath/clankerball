'use strict';
/* ============================================================
   engine.js — headless basketball simulation (no DOM access)
   Exposes BBEngine.Game. Drive it with game.step(dtSeconds).
   All positions are in feet on a 94x50 court, origin top-left.
   Team 0 attacks the right hoop, team 1 attacks the left hoop.
   ============================================================ */
(function (global) {

const COURT = { W: 94, H: 50, HOOP_X: 5.25, ARC: 23.75 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* Fill in any rating a config omits with a plausible value derived
   from body type and the ratings that are present, so minimal player
   configs (just the shooting ratings) still work. All ratings 25-99. */
function fillRatings(cfg) {
  const F = (v, fb) => (v == null ? clamp(Math.round(fb), 25, 99) : v);
  const r = {};
  r.speed = F(cfg.speed, 99 - (cfg.weightLb - 160) * 0.30 - (cfg.heightIn - 70) * 1.5);
  r.acceleration = F(cfg.acceleration, r.speed);
  r.strength = F(cfg.strength, (cfg.weightLb - 140) * 0.55);
  r.vertical = F(cfg.vertical, 30 + cfg.dunk * 0.6);
  r.ballHandle = F(cfg.ballHandle, 40 + cfg.iq * 0.4);
  r.passAcc = F(cfg.passAcc, cfg.iq);
  r.perimeterD = F(cfg.perimeterD, 50);
  r.interiorD = F(cfg.interiorD, (cfg.heightIn - 70) * 4 + (cfg.weightLb - 180) * 0.1);
  r.steal = F(cfg.steal, 50);
  r.block = F(cfg.block, (cfg.heightIn - 72) * 4 + cfg.dunk * 0.3);
  r.rebound = F(cfg.rebound, (cfg.heightIn - 66) * 3.5 + (cfg.weightLb - 160) * 0.15);
  return r;
}

/* Rating -> physical units */
const maxSpeedOf = (p) => 12.2 + p.speed * 0.054;        // ft/s
const accelOf = (p) => 8 + p.acceleration * 0.16;        // ft/s^2
const rebSkillOf = (p) =>
  40 + p.rebound * 0.55 + (p.heightIn - 66) * 0.7 + p.strength * 0.12 + p.vertical * 0.08;
const offThreat = (p) =>
  Math.max(p.threePoint, p.midRange, (p.layup + p.dunk) / 2) * 0.7 +
  p.iq * 0.15 + p.speed * 0.15;

function projectOnSeg(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const L2 = abx * abx + aby * aby || 1e-6;
  const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / L2, 0, 1);
  const pt = { x: a.x + abx * t, y: a.y + aby * t };
  return { t, d: dist(p, pt), pt };
}

/* Half-court spots in "attack space": ax = feet from hoop toward
   midcourt, ay = lateral offset from the rim line. */
const SPOTS = [
  { ax: 1.5,  ay: -20.5, cat: 'three'  }, // corners
  { ax: 1.5,  ay:  20.5, cat: 'three'  },
  { ax: 17,   ay: -16,   cat: 'three'  }, // wings
  { ax: 17,   ay:  16,   cat: 'three'  },
  { ax: 24.5, ay:   0,   cat: 'three'  }, // top
  { ax: 23,   ay:  -9,   cat: 'three'  }, // slots
  { ax: 23,   ay:   9,   cat: 'three'  },
  { ax: 14,   ay: -6.5,  cat: 'mid'    }, // elbows
  { ax: 14,   ay:  6.5,  cat: 'mid'    },
  { ax: 16.5, ay:   0,   cat: 'mid'    }, // free-throw area
  { ax: 7,    ay: -13,   cat: 'mid'    }, // short corners
  { ax: 7,    ay:  13,   cat: 'mid'    },
  { ax: 4.5,  ay: -5.5,  cat: 'inside' }, // blocks
  { ax: 4.5,  ay:  5.5,  cat: 'inside' },
  { ax: 2.5,  ay:  -9,   cat: 'inside' }, // dunker spots
  { ax: 2.5,  ay:   9,   cat: 'inside' },
];

const LINES = {
  make: {
    three: [
      (n, d) => `${n} splashes a ${d}-footer from deep!`,
      (n) => `${n} buries the triple`,
      (n) => `BANG! ${n} from downtown`,
      (n) => `${n} catches and cashes the three`,
    ],
    mid: [
      (n, d) => `${n} knocks down the ${d}-foot pull-up`,
      (n) => `${n} rises and fires — good!`,
      (n, d) => `Smooth ${d}-footer drops for ${n}`,
    ],
    inside: [
      (n) => `${n} finishes the layup`,
      (n) => `${n} scoops it in off the glass`,
      (n) => `${n} muscles it up and in`,
    ],
    dunk: [
      (n) => `${n} THROWS IT DOWN!`,
      (n) => `${n} rises up — monster jam!`,
      (n) => `${n} with the two-hand flush!`,
    ],
  },
  miss: {
    three: [
      (n) => `${n}'s three rims out`,
      (n, d) => `${n} misfires from ${d} feet`,
      (n) => `${n}'s deep ball is off the mark`,
    ],
    mid: [
      (n) => `${n}'s jumper is short`,
      (n, d) => `${n} can't connect from ${d} feet`,
      (n) => `${n}'s fadeaway clangs off the iron`,
    ],
    inside: [
      (n) => `${n}'s layup rolls off the rim`,
      (n) => `${n} is denied at the rim`,
      (n) => `${n} can't get the floater to fall`,
    ],
    dunk: [(n) => `${n} loses the slam off the back iron!`],
  },
  steal: [
    (s, v) => `${s} picks ${v}'s pocket!`,
    (s, v) => `${s} strips ${v} — turnover!`,
    (s, v) => `${s} swipes it away from ${v}`,
  ],
};

class Game {
  constructor(cfg, opts = {}) {
    this.onEvent = opts.onEvent || (() => {});
    this.quarterLen = (cfg.quarterMinutes || 12) * 60;
    this.hoops = [
      { x: COURT.W - COURT.HOOP_X, y: COURT.H / 2 },
      { x: COURT.HOOP_X, y: COURT.H / 2 },
    ];
    this.teams = [cfg.teamA, cfg.teamB].map((t, ti) => ({
      name: t.name,
      abbr: t.abbr || t.name.slice(0, 3).toUpperCase(),
      color: t.color,
      score: 0,
      players: t.players.map((p, si) => this.makePlayer(p, ti, si)),
    }));
    this.assignMatchups();
    this.quarter = 1;
    this.gameClock = this.quarterLen;
    this.shotClock = 24;
    this.shotClockActive = false;
    this.ball = { pos: { x: 47, y: 25 }, holder: null, flight: null, loose: null, air: 0 };
    this.possession = Math.random() < 0.5 ? 0 : 1;
    this.qStartPoss = this.possession;
    this.phase = 'setup';
    this.over = false;
    this.lastPasser = null;
    this.sinceCatch = 99;
    this.lastShotTeam = 0;
    this.claims = [new Map(), new Map()];
    this.emit('period', `Tip-off! The ${this.teams[this.possession].name} start with the ball`, null);
    this.setupInbound(this.possession, this.baselineSpot(this.possession), { sc: 24 });
  }

  makePlayer(cfg, team, slot) {
    return {
      ...cfg,
      ...fillRatings(cfg),
      position: cfg.pos || '', // cfg.pos (the label) is shadowed by the coordinate below
      team, slot, id: team * 5 + slot,
      tend: Object.assign(
        { shoot: 50, three: 50, drive: 50, pass: 50, help: 50, crash: 50, gamble: 50 },
        cfg.tendencies || {}),
      pos: { x: 47 + rand(-15, 15), y: 25 + rand(-15, 15) },
      vel: { x: 0, y: 0 },
      moveTarget: null,
      allowOOB: false,
      driving: false,
      driveSide: 1,
      decisionTimer: rand(0.3, 0.6),
      spotIdx: -1,
      spotTimer: 0,
      stats: { pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 },
    };
  }

  /* Man-to-man matchups: biggest offensive threats draw the best
     defenders. Quality is the defender's relevant defensive rating
     minus a size-mismatch penalty; strength shrinks the effective
     size gap, so strong small guards (Smart, Caruso types) can take
     bigger assignments — but nobody ends up on a 7-footer. */
  matchScore(d, o) {
    // guards/wings are perimeter assignments; bigs are interior ones
    const perim = o.heightIn <= 79 || o.threePoint >= (o.layup + o.dunk) / 2;
    const dq = perim
      ? d.perimeterD * 0.8 + d.steal * 0.2
      : d.interiorD * 0.7 + d.block * 0.2 + d.strength * 0.1;
    const sizeGap = Math.max(0, o.heightIn - d.heightIn - (d.strength - 50) * 0.10);
    return dq + d.iq * 0.25 - sizeGap * sizeGap * 0.9;
  }

  assignMatchups() {
    for (let ti = 0; ti < 2; ti++) {
      const defs = this.teams[ti].players;
      const offs = this.teams[1 - ti].players;
      // greedy seed: biggest threats draw the best available defender
      const pool = defs.slice();
      for (const o of offs.slice().sort((a, b) => offThreat(b) - offThreat(a))) {
        let best = null, bs = -Infinity;
        for (const d of pool) {
          const s = this.matchScore(d, o);
          if (s > bs) { bs = s; best = d; }
        }
        pool.splice(pool.indexOf(best), 1);
        best.markSlot = o.slot;
      }
      // 2-opt: swap assignments while it improves the total fit, so
      // nobody is left stranded on a hopeless mismatch
      const markOf = (d) => offs.find(q => q.slot === d.markSlot);
      for (let pass = 0; pass < 4; pass++) {
        let improved = false;
        for (let i = 0; i < defs.length; i++) {
          for (let j = i + 1; j < defs.length; j++) {
            const a = defs[i], b = defs[j];
            const cur = this.matchScore(a, markOf(a)) + this.matchScore(b, markOf(b));
            const swp = this.matchScore(a, markOf(b)) + this.matchScore(b, markOf(a));
            if (swp > cur + 0.01) {
              const tmp = a.markSlot;
              a.markSlot = b.markSlot;
              b.markSlot = tmp;
              improved = true;
            }
          }
        }
        if (!improved) break;
      }
    }
  }

  /* ---------- helpers ---------- */
  qLabel() {
    if (this.quarter <= 4) return 'Q' + this.quarter;
    const n = this.quarter - 4;
    return n > 1 ? 'OT' + n : 'OT';
  }
  emit(type, text, team) {
    this.onEvent({ type, text, team, qLabel: this.qLabel(), clock: fmtClock(this.gameClock) });
  }
  scoreLine() {
    const [a, b] = this.teams;
    return `${a.abbr} ${a.score}, ${b.abbr} ${b.score}`;
  }
  attackSign(team) { return this.hoops[team].x > COURT.W / 2 ? 1 : -1; }
  inFrontcourt(pos, team) {
    return this.attackSign(team) > 0 ? pos.x > 49 : pos.x < 45;
  }
  spotPos(team, s) {
    const hoop = this.hoops[team];
    const dir = hoop.x > COURT.W / 2 ? -1 : 1;
    return { x: hoop.x + dir * s.ax, y: COURT.H / 2 + s.ay };
  }
  mates(p) { return this.teams[p.team].players.filter(q => q !== p); }
  allPlayers() { return this.teams[0].players.concat(this.teams[1].players); }
  nearestOppTo(team, pos) {
    let best = null, bd = Infinity;
    for (const o of this.teams[1 - team].players) {
      const d = dist(o.pos, pos);
      if (d < bd) { bd = d; best = o; }
    }
    return { p: best, d: bd };
  }
  openness(p) { return this.nearestOppTo(p.team, p.pos).d; }
  baselineSpot(team) {
    // Inbound spot behind the hoop `team` defends.
    const hoop = this.hoops[1 - team];
    const x = hoop.x > COURT.W / 2 ? COURT.W + 1.5 : -1.5;
    return { x, y: COURT.H / 2 + rand(-9, 9) };
  }
  oobSpot(p) {
    const dl = p.x, dr = COURT.W - p.x, du = p.y, dd = COURT.H - p.y;
    const m = Math.min(dl, dr, du, dd);
    if (m === du) return { x: clamp(p.x, 4, COURT.W - 4), y: -1.5 };
    if (m === dd) return { x: clamp(p.x, 4, COURT.W - 4), y: COURT.H + 1.5 };
    if (m === dl) return { x: -1.5, y: clamp(p.y, 4, COURT.H - 4) };
    return { x: COURT.W + 1.5, y: clamp(p.y, 4, COURT.H - 4) };
  }

  /* ---------- main loop ---------- */
  step(dt) {
    if (this.over) return;
    if (this.phase === 'setup') {
      this.updateDefense();
      this.moveAll(dt);
      this.ballFollow();
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) this.releaseInbound();
      return;
    }
    const clockOn = !(this.ball.flight && this.ball.flight.kind === 'inbound');
    if (clockOn) {
      this.gameClock = Math.max(0, this.gameClock - dt);
      if (this.shotClockActive) {
        this.shotClock -= dt;
        if (this.shotClock <= 0) { this.shotClockViolation(); return; }
      }
    }
    this.sinceCatch += dt;
    this.updateOffense(dt);
    this.updateDefense();
    if (this.ball.loose) this.updateLoose(dt);
    this.moveAll(dt);
    if (this.ball.flight) this.updateFlight(dt);
    else if (this.ball.holder) this.updateHandler(dt);
    this.ballFollow();
    if (this.gameClock <= 0 && this.phase === 'live' &&
        !(this.ball.flight && this.ball.flight.kind === 'shot')) {
      this.endQuarter();
    }
  }

  ballFollow() {
    if (this.ball.holder) {
      this.ball.pos = { x: this.ball.holder.pos.x, y: this.ball.holder.pos.y };
    } else if (this.ball.loose) {
      this.ball.pos = { x: this.ball.loose.pos.x, y: this.ball.loose.pos.y };
    }
  }

  /* ---------- movement ---------- */
  moveAll(dt) {
    for (const t of this.teams) {
      for (const p of t.players) {
        const tgt = p.moveTarget;
        let dvx = 0, dvy = 0;
        if (tgt) {
          const dx = tgt.x - p.pos.x, dy = tgt.y - p.pos.y;
          const d = Math.hypot(dx, dy);
          if (d > 0.05) {
            // decelerate into the target instead of orbiting it
            const sp = maxSpeedOf(p) * (d < 3 ? Math.max(0.25, d / 3) : 1);
            dvx = (dx / d) * sp;
            dvy = (dy / d) * sp;
          }
        }
        const acc = accelOf(p) * dt;
        p.vel.x += clamp(dvx - p.vel.x, -acc, acc);
        p.vel.y += clamp(dvy - p.vel.y, -acc, acc);
        p.pos.x += p.vel.x * dt;
        p.pos.y += p.vel.y * dt;
      }
    }
    // gentle separation so dots don't stack
    const all = this.allPlayers();
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
        const d = Math.hypot(dx, dy);
        if (d < 1.6 && d > 0.001) {
          const push = (1.6 - d) * 0.5 * dt * 8;
          const ux = dx / d, uy = dy / d;
          a.pos.x -= ux * push; a.pos.y -= uy * push;
          b.pos.x += ux * push; b.pos.y += uy * push;
        }
      }
    }
    for (const t of this.teams) {
      for (const p of t.players) {
        if (!p.allowOOB) {
          const cx = clamp(p.pos.x, 0.8, COURT.W - 0.8);
          const cy = clamp(p.pos.y, 0.8, COURT.H - 0.8);
          if (cx !== p.pos.x) p.vel.x = 0;
          if (cy !== p.pos.y) p.vel.y = 0;
          p.pos.x = cx;
          p.pos.y = cy;
        }
      }
    }
  }

  /* ---------- off-ball offense ---------- */
  updateOffense(dt) {
    if (this.ball.loose) return;
    for (const p of this.teams[this.possession].players) {
      if (p === this.ball.holder) continue;
      if (this.ball.flight && this.ball.flight.catcher === p) {
        p.moveTarget = { ...this.ball.flight.to };
        continue;
      }
      p.spotTimer -= dt;
      if (p.spotIdx < 0 || p.spotTimer <= 0) this.assignSpot(p);
      p.moveTarget = this.spotPos(p.team, SPOTS[p.spotIdx]);
    }
  }

  assignSpot(p) {
    const claims = this.claims[p.team];
    claims.delete(p.id);
    const taken = new Set(claims.values());
    const tf = (t) => 0.3 + t * 0.014; // tendency factor: 50 -> 1.0
    const w3 = Math.pow(p.threePoint, 2.2) * tf(p.tend.three);
    const wm = Math.pow(p.midRange, 2.2);
    const wi = Math.pow((p.layup + p.dunk) / 2, 2.2) * tf(p.tend.drive);
    const total = w3 + wm + wi;
    const r = Math.random() * total;
    const cat = r < w3 ? 'three' : r < w3 + wm ? 'mid' : 'inside';
    let cands = SPOTS.map((s, i) => i).filter(i => SPOTS[i].cat === cat && !taken.has(i));
    if (!cands.length) cands = SPOTS.map((s, i) => i).filter(i => !taken.has(i));
    p.spotIdx = pick(cands);
    claims.set(p.id, p.spotIdx);
    p.spotTimer = rand(3, 7);
  }

  /* ---------- defense ---------- */
  updateDefense() {
    if (this.ball.loose) return;
    const defTeam = 1 - this.possession;
    const hoop = this.hoops[this.possession]; // the hoop being attacked
    const f = this.ball.flight;
    for (const p of this.teams[defTeam].players) {
      if (f && f.intercepted && f.catcher === p) {
        p.moveTarget = { ...f.to };
        continue;
      }
      const mark = this.teams[this.possession].players.find(q => q.slot === p.markSlot);
      const onBall = mark === this.ball.holder;
      const dm = dist(mark.pos, hoop);
      // sag off non-shooters, close out on snipers; better defenders
      // pressure the ball tighter
      const shooterTight = 1 - (mark.threePoint - 50) * 0.0045;
      const g = onBall
        ? clamp(2.8 - (p.perimeterD + p.iq) * 0.008, 1.0, 2.2)
        : clamp((2.5 + dm * 0.11) * shooterTight, 1.8, 6.5);
      const vx = hoop.x - mark.pos.x, vy = hoop.y - mark.pos.y;
      const L = Math.hypot(vx, vy) || 1;
      const gg = Math.min(g, L * 0.7);
      let tx = mark.pos.x + (vx / L) * gg;
      let ty = mark.pos.y + (vy / L) * gg;
      // no full-court pressing: wait at a pickup point near your half
      const PICKUP = 33;
      const dT = Math.hypot(tx - hoop.x, ty - hoop.y);
      if (dT > PICKUP) {
        tx = hoop.x + ((tx - hoop.x) / dT) * PICKUP;
        ty = hoop.y + ((ty - hoop.y) / dT) * PICKUP;
      }
      const holder = this.ball.holder;
      if (!onBall && holder) {
        if (holder.driving && dist(mark.pos, holder.pos) > 11) {
          // help rotation: shade toward a driving ball handler
          const hx = (holder.pos.x + hoop.x * 2) / 3;
          const hy = (holder.pos.y + hoop.y * 2) / 3;
          const w = clamp((p.tend.help - 20) * 0.011, 0, 0.85);
          tx = lerp(tx, hx, w);
          ty = lerp(ty, hy, w);
        } else if (!holder.driving && dist(mark.pos, holder.pos) < 30) {
          // lane denial: ball hawks overplay the pass to their man
          const denyW = clamp(((p.steal + p.tend.gamble) / 2 - 40) * 0.012, 0, 0.5);
          if (denyW > 0) {
            tx = lerp(tx, (holder.pos.x + mark.pos.x) / 2, denyW * 0.3);
            ty = lerp(ty, (holder.pos.y + mark.pos.y) / 2, denyW * 0.3);
          }
        }
      }
      p.moveTarget = { x: tx, y: ty };
    }
  }

  /* ---------- ball handler AI ---------- */
  updateHandler(dt) {
    const h = this.ball.holder;
    const near = this.nearestOppTo(h.team, h.pos);
    if (near.d < 2.0) {
      const gam = 0.6 + near.p.tend.gamble * 0.008;
      const rate = clamp(
        (0.003 + near.p.steal * 0.00008 + (h.driving ? 0.010 : 0)) *
          gam * (1.5 - h.ballHandle * 0.008),
        0.001, 0.045
      );
      if (Math.random() < rate * dt) {
        near.p.stats.stl++;
        h.stats.tov++;
        this.emit('steal', pick(LINES.steal)(near.p.name, h.name), near.p.team);
        this.gainPossession(near.p);
        return;
      }
    }
    if (h.driving) {
      const hoop = this.hoops[h.team];
      h.moveTarget = { x: hoop.x, y: hoop.y + h.driveSide * 1.5 };
      if (dist(h.pos, hoop) < 4.2) { this.attemptShot(h, false); return; }
    }
    h.decisionTimer -= dt;
    if (h.decisionTimer <= 0) {
      h.decisionTimer = rand(0.45, 0.9);
      this.decide(h);
    }
  }

  decide(h) {
    const sc = this.shotClock;
    const hoop = this.hoops[h.team];
    if (sc < 1.1 || this.gameClock < 1.6) { this.attemptShot(h, true); return; }

    if (!this.inFrontcourt(h.pos, h.team)) {
      // bring the ball up
      const dir = hoop.x > COURT.W / 2 ? -1 : 1;
      h.moveTarget = {
        x: hoop.x + dir * 25,
        y: clamp(COURT.H / 2 + (h.pos.y - COURT.H / 2) * 0.4, 10, 40),
      };
      const ahead = this.mates(h).filter(m =>
        this.inFrontcourt(m.pos, h.team) &&
        this.openness(m) > 7 &&
        dist(m.pos, hoop) < dist(h.pos, hoop) - 10
      );
      if (ahead.length && Math.random() < 0.3 + h.iq * 0.004) {
        ahead.sort((a, b) => dist(a.pos, hoop) - dist(b.pos, hoop));
        this.tryPass(h, ahead[0]);
      }
      return;
    }

    const my = this.shotValue(h, h.pos);
    const teamFga = this.teams[h.team].players.reduce((s, q) => s + q.stats.fga, 0);
    const avgFga = teamFga / 5;
    let best = null, bestVal = -1;
    for (const m of this.mates(h)) {
      if (!this.inFrontcourt(m.pos, h.team)) continue;
      const sv = this.shotValue(m, m.pos);
      let v = sv.value * 0.95 + clamp(this.openness(m), 0, 10) * 0.012;
      // spread the ball: discount feeding someone who's already eaten
      v *= 1 - clamp((m.stats.fga - avgFga) * 0.012, -0.08, 0.3);
      if (v > bestVal) { bestVal = v; best = m; }
    }
    const dv = this.driveValue(h);
    const noise = (110 - h.iq) * 0.003;
    let need = Math.max(0.92, 1.58 - (24 - clamp(sc, 0, 24)) * 0.045);
    // eager shooters fire earlier, reluctant ones hold out for better looks
    need *= clamp(1 - (h.tend.shoot - 50) * 0.004, 0.8, 1.25);
    // shot-hunting from deep: high three-tendency discounts the bar for triples
    if (my.type === 'three') need *= clamp(1 - (h.tend.three - 50) * 0.002, 0.88, 1.12);

    // usage governor: stars cool off a little once they're way ahead
    // of their teammates in attempts
    need *= 1 + clamp((h.stats.fga - avgFga) * 0.015, 0, 0.5);

    // ---- clock awareness ----
    const gc = this.gameClock;
    const margin = this.teams[h.team].score - this.teams[1 - h.team].score;
    const lateGame = this.quarter >= 4 && gc < 120;
    if (gc > 27 && gc < 38) {
      need *= 0.72; // 2-for-1: get a shot up early, you get the ball back
    } else if (gc < 24 && gc < sc && !(lateGame && margin < 0)) {
      if (gc > 7.5) need *= 2.2; // last shot of the period: milk it down
    }
    if (lateGame && margin < 0) need *= margin <= -9 ? 0.7 : 0.85; // trailing: hurry
    if (lateGame && margin > 0 && gc < 60) need *= 1.3;            // leading: slow it down

    if (my.value + rand(-noise, noise) >= need) { this.attemptShot(h, false); return; }
    const driveGate = clamp(0.6 + (h.tend.drive - 50) * 0.008, 0.15, 0.95);
    if (!h.driving && Math.random() < driveGate && dv + rand(-noise, noise) >= need * 0.9) {
      h.driving = true;
      h.driveSide = Math.random() < 0.5 ? -1 : 1;
      return;
    }
    if (best && sc > 2.5) {
      const passBias = (bestVal > my.value + 0.03 ? 0.75 : 0.3) *
        clamp(0.5 + h.tend.pass * 0.01, 0.4, 1.5);
      if (Math.random() < passBias) { this.tryPass(h, best); return; }
    }
    if (sc < 4 && my.value > 0.45) { this.attemptShot(h, true); return; }
    // probe: drift to a new spot in the frontcourt
    h.driving = false;
    const sign = this.attackSign(h.team);
    h.moveTarget = {
      x: clamp(h.pos.x + rand(-5, 5), sign > 0 ? 51 : 2, sign > 0 ? 92 : 43),
      y: clamp(h.pos.y + rand(-6, 6), 3, 47),
    };
  }

  shotValue(p, pos) {
    const hoop = this.hoops[p.team];
    const d = dist(pos, hoop);
    const dy = Math.abs(pos.y - COURT.H / 2);
    const isThree = d > 23.2 || (d > 21.2 && dy > 15);
    let type, base;
    if (d <= 4.6) {
      type = 'inside';
      base = 0.46 + p.layup * 0.0034 - (d - 1) * 0.012;
    } else if (d >= 29) {
      type = 'three';
      base = 0.04 + p.threePoint * 0.001; // desperation heave
    } else if (isThree) {
      type = 'three';
      base = 0.135 + p.threePoint * 0.0035 - (d - 22) * 0.008; // deep = harder
    } else {
      type = 'mid';
      base = 0.24 + p.midRange * 0.0036 - (d - 5) * 0.004; // long 2s = worst shot
    }
    const no = this.nearestOppTo(p.team, pos);
    let pen = 0;
    if (no.d < 6) {
      // contest quality: the right defensive rating + effective height
      // (vertical lets short defenders contest above their size)
      const dRating = type === 'inside' ? no.p.interiorD : no.p.perimeterD;
      const effH = no.p.heightIn + (no.p.vertical - 50) * 0.06;
      pen = ((6 - no.d) / 6) *
        ((type === 'inside' ? 0.115 : 0.09) + dRating * 0.0014 +
          clamp(effH - p.heightIn, -5, 7) * 0.01);
      // strength matters when finishing through bodies inside
      if (type === 'inside') pen -= (p.strength - no.p.strength) * 0.0006;
    }
    const prob = clamp(base - pen, 0.02, 0.97);
    const pts = type === 'three' ? 3 : 2;
    return { prob, type, d, pts, value: prob * pts, defD: no.d, defender: no.p };
  }

  driveValue(h) {
    const hoop = this.hoops[h.team];
    const d = dist(h.pos, hoop);
    if (d < 7) return 0;
    let blockers = 0;
    for (const o of this.teams[1 - h.team].players) {
      const pr = projectOnSeg(o.pos, h.pos, hoop);
      if (pr.t > 0.1 && pr.t < 0.95 && pr.d < 4.0) blockers++;
    }
    const press = this.nearestOppTo(h.team, h.pos).d < 2.5 ? 0.08 : 0;
    const fin = 0.42 + Math.max(h.layup, h.dunk * 0.92) * 0.0034
      - blockers * 0.13 - press
      + (h.speed - 60) * 0.0012 + (h.ballHandle - 50) * 0.0012;
    return clamp(fin, 0.05, 0.9) * 2 * 0.85;
  }

  /* ---------- passing ---------- */
  tryPass(h, m) {
    h.driving = false;
    const from = { x: h.pos.x, y: h.pos.y };
    const to = { x: m.pos.x + rand(-0.5, 0.5), y: m.pos.y + rand(-0.5, 0.5) };
    const d = dist(from, to);
    let interceptor = null, bestRisk = 0, ipt = null;
    for (const o of this.teams[1 - h.team].players) {
      const pr = projectOnSeg(o.pos, from, to);
      if (pr.t > 0.12 && pr.t < 0.88 && pr.d < 3.0) {
        const r = (3.0 - pr.d) * (0.4 + (o.steal - 40) / 120) *
          (0.7 + o.tend.gamble * 0.006);
        if (r > bestRisk) { bestRisk = r; interceptor = o; ipt = pr.pt; }
      }
    }
    const pf = (105 - h.passAcc) / 100; // sloppy passers risk more
    const stealP = interceptor ? clamp(bestRisk * 0.025 * (0.7 + pf), 0, 0.10) : 0;
    const press = this.nearestOppTo(h.team, h.pos).d;
    const errP = clamp(
      0.003 + pf * 0.012 + (press < 2.2 ? 0.012 : 0) + (d > 32 ? 0.02 : 0),
      0, 0.05
    );
    const roll = Math.random();
    let flight;
    if (roll < stealP) {
      flight = { kind: 'pass', from, to: ipt, catcher: interceptor, intercepted: true };
    } else if (roll < stealP + errP) {
      const ux = (to.x - from.x) / (d || 1), uy = (to.y - from.y) / (d || 1);
      const over = rand(3, 7);
      flight = { kind: 'pass', from, to: { x: to.x + ux * over, y: to.y + uy * over }, errant: true };
    } else {
      flight = { kind: 'pass', from, to, catcher: m };
    }
    flight.passer = h;
    flight.t = 0;
    flight.dur = 0.18 + dist(from, flight.to) / 42;
    this.ball.flight = flight;
    this.ball.holder = null;
  }

  /* ---------- ball in flight ---------- */
  updateFlight(dt) {
    const f = this.ball.flight;
    f.t += dt;
    const k = Math.min(1, f.t / f.dur);
    this.ball.pos = { x: lerp(f.from.x, f.to.x, k), y: lerp(f.from.y, f.to.y, k) };
    this.ball.air = Math.sin(Math.PI * k) * (f.kind === 'shot' ? 1 : 0.25);
    if (f.t < f.dur) return;
    this.ball.flight = null;
    this.ball.air = 0;
    if (f.kind === 'shot') this.resolveShot(f);
    else this.resolvePass(f);
  }

  resolvePass(f) {
    if (f.errant) {
      const out = f.to.x < 0 || f.to.x > COURT.W || f.to.y < 0 || f.to.y > COURT.H;
      if (out) {
        f.passer.stats.tov++;
        this.emit('turnover', `${f.passer.name} fires it out of bounds — turnover`, f.passer.team);
        this.setupInbound(1 - f.passer.team, this.oobSpot(f.to), { sc: 24 });
      } else {
        this.emit('loose', `Errant pass from ${f.passer.name} — ball is loose!`, f.passer.team);
        // the overthrown ball keeps skipping along the pass direction,
        // carrying most of the pass's momentum
        const ux = (f.to.x - f.from.x), uy = (f.to.y - f.from.y);
        const L = Math.hypot(ux, uy) || 1;
        const flightSpeed = L / (f.dur || 0.5);
        const v = Math.max(10, flightSpeed * rand(0.5, 0.75));
        this.ball.loose = {
          pos: { ...f.to },
          vel: { x: (ux / L) * v, y: (uy / L) * v },
          timer: rand(0.4, 0.8),
          isRebound: false,
          touchTeam: f.passer.team,
        };
      }
      return;
    }
    if (f.intercepted) {
      const s = f.catcher;
      s.stats.stl++;
      f.passer.stats.tov++;
      this.emit('steal', `${s.name} jumps the passing lane — stolen from ${f.passer.name}!`, s.team);
      this.gainPossession(s);
      return;
    }
    this.ball.holder = f.catcher;
    f.catcher.allowOOB = false;
    f.catcher.decisionTimer = rand(0.25, 0.6);
    this.sinceCatch = 0;
    this.lastPasser = f.passer;
    if (f.kind === 'inbound') {
      this.shotClockActive = true;
      if (f.passer) f.passer.allowOOB = false;
    }
  }

  /* ---------- shooting ---------- */
  attemptShot(h, forced) {
    const sv = this.shotValue(h, h.pos);
    // shot blocking: tight contests on twos can get swatted
    const def = sv.defender;
    if (def && sv.defD < 4.5 && sv.type !== 'three') {
      const effH = def.heightIn + (def.vertical - 50) * 0.06;
      const blockP = clamp(
        ((def.block - 30) * 0.0032 + (effH - h.heightIn) * 0.006) *
          (1 - sv.defD / 4.5) * (sv.type === 'inside' ? 1 : 0.4),
        0, 0.25);
      if (Math.random() < blockP) {
        h.stats.fga++;
        def.stats.blk++;
        h.driving = false;
        this.emit('block', `${def.name} swats ${h.name}'s shot away!`, def.team);
        // swatted ball flies away from the hoop
        const hoop = this.hoops[h.team];
        const away = Math.atan2(h.pos.y - hoop.y, h.pos.x - hoop.x) + rand(-1.1, 1.1);
        const v = rand(12, 24);
        this.ball.loose = {
          pos: { x: h.pos.x, y: h.pos.y },
          vel: { x: Math.cos(away) * v, y: Math.sin(away) * v },
          timer: rand(0.45, 0.8),
          isRebound: false,
          touchTeam: def.team,
        };
        this.ball.holder = null;
        return;
      }
    }
    let prob = sv.prob;
    let label = sv.type;
    if (sv.type === 'inside' && h.dunk >= 50 && sv.d < 3.4 &&
        Math.random() < (h.dunk - 35) / 80) {
      label = 'dunk';
      prob = clamp(0.55 + h.dunk * 0.0034 - (sv.defD < 2.5 ? 0.12 : 0), 0.05, 0.97);
    }
    if (forced) prob -= 0.06;
    if (h.driving && sv.type !== 'inside') prob -= 0.05;
    prob = clamp(prob, 0.02, 0.97);
    const made = Math.random() < prob;
    const hoop = this.hoops[h.team];
    const assist = (made && this.lastPasser && this.lastPasser !== h &&
      this.lastPasser.team === h.team && this.sinceCatch < 2.4)
      ? this.lastPasser : null;
    this.ball.flight = {
      kind: 'shot',
      from: { x: h.pos.x, y: h.pos.y },
      to: { x: hoop.x, y: hoop.y },
      t: 0,
      dur: 0.45 + sv.d / 24,
      shooter: h, made, pts: sv.pts, label,
      d: Math.round(sv.d), assist,
      defD: sv.defD,
      defName: def ? def.name.split(' ').slice(-1)[0] : null,
      prob,
    };
    this.ball.holder = null;
    this.shotClockActive = false;
    h.driving = false;
    this.lastShotTeam = h.team;
  }

  coverageTag(f) {
    let cov;
    if (f.defD >= 6) cov = 'wide open';
    else if (f.defD >= 4.5) cov = 'open';
    else if (f.defD >= 2.8) cov = `contested by ${f.defName}`;
    else cov = `smothered by ${f.defName}`;
    return ` [${cov} · ${Math.round(f.prob * 100)}% look]`;
  }

  resolveShot(f) {
    const sh = f.shooter;
    const T = this.teams[sh.team];
    sh.stats.fga++;
    if (f.pts === 3) sh.stats.tpa++;
    if (f.made) {
      T.score += f.pts;
      sh.stats.fgm++;
      sh.stats.pts += f.pts;
      if (f.pts === 3) sh.stats.tpm++;
      if (f.assist) f.assist.stats.ast++;
      const line = pick(LINES.make[f.label])(sh.name, f.d) +
        (f.assist ? ` (${f.assist.name} with the assist)` : '') +
        this.coverageTag(f) +
        ` — ${this.scoreLine()}`;
      this.emit(f.label === 'dunk' ? 'dunk' : 'score', line, sh.team);
      if (this.gameClock <= 0) { this.endQuarter(); return; }
      this.setupInbound(1 - sh.team, this.baselineSpot(1 - sh.team), { sc: 24 });
    } else {
      this.emit('miss', pick(LINES.miss[f.label])(sh.name, f.d) + this.coverageTag(f), sh.team);
      if (this.gameClock <= 0) { this.endQuarter(); return; }
      const hoop = this.hoops[sh.team];
      // caroms mostly bounce onto the floor in front of the rim, with
      // the occasional one off the back iron toward the baseline
      const toward = hoop.x > COURT.W / 2 ? Math.PI : 0;
      const ang = toward + rand(-2.0, 2.0);
      const carom = rand(4, 8 + f.d * 0.3); // long shots = long caroms
      this.ball.loose = {
        pos: { x: hoop.x + Math.cos(ang) * 1.2, y: hoop.y + Math.sin(ang) * 1.2 },
        vel: { x: Math.cos(ang) * carom, y: Math.sin(ang) * carom },
        timer: rand(0.55, 1.0),
        isRebound: true,
        touchTeam: sh.team,
      };
    }
  }

  /* ---------- loose balls & rebounds ---------- */
  updateLoose(dt) {
    const lb = this.ball.loose;
    // ball physics: roll and slow with friction
    const fr = Math.max(0, 1 - 1.4 * dt);
    lb.vel.x *= fr;
    lb.vel.y *= fr;
    lb.pos.x += lb.vel.x * dt;
    lb.pos.y += lb.vel.y * dt;
    const sp = Math.hypot(lb.vel.x, lb.vel.y);
    lb.phase = (lb.phase || 0) + dt * (4 + sp * 0.5);
    this.ball.air = Math.abs(Math.sin(lb.phase * 2.2)) * clamp(sp / 22, 0, 0.45);
    // rolled out of bounds: last team to touch it loses possession
    if (lb.pos.x < 0 || lb.pos.x > COURT.W || lb.pos.y < 0 || lb.pos.y > COURT.H) {
      const toTeam = 1 - lb.touchTeam;
      this.ball.air = 0;
      this.emit('turnover',
        `Loose ball bounces out — ${this.teams[toTeam].name} ball`, toTeam);
      this.setupInbound(toTeam, this.oobSpot(lb.pos), { sc: 24 });
      return;
    }
    // chase the ball where it's going, not where it is
    const aim = { x: lb.pos.x + lb.vel.x * 0.3, y: lb.pos.y + lb.vel.y * 0.3 };
    this.teams.forEach((t, ti) => {
      const offTeam = lb.isRebound && ti === this.lastShotTeam;
      const sorted = t.players.slice()
        .sort((a, b) => dist(a.pos, aim) - dist(b.pos, aim));
      sorted.slice(0, 3).forEach((p, i) => {
        // shooters' teammates only crash the glass if so inclined;
        // the rest get back on defense
        if (!offTeam || i === 0 || p.tend.crash >= 55) {
          p.moveTarget = { ...aim };
        }
      });
    });
    lb.timer -= dt;
    if (lb.timer > 0) return;
    const grabR = sp > 8 ? 1.7 : 2.8; // a hot ball is hard to corral
    const cands = this.allPlayers().filter(p => dist(p.pos, lb.pos) < grabR);
    if (!cands.length) return; // keep rolling until someone reaches it
    let win = null, wbest = -1;
    for (const p of cands) {
      let w = rebSkillOf(p) * rand(0.5, 1.5) +
        (grabR - dist(p.pos, lb.pos)) * 18 + p.iq * 0.1;
      if (lb.isRebound && p.team === this.lastShotTeam) {
        w *= 0.55 + p.tend.crash * 0.009;
      }
      if (w > wbest) { wbest = w; win = p; }
    }
    this.ball.air = 0;
    const wasRebound = lb.isRebound;
    const offBoard = wasRebound && win.team === this.lastShotTeam;
    const samePoss = !wasRebound && win.team === this.possession;
    const scBefore = this.shotClock;
    this.ball.loose = null;
    if (wasRebound) {
      win.stats.reb++;
      this.emit('rebound',
        offBoard
          ? `${win.name} crashes the glass — offensive rebound!`
          : `${win.name} secures the defensive board`,
        win.team);
    } else {
      this.emit('recover', `${win.name} comes up with the loose ball`, win.team);
    }
    this.gainPossession(win);
    if (offBoard) this.shotClock = 14;
    // recovering your own blocked shot / errant pass doesn't reset the clock
    if (samePoss) this.shotClock = Math.max(1, scBefore);
  }

  /* ---------- possession / dead balls ---------- */
  gainPossession(p) {
    this.possession = p.team;
    this.ball.holder = p;
    this.ball.flight = null;
    this.ball.loose = null;
    this.shotClock = 24;
    this.shotClockActive = true;
    this.lastPasser = null;
    this.sinceCatch = 99;
    p.decisionTimer = rand(0.2, 0.5);
    for (const t of this.teams) {
      for (const q of t.players) { q.driving = false; q.spotIdx = -1; q.spotTimer = 0; }
    }
    this.claims = [new Map(), new Map()];
  }

  shotClockViolation() {
    const t = this.possession;
    if (this.ball.holder) this.ball.holder.stats.tov++;
    this.emit('turnover', `Shot-clock violation on the ${this.teams[t].name}`, t);
    this.setupInbound(1 - t, this.oobSpot(this.ball.pos), { sc: 24 });
  }

  setupInbound(team, spot, opts) {
    this.phase = 'setup';
    this.deadTimer = rand(1.2, 2.0);
    this.possession = team;
    this.shotClock = opts.sc;
    this.shotClockActive = false;
    this.ball.holder = null;
    this.ball.flight = null;
    this.ball.loose = null;
    this.lastPasser = null;
    this.sinceCatch = 99;
    this.claims = [new Map(), new Map()];
    for (const t of this.teams) {
      for (const p of t.players) {
        p.driving = false;
        p.allowOOB = false;
        p.spotIdx = -1;
        p.spotTimer = 0;
      }
    }
    const tp = this.teams[team].players;
    let inb = tp[0];
    for (const p of tp) if (dist(p.pos, spot) < dist(inb.pos, spot)) inb = p;
    inb.allowOOB = true;
    inb.moveTarget = { ...spot };
    const rest = tp.filter(p => p !== inb);
    const recv = rest.slice().sort((a, b) => b.iq - a.iq)[0];
    recv.moveTarget = {
      x: clamp(spot.x + (COURT.W / 2 - spot.x) * 0.18, 3, COURT.W - 3),
      y: clamp(spot.y + (COURT.H / 2 - spot.y) * 0.3 + rand(-3, 3), 3, COURT.H - 3),
    };
    for (const p of rest) {
      if (p === recv) continue;
      this.assignSpot(p);
      p.moveTarget = this.spotPos(p.team, SPOTS[p.spotIdx]);
    }
    this.inb = { inbounder: inb, receiver: recv, spot };
    this.ball.holder = inb;
  }

  releaseInbound() {
    const { inbounder, receiver } = this.inb;
    this.phase = 'live';
    const from = { x: inbounder.pos.x, y: inbounder.pos.y };
    const to = { x: receiver.pos.x, y: receiver.pos.y };
    this.ball.holder = null;
    this.ball.flight = {
      kind: 'inbound', from, to, t: 0,
      dur: 0.2 + dist(from, to) / 40,
      catcher: receiver, passer: inbounder,
    };
  }

  /* ---------- periods ---------- */
  endQuarter() {
    this.ball.flight = null;
    this.ball.loose = null;
    this.ball.holder = null;
    const [a, b] = this.teams;
    if (this.quarter >= 4 && a.score !== b.score) {
      this.over = true;
      this.phase = 'over';
      const w = a.score > b.score ? a : b;
      this.emit('final', `FINAL — ${this.scoreLine()}. The ${w.name} take it!`, null);
      return;
    }
    this.emit('period', `End of ${this.qLabel()} — ${this.scoreLine()}`, null);
    this.quarter++;
    this.gameClock = this.quarter <= 4 ? this.quarterLen : 300;
    if (this.quarter === 5) this.emit('period', `Tied up — we're headed to overtime!`, null);
    const nextPoss = (this.qStartPoss + this.quarter + 1) % 2;
    this.setupInbound(nextPoss, this.baselineSpot(nextPoss), { sc: 24 });
  }
}

const api = { Game, COURT, SPOTS, fmtClock, fillRatings };
global.BBEngine = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
