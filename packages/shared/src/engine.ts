/* ============================================================
   engine.ts — headless basketball simulation (no DOM access)
   Drive a Game with game.step(dtSeconds).
   All positions are in feet on a 94x50 court, origin top-left.
   Team 0 attacks the right hoop, team 1 attacks the left hoop.

   Ported from the original engine.js with logic preserved exactly.
   ============================================================ */
import type { PlanAction, TeamPlan } from "./plan";
import type {
  DefScheme,
  GameConfig,
  GameOpts,
  InboundLoc,
  Player,
  PlayerConfig,
  Ratings,
  SimEvent,
  SimEventType,
  Tactics,
  TeamRuntime,
  Vec,
} from "./types";

export const COURT = { W: 94, H: 50, HOOP_X: 5.25, ARC: 23.75 };

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

export function fmtClock(s: number) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* Fill in any rating a config omits with a plausible value derived
   from body type and the ratings that are present, so minimal player
   configs (just the shooting ratings) still work. All ratings 25-99. */
export function fillRatings(cfg: PlayerConfig): Partial<Ratings> {
  const F = (v: number | undefined, fb: number) =>
    v == null ? clamp(Math.round(fb), 25, 99) : v;
  const r: Partial<Ratings> = {};
  r.speed = F(cfg.speed, 99 - (cfg.weightLb - 160) * 0.3 - (cfg.heightIn - 70) * 1.5);
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
  // touch travels: good jump shooters are good free-throw shooters
  r.freeThrow = F(cfg.freeThrow, cfg.midRange * 0.6 + cfg.threePoint * 0.4);
  return r;
}

/* Rating -> physical units */
const maxSpeedOf = (p: Player) => 12.2 + p.speed * 0.054; // ft/s
const accelOf = (p: Player) => 8 + p.acceleration * 0.16; // ft/s^2
const rebSkillOf = (p: Player) =>
  40 + p.rebound * 0.55 + (p.heightIn - 66) * 0.7 + p.strength * 0.12 + p.vertical * 0.08;
const offThreat = (p: Player) =>
  Math.max(p.threePoint, p.midRange, (p.layup + p.dunk) / 2) * 0.7 +
  p.iq * 0.15 + p.speed * 0.15;

function projectOnSeg(p: Vec, a: Vec, b: Vec) {
  const abx = b.x - a.x,
    aby = b.y - a.y;
  const L2 = abx * abx + aby * aby || 1e-6;
  const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / L2, 0, 1);
  const pt = { x: a.x + abx * t, y: a.y + aby * t };
  return { t, d: dist(p, pt), pt };
}

interface Spot {
  ax: number;
  ay: number;
  cat: "three" | "mid" | "inside";
}

/** A captured staged possession — enough to run the exact same play again. */
export interface LabSetup {
  players: {
    team: number;
    slot: number;
    pos: Vec;
    moveTarget: Vec | null;
    path: Vec[] | null;
    pathHold: boolean;
  }[];
  assignTargets: [number, Spot][];
  inbSpot: Vec;
  inbounderSlot: number;
  labTeam: number;
  gameClock: number;
  /** shot-clock seconds the possession starts with (1–24) */
  startShotClock: number;
  /** start the possession live (the offense already holds the ball in the
      frontcourt, clock running) instead of from an inbound. */
  live: boolean;
}

/* Half-court spots in "attack space": ax = feet from hoop toward
   midcourt, ay = lateral offset from the rim line. */
export const SPOTS: Spot[] = [
  { ax: 1.5, ay: -20.5, cat: "three" }, // corners
  { ax: 1.5, ay: 20.5, cat: "three" },
  { ax: 17, ay: -16, cat: "three" }, // wings
  { ax: 17, ay: 16, cat: "three" },
  { ax: 24.5, ay: 0, cat: "three" }, // top
  { ax: 23, ay: -9, cat: "three" }, // slots
  { ax: 23, ay: 9, cat: "three" },
  { ax: 14, ay: -6.5, cat: "mid" }, // elbows
  { ax: 14, ay: 6.5, cat: "mid" },
  { ax: 16.5, ay: 0, cat: "mid" }, // free-throw area
  { ax: 7, ay: -13, cat: "mid" }, // short corners
  { ax: 7, ay: 13, cat: "mid" },
  // the blocks sit at the lane line, like real post position — inside the
  // paint you duck in and out (offensive 3-second rule)
  { ax: 4.5, ay: -8.6, cat: "inside" }, // blocks
  { ax: 4.5, ay: 8.6, cat: "inside" },
  { ax: 2.5, ay: -9, cat: "inside" }, // dunker spots
  { ax: 2.5, ay: 9, cat: "inside" },
];

