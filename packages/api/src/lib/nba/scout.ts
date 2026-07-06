/* ============================================================
   nba/scout.ts — turn real NBA season stats into 0–99 ratings
   ------------------------------------------------------------
   Ratings are league-relative: every metric is z-scored against
   the season's rotation players, then mapped onto the 25–99
   scale the engine expects.

   The defensive model is deliberately built to see the players
   the box score misses. Steals and blocks alone make Marcus
   Smart, Jose Alvarado, and Draymond Green look ordinary, so the
   perimeter/interior defense ratings lean hardest on:
     • def_ws        — defensive win shares (overall impact)
     • deflections   — on-ball pressure / passing-lane disruption
     • charges_drawn — positioning & willingness to take a hit
     • contested_shots — closeouts and rim contests
     • def_rating    — points allowed per 100 while on the floor
   Those are the signals that actually separate elite defenders
   from empty-stat gamblers.
   ============================================================ */
import type { PlayerConfig, Tendencies } from "@repo/shared";
import { per36, type Distributions, type MergedStats, type NbaPlayerIdentity } from "./model";

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Pull the exact value a distribution key was computed from. */
function valueOf(p: MergedStats, key: string): number | undefined {
  switch (key) {
    case "pts36": return per36(p.pts, p.min);
    case "fga36": return per36(p.fga, p.min);
    case "fg3a36": return per36(p.fg3a, p.min);
    case "fg3_pct": return p.fg3a >= 1 ? p.fg3_pct : undefined;
    case "fg_pct": return p.fg_pct;
    case "ft_pct": return p.fta >= 0.5 ? p.ft_pct : undefined;
    case "fta36": return per36(p.fta, p.min);
    case "ast36": return per36(p.ast, p.min);
    case "astTov": return p.ast / Math.max(0.5, p.tov);
    case "tov36": return per36(p.tov, p.min);
    case "pfd36": return per36(p.pfd, p.min);
    case "pf36": return per36(p.pf, p.min);
    case "oreb36": return per36(p.oreb, p.min);
    case "stl36": return per36(p.stl, p.min);
    case "blk36": return per36(p.blk, p.min);
    case "dreb36": return per36(p.dreb, p.min);
    case "pct_stl": return p.pct_stl;
    case "pct_blk": return p.pct_blk;
    case "dreb_pct": return p.dreb_pct;
    case "def_ws": return p.def_ws;
    case "def_rating": return p.def_rating;
    case "deflections36": return per36(p.deflections ?? 0, p.min);
    case "charges36": return per36(p.charges_drawn ?? 0, p.min);
    case "contested36": return per36(p.contested_shots ?? 0, p.min);
    case "def_boxouts36": return per36(p.def_boxouts ?? 0, p.min);
    default: return undefined;
  }
}

export function makeScout(dist: Distributions) {
  /** z-score of a metric; missing data → 0 (league average). */
  const z = (p: MergedStats, key: string): number => {
    const v = valueOf(p, key);
    const d = dist[key];
    if (v == null || !d) return 0;
    return (v - d.mean) / d.std;
  };

  /** Weighted blend of z-scores. "defRtgInv" flips def_rating (low = good). */
  const blend = (p: MergedStats, weights: Record<string, number>): number => {
    let sum = 0,
      wsum = 0;
    for (const [key, w] of Object.entries(weights)) {
      const zi = key === "defRtgInv" ? -z(p, "def_rating") : z(p, key);
      sum += w * zi;
      wsum += w;
    }
    return wsum ? sum / wsum : 0;
  };

  const map = (zVal: number, center: number, spread: number, lo = 25, hi = 99) =>
    clamp(Math.round(center + zVal * spread), lo, hi);

  return { z, blend, map };
}

type Scout = ReturnType<typeof makeScout>;

function parseHeight(h: string | null): number {
  if (!h) return 78;
  const [ft, inch] = h.split("-").map(Number);
  return (ft || 6) * 12 + (inch || 6);
}
function parseWeight(w: string | null): number {
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : 215;
}

/** 0 = pure guard, 1 = pure center, blended from position label + height. */
function bignessOf(position: string, heightIn: number): number {
  const pos = position.toUpperCase();
  let posBig = 0.5;
  if (pos.includes("C")) posBig = pos.includes("F") ? 0.85 : 1.0;
  else if (pos.includes("F")) posBig = pos.includes("G") ? 0.45 : 0.7;
  else if (pos.includes("G")) posBig = 0.15;
  const heightBig = clamp((heightIn - 72) / (86 - 72), 0, 1);
  return clamp(posBig * 0.65 + heightBig * 0.35, 0, 1);
}

