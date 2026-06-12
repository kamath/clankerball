/* ============================================================
   types.ts — shared domain types for the simulation
   ============================================================ */

export interface Vec {
  x: number;
  y: number;
}

/** All player ratings are on a 25–99 scale. */
export interface Ratings {
  iq: number;
  threePoint: number;
  midRange: number;
  layup: number;
  dunk: number;
  ballHandle: number;
  passAcc: number;
  speed: number;
  acceleration: number;
  strength: number;
  vertical: number;
  perimeterD: number;
  interiorD: number;
  steal: number;
  block: number;
  rebound: number;
}

/** Behavioural tendencies, each 1–99 (default 50). */
export interface Tendencies {
  shoot: number;
  three: number;
  drive: number;
  pass: number;
  kickout: number;
  help: number;
  crash: number;
  gamble: number;
}

/** Offensive play call for a possession. */
export type PlayCall = "motion" | "iso" | "pnr" | "post" | "dho";

/** Defensive scheme for a possession. */
export type DefScheme = "man" | "switch" | "zone";

/** A job given to one offensive player for a scripted possession. */
export type PlayerAssignment =
  | "handler"
  | "screener"
  | "focus"
  | "corner"
  | "wing"
  | "top"
  | "dunker";

export interface Tactics {
  play: PlayCall;
  defScheme: DefScheme;
  /** roster slot the play runs through (iso/post/pnr screener); null = auto */
  focusSlot: number | null;
  /** per-roster-slot jobs (lab mode); null/missing = auto */
  assignments?: (PlayerAssignment | null)[];
}

/**
 * A player as supplied in configuration. Core identity + shooting ratings
 * are required; any other rating may be omitted and is filled in by
 * fillRatings() from body type and the ratings that are present.
 */
export interface PlayerConfig extends Partial<Ratings> {
  name: string;
  number: number;
  pos: string; // position label (PG/SG/SF/PF/C) — display only
  heightIn: number;
  weightLb: number;
  iq: number;
  threePoint: number;
  midRange: number;
  layup: number;
  dunk: number;
  tendencies?: Partial<Tendencies>;
  /** balldontlie player id, when sourced from real NBA data. */
  nbaId?: number;
}

export interface TeamConfig {
  name: string;
  abbr?: string;
  color: string;
  players: PlayerConfig[];
}

export interface GameConfig {
  quarterMinutes?: number;
  randomizeEachGame?: boolean;
  teamA: TeamConfig;
  teamB: TeamConfig;
}

export interface PlayerStats {
  pts: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
}

/** A live player object inside a running Game (config + runtime state). */
export interface Player extends Ratings {
  name: string;
  number: number;
  heightIn: number;
  weightLb: number;
  position: string;
  nbaId?: number;
  team: number;
  slot: number;
  id: number;
  tend: Tendencies;
  pos: Vec;
  vel: Vec;
  moveTarget: Vec | null;
  allowOOB: boolean;
  driving: boolean;
  driveSide: number;
  decisionTimer: number;
  spotIdx: number;
  spotTimer: number;
  markSlot?: number;
  /** seconds left rolling to the rim after setting a screen */
  rollTimer: number;
  /** assigned slot in a zone defense, -1 when unassigned */
  zoneIdx: number;
  /** role label drawn on the court during lab possessions */
  annotation: string | null;
  /** lab-authored motion path: waypoints followed when the play runs */
  path: Vec[] | null;
  pathIdx: number;
  stats: PlayerStats;
}

export interface TeamRuntime {
  name: string;
  abbr: string;
  color: string;
  score: number;
  players: Player[];
}

export type SimEventType =
  | "period"
  | "final"
  | "score"
  | "dunk"
  | "miss"
  | "block"
  | "steal"
  | "turnover"
  | "rebound"
  | "recover"
  | "loose"
  | "pass"
  | "info";

export interface SimEvent {
  type: SimEventType;
  text: string;
  team: number | null;
  qLabel: string;
  clock: string;
}

export interface GameOpts {
  onEvent?: (e: SimEvent) => void;
}
