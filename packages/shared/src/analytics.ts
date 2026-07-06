/* ============================================================
   analytics.ts — turn a batch of simulated possessions into one
   normalized, queryable artifact.

   Running a config N times produces N independent possessions. This
   assembles them into a single in-memory dataset:

     players        — the ten on the floor (both teams)
     possessions    — one aggregate-ready feature row per run
     events         — the play-by-play, keyed (simId, eventIndex)
     contributions  — who-did-what, FK (simId, eventIndex) → events
     aggregate      — the config-level rollup (rates & distributions)

   The three flat arrays are relational tables: `contributions` joins to
   `events` on (simId, eventIndex) and to `players` on playerId. The shape
   maps 1:1 onto a SQLite schema if the data is ever persisted, and is read
   directly by the browser or a CLI (e.g. duckdb `read_json_auto`). No
   storage is involved — this is pure, in-memory, and reused on both ends.
   ============================================================ */
import type { Contribution, GameConfig, SimEvent, ShotType, Openness } from "./types";
import { summarizePossession, type PossessionSummary, type Replay } from "./replay";

/** One of the ten players on the floor, as a joinable row. */
export interface ArtifactPlayer {
  /** global id = team * 5 + slot. */
  id: number;
  team: number;
  slot: number;
  name: string;
  number: number;
  /** position label (PG/SG/SF/PF/C). */
  position: string;
  /** balldontlie id, when sourced from real NBA data. */
  nbaId?: number;
}

/** A play-by-play line widened with its batch coordinates. */
export interface ArtifactEvent extends SimEvent {
  simId: string;
  /** position within its possession's stream — the FK contributions point at. */
  eventIndex: number;
}

/** A contribution widened with the run it belongs to; (simId, eventIndex) is
    the foreign key into `events`. */
export interface ArtifactContribution extends Contribution {
  simId: string;
}

/** A possession feature row tagged with its run handle. */
export interface ArtifactPossession extends PossessionSummary {
  simId: string;
}

/** The config-level rollup: what this play generally produces over the batch. */
export interface BatchAggregate {
  n: number;
  pointsPerPossession: number;
  /** share of possessions that scored (points > 0). */
  scoredPct: number;
  /** share of made field goals that were assisted. */
  assistRate: number;
  /** share of possessions ending in a live-ball turnover. */
  turnoverRate: number;
  /** share of possessions with at least one offensive rebound. */
  offRebRate: number;
  avgPasses: number;
  /** fraction of shot-ending possessions by shot type. */
  shotTypeMix: Record<string, number>;
  /** fraction of shot-ending possessions by openness. */
  opennessMix: Record<string, number>;
  /** count of possessions by decisive-event type. */
  outcomeHistogram: Record<string, number>;
}

/** The full normalized result of running one config N times. */
export interface SimArtifact {
  config: {
    offense: number;
    offenseTeam: string;
    defenseTeam: string;
    n: number;
    plan?: string | null;
  };
  players: ArtifactPlayer[];
  possessions: ArtifactPossession[];
  events: ArtifactEvent[];
  contributions: ArtifactContribution[];
  aggregate: BatchAggregate;
}

/** Build the joinable player table from a matchup config. Slot is the player's
    index within its team's five; id is the global team*5+slot the engine uses. */
function playerRows(config: GameConfig): ArtifactPlayer[] {
  const teams = [config.teamA, config.teamB];
  const rows: ArtifactPlayer[] = [];
  teams.forEach((t, team) => {
    t.players.forEach((p, slot) => {
      rows.push({
        id: team * 5 + slot,
        team,
        slot,
        name: p.name,
        number: p.number,
        position: p.pos,
        nbaId: p.nbaId,
      });
    });
  });
  return rows;
}

/** Roll the per-possession feature rows up into the config-level distribution. */
function aggregate(possessions: PossessionSummary[]): BatchAggregate {
  const n = possessions.length;
  const safe = (num: number, den: number) => (den > 0 ? num / den : 0);

  const makes = possessions.filter((p) => p.fgMade).length;
  const shots = possessions.filter((p) => p.fgAttempted);

  const tally = <T extends string>(items: (T | undefined)[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of items) if (k != null) out[k] = (out[k] ?? 0) + 1;
    return out;
  };
  const fraction = (counts: Record<string, number>, den: number): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of Object.keys(counts)) out[k] = safe(counts[k], den);
    return out;
  };

  return {
    n,
    pointsPerPossession: safe(
      possessions.reduce((s, p) => s + p.points, 0),
      n
    ),
    scoredPct: safe(possessions.filter((p) => p.points > 0).length, n),
    assistRate: safe(possessions.filter((p) => p.assisted).length, makes),
    turnoverRate: safe(possessions.filter((p) => p.turnover).length, n),
    offRebRate: safe(possessions.filter((p) => p.offReb > 0).length, n),
    avgPasses: safe(
      possessions.reduce((s, p) => s + p.passes, 0),
      n
    ),
    shotTypeMix: fraction(tally<ShotType>(shots.map((p) => p.shotType)), shots.length),
    opennessMix: fraction(tally<Openness>(shots.map((p) => p.openness)), shots.length),
    outcomeHistogram: tally(possessions.map((p) => p.outcomeType)),
  };
}

/** Assemble the normalized artifact from a batch of simulated runs. Pure and
    storage-free: the same function serves the API response and any offline CLI. */
export function buildArtifact(input: {
  config: GameConfig;
  offense: number;
  plan?: string | null;
  runs: { simId: string; replay: Replay }[];
}): SimArtifact {
  const { config, offense, plan, runs } = input;
  const offenseTeam = offense === 0 ? config.teamA.name : config.teamB.name;
  const defenseTeam = offense === 0 ? config.teamB.name : config.teamA.name;

  const possessions: ArtifactPossession[] = [];
  const events: ArtifactEvent[] = [];
  const contributions: ArtifactContribution[] = [];

  for (const { simId, replay } of runs) {
    possessions.push({ simId, ...summarizePossession(offense, replay) });
    replay.events.forEach((e, eventIndex) => events.push({ simId, eventIndex, ...e }));
    for (const c of replay.contributions) contributions.push({ simId, ...c });
  }

  return {
    config: { offense, offenseTeam, defenseTeam, n: runs.length, plan },
    players: playerRows(config),
    possessions,
    events,
    contributions,
    aggregate: aggregate(possessions),
  };
}