type LineFn = (n: string, d?: number) => string;
const LINES: {
  make: Record<string, LineFn[]>;
  miss: Record<string, LineFn[]>;
  steal: ((s: string, v: string) => string)[];
} = {
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

export type PassType =
  | "chest"
  | "bounce"
  | "skip"
  | "lob"
  | "entry"
  | "outlet"
  | "hitAhead"
  | "pocket"
  | "kickout"
  | "noLook"
  | "handoff";

type PassLineFn = (p: string, c: string) => string;
const PASS_LINES: Record<PassType, PassLineFn[]> = {
  chest: [
    (p, c) => `${p} swings it to ${c}`,
    (p, c) => `${p} moves it along to ${c}`,
    (p, c) => `${p} finds ${c} on the perimeter`,
  ],
  bounce: [
    (p, c) => `${p} threads a bounce pass to ${c}`,
    (p, c) => `${p} sneaks a bounce pass through to ${c}`,
  ],
  skip: [
    (p, c) => `${p} whips a cross-court skip pass to ${c}`,
    (p, c) => `${p} skips it over the defense to ${c}`,
  ],
  lob: [
    (p, c) => `${p} floats a lob in to ${c}`,
    (p, c) => `${p} tosses it over the top to ${c}`,
  ],
  entry: [
    (p, c) => `${p} feeds ${c} on the block`,
    (p, c) => `${p} drops it into ${c} inside`,
  ],
  outlet: [
    (p, c) => `${p} fires the outlet to ${c}`,
    (p, c) => `${p} kicks the outlet ahead to ${c}`,
  ],
  hitAhead: [
    (p, c) => `${p} hits ${c} ahead of the pack`,
    (p, c) => `${p} pushes it up the floor to ${c}`,
  ],
  pocket: [
    (p, c) => `${p} slips a pocket pass to ${c} on the roll`,
    (p, c) => `${p} drops it off to the rolling ${c}`,
  ],
  kickout: [
    (p, c) => `${p} drives and kicks to ${c}`,
    (p, c) => `${p} collapses the defense and sprays it to ${c}`,
  ],
  noLook: [
    (p, c) => `${p} drops a no-look dime to ${c}`,
    (p, c) => `${p} finds ${c} without even looking`,
  ],
  handoff: [
    (p, c) => `${p} hands it off to ${c}`,
    (p, c) => `${p} dribbles into the hand-off with ${c}`,
  ],
};

interface Flight {
  kind: "pass" | "shot" | "inbound";
  from: Vec;
  to: Vec;
  t: number;
  dur: number;
  passer?: Player | null;
  catcher?: Player;
  errant?: boolean;
  passType?: PassType;
  // shot-only fields
  shooter?: Player;
  made?: boolean;
  pts?: number;
  label?: string;
  d?: number;
  assist?: Player | null;
  defD?: number;
  defName?: string | null;
  prob?: number;
  /** the shooter was fouled on a made basket — one FT coming */
  andOne?: boolean;
  /** this flight is a free-throw attempt */
  ft?: boolean;
  /** jumper taken off the dribble, not a set catch-and-shoot */
  pullUp?: boolean;
}

interface Loose {
  pos: Vec;
  vel: Vec;
  timer: number;
  isRebound: boolean;
  touchTeam: number;
  phase?: number;
  /** seconds the ball is still in the AIR off the rim — a rebound is caught
      at hand height during this window (the NBA board) and only hits the
      floor if nobody gets to it */
  airborne?: number;
}

interface Ball {
  pos: Vec;
  holder: Player | null;
  flight: Flight | null;
  loose: Loose | null;
  air: number;
}

export class Game {
  onEvent: (e: SimEvent) => void;
  quarterLen: number;
  hoops: Vec[];
  teams: TeamRuntime[];
  quarter!: number;
  gameClock!: number;
  shotClock!: number;
  shotClockActive!: boolean;
  ball!: Ball;
  possession!: number;
  qStartPoss!: number;
  phase!: "setup" | "live" | "over";
  over!: boolean;
  lastPasser!: Player | null;
  sinceCatch!: number;
  lastShotTeam!: number;
  claims!: Map<number, number>[];
  deadTimer = 0;
  /** the current inbound (inbounder + receiver + spot), or null when the
      possession started live (mid-possession, no inbound). */
  inb!: { inbounder: Player; receiver: Player; spot: Vec } | null;
  tactics!: Tactics[];
  /** roles for the team currently on offense. `focus` is the primary scoring
      option; `scorers` is every option in priority order. `screener` is kept
      for the inert screen machinery and is currently always null. */
  roles!: {
    handler: Player | null;
    screener: Player | null;
    focus: Player | null;
    scorers: Player[];
  };
  /** fixed hold-spots for dragged-into-place players, keyed by player id */
  assignTargets: Map<number, Spot> = new Map();
  screen!: { timer: number; screener: Player; handler: Player } | null;
  /** live plan-driven pick-and-roll: screener jogs to the ball ("approach"),
      sets the pick ("set"), then rolls or pops */
  pnr: {
    handler: Player;
    screener: Player;
    finish: "roll" | "pop";
    phase: "approach" | "set";
    timer: number;
  } | null = null;
  /** seconds before the offense hunts the next ball screen */
  pnrCooldown = 0;
  /** seconds of transition remaining after a live change of possession */
  fastBreak = 0;
  /** single-possession lab mode: which team's possession we're watching */
  lab: { team: number } | null = null;
  /** lab: the staged possession started live (mid-possession) rather than from
      an inbound. Captured into / restored from the LabSetup. */
  labStartLive = false;
  frozen = false;
  /** inbound deferred by a lab freeze, replayed on resume */
  labPending: { team: number; spot: Vec; sc: number } | null = null;
  /** jump-ball state: game and OT periods open with a tip, not an inbound */
  tipoff = false;
  jumpers: Player[] = [];
  /** team fouls this quarter, per team — 5+ puts the other side in the bonus */
  teamFouls: [number, number] = [0, 0];
  /** a free-throw sequence in progress: the game clock is dead and step()
      drives nothing but the shooter's attempts until it resolves */
  ftState: { shooter: Player; remaining: number; total: number; timer: number } | null = null;

  constructor(cfg: GameConfig, opts: GameOpts = {}) {
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
    this.phase = "setup";
    this.over = false;
    this.lastPasser = null;
    this.sinceCatch = 99;
    this.lastShotTeam = 0;
    this.claims = [new Map(), new Map()];
    this.tactics = [
      { defScheme: "man", scorers: [] },
      { defScheme: "man", scorers: [] },
    ];
    this.roles = { handler: null, screener: null, focus: null, scorers: [] };
    this.screen = null;
    this.emit("period", `Tip-off! Jump ball at center court`, null);
    this.setupTipoff();
  }

  makePlayer(cfg: PlayerConfig, team: number, slot: number): Player {
    const baseTend = Object.assign(
      { shoot: 50, three: 50, drive: 50, pass: 50, kickout: 50, help: 50, crash: 50, gamble: 50 },
      cfg.tendencies || {}
    );
    return {
      ...cfg,
      ...fillRatings(cfg),
      position: cfg.pos || "", // cfg.pos (the label) is shadowed by the coordinate below
      team,
      slot,
      id: team * 5 + slot,
      tend: { ...baseTend },
      baseTend,
      pos: { x: 47 + rand(-15, 15), y: 25 + rand(-15, 15) },
      vel: { x: 0, y: 0 },
      moveTarget: null,
      allowOOB: false,
      driving: false,
      driveSide: 1,
      decisionTimer: rand(0.3, 0.6),
      spotIdx: -1,
      spotTimer: 0,
      rollTimer: 0,
      keyTime: 0,
      zoneIdx: -1,
      annotation: null,
      path: null,
      pathIdx: 0,
      pathHold: true,
      stats: { pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0 },
    } as Player;
  }

  /* Man-to-man matchups: biggest offensive threats draw the best
     defenders. Quality is the defender's relevant defensive rating
     minus a size-mismatch penalty; strength shrinks the effective
     size gap, so strong small guards (Smart, Caruso types) can take
     bigger assignments — but nobody ends up on a 7-footer. */
  matchScore(d: Player, o: Player) {
    // guards/wings are perimeter assignments; bigs are interior ones
    const perim = o.heightIn <= 79 || o.threePoint >= (o.layup + o.dunk) / 2;
    const dq = perim
      ? d.perimeterD * 0.8 + d.steal * 0.2
      : d.interiorD * 0.7 + d.block * 0.2 + d.strength * 0.1;
    const sizeGap = Math.max(0, o.heightIn - d.heightIn - (d.strength - 50) * 0.1);
    return dq + d.iq * 0.25 - sizeGap * sizeGap * 0.9;
  }

  assignMatchups() {
    for (let ti = 0; ti < 2; ti++) {
      const defs = this.teams[ti].players;
      const offs = this.teams[1 - ti].players;
      // greedy seed: biggest threats draw the best available defender
      const pool = defs.slice();
      for (const o of offs.slice().sort((a, b) => offThreat(b) - offThreat(a))) {
        let best: Player | null = null,
          bs = -Infinity;
        for (const d of pool) {
          const s = this.matchScore(d, o);
          if (s > bs) {
            bs = s;
            best = d;
          }
        }
        pool.splice(pool.indexOf(best!), 1);
        best!.markSlot = o.slot;
      }
      // 2-opt: swap assignments while it improves the total fit, so
      // nobody is left stranded on a hopeless mismatch
      const markOf = (d: Player) => offs.find((q) => q.slot === d.markSlot)!;
      for (let pass = 0; pass < 4; pass++) {
        let improved = false;
        for (let i = 0; i < defs.length; i++) {
          for (let j = i + 1; j < defs.length; j++) {
            const a = defs[i],
              b = defs[j];
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

  /** Pin the coach's explicit man assignments (plan.matchups) on top of the
      auto matchups: each named defender takes the named attacker, trading
      marks with whoever had him so the assignment stays a permutation. */
  applyPlanMatchups(team: number) {
    const pairs = this.tactics[team]?.plan?.matchups;
    if (!pairs?.length) return;
    const defs = this.teams[team].players;
    for (const { defenderSlot, targetSlot } of pairs) {
      const d = defs[defenderSlot];
      if (!d || d.markSlot === targetSlot) continue;
      const cur = defs.find((q) => q.markSlot === targetSlot);
      if (cur) cur.markSlot = d.markSlot;
      d.markSlot = targetSlot;
    }
  }

  /* ---------- helpers ---------- */
  qLabel() {
    if (this.quarter <= 4) return "Q" + this.quarter;
    const n = this.quarter - 4;
    return n > 1 ? "OT" + n : "OT";
  }
  emit(type: SimEventType, text: string, team: number | null) {
    this.onEvent({ type, text, team, qLabel: this.qLabel(), clock: fmtClock(this.gameClock) });
  }
  scoreLine() {
    const [a, b] = this.teams;
    return `${a.abbr} ${a.score}, ${b.abbr} ${b.score}`;
  }
  attackSign(team: number) {
    return this.hoops[team].x > COURT.W / 2 ? 1 : -1;
  }
  inFrontcourt(pos: Vec, team: number) {
    return this.attackSign(team) > 0 ? pos.x > 49 : pos.x < 45;
  }
  spotPos(team: number, s: Spot) {
    const hoop = this.hoops[team];
    const dir = hoop.x > COURT.W / 2 ? -1 : 1;
    return { x: hoop.x + dir * s.ax, y: COURT.H / 2 + s.ay };
  }
  mates(p: Player) {
    return this.teams[p.team].players.filter((q) => q !== p);
  }
  allPlayers() {
    return this.teams[0].players.concat(this.teams[1].players);
  }
  nearestOppTo(team: number, pos: Vec) {
    let best: Player | null = null,
      bd = Infinity;
    for (const o of this.teams[1 - team].players) {
      const d = dist(o.pos, pos);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return { p: best as Player, d: bd };
  }
  openness(p: Player) {
    return this.nearestOppTo(p.team, p.pos).d;
  }
  baselineSpot(team: number) {
    // Inbound spot behind the hoop `team` defends.
    const hoop = this.hoops[1 - team];
    const x = hoop.x > COURT.W / 2 ? COURT.W + 1.5 : -1.5;
    return { x, y: COURT.H / 2 + rand(-9, 9) };
  }
  sidelineSpot(team: number) {
    // Frontcourt sideline inbound (half-court set, like after a timeout).
    const hoop = this.hoops[team];
    const dir = hoop.x > COURT.W / 2 ? -1 : 1; // toward midcourt
    const y = Math.random() < 0.5 ? -1.5 : COURT.H + 1.5;
    return { x: hoop.x + dir * 19, y };
  }
  /** Deterministic inbound spot for a named lab location, so re-staging
      never makes the ball jump to a new random spot. */
  labInboundSpot(team: number, loc: InboundLoc): Vec {
    const oh = this.hoops[team]; // hoop the offense attacks
    const dir = oh.x > COURT.W / 2 ? -1 : 1; // toward midcourt
    const top = -1.5;
    const bot = COURT.H + 1.5;
    const baseX = dir < 0 ? COURT.W + 1.5 : -1.5; // behind the offensive basket
    switch (loc) {
      case "side-top":
        return { x: oh.x + dir * 19, y: top };
      case "side-bot":
        return { x: oh.x + dir * 19, y: bot };
      case "base-top":
        return { x: baseX, y: COURT.H / 2 - 8 };
      case "base-bot":
        return { x: baseX, y: COURT.H / 2 + 8 };
      case "full":
      default: {
        const dh = this.hoops[1 - team]; // behind the basket the offense defends
        return { x: dh.x > COURT.W / 2 ? COURT.W + 1.5 : -1.5, y: COURT.H / 2 };
      }
    }
  }
  /** Is `pos` inside the key (paint) in front of the hoop `offTeam` attacks?
      The lane is 16 ft wide and runs 19 ft out from the baseline. */
  inKey(pos: Vec, offTeam: number) {
    if (Math.abs(pos.y - COURT.H / 2) > 8) return false;
    return this.hoops[offTeam].x > COURT.W / 2 ? pos.x > COURT.W - 19 : pos.x < 19;
  }

  /** Nearest step-out point clear of the lane. Placed well past the line so
      players cross it at speed instead of decelerating on top of it. */
  paintExit(p: Player): Vec {
    const hoop = this.hoops[this.possession];
    const yEdge = p.pos.y >= COURT.H / 2 ? COURT.H / 2 + 11 : COURT.H / 2 - 11;
    const xEdge = hoop.x > COURT.W / 2 ? COURT.W - 22.5 : 22.5;
    return Math.abs(yEdge - p.pos.y) <= Math.abs(xEdge - p.pos.x)
      ? { x: p.pos.x, y: yEdge }
      : { x: xEdge, y: p.pos.y };
  }

  /** Offensive & defensive three-second rules. Accrues each player's
      continuous time in the attacked key, steers players back out before
      the whistle (duck in, clear out — like real bigs), and calls the rare
      violation that slips through. Returns true if a whistle stopped play. */
  updatePaintRules(dt: number): boolean {
    const off = this.possession;
    // both counts only run while the offense controls the ball in the
    // frontcourt; a shot, loose ball, or inbound resets everyone
    const ctrl =
      !this.ball.loose &&
      !(this.ball.flight && this.ball.flight.kind !== "pass") &&
      this.inFrontcourt(this.ball.pos, off);
    if (!ctrl) {
      for (const p of this.allPlayers()) p.keyTime = 0;
      return false;
    }
    const holder = this.ball.holder;
    const f = this.ball.flight;
    for (const p of this.teams[off].players) {
      if (!this.inKey(p.pos, off)) {
        p.keyTime = 0;
        continue;
      }
      p.keyTime += dt;
      if (p.keyTime > 3) {
        p.stats.tov++;
        this.emit("turnover", `Three seconds in the key on ${p.name} — turnover`, p.team);
        this.setupInbound(1 - off, this.oobSpot(p.pos), { sc: 24 });
        return true;
      }
      // camped too long: clear out past the nearest lane line. A driving
      // handler is finishing his own action, catchers meet the pass, and
      // an authored lab route is the user's to run.
      const steer =
        p === holder
          ? p.keyTime > 2.0 && !p.driving
          : p.keyTime > 1.6 && f?.catcher !== p && !(p.path && p.pathIdx < p.path.length);
      if (steer) p.moveTarget = this.paintExit(p);
    }
    for (const p of this.teams[1 - off].players) {
      // legal as long as he's actively guarding someone within arm's length
      const guarding = this.teams[off].players.some((o) => dist(o.pos, p.pos) < 3.5);
      if (!this.inKey(p.pos, off) || guarding) {
        p.keyTime = 0;
        continue;
      }
      p.keyTime += dt;
      if (p.keyTime > 3) {
        // no free-throw machinery: call it and hand the offense a fresh clock
        this.emit("info", `Defensive three seconds on ${p.name} — illegal defense`, p.team);
        this.shotClock = Math.max(this.shotClock, 14);
        p.keyTime = 0;
        continue;
      }
      if (p.keyTime > 1.8) p.moveTarget = this.paintExit(p);
    }
    return false;
  }

  oobSpot(p: Vec) {
    const dl = p.x,
      dr = COURT.W - p.x,
      du = p.y,
      dd = COURT.H - p.y;
    const m = Math.min(dl, dr, du, dd);
    if (m === du) return { x: clamp(p.x, 4, COURT.W - 4), y: -1.5 };
    if (m === dd) return { x: clamp(p.x, 4, COURT.W - 4), y: COURT.H + 1.5 };
    if (m === dl) return { x: -1.5, y: clamp(p.y, 4, COURT.H - 4) };
    return { x: COURT.W + 1.5, y: clamp(p.y, 4, COURT.H - 4) };
  }

  /* ---------- main loop ---------- */
  step(dt: number) {
    if (this.over || this.frozen) return;
    if (this.ftState) {
      this.stepFreeThrows(dt);
      return;
    }
    if (this.phase === "setup") {
      if (!this.tipoff) this.updateDefense();
      this.moveAll(dt);
      this.ballFollow();
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) {
        if (this.tipoff) {
          this.resolveTipoff();
        } else if (
          // don't throw it in until the inbounder is actually standing
          // at the out-of-bounds spot (forced release as a backstop)
          dist(this.inb!.inbounder.pos, this.inb!.spot) < 2 ||
          this.deadTimer < -4
        ) {
          this.releaseInbound();
        }
      }
      return;
    }
    const clockOn = !(this.ball.flight && this.ball.flight.kind === "inbound");
    if (clockOn) {
      this.gameClock = Math.max(0, this.gameClock - dt);
      if (this.shotClockActive) {
        this.shotClock -= dt;
        if (this.shotClock <= 0) {
          this.shotClockViolation();
          return;
        }
      }
    }
    this.sinceCatch += dt;
    this.fastBreak = Math.max(0, this.fastBreak - dt);
    this.pnrCooldown = Math.max(0, this.pnrCooldown - dt);
    if (this.screen) {
      this.screen.timer -= dt;
      if (this.screen.timer <= 0) this.screen = null;
    }
    this.updateOffense(dt);
    this.updateDefense();
    if (this.updatePaintRules(dt)) return;
    if (this.ball.loose) this.updateLoose(dt);
    this.moveAll(dt);
    if (this.ball.flight) this.updateFlight(dt);
    else if (this.ball.holder) this.updateHandler(dt);
    this.ballFollow();
    if (
      this.gameClock <= 0 &&
      this.phase === "live" &&
      !(this.ball.flight && this.ball.flight.kind === "shot")
    ) {
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
  moveAll(dt: number) {
    for (const t of this.teams) {
      for (const p of t.players) {
        const tgt = p.moveTarget;
        let dvx = 0,
          dvy = 0;
        if (tgt) {
          const dx = tgt.x - p.pos.x,
            dy = tgt.y - p.pos.y;
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
        const a = all[i],
          b = all[j];
        const dx = b.pos.x - a.pos.x,
          dy = b.pos.y - a.pos.y;
        const d = Math.hypot(dx, dy);
        if (d < 1.6 && d > 0.001) {
          const push = (1.6 - d) * 0.5 * dt * 8;
          const ux = dx / d,
            uy = dy / d;
          a.pos.x -= ux * push;
          a.pos.y -= uy * push;
          b.pos.x += ux * push;
          b.pos.y += uy * push;
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
  updateOffense(dt: number) {
    if (this.ball.loose) return;
    // the shot is in the air: crashers attack the glass at the release,
    // everyone else starts finding floor balance
    if (this.ball.flight?.kind === "shot" && !this.ball.flight.ft) {
      this.crashGlass();
      return;
    }
    if (this.fastBreak > 0) {
      this.transitionOffense();
      return;
    }
    const holder = this.ball.holder;
    const planHandled = this.runPlanActions(dt);
    for (const p of this.teams[this.possession].players) {
      if (p === holder) continue;
      if (this.ball.flight && this.ball.flight.catcher === p) {
        p.moveTarget = { ...this.ball.flight.to };
        continue;
      }
      if (planHandled.has(p)) continue;
      if (p.path && p.path.length) {
        // lab-authored motion path: run the waypoints in order
        if (p.pathIdx < p.path.length) {
          p.moveTarget = { ...p.path[p.pathIdx] };
          if (dist(p.pos, p.path[p.pathIdx]) < 2) p.pathIdx++;
          continue;
        }
        // route finished: hold the end spot, or (keep-moving) fall through
        // and rejoin the live offense
        if (p.pathHold) {
          p.moveTarget = { ...p.path[p.path.length - 1] };
          continue;
        }
      }
      if (p.rollTimer > 0) {
        // screener rolling hard to the rim
        p.rollTimer -= dt;
        const hoop = this.hoops[p.team];
        const side = p.pos.y >= COURT.H / 2 ? 1 : -1;
        p.moveTarget = this.spotPos(p.team, { ax: 3, ay: side * 4, cat: "inside" });
        continue;
      }
      if (this.playTarget(p)) continue;
      p.spotTimer -= dt;
      if (p.spotIdx < 0 || p.spotTimer <= 0) this.assignSpot(p);
      p.moveTarget = this.spotPos(p.team, SPOTS[p.spotIdx]);
    }
  }

  /** Off-ball assignment for players dragged to a fixed hold-spot. Returns
      true if it set a target; otherwise the player flows in the motion spots. */
  playTarget(p: Player): boolean {
    // a player dragged into place holds that spot instead of drifting
    const fixed = this.assignTargets.get(p.id);
    if (fixed && p !== this.roles.focus) {
      p.moveTarget = this.spotPos(p.team, fixed);
      return true;
    }
    return false;
  }

  /** Drive the compiled plan's on-court actions (pick-and-roll, off-ball
      screens to free a target, post-ups). Returns the offensive players
      whose movement is owned by the play this frame, so the generic
      spot-flow logic leaves them alone. */
  runPlanActions(dt: number): Set<Player> {
    const handled = new Set<Player>();
    const team = this.possession;
    const plan = this.tactics[team].plan;
    if (!plan) {
      this.pnr = null;
      return handled;
    }
    const ps = this.teams[team].players;
    const holder = this.ball.holder;
    const ballFront = this.inFrontcourt(this.ball.pos, team);

    // ---- pick and roll ----
    const pa = plan.actions.find((a) => a.type === "pickAndRoll");
    if (pa) {
      if (this.pnr) {
        const { handler, screener } = this.pnr;
        if (this.pnr.phase === "approach") {
          this.pnr.timer -= dt;
          // the action died: handler gave the ball up or the screen stalled
          if (holder !== handler || this.pnr.timer <= 0) {
            this.pnr = null;
            this.pnrCooldown = 1.5;
          } else {
            const def = this.nearestOppTo(handler.team, handler.pos).p;
            screener.moveTarget = def ? { x: def.pos.x, y: def.pos.y } : { ...handler.pos };
            handled.add(screener);
            if (def && dist(screener.pos, def.pos) < 2.4 && dist(screener.pos, handler.pos) < 6) {
              // pick is set: handler turns the corner off the screener's body
              this.pnr.phase = "set";
              this.pnr.timer = 0.8;
              this.screen = { timer: 1.1, screener, handler };
              handler.driving = true;
              handler.driveSide = Math.sign(screener.pos.y - handler.pos.y) || 1;
              this.emit("info", `${screener.name} sets the pick for ${handler.name}`, team);
            }
          }
        } else {
          // hold the screen a beat, then roll to the rim or pop to the arc
          this.pnr.timer -= dt;
          screener.moveTarget = { x: screener.pos.x, y: screener.pos.y };
          handled.add(screener);
          if (this.pnr.timer <= 0) {
            if (this.pnr.finish === "pop") {
              const side = screener.pos.y >= COURT.H / 2 ? 1 : -1;
              const idx = SPOTS.findIndex(
                (s) => s.cat === "three" && s.ax > 20 && Math.sign(s.ay || side) === side
              );
              screener.spotIdx = idx >= 0 ? idx : 4;
              screener.spotTimer = 6;
            } else {
              screener.rollTimer = 2.4;
            }
            this.pnr = null;
            this.pnrCooldown = rand(5, 8);
          }
        }
      } else if (this.pnrCooldown <= 0 && holder && ballFront && !holder.driving) {
        const handler = (pa.handlerSlot != null ? ps[pa.handlerSlot] : this.roles.handler) ?? null;
        let screener = (pa.screenerSlot != null ? ps[pa.screenerSlot] : this.roles.screener) ?? null;
        if (screener === handler) screener = null;
        if (handler && screener && holder === handler) {
          this.pnr = {
            handler,
            screener,
            finish: pa.finish ?? "roll",
            phase: "approach",
            timer: 4.5,
          };
        }
      }
    } else {
      this.pnr = null;
    }

    // ---- get a man open: a teammate keeps screening his defender ----
    const ga = plan.actions.find((a) => a.type === "getOpen");
    if (ga && ga.targetSlot != null && holder && ballFront) {
      const target = ps[ga.targetSlot];
      let scr = ga.screenerSlot != null ? (ps[ga.screenerSlot] ?? null) : null;
      if (!scr || scr === target) {
        scr =
          ps
            .filter((q) => q !== target && q !== holder && q !== this.roles.handler)
            .sort((a, b) => b.strength + b.heightIn * 2 - (a.strength + a.heightIn * 2))[0] ??
          null;
      }
      if (target && target !== holder && scr && scr !== holder && !handled.has(scr)) {
        const def = this.nearestOppTo(team, target.pos).p;
        if (def) {
          scr.moveTarget = { x: def.pos.x, y: def.pos.y };
          handled.add(scr);
        }
        // the target keeps sprinting to fresh spots off the screens
        if (target.spotTimer > 2.4) target.spotTimer = 2.4;
      }
    }

    // ---- post up: the target seals on the block, waiting for the entry ----
    const pu = plan.actions.find((a) => a.type === "postUp");
    if (pu && pu.targetSlot != null && ballFront) {
      const target = ps[pu.targetSlot];
      if (
        target &&
        target !== holder &&
        !handled.has(target) &&
        !(this.ball.flight && this.ball.flight.catcher === target)
      ) {
        const side = target.pos.y >= COURT.H / 2 ? 1 : -1;
        // seal at the block, outside the lane — step in on the entry pass
        target.moveTarget = this.spotPos(team, { ax: 4.5, ay: side * 8.6, cat: "inside" });
        handled.add(target);
      }
    }

    return handled;
  }

  /** While a live shot flies: inclined (or already-deep) teammates attack
      the offensive glass so they're under the carom when it comes off —
      real crashers move at the release, not after the bounce. */
  crashGlass() {
    const f = this.ball.flight!;
    const off = f.shooter!.team;
    const hoop = this.hoops[off];
    const dir = hoop.x > COURT.W / 2 ? -1 : 1; // toward the floor
    for (const p of this.teams[off].players) {
      if (p === f.shooter) continue;
      const d = dist(p.pos, hoop);
      if (p.tend.crash >= 55 || d < 13) {
        // carve out rebounding position in front of the rim, split by side
        const side = p.pos.y >= hoop.y ? 1 : -1;
        p.moveTarget = {
          x: hoop.x + dir * (3 + (p.slot % 3)),
          y: hoop.y + side * (2 + (p.slot % 2) * 3.5),
        };
      }
      // everyone else holds his spot — safe floor balance
    }
  }

  /** Fill the lanes: rim runner, two corner sprinters, a trailer. */
  transitionOffense() {
    const hoop = this.hoops[this.possession];
    const holder = this.ball.holder;
    const runners = this.teams[this.possession].players.filter((p) => {
      if (p === holder) return false;
      if (this.ball.flight && this.ball.flight.catcher === p) {
        p.moveTarget = { ...this.ball.flight.to };
        return false;
      }
      return true;
    });
    runners.sort((a, b) => dist(a.pos, hoop) - dist(b.pos, hoop));
    const lanes: Spot[] = [
      { ax: 3, ay: 0, cat: "inside" }, // rim run
      { ax: 2, ay: -19, cat: "three" }, // corners
      { ax: 2, ay: 19, cat: "three" },
      { ax: 24.5, ay: 0, cat: "three" }, // trailer
    ];
    const taken = new Set<number>();
    for (const p of runners) {
      let best = -1,
        bd = Infinity;
      for (let i = 0; i < lanes.length; i++) {
        if (taken.has(i)) continue;
        const d = dist(p.pos, this.spotPos(p.team, lanes[i]));
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (best < 0) continue; // more runners than lanes (ball in flight)
      taken.add(best);
      p.moveTarget = this.spotPos(p.team, lanes[best]);
    }
  }

  assignSpot(p: Player) {
    const claims = this.claims[p.team];
    claims.delete(p.id);
    const taken = new Set(claims.values());
    // iso spacing: everyone but the iso man clears out to the arc,
    // away from his side of the floor
    const isoA = this.tactics[p.team].plan?.actions.find((a) => a.type === "iso");
    const isoMan = isoA?.targetSlot != null ? this.teams[p.team].players[isoA.targetSlot] : null;
    if (isoMan && isoMan !== p && p.team === this.possession) {
      let cands = SPOTS.map((s, i) => i).filter(
        (i) =>
          SPOTS[i].cat === "three" &&
          !taken.has(i) &&
          dist(this.spotPos(p.team, SPOTS[i]), isoMan.pos) > 16
      );
      if (!cands.length)
        cands = SPOTS.map((s, i) => i).filter((i) => SPOTS[i].cat === "three" && !taken.has(i));
      if (cands.length) {
        p.spotIdx = pick(cands);
        claims.set(p.id, p.spotIdx);
        p.spotTimer = rand(4, 8);
        return;
      }
    }
    const tf = (t: number) => 0.3 + t * 0.014; // tendency factor: 50 -> 1.0
    const w3 = Math.pow(p.threePoint, 2.2) * tf(p.tend.three);
    const wm = Math.pow(p.midRange, 2.2);
    const wi = Math.pow((p.layup + p.dunk) / 2, 2.2) * tf(p.tend.drive);
    const total = w3 + wm + wi;
    const r = Math.random() * total;
    const cat: Spot["cat"] = r < w3 ? "three" : r < w3 + wm ? "mid" : "inside";
    let cands = SPOTS.map((s, i) => i).filter((i) => SPOTS[i].cat === cat && !taken.has(i));
    if (!cands.length) cands = SPOTS.map((s, i) => i).filter((i) => !taken.has(i));
    p.spotIdx = pick(cands);
    claims.set(p.id, p.spotIdx);
    // a spot inside the lane is a duck-in, not a camp — the 3-second rule
    // (and real spacing) says get in, look for the ball, get out
    p.spotTimer = this.inKey(this.spotPos(p.team, SPOTS[p.spotIdx]), p.team)
      ? rand(1.0, 2.0)
      : rand(3, 7);
  }

  /* ---------- defense ---------- */
  updateDefense() {
    if (this.ball.loose) return;
    const defTeam = 1 - this.possession;
    const hoop = this.hoops[this.possession]; // the hoop being attacked
    const f = this.ball.flight;
    const scheme = this.tactics[defTeam].defScheme;
    // react to a live pass: defenders near the remaining flight path
    // lunge into the lane for the pick or deflection
    const lunged = new Set<Player>();
    if (f && f.kind === "pass" && !f.errant) {
      for (const p of this.teams[defTeam].players) {
        const pr = projectOnSeg(p.pos, this.ball.pos, f.to);
        // jump the lane only where the pick is live (not at the catch point)
        if (pr.d < 3.0 && dist(pr.pt, f.to) > 4.0) {
          p.moveTarget = pr.pt;
          lunged.add(p);
        }
      }
    }
    if (this.fastBreak > 0) {
      this.transitionDefense(defTeam, lunged);
      return;
    }
    if (scheme === "zone") {
      this.zoneDefense(defTeam, lunged);
      return;
    }
    if (scheme === "switch") this.trySwitches(defTeam);
    for (const p of this.teams[defTeam].players) {
      if (lunged.has(p)) continue;
      const mark = this.teams[this.possession].players.find((q) => q.slot === p.markSlot)!;
      const onBall = mark === this.ball.holder;
      const dm = dist(mark.pos, hoop);
      // sag off non-shooters, close out on snipers; better defenders
      // pressure the ball tighter
      const shooterTight = 1 - (mark.threePoint - 50) * 0.0045;
      const g = onBall
        ? clamp(2.8 - (p.perimeterD + p.iq) * 0.008, 1.0, 2.2)
        : clamp((2.5 + dm * 0.11) * shooterTight, 1.8, 6.5);
      const vx = hoop.x - mark.pos.x,
        vy = hoop.y - mark.pos.y;
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
    this.applyDoubleTeam(defTeam, lunged);
  }

  /** Coached double-team: when the marked man has the ball in the frontcourt,
      the chosen doubler (or the nearest helper) abandons his man and traps the
      ball. The man he leaves is open — that's the gamble. */
  applyDoubleTeam(defTeam: number, lunged: Set<Player>) {
    const dbl = this.tactics[defTeam].plan?.double;
    const holder = this.ball.holder;
    if (
      !dbl ||
      !holder ||
      holder.team !== this.possession ||
      holder.slot !== dbl.targetSlot ||
      !this.inFrontcourt(holder.pos, this.possession)
    )
      return;
    const defs = this.teams[defTeam].players;
    let doubler: Player | null = dbl.doublerSlot != null ? (defs[dbl.doublerSlot] ?? null) : null;
    // no named doubler: the nearest defender not already on the ball comes
    if (!doubler) {
      let bd = Infinity;
      for (const p of defs) {
        if (p.markSlot === holder.slot) continue;
        const d = dist(p.pos, holder.pos);
        if (d < bd) {
          bd = d;
          doubler = p;
        }
      }
    }
    if (!doubler || lunged.has(doubler) || doubler.markSlot === holder.slot) return;
    // close from where he stands so the trap converges from a second angle
    const dx = doubler.pos.x - holder.pos.x;
    const dy = doubler.pos.y - holder.pos.y;
    const L = Math.hypot(dx, dy) || 1;
    doubler.moveTarget = { x: holder.pos.x + (dx / L) * 1.4, y: holder.pos.y + (dy / L) * 1.4 };
  }

  /** Scramble defense while the break is on: deepest man protects the
      rim, everyone else picks up the nearest unclaimed attacker. */
  transitionDefense(defTeam: number, lunged: Set<Player>) {
    const hoop = this.hoops[this.possession];
    const offs = this.teams[this.possession].players;
    const defs = this.teams[defTeam].players
      .slice()
      .sort((a, b) => dist(a.pos, hoop) - dist(b.pos, hoop));
    const ballPos = this.ball.pos;
    const claimed = new Set<Player>();
    defs.forEach((p, i) => {
      if (lunged.has(p)) return;
      if (i === 0) {
        // build the wall: sit between the rim and the ball
        const ux = (ballPos.x - hoop.x) / (dist(ballPos, hoop) || 1);
        const uy = (ballPos.y - hoop.y) / (dist(ballPos, hoop) || 1);
        const depth = Math.min(9, dist(ballPos, hoop) * 0.5);
        p.moveTarget = { x: hoop.x + ux * depth, y: hoop.y + uy * depth };
        return;
      }
      let near: Player | null = null,
        nd = Infinity;
      for (const o of offs) {
        if (claimed.has(o)) continue;
        const d = dist(p.pos, o.pos);
        if (d < nd) {
          nd = d;
          near = o;
        }
      }
      if (!near) return;
      claimed.add(near);
      // pick him up goal-side
      const ux = (hoop.x - near.pos.x) / (dist(near.pos, hoop) || 1);
      const uy = (hoop.y - near.pos.y) / (dist(near.pos, hoop) || 1);
      p.moveTarget = { x: near.pos.x + ux * 1.8, y: near.pos.y + uy * 1.8 };
    });
  }

  /** 2-3 zone: hold your area, shade toward the ball, nearest man
      closes out on the handler. */
  zoneDefense(defTeam: number, lunged: Set<Player>) {
    const anchors: Spot[] = [
      { ax: 15, ay: -7, cat: "mid" }, // top guards
      { ax: 15, ay: 7, cat: "mid" },
      { ax: 8, ay: -14, cat: "mid" }, // baseline wings
      { ax: 8, ay: 14, cat: "mid" },
      { ax: 4.5, ay: 0, cat: "inside" }, // middle
    ];
    const defs = this.teams[defTeam].players;
    if (defs.some((p) => p.zoneIdx < 0)) this.assignZones(defTeam);
    const bp = this.ball.pos;
    const holder = this.ball.holder;
    const ballInFront = this.inFrontcourt(bp, this.possession);
    // the defender whose anchor is closest to the ball closes out
    let closer: Player | null = null;
    if (holder && ballInFront) {
      let bd = Infinity;
      for (const p of defs) {
        const a = this.spotPos(this.possession, anchors[p.zoneIdx]);
        const d = dist(a, bp);
        if (d < bd) {
          bd = d;
          closer = p;
        }
      }
    }
    for (const p of defs) {
      if (lunged.has(p)) continue;
      const a = this.spotPos(this.possession, anchors[p.zoneIdx]);
      if (p === closer && holder) {
        const hoop = this.hoops[this.possession];
        const ux = (hoop.x - holder.pos.x) / (dist(holder.pos, hoop) || 1);
        const uy = (hoop.y - holder.pos.y) / (dist(holder.pos, hoop) || 1);
        p.moveTarget = { x: holder.pos.x + ux * 1.8, y: holder.pos.y + uy * 1.8 };
        continue;
      }
      const shade = ballInFront ? 0.3 : 0;
      p.moveTarget = {
        x: a.x + clamp((bp.x - a.x) * shade, -6, 6),
        y: a.y + clamp((bp.y - a.y) * shade, -6, 6),
      };
    }
  }

  /** Tallest players anchor the back line, quickest take the top. */
  assignZones(defTeam: number) {
    const defs = this.teams[defTeam].players.slice();
    defs.sort((a, b) => b.heightIn - a.heightIn);
    defs[0].zoneIdx = 4; // middle
    const rest = defs.slice(1);
    rest.sort((a, b) => b.perimeterD + b.speed - (a.perimeterD + a.speed));
    // two quickest up top, the other two on the baseline wings
    const tops = rest.slice(0, 2).sort((a, b) => a.pos.y - b.pos.y);
    tops[0].zoneIdx = 0;
    tops[1].zoneIdx = 1;
    const lows = rest.slice(2).sort((a, b) => a.pos.y - b.pos.y);
    lows[0].zoneIdx = 2;
    lows[1].zoneIdx = 3;
  }

  /** Switching scheme: when two marks cross or screen for each other
      and trading assignments shortens both closeouts, swap them. */
  trySwitches(defTeam: number) {
    const defs = this.teams[defTeam].players;
    const offs = this.teams[this.possession].players;
    const markOf = (d: Player) => offs.find((q) => q.slot === d.markSlot)!;
    for (let i = 0; i < defs.length; i++) {
      for (let j = i + 1; j < defs.length; j++) {
        const a = defs[i],
          b = defs[j];
        const ma = markOf(a),
          mb = markOf(b);
        if (dist(ma.pos, mb.pos) > 7) continue; // only on screens / crossing action
        const cur = dist(a.pos, ma.pos) + dist(b.pos, mb.pos);
        const swp = dist(a.pos, mb.pos) + dist(b.pos, ma.pos);
        if (swp + 1.5 < cur) {
          const tmp = a.markSlot;
          a.markSlot = b.markSlot;
          b.markSlot = tmp;
        }
      }
    }
  }

  /* ---------- ball handler AI ---------- */
  updateHandler(dt: number) {
    const h = this.ball.holder!;
    const near = this.nearestOppTo(h.team, h.pos);
    if (near.d < 2.0) {
      const gam = 0.6 + near.p.tend.gamble * 0.008;
      // a trap (two bodies on the ball) multiplies the turnover pressure
      const crowd = this.teams[1 - h.team].players.filter(
        (o) => dist(o.pos, h.pos) < 2.6
      ).length;
      const rate = clamp(
        (0.003 + near.p.steal * 0.00008 + (h.driving ? 0.01 : 0)) *
          gam *
          (1.5 - h.ballHandle * 0.008) *
          (1 + 0.7 * Math.max(0, crowd - 1)),
        0.001,
        0.09
      );
      if (Math.random() < rate * dt) {
        near.p.stats.stl++;
        h.stats.tov++;
        this.emit("steal", pick(LINES.steal)(near.p.name, h.name), near.p.team);
        this.gainPossession(near.p, { live: true });
        return;
      }
      // reach-in: hands get lazy digging at a live dribble. Gamblers and
      // undisciplined defenders hack more; a downhill handler draws more.
      const foulRate = clamp(
        (0.005 + near.p.tend.gamble * 0.00008 + (h.driving ? 0.01 : 0)) *
          (1 + (50 - near.p.iq) * 0.006),
        0.0005,
        0.03
      );
      if (Math.random() < foulRate * dt) {
        this.commonFoul(near.p, h);
        return;
      }
    }
    if (h.driving) {
      const hoop = this.hoops[h.team];
      h.moveTarget = { x: hoop.x, y: hoop.y + h.driveSide * 1.5 };
      const dHoop = dist(h.pos, hoop);
      // drive-and-kick: if the help collapses on the way down, spray
      // it out to an open shooter on the arc. an uncontested runway to
      // the rim is the best shot there is — never kick out of one, and a
      // beaten defender trailing the play doesn't count as pressure.
      if (dHoop > 6 && dHoop < 18 && this.shotClock > 2.5) {
        const blockers = this.laneBlockers(h);
        const kick = blockers > 0 || near.d < 4 ? this.kickoutTarget(h) : null;
        if (kick) {
          const pressure = near.d < 3.5 || blockers >= 2;
          const rate =
            (0.45 + h.iq * 0.009) *
            clamp(0.15 + (h.tend.kickout - 30) * 0.012, 0.05, 1.1) *
            (pressure ? 2.2 : 0.5);
          if (Math.random() < rate * dt) {
            this.tryPass(h, kick, "kickout");
            return;
          }
        }
      }
      if (dHoop < 4.2) {
        this.attemptShot(h, false);
        return;
      }
    }
    // daylight is read every frame, not on the survey rhythm: a beaten
    // defense inside ~10 ft gets attacked in a fraction of a second
    if (!h.driving && this.inFrontcourt(h.pos, h.team)) {
      const hoop = this.hoops[h.team];
      const dH = dist(h.pos, hoop);
      if (
        dH > 3 &&
        dH < 10 &&
        near.d > 3.2 &&
        this.laneBlockers(h) === 0 &&
        Math.random() < 3.5 * dt // ~0.3s reaction time
      ) {
        h.driving = true;
        h.driveSide = h.pos.y >= hoop.y ? 1 : -1;
        return;
      }
    }
    h.decisionTimer -= dt;
    if (h.decisionTimer <= 0) {
      // survey-dribble-decide rhythm: roughly one read per second, so the
      // ball doesn't ping-pong; late clock the reads come faster
      h.decisionTimer = this.shotClock < 6 ? rand(0.4, 0.7) : rand(0.7, 1.2);
      this.decide(h);
    }
  }

  decide(h: Player) {
    const sc = this.shotClock;
    const hoop = this.hoops[h.team];
    if (sc < 1.1 || this.gameClock < 1.6) {
      this.attemptShot(h, true);
      return;
    }

    // holding the ball in the lane with the 3-second count running:
    // go up with it or dribble back out — nobody stands there
    if (!h.driving && h.keyTime > 1.2 && this.inKey(h.pos, h.team)) {
      const sv = this.shotValue(h, h.pos);
      if (sv.value >= 0.95 || sc < 6) {
        this.attemptShot(h, false);
      } else {
        h.moveTarget = this.paintExit(h);
      }
      return;
    }

    const breaking = this.fastBreak > 0;
    if (!this.inFrontcourt(h.pos, h.team)) {
      // bring the ball up — push harder on the break
      const dir = hoop.x > COURT.W / 2 ? -1 : 1;
      h.moveTarget = {
        x: hoop.x + dir * (breaking ? 8 : 25),
        y: clamp(COURT.H / 2 + (h.pos.y - COURT.H / 2) * 0.4, 10, 40),
      };
      const minGap = breaking ? 6 : 7;
      const minAhead = breaking ? 8 : 10;
      const ahead = this.mates(h).filter(
        (m) =>
          this.inFrontcourt(m.pos, h.team) &&
          this.openness(m) > minGap &&
          dist(m.pos, hoop) < dist(h.pos, hoop) - minAhead &&
          this.passRisk(h, m.pos) < 0.55
      );
      const eager = breaking ? 0.5 + h.iq * 0.005 : 0.3 + h.iq * 0.004;
      if (ahead.length && Math.random() < eager) {
        ahead.sort((a, b) => dist(a.pos, hoop) - dist(b.pos, hoop));
        this.tryPass(h, ahead[0]);
      }
      return;
    }

    // a ball screen is on its way: keep the dribble alive and let it arrive
    if (this.pnr && this.pnr.handler === h && this.pnr.phase === "approach" && sc > 6) {
      h.moveTarget = { x: h.pos.x, y: h.pos.y };
      return;
    }

    const dHoop = dist(h.pos, hoop);
    // already downhill with the lane still open (or at the rack): the read
    // was made when the drive started — stay on the attack. Re-reads only
    // happen when the defense has actually loaded up; pressured kick-outs
    // live in updateHandler.
    if (
      h.driving &&
      (dHoop < 6 ||
        (this.laneBlockers(h) === 0 && this.nearestOppTo(h.team, h.pos).d > 3))
    ) {
      return;
    }

    const { focus, scorers } = this.roles;
    const my = this.shotValue(h, h.pos);
    // point-blank: a quality look under the rim is the best shot in
    // basketball — finish it, don't pass out of it. Only a defender right
    // on his body (smothered) keeps the read alive.
    if (my.type === "inside" && my.defD >= 3.5 && my.value >= 1.25) {
      this.attemptShot(h, false);
      return;
    }
    // blow-by: he's beaten his man inside ~10 feet with a clear runway and
    // nobody on his hip — there is no read left to make. Attack the rim.
    if (
      !h.driving &&
      dHoop > 3 &&
      dHoop < 10 &&
      this.laneBlockers(h) === 0 &&
      this.nearestOppTo(h.team, h.pos).d > 3.2
    ) {
      h.driving = true;
      h.driveSide = h.pos.y >= hoop.y ? 1 : -1;
      return;
    }
    // a wide-open quality look in hand beats working the offense for one;
    // a rim look needs far less daylight than a jumper to qualify
    const wideOpenLook =
      my.defD >= (my.type === "inside" ? 4 : 6) && my.value >= 1.25;
    // work the ball to the designated scoring options in priority order: feed
    // the first one who's open in the frontcourt. the primary option gets the
    // ball on a lighter window; lower options have to be more clearly open.
    if (sc > 5 && !wideOpenLook) {
      for (let i = 0; i < scorers.length; i++) {
        const s = scorers[i];
        if (s === h || !this.inFrontcourt(s.pos, h.team)) continue;
        if (this.openness(s) > 3.2 + i * 1.3 && this.passRisk(h, s.pos) < 0.58) {
          this.tryPass(h, s);
          return;
        }
      }
    }

    const teamFga = this.teams[h.team].players.reduce((s, q) => s + q.stats.fga, 0);
    const avgFga = teamFga / 5;
    let best: Player | null = null,
      bestVal = -1;
    for (const m of this.mates(h)) {
      if (!this.inFrontcourt(m.pos, h.team)) continue;
      const sv = this.shotValue(m, m.pos);
      let v = sv.value * 0.95 + clamp(this.openness(m), 0, 10) * 0.012;
      // spread the ball: discount feeding someone who's already eaten
      v *= 1 - clamp((m.stats.fga - avgFga) * 0.012, -0.08, 0.3);
      // don't throw into traffic: discount targets with a hot lane,
      // and write off lanes that are flat-out covered
      const risk = this.passRisk(h, m.pos);
      if (risk > 0.65) continue;
      v *= 1 - risk * 0.6;
      // lean toward the designated scoring options as kick/feed targets
      const prio = scorers.indexOf(m);
      if (prio >= 0) v += 0.18 - prio * 0.05;
      // hit the roller: a screener diving to the rim is the pass the play wants
      if (m === this.roles.screener && m.rollTimer > 0) v += 0.2;
      if (v > bestVal) {
        bestVal = v;
        best = m;
      }
    }
    const dv = this.driveValue(h);
    const noise = (110 - h.iq) * 0.003;
    let need = Math.max(0.92, 1.52 - (24 - clamp(sc, 0, 24)) * 0.045);
    // eager shooters fire earlier, reluctant ones hold out for better looks
    need *= clamp(1 - (h.tend.shoot - 50) * 0.004, 0.8, 1.25);
    // shot-hunting from deep: high three-tendency discounts the bar for triples
    if (my.type === "three") need *= clamp(1 - (h.tend.three - 50) * 0.002, 0.88, 1.12);

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
    if (lateGame && margin > 0 && gc < 60) need *= 1.3; // leading: slow it down
    if (breaking) need *= 0.8; // transition looks are good looks
    // coached tempo: push for early offense, or grind for the best look
    const pace = this.tactics[h.team].plan?.pace;
    if (pace === "fast") need *= 0.86;
    else if (pace === "slow") need *= 1.15;
    // designated scorers hunt their shot — the higher the option, the harder
    const myPrio = scorers.indexOf(h);
    if (myPrio === 0) need *= 0.88;
    else if (myPrio > 0) need *= 0.95;
    // no defender anywhere near the ball: the open look in hand is worth
    // more than hunting a marginally better one
    if (my.defD >= 6) need *= clamp(1 - (my.defD - 6) * 0.045, 0.68, 1);
    // a clean look at the rim clears the bar sooner than any jumper
    if (my.type === "inside" && my.defD >= 3) need *= 0.85;
    // in rhythm off the catch: an open catch-and-shoot look gets let fly
    if (this.sinceCatch < 1.2 && !h.driving && my.type !== "inside" && my.defD >= 4.5)
      need *= 0.92;

    // numbers on the break: attack the rim before the defense loads up
    if (breaking && !h.driving) {
      const defBack = this.teams[1 - h.team].players.filter(
        (o) => dist(o.pos, hoop) < dist(h.pos, hoop)
      ).length;
      const usAhead =
        this.mates(h).filter((m) => dist(m.pos, hoop) < dist(h.pos, hoop)).length + 1;
      if (defBack < usAhead && Math.random() < 0.5 + h.speed * 0.004) {
        h.driving = true;
        h.driveSide = Math.random() < 0.5 ? -1 : 1;
        return;
      }
    }

    if (my.value + rand(-noise, noise) >= need) {
      this.attemptShot(h, false);
      return;
    }
    let driveGate = clamp(0.6 + (h.tend.drive - 50) * 0.008, 0.15, 0.95);
    if (myPrio === 0) driveGate = Math.min(0.95, driveGate + 0.25);
    else if (myPrio > 0) driveGate = Math.min(0.95, driveGate + 0.12);
    // clock burning down: stop surveying and get downhill
    if (sc < 7) driveGate = Math.min(0.95, driveGate + 0.2);
    if (!h.driving && Math.random() < driveGate && dv + rand(-noise, noise) >= need * 0.9) {
      h.driving = true;
      h.driveSide = Math.random() < 0.5 ? -1 : 1;
      return;
    }
    if (best && sc > 2.5) {
      // pass with purpose: swing it when a teammate has a genuinely better
      // look; the aimless hot-potato swing is rare
      let passBias =
        (bestVal > my.value + 0.12 ? 0.65 : 0.18) * clamp(0.5 + h.tend.pass * 0.01, 0.4, 1.5);
      // trapped by a double-team: someone is open — get off the ball
      const trapped =
        this.teams[1 - h.team].players.filter((o) => dist(o.pos, h.pos) < 3.2).length >= 2;
      if (trapped) passBias = Math.max(passBias, 0.85);
      // early clock the ball moves to probe the defense; crunch time it
      // stays in the decision-maker's hands
      passBias *= sc > 16 ? 1.2 : sc < 8 ? 0.55 : 1;
      // the primary option holds the ball more, working for his own shot
      if (h === focus) passBias *= 0.45;
      // don't swing away from your own wide-open look to a worse one
      if (my.defD >= 6 && my.value > bestVal) passBias *= 0.25;
      if (Math.random() < passBias) {
        this.tryPass(h, best);
        return;
      }
    }
    if (sc < 4 && my.value > 0.45) {
      this.attemptShot(h, true);
      return;
    }
    // probe: drift to a new spot in the frontcourt
    h.driving = false;
    const sign = this.attackSign(h.team);
    h.moveTarget = {
      x: clamp(h.pos.x + rand(-5, 5), sign > 0 ? 51 : 2, sign > 0 ? 92 : 43),
      y: clamp(h.pos.y + rand(-6, 6), 3, 47),
    };
  }

  /* Shot probability model, calibrated against real NBA shooting splits.
     `base` is the OPEN-look probability (no defender within 6 ft); the
     contest penalty walks it back down toward league contested numbers.
     Ratings are league-relative (the scout maps season stats so that
     ~58 = league average, ±14 ≈ one league σ), so the anchors are:
       rim, open      ~80% at layup 58  (NBA uncontested rim: 80-90%)
       rim, contested ~60s              (NBA restricted area overall: ~65%)
       three, open    ~37% at 3pt 58    (NBA wide-open 3: ~38%)
       three, tight   ~high 20s         (NBA tight 3: ~30%)
       mid, open      ~45% at mid 58 from 12 ft, ~43% from 18
                      (NBA open mid ~45%, open long-2 ~42-44%);
                      pull-ups off the dribble give back another 3 points */
  shotValue(p: Player, pos: Vec) {
    const hoop = this.hoops[p.team];
    const d = dist(pos, hoop);
    const dy = Math.abs(pos.y - COURT.H / 2);
    const isThree = d > 23.2 || (d > 21.2 && dy > 15);
    let type: "inside" | "three" | "mid", base: number;
    if (d <= 4.6) {
      type = "inside";
      base = 0.62 + p.layup * 0.0032 - (d - 1) * 0.03;
    } else if (d >= 29) {
      type = "three";
      base = 0.04 + p.threePoint * 0.001; // desperation heave
    } else if (isThree) {
      type = "three";
      base = 0.17 + p.threePoint * 0.0034 - (d - 22) * 0.008; // deep = harder
    } else {
      type = "mid";
      // open 18-footer ≈ 43% at rating 58 (NBA open long-2: ~42-44%)
      base = 0.28 + p.midRange * 0.0034 - (d - 5) * 0.004;
    }
    const no = this.nearestOppTo(p.team, pos);
    let pen = 0;
    if (no.d < 6) {
      // contest quality: the right defensive rating + effective height
      // (vertical lets short defenders contest above their size)
      const dRating = type === "inside" ? no.p.interiorD : no.p.perimeterD;
      const effH = no.p.heightIn + (no.p.vertical - 50) * 0.06;
      pen =
        ((6 - no.d) / 6) *
        ((type === "inside" ? 0.16 : 0.09) +
          dRating * 0.0014 +
          clamp(effH - p.heightIn, -5, 7) * 0.01);
      // strength matters when finishing through bodies inside
      if (type === "inside") pen -= (p.strength - no.p.strength) * 0.0006;
    }
    const prob = clamp(base - pen, 0.02, 0.97);
    const pts = type === "three" ? 3 : 2;
    return { prob, type, d, pts, value: prob * pts, defD: no.d, defender: no.p };
  }

  laneBlockers(h: Player) {
    const hoop = this.hoops[h.team];
    let blockers = 0;
    for (const o of this.teams[1 - h.team].players) {
      const pr = projectOnSeg(o.pos, h.pos, hoop);
      if (pr.t > 0.1 && pr.t < 0.95 && pr.d < 4.0) blockers++;
    }
    return blockers;
  }

  /** Best open three-point shooter to kick out to, if any. */
  kickoutTarget(h: Player): Player | null {
    let best: Player | null = null,
      bv = 0;
    for (const m of this.mates(h)) {
      if (!this.inFrontcourt(m.pos, h.team)) continue;
      const sv = this.shotValue(m, m.pos);
      if (sv.type !== "three") continue;
      const open = this.openness(m);
      if (open < 5) continue;
      if (this.passRisk(h, m.pos) > 0.55) continue;
      const v = sv.prob + clamp(open - 5, 0, 8) * 0.012;
      if (v > bv) {
        bv = v;
        best = m;
      }
    }
    // only kick to someone who can actually shoot it
    return best && bv > 0.32 ? best : null;
  }

  /** 0..1: how likely a pass from h to `to` is to be picked off,
      given defenders' ability to close on the lane while the ball
      is in the air. Used by the AI to avoid risky passes. */
  passRisk(h: Player, to: Vec) {
    const from = h.pos;
    const d = dist(from, to);
    let risk = 0;
    for (const o of this.teams[1 - h.team].players) {
      const pr = projectOnSeg(o.pos, from, to);
      if (pr.t < 0.08 || pr.t > 0.92) continue;
      const tAt = (pr.t * d) / 40; // seconds until the ball is there
      const reach = 1.6 + maxSpeedOf(o) * tAt * 0.55;
      if (pr.d >= reach) continue;
      const r =
        (1 - pr.d / reach) * (0.55 + (o.steal - 50) * 0.008 + o.tend.gamble * 0.002);
      if (r > risk) risk = r;
    }
    return clamp(risk, 0, 1);
  }

  driveValue(h: Player) {
    const hoop = this.hoops[h.team];
    const d = dist(h.pos, hoop);
    if (d < 4.5) return 0; // already in finishing range
    const blockers = this.laneBlockers(h);
    const press = this.nearestOppTo(h.team, h.pos).d < 2.5 ? 0.08 : 0;
    const fin =
      0.42 +
      Math.max(h.layup, h.dunk * 0.92) * 0.0034 -
      blockers * 0.13 -
      press +
      (h.speed - 60) * 0.0012 +
      (h.ballHandle - 50) * 0.0012;
    return clamp(fin, 0.05, 0.9) * 2 * 0.85;
  }

  /* ---------- passing ---------- */
  /** Pick a descriptive pass type from the geometry and game context. */
  classifyPass(h: Player, m: Player, from: Vec, to: Vec): PassType {
    const hoop = this.hoops[h.team];
    const d = dist(from, to);
    const forward = dist(from, hoop) - dist(to, hoop);
    if (this.fastBreak > 0 && forward > 14) {
      return this.inFrontcourt(from, h.team) ? "hitAhead" : "outlet";
    }
    if (m === this.roles.screener && m.rollTimer > 0) return "pocket";
    if (dist(to, hoop) < 9 && d > 14) {
      // entry feed: lob it over the top if the defender is fronting
      const md = this.nearestOppTo(h.team, m.pos);
      const fronting = md.d < 3 && dist(md.p.pos, from) < dist(m.pos, from);
      return fronting ? "lob" : "entry";
    }
    if (Math.abs(from.y - to.y) > 22 && d > 25) return "skip";
    // a defender tight to the lane forces it low
    for (const o of this.teams[1 - h.team].players) {
      const pr = projectOnSeg(o.pos, from, to);
      if (pr.t > 0.12 && pr.t < 0.88 && pr.d < 3.2) return "bounce";
    }
    if (h.passAcc > 78 && Math.random() < 0.1) return "noLook";
    return "chest";
  }

  tryPass(h: Player, m: Player, forceType?: PassType) {
    h.driving = false;
    const from = { x: h.pos.x, y: h.pos.y };
    const to = { x: m.pos.x + rand(-0.5, 0.5), y: m.pos.y + rand(-0.5, 0.5) };
    const d = dist(from, to);
    const passType = forceType || this.classifyPass(h, m, from, to);
    const pf = (105 - h.passAcc) / 100; // sloppy passers risk more
    const press = this.nearestOppTo(h.team, h.pos).d;
    const errP = clamp(
      0.003 +
        pf * 0.012 +
        (press < 2.2 ? 0.012 : 0) +
        (d > 32 ? 0.02 : 0) +
        (passType === "noLook" ? 0.012 : 0),
      0,
      0.06
    );
    let flight: Flight;
    if (Math.random() < errP) {
      const ux = (to.x - from.x) / (d || 1),
        uy = (to.y - from.y) / (d || 1);
      const over = rand(3, 7);
      flight = {
        kind: "pass",
        from,
        to: { x: to.x + ux * over, y: to.y + uy * over },
        errant: true,
      } as Flight;
    } else {
      flight = { kind: "pass", from, to, catcher: m } as Flight;
    }
    flight.passer = h;
    flight.passType = passType;
    flight.t = 0;
    flight.dur = 0.18 + dist(from, flight.to) / 42;
    // bounce passes and lobs hang longer; transition lasers zip
    if (passType === "bounce" || passType === "lob") flight.dur *= 1.18;
    if (passType === "outlet" || passType === "hitAhead" || passType === "skip")
      flight.dur *= 0.88;
    this.ball.flight = flight;
    this.ball.holder = null;
  }

  /* ---------- ball in flight ---------- */
  updateFlight(dt: number) {
    const f = this.ball.flight!;
    f.t += dt;
    const k = Math.min(1, f.t / f.dur);
    this.ball.pos = { x: lerp(f.from.x, f.to.x, k), y: lerp(f.from.y, f.to.y, k) };
    this.ball.air = Math.sin(Math.PI * k) * (f.kind === "shot" ? 1 : 0.25);
    if (f.kind === "pass" && this.checkInterception(f, k, dt)) return;
    if (f.t < f.dur) return;
    this.ball.flight = null;
    this.ball.air = 0;
    if (f.kind === "shot") this.resolveShot(f);
    else this.resolvePass(f);
  }

  /** A pass in the air is live: any defender who gets to the ball can
      pick it clean or knock it loose. Resolved continuously so a body
      sitting in the lane of a lazy cross-court pass actually matters. */
  checkInterception(f: Flight, k: number, dt: number): boolean {
    // only the middle of the flight is live: at the ends the ball is
    // protected by the passer's release and the catcher's body
    if (dist(this.ball.pos, f.from) < 3.5 || dist(this.ball.pos, f.to) < 4.0) return false;
    const passer = f.passer!;
    const passLen = dist(f.from, f.to);
    const ballSpeed = passLen / f.dur;
    // a lob over the top floats above outstretched hands mid-flight
    const high = f.passType === "lob" && k > 0.25 && k < 0.8;
    if (high) return false;
    // short zip passes are nearly impossible to react to; long lazy
    // cross-court balls hang in the air asking to be taken
    const lazy = clamp((passLen - 12) / 25, 0.12, 1);
    for (const o of this.teams[1 - passer.team].players) {
      const d = dist(o.pos, this.ball.pos);
      if (d > 2.4) continue;
      if (d < 1.9) {
        const pickRate = clamp(
          (3.4 + (o.steal - 50) * 0.07 + o.tend.gamble * 0.012 - ballSpeed * 0.03) *
            (f.passType === "bounce" ? 0.7 : 1) *
            lazy,
          0.1,
          8
        );
        if (Math.random() < pickRate * dt) {
          o.stats.stl++;
          passer.stats.tov++;
          this.emit(
            "steal",
            `${o.name} jumps the passing lane — stolen from ${passer.name}!`,
            o.team
          );
          this.ball.flight = null;
          this.ball.air = 0;
          this.gainPossession(o, { live: true });
          return true;
        }
      }
      // got a hand on it: deflection sends it bouncing free
      const deflRate = clamp(1.2 + (o.steal - 50) * 0.025, 0.2, 3) * lazy;
      if (Math.random() < deflRate * dt) {
        this.emit("loose", `${o.name} gets a hand on the pass — deflected!`, o.team);
        const ang = Math.atan2(this.ball.pos.y - o.pos.y, this.ball.pos.x - o.pos.x) + rand(-1.2, 1.2);
        const v = rand(8, 16);
        this.ball.flight = null;
        this.ball.air = 0;
        this.ball.loose = {
          pos: { x: this.ball.pos.x, y: this.ball.pos.y },
          vel: { x: Math.cos(ang) * v, y: Math.sin(ang) * v },
          timer: rand(0.4, 0.8),
          isRebound: false,
          touchTeam: o.team,
        };
        return true;
      }
    }
    return false;
  }

  resolvePass(f: Flight) {
    if (f.errant) {
      const out = f.to.x < 0 || f.to.x > COURT.W || f.to.y < 0 || f.to.y > COURT.H;
      if (out) {
        f.passer!.stats.tov++;
        this.emit("turnover", `${f.passer!.name} fires it out of bounds — turnover`, f.passer!.team);
        this.setupInbound(1 - f.passer!.team, this.oobSpot(f.to), { sc: 24 });
      } else {
        this.emit("loose", `Errant pass from ${f.passer!.name} — ball is loose!`, f.passer!.team);
        // the overthrown ball keeps skipping along the pass direction,
        // carrying most of the pass's momentum
        const ux = f.to.x - f.from.x,
          uy = f.to.y - f.from.y;
        const L = Math.hypot(ux, uy) || 1;
        const flightSpeed = L / (f.dur || 0.5);
        const v = Math.max(10, flightSpeed * rand(0.5, 0.75));
        this.ball.loose = {
          pos: { ...f.to },
          vel: { x: (ux / L) * v, y: (uy / L) * v },
          timer: rand(0.4, 0.8),
          isRebound: false,
          touchTeam: f.passer!.team,
        };
      }
      return;
    }
    this.ball.holder = f.catcher!;
    f.catcher!.allowOOB = false;
    // catch, read the floor, then act — quick enough for catch-and-shoot,
    // slow enough that the ball doesn't ping-pong around the horn. a catch
    // inside the lane demands an immediate decision (the count is running)
    f.catcher!.decisionTimer = this.inKey(f.catcher!.pos, this.possession)
      ? rand(0.2, 0.45)
      : rand(0.4, 0.9);
    this.sinceCatch = 0;
    this.lastPasser = f.passer!;
    if (f.kind === "inbound") {
      this.shotClockActive = true;
      if (f.passer) f.passer.allowOOB = false;
    } else if (f.passer) {
      const line = pick(PASS_LINES[f.passType || "chest"])(f.passer.name, f.catcher!.name);
      this.emit("pass", line, f.passer.team);
      if (f.passType === "handoff") {
        // the exchange acts like a screen: receiver turns the corner,
        // the handler rolls out of it
        const recv = f.catcher!;
        this.screen = { timer: 1.0, screener: f.passer, handler: recv };
        f.passer.rollTimer = 2.2;
        recv.driving = true;
        recv.driveSide = recv.pos.y >= COURT.H / 2 ? -1 : 1; // turn toward the middle
      }
    }
  }

  /* ---------- shooting ---------- */
  attemptShot(h: Player, forced: boolean) {
    const sv = this.shotValue(h, h.pos);
    // shot blocking: tight contests on twos can get swatted
    const def = sv.defender;
    if (def && sv.defD < 4.5 && sv.type !== "three") {
      const effH = def.heightIn + (def.vertical - 50) * 0.06;
      const blockP = clamp(
        ((def.block - 30) * 0.0032 + (effH - h.heightIn) * 0.006) *
          (1 - sv.defD / 4.5) *
          (sv.type === "inside" ? 1 : 0.4),
        0,
        0.25
      );
      if (Math.random() < blockP) {
        h.stats.fga++;
        def.stats.blk++;
        h.driving = false;
        this.emit("block", `${def.name} swats ${h.name}'s shot away!`, def.team);
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
    let label = sv.type as string;
    if (sv.type === "inside" && h.dunk >= 50 && sv.d < 3.4 && Math.random() < (h.dunk - 35) / 80) {
      label = "dunk";
      // dunks are near-automatic unless somebody is there to challenge
      prob = clamp(0.72 + h.dunk * 0.0022 - (sv.defD < 2.5 ? 0.14 : 0), 0.05, 0.97);
    }
    if (forced) prob -= 0.06;
    const pullUp = h.driving && sv.type !== "inside";
    if (pullUp) prob -= 0.03; // off the dribble beats a set catch-and-shoot look
    // shooting foul: tight contests draw whistles, most of all at the rim.
    // Undisciplined, gambling defenders hack more; a downhill driver gets
    // more calls than a stationary finisher.
    let fouled = false;
    if (def && sv.defD < 6) {
      const tight = 1 - sv.defD / 6;
      const base = sv.type === "inside" ? 0.32 : sv.type === "mid" ? 0.08 : 0.03;
      const hack = 1 + (50 - def.iq) * 0.006 + (def.tend.gamble - 50) * 0.004;
      const foulP = clamp(
        base * tight * hack * (h.driving && sv.type === "inside" ? 1.35 : 1),
        0,
        0.35
      );
      fouled = Math.random() < foulP;
    }
    if (fouled && def) {
      def.stats.pf++;
      this.teamFouls[def.team]++;
      prob *= 0.62; // shooting through contact
    }
    prob = clamp(prob, 0.02, 0.97);
    const made = Math.random() < prob;
    if (fouled && def && !made) {
      // whistle, no basket: the miss doesn't count — straight to the line
      h.driving = false;
      this.shotClockActive = false;
      this.emit(
        "foul",
        `${def.name} fouls ${h.name} on the ${sv.type === "three" ? "three-point " : ""}shot — ${sv.pts} free throws`,
        def.team
      );
      this.startFreeThrows(h, sv.pts);
      return;
    }
    const hoop = this.hoops[h.team];
    const assist =
      made &&
      this.lastPasser &&
      this.lastPasser !== h &&
      this.lastPasser.team === h.team &&
      this.sinceCatch < 2.4
        ? this.lastPasser
        : null;
    this.ball.flight = {
      kind: "shot",
      from: { x: h.pos.x, y: h.pos.y },
      to: { x: hoop.x, y: hoop.y },
      t: 0,
      dur: 0.45 + sv.d / 24,
      shooter: h,
      made,
      pts: sv.pts,
      label,
      d: Math.round(sv.d),
      assist,
      defD: sv.defD,
      defName: def ? def.name.split(" ").slice(-1)[0] : null,
      prob,
      andOne: fouled && made,
      pullUp,
    };
    this.ball.holder = null;
    this.shotClockActive = false;
    h.driving = false;
    this.lastShotTeam = h.team;
  }

  coverageTag(f: Flight) {
    let cov: string;
    if (f.defD! >= 6) cov = "wide open";
    else if (f.defD! >= 4.5) cov = "open";
    else if (f.defD! >= 2.8) cov = `contested by ${f.defName}`;
    else cov = `smothered by ${f.defName}`;
    if (f.pullUp) cov += " pull-up";
    return ` [${cov} · ${Math.round(f.prob! * 100)}% look]`;
  }

  resolveShot(f: Flight) {
    if (f.ft) return this.resolveFreeThrow(f);
    const sh = f.shooter!;
    const T = this.teams[sh.team];
    sh.stats.fga++;
    if (f.pts === 3) sh.stats.tpa++;
    if (f.made) {
      T.score += f.pts!;
      sh.stats.fgm++;
      sh.stats.pts += f.pts!;
      if (f.pts === 3) sh.stats.tpm++;
      if (f.assist) f.assist.stats.ast++;
      const line =
        pick(LINES.make[f.label!])(sh.name, f.d) +
        (f.assist ? ` (${f.assist.name} with the assist)` : "") +
        this.coverageTag(f) +
        ` — ${this.scoreLine()}`;
      this.emit(f.label === "dunk" ? "dunk" : "score", line, sh.team);
      if (f.andOne) {
        this.emit("foul", `${sh.name} is fouled on the finish — and one!`, 1 - sh.team);
        this.startFreeThrows(sh, 1);
        return;
      }
      if (this.gameClock <= 0) {
        this.endQuarter();
        return;
      }
      this.setupInbound(1 - sh.team, this.baselineSpot(1 - sh.team), { sc: 24 });
    } else {
      this.emit("miss", pick(LINES.miss[f.label!])(sh.name, f.d) + this.coverageTag(f), sh.team);
      if (this.gameClock <= 0) {
        this.endQuarter();
        return;
      }
      const hoop = this.hoops[sh.team];
      // caroms mostly bounce onto the floor in front of the rim, with
      // the occasional one off the back iron toward the baseline
      const toward = hoop.x > COURT.W / 2 ? Math.PI : 0;
      const ang = toward + rand(-2.0, 2.0);
      const carom = rand(4, 8 + f.d! * 0.3); // long shots = long caroms
      this.ball.loose = {
        pos: { x: hoop.x + Math.cos(ang) * 1.2, y: hoop.y + Math.sin(ang) * 1.2 },
        vel: { x: Math.cos(ang) * carom, y: Math.sin(ang) * carom },
        timer: rand(0.55, 1.0),
        isRebound: true,
        touchTeam: sh.team,
        airborne: rand(0.55, 0.85), // hang time off the iron
      };
    }
  }

  /* ---------- loose balls & rebounds ---------- */
  updateLoose(dt: number) {
    const lb = this.ball.loose!;
    // ---- airborne phase: the carom is still in the air off the rim ----
    // The ball flies clean (no floor drag) and comes down toward hands. A
    // body under it snares the board at hand height — the ball never touches
    // the floor unless nobody is there to meet it.
    if (lb.airborne && lb.airborne > 0) {
      lb.airborne -= dt;
      lb.pos.x += lb.vel.x * dt;
      lb.pos.y += lb.vel.y * dt;
      this.ball.air = clamp(0.25 + lb.airborne * 1.1, 0.2, 1);
      if (this.looseOutOfBounds(lb)) return;
      this.chaseLoose(lb);
      // catchable once it drops into reach
      if (lb.airborne < 0.45 && this.tryGrabLoose(lb, 2.4)) return;
      if (lb.airborne <= 0) {
        // nobody met it: the ball hits the floor and skips
        lb.airborne = 0;
        lb.timer = rand(0.15, 0.35);
      }
      return;
    }
    // ---- floor phase ----
    // two-regime ball physics: while it's hot (skipping and bouncing) the
    // floor scrubs speed off fast; once it settles into a roll, hardwood
    // barely slows it — an errant pass keeps rolling until someone gets it
    const sp0 = Math.hypot(lb.vel.x, lb.vel.y);
    const decel = sp0 > 9 ? sp0 * 1.4 : 2.2; // ft/s²: drag while hot, rolling resistance after
    const k = sp0 > 0.001 ? Math.max(0, sp0 - decel * dt) / sp0 : 0;
    lb.vel.x *= k;
    lb.vel.y *= k;
    lb.pos.x += lb.vel.x * dt;
    lb.pos.y += lb.vel.y * dt;
    const sp = Math.hypot(lb.vel.x, lb.vel.y);
    lb.phase = (lb.phase || 0) + dt * (4 + sp * 0.5);
    this.ball.air = Math.abs(Math.sin(lb.phase * 2.2)) * clamp(sp / 22, 0, 0.45);
    if (this.looseOutOfBounds(lb)) return;
    this.chaseLoose(lb);
    lb.timer -= dt;
    if (lb.timer > 0) return;
    const grabR = sp > 8 ? 1.7 : 2.8; // a hot ball is hard to corral
    this.tryGrabLoose(lb, grabR);
  }

  /** Rolled/bounced out of bounds: last team to touch it loses possession. */
  looseOutOfBounds(lb: Loose): boolean {
    if (lb.pos.x >= 0 && lb.pos.x <= COURT.W && lb.pos.y >= 0 && lb.pos.y <= COURT.H)
      return false;
    const toTeam = 1 - lb.touchTeam;
    this.ball.air = 0;
    this.emit("turnover", `Loose ball bounces out — ${this.teams[toTeam].name} ball`, toTeam);
    this.setupInbound(toTeam, this.oobSpot(lb.pos), { sc: 24 });
    return true;
  }

  /** Send nearby players after the ball — where it's going, not where it is. */
  chaseLoose(lb: Loose) {
    const lead = lb.airborne && lb.airborne > 0 ? lb.airborne : 0.3;
    const aim = { x: lb.pos.x + lb.vel.x * lead, y: lb.pos.y + lb.vel.y * lead };
    this.teams.forEach((t, ti) => {
      const offTeam = lb.isRebound && ti === this.lastShotTeam;
      const sorted = t.players.slice().sort((a, b) => dist(a.pos, aim) - dist(b.pos, aim));
      sorted.slice(0, 3).forEach((p, i) => {
        // shooters' teammates only crash the glass if so inclined;
        // the rest get back on defense
        if (!offTeam || i === 0 || p.tend.crash >= 55) {
          p.moveTarget = { ...aim };
        }
      });
    });
  }

  /** Contest the ball among everyone within reach; the winner takes
      possession. Returns false when nobody is close enough yet. */
  tryGrabLoose(lb: Loose, grabR: number): boolean {
    const cands = this.allPlayers().filter((p) => dist(p.pos, lb.pos) < grabR);
    if (!cands.length) return false;
    let win: Player | null = null,
      wbest = -1;
    for (const p of cands) {
      let w = rebSkillOf(p) * rand(0.5, 1.5) + (grabR - dist(p.pos, lb.pos)) * 18 + p.iq * 0.1;
      if (lb.isRebound && p.team === this.lastShotTeam) {
        w *= 0.55 + p.tend.crash * 0.009;
      }
      if (w > wbest) {
        wbest = w;
        win = p;
      }
    }
    this.ball.air = 0;
    const wasRebound = lb.isRebound;
    const offBoard = wasRebound && win!.team === this.lastShotTeam;
    const samePoss = !wasRebound && win!.team === this.possession;
    const scBefore = this.shotClock;
    this.ball.loose = null;
    if (wasRebound) {
      win!.stats.reb++;
      this.emit(
        "rebound",
        offBoard
          ? `${win!.name} crashes the glass — offensive rebound!`
          : `${win!.name} secures the defensive board`,
        win!.team
      );
    } else {
      this.emit("recover", `${win!.name} comes up with the loose ball`, win!.team);
    }
    this.gainPossession(win!, { live: true });
    if (offBoard) this.shotClock = 14;
    // recovering your own blocked shot / errant pass doesn't reset the clock
    if (samePoss) this.shotClock = Math.max(1, scBefore);
    return true;
  }

  /* ---------- fouls & free throws ---------- */
  ftProb(p: Player) {
    // rating 58 (league average) ≈ 73%; elite shooters live in the low 90s
    return clamp(0.38 + p.freeThrow * 0.006, 0.3, 0.95);
  }

  /** A non-shooting defensive foul: side-out for the offense — or two free
      throws once the defense is in the bonus (5+ team fouls this quarter). */
  commonFoul(def: Player, victim: Player) {
    def.stats.pf++;
    this.teamFouls[def.team]++;
    const bonus = this.teamFouls[def.team] >= 5;
    victim.driving = false;
    this.emit(
      "foul",
      `${def.name} reaches in on ${victim.name} — personal foul` +
        (bonus ? `, and the ${this.teams[victim.team].name} are in the bonus` : ""),
      def.team
    );
    if (bonus) {
      this.startFreeThrows(victim, 2);
    } else {
      // the offense keeps it, side out; the shot clock resets no lower than 14
      this.setupInbound(victim.team, this.oobSpot(victim.pos), {
        sc: Math.max(Math.ceil(this.shotClock), 14),
      });
    }
  }

  /** Send `shooter` to the line for `n` attempts: kill the clocks, walk
      everyone to his lane spot, and let stepFreeThrows run the sequence. */
  startFreeThrows(shooter: Player, n: number) {
    this.ball.flight = null;
    this.ball.loose = null;
    this.ball.holder = shooter;
    this.ball.air = 0;
    this.shotClockActive = false;
    this.screen = null;
    this.pnr = null;
    this.fastBreak = 0;
    this.lastPasser = null;
    for (const t of this.teams) {
      for (const p of t.players) {
        p.driving = false;
        p.rollTimer = 0;
        p.keyTime = 0;
        p.allowOOB = false;
        p.path = null;
        p.pathIdx = 0;
      }
    }
    this.lineUpFreeThrow(shooter);
    this.ftState = { shooter, remaining: n, total: n, timer: 2.4 };
  }

  /** Real free-throw geometry: shooter at the line, the defense owning the
      low blocks, offensive rebounders between them, everyone else spaced
      out behind the play. */
  lineUpFreeThrow(shooter: Player) {
    const off = shooter.team;
    const at = (ax: number, ay: number) => this.spotPos(off, { ax, ay, cat: "mid" });
    shooter.moveTarget = at(13.6, 0);
    const byReb = (ps: Player[]) => ps.slice().sort((a, b) => rebSkillOf(b) - rebSkillOf(a));
    const defSpots: [number, number][] = [
      [3.2, -8.6], [3.2, 8.6], [9.6, -8.6], // lane spots
      [16, 8.6], [30, 0], // above the line + safety back
    ];
    byReb(this.teams[1 - off].players).forEach((p, i) => {
      const [ax, ay] = defSpots[i];
      p.moveTarget = at(ax, ay);
    });
    const offSpots: [number, number][] = [
      [6.4, -8.6], [6.4, 8.6], // lane rebounders
      [22, -14], [28, 6], // spaced out top-side
    ];
    byReb(this.mates(shooter)).forEach((p, i) => {
      const [ax, ay] = offSpots[i];
      p.moveTarget = at(ax, ay);
    });
  }

  /** Drive a free-throw sequence: bodies settle onto the lane, the shooter
      works on a fixed rhythm, and each attempt flies as a normal shot flight
      that resolveFreeThrow picks up. The game clock is dead throughout. */
  stepFreeThrows(dt: number) {
    this.moveAll(dt);
    if (this.ball.flight) {
      this.updateFlight(dt);
      return;
    }
    this.ballFollow();
    const ft = this.ftState!;
    ft.timer -= dt;
    if (ft.timer > 0) return;
    const sh = ft.shooter;
    const prob = this.ftProb(sh);
    const hoop = this.hoops[sh.team];
    this.ball.holder = null;
    this.ball.flight = {
      kind: "shot",
      ft: true,
      from: { x: sh.pos.x, y: sh.pos.y },
      to: { x: hoop.x, y: hoop.y },
      t: 0,
      dur: 0.85,
      shooter: sh,
      made: Math.random() < prob,
      pts: 1,
      label: "ft",
      d: 15,
      assist: null,
      defD: 99,
      defName: null,
      prob,
    };
  }

  resolveFreeThrow(f: Flight) {
    const ft = this.ftState;
    const sh = f.shooter!;
    sh.stats.fta++;
    const n = ft ? ft.total - ft.remaining + 1 : 1;
    const total = ft?.total ?? 1;
    const ordinal = total > 1 ? ` (${n} of ${total})` : "";
    if (f.made) {
      sh.stats.ftm++;
      sh.stats.pts++;
      this.teams[sh.team].score++;
      this.emit(
        "freethrow",
        `${sh.name} makes the free throw${ordinal} — ${this.scoreLine()}`,
        sh.team
      );
    } else {
      this.emit("freethrow", `${sh.name} misses the free throw${ordinal}`, sh.team);
    }
    if (ft && ft.remaining > 1) {
      ft.remaining--;
      ft.timer = 1.7;
      this.ball.holder = sh;
      return;
    }
    // sequence over: a made last FT is a dead ball the other way; a miss
    // is live off the rim with the lane already loaded
    this.ftState = null;
    this.lastShotTeam = sh.team;
    if (f.made) {
      if (this.gameClock <= 0 && !this.lab) {
        this.endQuarter();
        return;
      }
      this.setupInbound(1 - sh.team, this.baselineSpot(1 - sh.team), { sc: 24 });
    } else {
      const hoop = this.hoops[sh.team];
      const toward = hoop.x > COURT.W / 2 ? Math.PI : 0;
      const ang = toward + rand(-1.6, 1.6);
      const carom = rand(3, 7);
      this.ball.loose = {
        pos: { x: hoop.x + Math.cos(ang) * 1.2, y: hoop.y + Math.sin(ang) * 1.2 },
        vel: { x: Math.cos(ang) * carom, y: Math.sin(ang) * carom },
        timer: rand(0.5, 0.9),
        isRebound: true,
        touchTeam: sh.team,
        airborne: rand(0.5, 0.75),
      };
    }
  }

  /* ---------- possession / dead balls ---------- */
  gainPossession(p: Player, opts: { live?: boolean } = {}) {
    const changed = p.team !== this.possession;
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
      for (const q of t.players) {
        q.driving = false;
        q.spotIdx = -1;
        q.spotTimer = 0;
        q.rollTimer = 0;
        q.keyTime = 0;
        q.zoneIdx = -1;
        q.path = null;
        q.pathIdx = 0;
      }
    }
    this.claims = [new Map(), new Map()];
    this.screen = null;
    this.pnr = null;
    // a live change of possession ignites the break
    if (opts.live && changed) this.fastBreak = 6;
    else if (changed) this.fastBreak = 0;
    this.setRoles(p.team);
    if (this.lab && changed && p.team !== this.lab.team) this.labEnd();
  }

  /** Apply (or clear) a compiled coaching plan for a team. Scoring options
      and the defensive scheme come along; tendency biases are layered onto
      each player's base tendencies. */
  setPlan(team: number, plan: TeamPlan | null) {
    const t = this.tactics[team];
    t.plan = plan;
    t.scorers = plan?.scorerSlots ?? [];
    if (plan?.defScheme) t.defScheme = plan.defScheme;
    for (const p of this.teams[team].players) {
      const bias = plan?.directives.find((d) => d.slot === p.slot)?.tendencyBias ?? null;
      for (const k of Object.keys(p.baseTend) as (keyof typeof p.baseTend)[]) {
        p.tend[k] = clamp(p.baseTend[k] + (bias?.[k] ?? 0), 1, 99);
      }
      p.zoneIdx = -1; // zones re-resolve if the scheme changed
    }
    // matchups may have changed: re-derive the auto assignments from scratch,
    // then pin both sides' explicit who-guards-who choices on top
    this.assignMatchups();
    for (let ti = 0; ti < 2; ti++) this.applyPlanMatchups(ti);
    this.pnr = null;
    this.pnrCooldown = 0;
    if (this.possession === team && !this.ball.loose) this.setRoles(team);
  }

  /** Resolve the roles for the team now on offense from its plan / chosen
      scoring options. The primary option is the go-to scorer (`focus`); the
      plan's initiator (or the best on-ball creator) brings it up (`handler`);
      a plan with a pick-and-roll resolves its `screener`. */
  setRoles(team: number) {
    const ps = this.teams[team].players;
    const t = this.tactics[team];
    const plan = t.plan ?? null;

    // hold-spots are authored by dragging players, not by setRoles
    this.assignTargets.clear();

    // scoring options, in priority order, from the chosen roster slots
    const scorers = (t.scorers || [])
      .map((slot) => ps[slot])
      .filter((p): p is Player => !!p);
    const focus = scorers[0] || null;

    // the plan's initiator — otherwise the best creator — runs the offense
    const pa = plan?.actions.find((a): a is PlanAction => a.type === "pickAndRoll") ?? null;
    const handlerSlot = pa?.handlerSlot ?? plan?.handlerSlot ?? null;
    const handler =
      (handlerSlot != null ? ps[handlerSlot] : null) ??
      ps
        .slice()
        .sort(
          (a, b) =>
            b.ballHandle * 0.6 + b.iq * 0.2 + b.speed * 0.2 -
            (a.ballHandle * 0.6 + a.iq * 0.2 + a.speed * 0.2)
        )[0];

    // a pick-and-roll needs a screener: the named one, else the best body
    let screener: Player | null = null;
    if (pa) {
      screener = (pa.screenerSlot != null ? ps[pa.screenerSlot] : null) ?? null;
      if (!screener || screener === handler) {
        screener =
          ps
            .filter((q) => q !== handler)
            .sort((a, b) => b.strength + b.heightIn * 2 - (a.strength + a.heightIn * 2))[0] ??
          null;
      }
      if (screener === handler) screener = null;
    }

    this.roles = { handler, screener, focus, scorers };
    this.annotate(team);
  }

  /** Court labels for each player's job — only drawn in lab mode. */
  annotate(team: number) {
    for (const t of this.teams) for (const p of t.players) p.annotation = null;
    if (!this.lab || this.lab.team !== team) return;
    const { handler, screener, scorers } = this.roles;
    const OPTION_LABELS = ["1ST", "2ND", "3RD"];
    scorers.forEach((p, i) => {
      if (p && i < OPTION_LABELS.length) p.annotation = OPTION_LABELS[i];
    });
    if (handler && !handler.annotation) handler.annotation = "HANDLER";
    if (screener && !screener.annotation) screener.annotation = "SCREEN";
    const plan = this.tactics[team].plan;
    if (!plan) return;
    for (const a of plan.actions) {
      const tgt = a.targetSlot != null ? this.teams[team].players[a.targetSlot] : null;
      if (tgt && !tgt.annotation)
        tgt.annotation = a.type === "postUp" ? "POST" : a.type === "iso" ? "ISO" : "TARGET";
    }
    // an explicit coach's label wins over the inferred role
    for (const d of plan.directives) {
      const p = this.teams[team].players[d.slot];
      if (p && d.note) p.annotation = d.note;
    }
  }

  shotClockViolation() {
    const t = this.possession;
    if (this.ball.holder) this.ball.holder.stats.tov++;
    this.emit("turnover", `Shot-clock violation on the ${this.teams[t].name}`, t);
    this.setupInbound(1 - t, this.oobSpot(this.ball.pos), { sc: 24 });
  }

  /* ---------- jump ball ---------- */
  setupTipoff() {
    this.phase = "setup";
    this.tipoff = true;
    this.ftState = null;
    this.deadTimer = rand(1.2, 1.8);
    this.shotClock = 24;
    this.shotClockActive = false;
    this.ball.holder = null;
    this.ball.flight = null;
    this.ball.loose = null;
    this.ball.pos = { x: COURT.W / 2, y: COURT.H / 2 };
    this.lastPasser = null;
    this.sinceCatch = 99;
    this.fastBreak = 0;
    this.screen = null;
    this.claims = [new Map(), new Map()];
    this.jumpers = [];
    for (let ti = 0; ti < 2; ti++) {
      const ps = this.teams[ti].players;
      for (const p of ps) {
        p.driving = false;
        p.allowOOB = false;
        p.spotIdx = -1;
        p.spotTimer = 0;
        p.rollTimer = 0;
        p.keyTime = 0;
        p.zoneIdx = -1;
        p.path = null;
        p.pathIdx = 0;
      }
      const jumper = ps
        .slice()
        .sort((a, b) => b.heightIn + b.vertical * 0.3 - (a.heightIn + a.vertical * 0.3))[0];
      this.jumpers.push(jumper);
      // jumper at the circle on his defensive side, the rest fanned
      // around it in their own half
      const side = -this.attackSign(ti);
      jumper.moveTarget = { x: COURT.W / 2 + side * 1.4, y: COURT.H / 2 };
      const rest = ps.filter((p) => p !== jumper);
      const ring = [
        { dx: 8, dy: -7 },
        { dx: 8, dy: 7 },
        { dx: 14, dy: -15 },
        { dx: 14, dy: 15 },
      ];
      rest.forEach((p, i) => {
        p.moveTarget = { x: COURT.W / 2 + side * ring[i].dx, y: COURT.H / 2 + ring[i].dy };
      });
    }
  }

  resolveTipoff() {
    this.tipoff = false;
    this.phase = "live";
    const [ja, jb] = this.jumpers;
    const leap = (p: Player) => p.heightIn * 0.7 + p.vertical * 0.45 + rand(0, 26);
    const winner = leap(ja) > leap(jb) ? ja : jb;
    this.possession = winner.team;
    this.setRoles(winner.team);
    const mates = this.mates(winner)
      .slice()
      .sort((a, b) => dist(a.pos, this.ball.pos) - dist(b.pos, this.ball.pos));
    const catcher = mates[0];
    this.emit(
      "recover",
      `${winner.name} controls the tip — ${this.teams[winner.team].name} ball`,
      winner.team
    );
    const from = { x: COURT.W / 2, y: COURT.H / 2 };
    const to = { x: catcher.pos.x, y: catcher.pos.y };
    this.ball.flight = {
      kind: "inbound", // a tip: no pass commentary, no lane picks
      from,
      to,
      t: 0,
      dur: 0.2 + dist(from, to) / 40,
      catcher,
      passer: null,
    };
  }

  setupInbound(team: number, spot: Vec, opts: { sc: number }) {
    if (this.lab && team !== this.lab.team) {
      this.labPending = { team, spot, sc: opts.sc };
      this.labEnd();
      return;
    }
    this.phase = "setup";
    this.deadTimer = rand(1.2, 2.0);
    this.ftState = null;
    this.possession = team;
    this.shotClock = opts.sc;
    this.shotClockActive = false;
    this.ball.holder = null;
    this.ball.flight = null;
    this.ball.loose = null;
    this.lastPasser = null;
    this.sinceCatch = 99;
    this.fastBreak = 0;
    this.screen = null;
    this.tipoff = false;
    this.claims = [new Map(), new Map()];
    this.setRoles(team);
    for (const t of this.teams) {
      for (const p of t.players) {
        p.driving = false;
        p.allowOOB = false;
        p.spotIdx = -1;
        p.spotTimer = 0;
        p.rollTimer = 0;
        p.keyTime = 0;
        p.zoneIdx = -1;
        p.path = null;
        p.pathIdx = 0;
      }
    }
    const tp = this.teams[team].players;
    // lab: honor an explicitly chosen inbounder; otherwise the designated
    // handler should be receiving, not throwing it in, so pick the man
    // already closest to the inbound spot
    const chosenInb = this.tactics[team].inbounderSlot;
    let inb: Player;
    if (chosenInb != null && tp[chosenInb]) {
      inb = tp[chosenInb];
    } else {
      const inbCands = tp.filter((p) => p !== this.roles.handler);
      inb = inbCands[0] || tp[0];
      for (const p of inbCands) if (dist(p.pos, spot) < dist(inb.pos, spot)) inb = p;
    }
    inb.allowOOB = true;
    inb.moveTarget = { ...spot };
    const rest = tp.filter((p) => p !== inb);
    // the designated ball handler takes the inbound when he can
    const recv =
      this.roles.handler && rest.includes(this.roles.handler)
        ? this.roles.handler
        : rest.slice().sort((a, b) => b.iq - a.iq)[0];
    recv.moveTarget = {
      x: clamp(spot.x + (COURT.W / 2 - spot.x) * 0.18, 3, COURT.W - 3),
      y: clamp(spot.y + (COURT.H / 2 - spot.y) * 0.3 + rand(-3, 3), 3, COURT.H - 3),
    };
    for (const p of rest) {
      if (p === recv) continue;
      const fixed = this.assignTargets.get(p.id);
      if (fixed) {
        p.moveTarget = this.spotPos(p.team, fixed);
        continue;
      }
      this.assignSpot(p);
      p.moveTarget = this.spotPos(p.team, SPOTS[p.spotIdx]);
    }
    this.inb = { inbounder: inb, receiver: recv, spot };
    this.ball.holder = inb;
  }

  releaseInbound() {
    const { inbounder, receiver } = this.inb!;
    this.phase = "live";
    const from = { x: inbounder.pos.x, y: inbounder.pos.y };
    const to = { x: receiver.pos.x, y: receiver.pos.y };
    this.ball.holder = null;
    this.ball.flight = {
      kind: "inbound",
      from,
      to,
      t: 0,
      dur: 0.2 + dist(from, to) / 40,
      catcher: receiver,
      passer: inbounder,
    };
  }

  /** Start a possession already in progress: instead of an inbound, the
      offense's initiator holds the ball at the top of the frontcourt and the
      shot clock is already running. The rest of the formation mirrors
      setupInbound so a live start and an inbound start stage the same set. */
  setupLive(team: number, opts: { sc: number }) {
    this.phase = "live";
    this.deadTimer = 0;
    this.ftState = null;
    this.possession = team;
    this.shotClock = opts.sc;
    this.shotClockActive = true;
    this.ball.flight = null;
    this.ball.loose = null;
    this.lastPasser = null;
    this.sinceCatch = 0;
    this.fastBreak = 0;
    this.screen = null;
    this.tipoff = false;
    this.claims = [new Map(), new Map()];
    this.setRoles(team);
    for (const t of this.teams) {
      for (const p of t.players) {
        p.driving = false;
        p.allowOOB = false;
        p.spotIdx = -1;
        p.spotTimer = 0;
        p.rollTimer = 0;
        p.keyTime = 0;
        p.zoneIdx = -1;
        p.path = null;
        p.pathIdx = 0;
      }
    }
    const tp = this.teams[team].players;
    // the initiator brings it up already holding the ball, at the top of the key
    const handler = this.roles.handler ?? tp[0];
    handler.moveTarget = this.spotPos(team, { ax: 24.5, ay: 0, cat: "three" });
    handler.decisionTimer = rand(0.25, 0.6);
    const rest = tp.filter((p) => p !== handler);
    for (const p of rest) {
      const fixed = this.assignTargets.get(p.id);
      if (fixed) {
        p.moveTarget = this.spotPos(p.team, fixed);
        continue;
      }
      this.assignSpot(p);
      p.moveTarget = this.spotPos(p.team, SPOTS[p.spotIdx]);
    }
    this.inb = null;
    this.ball.holder = handler;
  }

  /* ---------- possession lab ---------- */
  static SCHEME_LABELS: Record<DefScheme, string> = {
    man: "man-to-man",
    switch: "switch-everything",
    zone: "a 2-3 zone",
  };

  /** Run a single scripted possession: the offense optimizes for its
      compiled plan (or just flows) against the defense's plan/scheme.
      Starts from a clean inbound formation — or, when `live`, mid-possession
      with the offense already holding the ball. The sim freezes when the
      possession ends. */
  runPossession(opts: {
    offense: number;
    plan?: TeamPlan | null;
    defPlan?: TeamPlan | null;
    defScheme?: DefScheme;
    scorers?: number[];
    start?: InboundLoc;
    inbounderSlot?: number | null;
    /** skip the inbound and start with the ball live in the frontcourt */
    live?: boolean;
  }) {
    if (this.over) return;
    this.lab = { team: opts.offense };
    this.frozen = false;
    this.labPending = null;
    this.ftState = null;
    this.teamFouls = [0, 0]; // each staged possession opens with a clean slate
    this.setPlan(opts.offense, opts.plan ?? null);
    this.setPlan(1 - opts.offense, opts.defPlan ?? null);
    if (opts.scorers) this.tactics[opts.offense].scorers = opts.scorers;
    this.tactics[opts.offense].inbounderSlot =
      opts.inbounderSlot ?? opts.plan?.inbounderSlot ?? null;
    const defScheme = opts.defScheme ?? opts.defPlan?.defScheme ?? "man";
    this.tactics[1 - opts.offense].defScheme = defScheme;
    if (this.gameClock < 35) this.gameClock = 35; // room to run the play
    this.emit(
      "info",
      `LAB — ${this.teams[opts.offense].name} possession against ${Game.SCHEME_LABELS[defScheme]}`,
      null
    );
    this.labStartLive = !!opts.live;
    if (opts.live) {
      this.setupLive(opts.offense, { sc: 24 });
    } else {
      const spot = this.labInboundSpot(opts.offense, opts.start ?? opts.plan?.inbound ?? "side-top");
      this.setupInbound(opts.offense, spot, { sc: 24 });
    }
    // drill-style start: snap everyone straight into formation instead
    // of jogging there, so the inbound always looks traditional
    this.deadTimer = rand(0.8, 1.2);
    for (const p of this.teams[opts.offense].players) {
      if (p.moveTarget) {
        p.pos = { ...p.moveTarget };
        p.vel = { x: 0, y: 0 };
      }
    }
    this.updateDefense(); // compute defensive shape against the set offense
    for (const p of this.teams[1 - opts.offense].players) {
      if (p.moveTarget) {
        p.pos = { ...p.moveTarget };
        p.vel = { x: 0, y: 0 };
      }
    }
    this.ballFollow();
    // every route opens clean — the user authors the motion paths by hand
    for (const p of this.teams[opts.offense].players) {
      p.path = null;
      p.pathIdx = 0;
      p.pathHold = true;
    }
  }

  /** Snapshot the staged play — every player's spot and authored route, the
      dragged hold-spots, and the inbound — so the exact same possession can be
      run again. Call while the formation is frozen, just before it runs. */
  labCaptureSetup(): LabSetup {
    return {
      players: this.teams.flatMap((t) =>
        t.players.map((p) => ({
          team: p.team,
          slot: p.slot,
          pos: { ...p.pos },
          moveTarget: p.moveTarget ? { ...p.moveTarget } : null,
          path: p.path ? p.path.map((v) => ({ ...v })) : null,
          pathHold: p.pathHold,
        }))
      ),
      assignTargets: [...this.assignTargets.entries()].map(([id, s]) => [id, { ...s }]),
      inbSpot: this.inb ? { ...this.inb.spot } : { ...this.ball.pos },
      inbounderSlot: this.inb ? this.inb.inbounder.slot : 0,
      labTeam: this.lab ? this.lab.team : this.possession,
      gameClock: this.gameClock,
      startShotClock: Math.min(24, Math.max(1, Math.round(this.shotClock))),
      live: this.labStartLive,
    };
  }

  /** Restage a captured play to run it again exactly: rebuild the inbound,
      then drop every player back on his authored spot with his route reset
      to the top. Outcomes still vary — only the design is replayed. */
  labReplaySetup(snap: LabSetup) {
    this.over = false;
    this.lab = { team: snap.labTeam };
    this.frozen = false;
    this.labPending = null;
    this.gameClock = Math.max(35, snap.gameClock);
    // pin the same inbounder so the exact play replays (auto-pick would
    // otherwise re-resolve against wherever everyone ended up)
    this.tactics[snap.labTeam].inbounderSlot = snap.inbounderSlot;
    this.labStartLive = !!snap.live;
    const sc = Math.min(24, Math.max(1, snap.startShotClock ?? 24));
    if (snap.live) {
      this.setupLive(snap.labTeam, { sc });
    } else {
      this.setupInbound(snap.labTeam, { ...snap.inbSpot }, { sc });
    }
    for (const f of snap.players) {
      const p = this.teams[f.team].players[f.slot];
      p.pos = { ...f.pos };
      p.vel = { x: 0, y: 0 };
      p.moveTarget = f.moveTarget ? { ...f.moveTarget } : null;
      p.path = f.path ? f.path.map((v) => ({ ...v })) : null;
      p.pathIdx = 0;
      p.pathHold = f.pathHold;
    }
    // restore the dragged hold-spots (setupInbound clears them via setRoles)
    this.assignTargets = new Map(snap.assignTargets.map(([id, s]) => [id, { ...s }]));
    this.ballFollow();
  }

  /** Swap the defensive scheme on a staged possession without disturbing the
      offense — recompute the defensive shape and (while frozen) snap the
      defenders into it. The offense, its roles, and authored routes are kept. */
  labSetDefense(scheme: DefScheme) {
    if (!this.lab) return;
    const def = 1 - this.possession;
    this.tactics[def].defScheme = scheme;
    this.updateDefense();
    if (this.frozen) {
      for (const p of this.teams[def].players) {
        if (p.moveTarget) {
          p.pos = { ...p.moveTarget };
          p.vel = { x: 0, y: 0 };
        }
      }
    }
  }

  labEnd() {
    this.frozen = true;
    this.emit("info", `LAB — possession over. Run another or resume the game.`, null);
  }

  /** A staged player was dragged: his new position becomes his
      starting spot, and (for role-less offense) the spot he holds
      while the play runs. */
  setHoldSpot(p: Player) {
    p.moveTarget = { x: p.pos.x, y: p.pos.y };
    p.vel = { x: 0, y: 0 };
    if (p.team !== this.possession) return; // defenders re-shape per scheme
    if (this.inb && p === this.inb.inbounder) {
      this.inb.spot = { x: p.pos.x, y: p.pos.y };
      return;
    }
    if (this.inb && p === this.inb.receiver) return;
    const { handler, screener, focus } = this.roles;
    if (p === handler || p === screener || p === focus) return; // role movement wins
    const hoop = this.hoops[p.team];
    const dir = hoop.x > COURT.W / 2 ? -1 : 1;
    const ax = (p.pos.x - hoop.x) / dir;
    const ay = p.pos.y - COURT.H / 2;
    const d = dist(p.pos, hoop);
    this.assignTargets.set(p.id, {
      ax,
      ay,
      cat: d < 8 ? "inside" : d < 22 ? "mid" : "three",
    });
  }

  /** Leave lab mode and return to a normally simulated game. Standing
      coaching plans survive; lab-only staging (inbounder) is dropped. */
  resumeGame() {
    this.lab = null;
    this.frozen = false;
    this.tactics = this.tactics.map((t) => ({
      defScheme: t.plan?.defScheme ?? "man",
      scorers: t.plan?.scorerSlots ?? [],
      inbounderSlot: null,
      plan: t.plan ?? null,
    }));
    if (this.labPending) {
      const { team, spot, sc } = this.labPending;
      this.labPending = null;
      this.setupInbound(team, spot, { sc });
    } else {
      this.setRoles(this.possession);
    }
  }

  /* ---------- periods ---------- */
  endQuarter() {
    this.ball.flight = null;
    this.ball.loose = null;
    this.ball.holder = null;
    this.ftState = null;
    this.teamFouls = [0, 0]; // team fouls reset each period
    if (this.lab) {
      this.labEnd();
      return;
    }
    const [a, b] = this.teams;
    if (this.quarter >= 4 && a.score !== b.score) {
      this.over = true;
      this.phase = "over";
      const w = a.score > b.score ? a : b;
      this.emit("final", `FINAL — ${this.scoreLine()}. The ${w.name} take it!`, null);
      return;
    }
    this.emit("period", `End of ${this.qLabel()} — ${this.scoreLine()}`, null);
    this.quarter++;
    this.gameClock = this.quarter <= 4 ? this.quarterLen : 300;
    if (this.quarter >= 5) {
      // every overtime period opens with a jump ball
      if (this.quarter === 5) this.emit("period", `Tied up — we're headed to overtime!`, null);
      this.setupTipoff();
      return;
    }
    const nextPoss = (this.qStartPoss + this.quarter + 1) % 2;
    this.setupInbound(nextPoss, this.baselineSpot(nextPoss), { sc: 24 });
  }
}
