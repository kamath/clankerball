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
import { z } from "zod";
import type { Contribution, GameConfig, SimEvent, ShotType, Openness } from "./types";
import { summarizePossession, type PossessionSummary, type Replay } from "./replay";
import {
  ArtifactContributionSchema,
  ArtifactEventSchema,
  ArtifactPlayerSchema,
  ArtifactPossessionSchema,
} from "./schemas";

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

/* ---------- self-documenting data dictionary ---------- */

/** One column's documentation, distilled from the schema's JSON Schema. */
export interface ColumnDoc {
  type: string;
  description?: string;
  enum?: string[];
}

/** A table's grain plus its column dictionary. */
export interface TableDoc {
  grain: string;
  columns: Record<string, ColumnDoc>;
}

/** A join between two tables; fromCol may differ from toCol. */
export interface Relationship {
  from: string;
  to: string;
  on: { fromCol: string; toCol: string }[];
}

/** The dictionary carried inside every artifact so it documents itself. */
export interface ArtifactMeta {
  version: number;
  tables: Record<string, TableDoc>;
  relationships: Relationship[];
}

/** The full normalized result of running one config N times. */
export interface SimArtifact {
  /** the data dictionary — read this first to learn the tables, columns, and joins. */
  meta: ArtifactMeta;
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

/** The four relational tables, and the one hand-authored fact per table JSON
    Schema can't derive: its grain. Typed strictly here so a bad name is a
    compile error; the public ArtifactMeta widens to string for the wire. */
type TableName = "players" | "possessions" | "events" | "contributions";

const GRAIN: Record<TableName, string> = {
  players: "one row per player on the floor (both teams)",
  possessions: "one row per simulated possession",
  events: "one row per play-by-play line",
  contributions: "one row per player action on an event",
};

/** The joins JSON Schema can't express. `on` maps a column on `from` to its
    counterpart on `to` (they differ for contributions.playerId → players.id). */
const RELATIONSHIPS: { from: TableName; to: TableName; on: { fromCol: string; toCol: string }[] }[] = [
  {
    from: "contributions",
    to: "events",
    on: [
      { fromCol: "simId", toCol: "simId" },
      { fromCol: "eventIndex", toCol: "eventIndex" },
    ],
  },
  { from: "contributions", to: "players", on: [{ fromCol: "playerId", toCol: "id" }] },
  { from: "possessions", to: "events", on: [{ fromCol: "simId", toCol: "simId" }] },
];

/** Pull each column's type/description/enum out of a schema's JSON Schema,
    resolving any $ref into $defs so shared enums still surface inline. */
function columnsOf(schema: z.ZodType): Record<string, ColumnDoc> {
  const js = z.toJSONSchema(schema) as Record<string, any>;
  const defs: Record<string, any> = js.$defs ?? {};
  const deref = (d: any): any => (d && d.$ref ? deref(defs[String(d.$ref).split("/").pop() ?? ""] ?? {}) : d);
  const props: Record<string, any> = js.properties ?? {};
  const out: Record<string, ColumnDoc> = {};
  for (const [name, raw] of Object.entries(props)) {
    const def = deref(raw);
    const type =
      typeof def.type === "string"
        ? def.type
        : Array.isArray(def.type)
          ? def.type.join("|")
          : def.enum
            ? "string"
            : "unknown";
    const col: ColumnDoc = { type };
    const description = raw.description ?? def.description;
    if (description) col.description = description;
    if (def.enum) col.enum = def.enum;
    out[name] = col;
  }
  return out;
}

/** Assemble the data dictionary, and guard it: every relationship must join
    columns that actually exist on both tables — so renaming a key that isn't
    updated here fails loudly instead of shipping a lie. Memoized: the schema
    is static, so it's derived once. */
let cachedMeta: ArtifactMeta | null = null;
function buildMeta(): ArtifactMeta {
  if (cachedMeta) return cachedMeta;
  const tables: Record<TableName, TableDoc> = {
    players: { grain: GRAIN.players, columns: columnsOf(ArtifactPlayerSchema) },
    possessions: { grain: GRAIN.possessions, columns: columnsOf(ArtifactPossessionSchema) },
    events: { grain: GRAIN.events, columns: columnsOf(ArtifactEventSchema) },
    contributions: { grain: GRAIN.contributions, columns: columnsOf(ArtifactContributionSchema) },
  };
  for (const r of RELATIONSHIPS) {
    for (const { fromCol, toCol } of r.on) {
      if (!(fromCol in tables[r.from].columns))
        throw new Error(`meta drift: relationship ${r.from} → ${r.to} references missing column ${r.from}.${fromCol}`);
      if (!(toCol in tables[r.to].columns))
        throw new Error(`meta drift: relationship ${r.from} → ${r.to} references missing column ${r.to}.${toCol}`);
    }
  }
  cachedMeta = { version: 1, tables, relationships: RELATIONSHIPS };
  return cachedMeta;
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
    meta: buildMeta(),
    config: { offense, offenseTeam, defenseTeam, n: runs.length, plan },
    players: playerRows(config),
    possessions,
    events,
    contributions,
    aggregate: aggregate(possessions),
  };
}
