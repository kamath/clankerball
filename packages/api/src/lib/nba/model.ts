/* ============================================================
   nba/model.ts — pure data shapes + the league distribution math
   No I/O here, so this module is safe to unit-test / run outside
   the Next.js server runtime.
   ============================================================ */

export interface NbaTeam {
  id: number;
  abbreviation: string;
  city: string;
  name: string;
  full_name: string;
  conference: string;
  division: string;
}

export interface NbaPlayerIdentity {
  id: number;
  first_name: string;
  last_name: string;
  position: string;
  height: string | null; // e.g. "6-2"
  weight: string | null; // e.g. "185"
  jersey_number: string | null;
  team?: NbaTeam;
}

/** Merged season stats for one player across base / defense / hustle. */
export interface MergedStats {
  player: NbaPlayerIdentity;
  gp: number;
  min: number;
  pts: number;
  fgm: number;
  fga: number;
  fg_pct: number;
  fg3m: number;
  fg3a: number;
  fg3_pct: number;
  ftm: number;
  fta: number;
  ft_pct: number;
  ast: number;
  tov: number;
  oreb: number;
  dreb: number;
  reb: number;
  stl: number;
  blk: number;
  pf: number;
  pfd: number;
  age: number;
  def_rating?: number;
  def_ws?: number;
  dreb_pct?: number;
  pct_stl?: number;
  pct_blk?: number;
  deflections?: number;
  charges_drawn?: number;
  contested_shots?: number;
  def_boxouts?: number;
  screen_assists?: number;
}

export interface SeasonRow {
  player: NbaPlayerIdentity;
  stats: Record<string, number>;
}

export interface Stat1D {
  mean: number;
  std: number;
}
export type Distributions = Record<string, Stat1D>;

/** per-36 normalization of a counting stat. */
export const per36 = (stat: number, min: number) => (min > 0 ? (stat * 36) / min : 0);

/** Merge base / defense / hustle season rows into one map keyed by player id. */
export function mergeRows(
  base: SeasonRow[],
  defense: SeasonRow[],
  hustle: SeasonRow[]
): Map<number, MergedStats> {
  const defById = new Map(defense.map((r) => [r.player.id, r.stats]));
  const husById = new Map(hustle.map((r) => [r.player.id, r.stats]));
  const byId = new Map<number, MergedStats>();
  for (const row of base) {
    const s = row.stats;
    const d = defById.get(row.player.id) || {};
    const h = husById.get(row.player.id) || {};
    byId.set(row.player.id, {
      player: row.player,
      gp: s.gp ?? 0,
      min: s.min ?? 0,
      pts: s.pts ?? 0,
      fgm: s.fgm ?? 0,
      fga: s.fga ?? 0,
      fg_pct: s.fg_pct ?? 0,
      fg3m: s.fg3m ?? 0,
      fg3a: s.fg3a ?? 0,
      fg3_pct: s.fg3_pct ?? 0,
      ftm: s.ftm ?? 0,
      fta: s.fta ?? 0,
      ft_pct: s.ft_pct ?? 0,
      ast: s.ast ?? 0,
      tov: s.tov ?? 0,
      oreb: s.oreb ?? 0,
      dreb: s.dreb ?? 0,
      reb: s.reb ?? 0,
      stl: s.stl ?? 0,
      blk: s.blk ?? 0,
      pf: s.pf ?? 0,
      pfd: s.pfd ?? 0,
      age: s.age ?? 25,
      def_rating: d.def_rating,
      def_ws: d.def_ws,
      dreb_pct: d.dreb_pct,
      pct_stl: d.pct_stl,
      pct_blk: d.pct_blk,
      deflections: h.deflections,
      charges_drawn: h.charges_drawn,
      contested_shots: h.contested_shots,
      def_boxouts: h.def_boxouts,
      screen_assists: h.screen_assists,
    });
  }
  return byId;
}

/**
 * League mean/std for every metric the scout scales, over rotation players
 * only (gp >= 20 & min >= 12). Counting stats are normalized to per-36.
 */
export function computeDistributions(byId: Map<number, MergedStats>): Distributions {
  const qualified = [...byId.values()].filter((p) => p.gp >= 20 && p.min >= 12);

  const metric = (fn: (p: MergedStats) => number | undefined): Stat1D => {
    const vals = qualified.map(fn).filter((v): v is number => v != null && !Number.isNaN(v));
    const n = vals.length || 1;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    return { mean, std: Math.sqrt(variance) || 1 };
  };

  return {
    pts36: metric((p) => per36(p.pts, p.min)),
    fga36: metric((p) => per36(p.fga, p.min)),
    fg3a36: metric((p) => per36(p.fg3a, p.min)),
    fg3_pct: metric((p) => (p.fg3a >= 1 ? p.fg3_pct : undefined)),
    fg_pct: metric((p) => p.fg_pct),
    ft_pct: metric((p) => (p.fta >= 0.5 ? p.ft_pct : undefined)),
    fta36: metric((p) => per36(p.fta, p.min)),
    ast36: metric((p) => per36(p.ast, p.min)),
    astTov: metric((p) => p.ast / Math.max(0.5, p.tov)),
    tov36: metric((p) => per36(p.tov, p.min)),
    pfd36: metric((p) => per36(p.pfd, p.min)),
    pf36: metric((p) => per36(p.pf, p.min)),
    oreb36: metric((p) => per36(p.oreb, p.min)),
    stl36: metric((p) => per36(p.stl, p.min)),
    blk36: metric((p) => per36(p.blk, p.min)),
    dreb36: metric((p) => per36(p.dreb, p.min)),
    pct_stl: metric((p) => p.pct_stl),
    pct_blk: metric((p) => p.pct_blk),
    dreb_pct: metric((p) => p.dreb_pct),
    def_ws: metric((p) => p.def_ws),
    def_rating: metric((p) => p.def_rating),
    deflections36: metric((p) => per36(p.deflections ?? 0, p.min)),
    charges36: metric((p) => per36(p.charges_drawn ?? 0, p.min)),
    contested36: metric((p) => per36(p.contested_shots ?? 0, p.min)),
    def_boxouts36: metric((p) => per36(p.def_boxouts ?? 0, p.min)),
  };
}