function posLabel(position: string, heightIn: number): string {
  const pos = position.toUpperCase();
  if (pos.includes("C")) return "C";
  if (pos.includes("G") && pos.includes("F")) return heightIn < 78 ? "SG" : "SF";
  if (pos.includes("G")) return heightIn < 75 ? "PG" : "SG";
  if (pos.includes("F")) return heightIn < 81 ? "SF" : "PF";
  return heightIn < 75 ? "PG" : heightIn < 79 ? "SG" : heightIn < 82 ? "SF" : heightIn < 84 ? "PF" : "C";
}

/**
 * Convert one player's merged season stats into a full PlayerConfig.
 * `fallbackNumber` is used when the player has no jersey number.
 */
export function ratePlayer(
  s: MergedStats,
  scout: Scout,
  fallbackNumber: number
): PlayerConfig {
  const { z, blend, map } = scout;
  const heightIn = parseHeight(s.player.height);
  const weightLb = parseWeight(s.player.weight);
  const big = bignessOf(s.player.position, heightIn);
  const guard = 1 - big;
  const agePenalty = clamp((s.age - 28) * 1.2, 0, 12);

  // ---------- offense ----------
  // shooting: blend % with volume confidence so low-volume snipers and
  // non-shooters don't grade like high-usage marksmen.
  const vol3 = clamp(per36(s.fg3a, s.min) / 6, 0, 1);
  const threePoint =
    s.fg3a < 0.8
      ? map(z(s, "ft_pct") * 0.6 - 1.0, 42, 10) // non-shooter: touch only
      : map(z(s, "fg3_pct") * (0.5 + 0.5 * vol3) + vol3 * 0.4, 58, 14);

  // no public shot-zone splits, so mid-range leans on the best proxies:
  // FT% (pure touch) and scoring volume. 3P% only lightly — elite middy
  // players (SGA, DeRozan types) are often mediocre from deep.
  const midRange = map(
    z(s, "ft_pct") * 0.5 + z(s, "pts36") * 0.25 + z(s, "fg3_pct") * 0.15 + z(s, "fg_pct") * 0.1,
    54,
    15
  );
  const layup = map(z(s, "fg_pct") * 0.5 + z(s, "fta36") * 0.3, 58, 13) + Math.round(big * 4);
  const freeThrow = map(z(s, "ft_pct"), 58, 14);
  const dunk = clamp(
    Math.round(30 + big * 46 + clamp(z(s, "blk36"), 0, 3) * 5 + clamp(z(s, "fta36"), 0, 3) * 4),
    25,
    99
  );
  const ballHandle = clamp(
    Math.round(44 + guard * 22 + z(s, "ast36") * 7 + z(s, "fga36") * 3 - clamp(z(s, "tov36"), 0, 3) * 2),
    25,
    99
  );
  const passAcc = clamp(
    Math.round(50 + z(s, "astTov") * 8 + z(s, "ast36") * 5 - clamp(z(s, "tov36"), 0, 3) * 2),
    25,
    99
  );
  const iq = clamp(
    Math.round(
      50 + z(s, "astTov") * 6 + z(s, "def_ws") * 4 + z(s, "pfd36") * 3 - z(s, "pf36") * 3 +
        clamp((s.age - 24) * 0.6, -3, 6)
    ),
    25,
    99
  );

  // ---------- physical ----------
  const speed = clamp(
    Math.round(60 + guard * 18 - big * 14 + z(s, "deflections36") * 3 + z(s, "stl36") * 2 - agePenalty),
    25,
    99
  );
  const acceleration = clamp(speed + (guard > 0.6 ? 2 : -2), 25, 99);
  const strength = clamp(
    Math.round(35 + (weightLb - 170) * 0.3 + big * 12 + z(s, "charges36") * 2 + z(s, "def_boxouts36") * 2),
    25,
    99
  );
  const vertical = clamp(
    Math.round(45 + z(s, "blk36") * 8 + big * 10 + z(s, "oreb36") * 4),
    25,
    99
  );

  // ---------- defense (off-ball-aware) ----------
  // Averaging across skills washes out specialists, so each rating gets a
  // "peak" bump for a standout single dimension — a player who is elite at
  // one thing (Caruso's deflections, Gobert's rim protection) shouldn't be
  // dragged to the middle by the categories they don't fill.
  const peak = (...keys: string[]) =>
    clamp(Math.max(0, ...keys.map((k) => z(s, k))), 0, 3) * 4;

  const steal = clamp(
    map(blend(s, { deflections36: 1.0, stl36: 0.8, pct_stl: 0.5, charges36: 0.2 }), 50, 18) +
      Math.round(peak("deflections36", "stl36", "pct_stl") * 0.9),
    25,
    99
  );
  const block = clamp(
    map(blend(s, { blk36: 1.0, pct_blk: 0.6, contested36: 0.3 }), 48, 17) +
      Math.round(big * 6 + peak("blk36", "pct_blk") * 1.1),
    25,
    99
  );
  const rebound = clamp(
    map(blend(s, { dreb36: 0.7, oreb36: 0.4, dreb_pct: 0.6, def_boxouts36: 0.4 }), 46, 15) +
      Math.round(big * 10 + peak("dreb_pct", "dreb36")),
    25,
    99
  );
  const perimeterD = clamp(
    map(
      blend(s, {
        deflections36: 1.0,
        def_ws: 0.8,
        contested36: 0.5,
        stl36: 0.5,
        defRtgInv: 0.5,
        charges36: 0.3,
      }),
      49,
      17
    ) + Math.round(guard * 5 + peak("deflections36", "def_ws", "stl36", "contested36")),
    25,
    99
  );
  const interiorD = clamp(
    map(
      blend(s, {
        blk36: 0.9,
        contested36: 0.6,
        def_ws: 0.6,
        defRtgInv: 0.5,
        def_boxouts36: 0.4,
        pct_blk: 0.4,
        charges36: 0.3,
      }),
      46,
      16
    ) + Math.round(big * 16 + peak("blk36", "def_ws", "pct_blk")),
    25,
    99
  );

  // ---------- tendencies (1–99) ----------
  const tmap = (zVal: number, center = 50, spread = 17) =>
    clamp(Math.round(center + zVal * spread), 5, 95);
  const shotShare3 = s.fga > 0 ? s.fg3a / s.fga : 0;
  const tendencies: Tendencies = {
    shoot: tmap(z(s, "fga36") * 0.8),
    three: clamp(Math.round(10 + shotShare3 * 110), 5, 95),
    drive: tmap(z(s, "fta36") * 0.7 + (1 - shotShare3) * 0.6),
    pass: tmap(z(s, "ast36") * 0.9),
    kickout: tmap(z(s, "ast36") * 0.6 + z(s, "fta36") * 0.3),
    help: tmap(z(s, "def_ws") * 0.5 + z(s, "charges36") * 0.4 + (big - 0.5) * 1.2),
    crash: tmap(z(s, "oreb36") * 0.9, 45),
    gamble: tmap(z(s, "deflections36") * 0.6 + z(s, "pct_stl") * 0.5),
  };

  const jersey = Number(s.player.jersey_number);
  return {
    name: `${s.player.first_name} ${s.player.last_name}`,
    number: Number.isFinite(jersey) && jersey > 0 ? jersey : fallbackNumber,
    pos: posLabel(s.player.position, heightIn),
    heightIn,
    weightLb,
    nbaId: s.player.id,
    iq,
    threePoint,
    midRange,
    layup,
    dunk,
    freeThrow,
    ballHandle,
    passAcc,
    speed,
    acceleration,
    strength,
    vertical,
    perimeterD,
    interiorD,
    steal,
    block,
    rebound,
    tendencies,
  };
}

/**
 * For a rostered player with no season averages (rookie, just-traded, deep
 * bench). We only know identity, so ratings hang off position/size and land
 * near league average — these players rarely crack a starting five anyway.
 */
export function fallbackPlayer(p: NbaPlayerIdentity, fallbackNumber: number): PlayerConfig {
  const heightIn = parseHeight(p.height);
  const weightLb = parseWeight(p.weight);
  const big = bignessOf(p.position, heightIn);
  const guard = 1 - big;
  const r = (base: number, slope: number, lean = big) =>
    clamp(Math.round(base + slope * (lean - 0.5) * 2), 25, 99);
  const jersey = Number(p.jersey_number);
  return {
    name: `${p.first_name} ${p.last_name}`,
    number: Number.isFinite(jersey) && jersey > 0 ? jersey : fallbackNumber,
    pos: posLabel(p.position, heightIn),
    heightIn,
    weightLb,
    nbaId: p.id,
    iq: 50,
    threePoint: r(52, -18),
    midRange: 50,
    layup: r(58, 10),
    dunk: r(50, 30),
    ballHandle: r(55, -22),
    passAcc: r(52, -12),
    speed: r(60, -22),
    acceleration: r(60, -22),
    strength: clamp(Math.round(40 + (weightLb - 175) * 0.28 + big * 12), 25, 99),
    vertical: r(55, 12),
    perimeterD: r(52, -10, guard),
    interiorD: r(48, 24),
    steal: r(50, -8, guard),
    block: r(45, 26),
    rebound: r(48, 26),
    tendencies: {
      shoot: 50, three: clamp(Math.round(60 - big * 50), 5, 95), drive: 50,
      pass: clamp(Math.round(40 + guard * 25), 5, 95), help: 50,
      crash: clamp(Math.round(35 + big * 35), 5, 95), gamble: 50,
    },
  };
}
