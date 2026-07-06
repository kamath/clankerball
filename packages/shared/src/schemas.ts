/* ============================================================
   schemas.ts — zod schemas for everything that crosses the wire
   between the Next.js client and the Hono API. These are the
   single source of truth for the API's input/output validation
   and its generated OpenAPI document. The hand-written domain
   interfaces in ./types and ./plan stay authoritative for the
   engine; the assertions at the bottom keep the two in lockstep.
   ============================================================ */
import { z } from "zod";
import type { Contribution, GameConfig, PlayerConfig, TeamConfig, Tendencies, Vec } from "./types";
import type { TeamPlan } from "./plan";
import type { LabSetup } from "./engine";
import type { PossessionSummary, Replay, ReplayFrame, ReplayMeta, SimulateRequest } from "./replay";
import type { SimArtifact } from "./analytics";

/* ---------- domain: teams, players, matchups ---------- */

export const TendenciesSchema = z.object({
  shoot: z.number(),
  three: z.number(),
  drive: z.number(),
  pass: z.number(),
  kickout: z.number(),
  help: z.number(),
  crash: z.number(),
  gamble: z.number(),
});

/** Every optional rating that fillRatings() may backfill on the engine side. */
const optionalRatings = {
  ballHandle: z.number().optional(),
  passAcc: z.number().optional(),
  speed: z.number().optional(),
  acceleration: z.number().optional(),
  strength: z.number().optional(),
  vertical: z.number().optional(),
  perimeterD: z.number().optional(),
  interiorD: z.number().optional(),
  steal: z.number().optional(),
  block: z.number().optional(),
  rebound: z.number().optional(),
  freeThrow: z.number().optional(),
};

export const PlayerConfigSchema = z.object({
  name: z.string(),
  number: z.number(),
  pos: z.string(),
  heightIn: z.number(),
  weightLb: z.number(),
  iq: z.number(),
  threePoint: z.number(),
  midRange: z.number(),
  layup: z.number(),
  dunk: z.number(),
  tendencies: TendenciesSchema.partial().optional(),
  nbaId: z.number().optional(),
  ...optionalRatings,
});

export const TeamConfigSchema = z.object({
  name: z.string(),
  abbr: z.string().optional(),
  color: z.string(),
  players: z.array(PlayerConfigSchema),
  roster: z.array(PlayerConfigSchema).optional(),
});

export const GameConfigSchema = z.object({
  quarterMinutes: z.number().optional(),
  randomizeEachGame: z.boolean().optional(),
  teamA: TeamConfigSchema,
  teamB: TeamConfigSchema,
});

export const TeamOptionSchema = z.object({
  id: z.number(),
  abbr: z.string(),
  fullName: z.string(),
  conference: z.string(),
});
export type TeamOption = z.infer<typeof TeamOptionSchema>;

/** A rated player in the leaguewide pool — a PlayerConfig plus the real team
    he plays for, so the "All NBA" picker can show and search by team. */
export const RosterPlayerSchema = PlayerConfigSchema.extend({
  teamAbbr: z.string().optional(),
});
export type RosterPlayer = z.infer<typeof RosterPlayerSchema>;

export const BuildMatchupInputSchema = z.object({
  teamAId: z.number().int(),
  teamBId: z.number().int(),
  season: z.number().int().optional(),
});
export type BuildMatchupInput = z.infer<typeof BuildMatchupInputSchema>;

/* ---------- game plan ----------
   The TeamPlan a coach builds by hand, mirroring the TeamPlan interface in
   ./plan. Carried on the wire so a staged possession can be simulated. */
const slot = z.number();
export const PlanActionSchema = z.object({
  type: z.enum(["pickAndRoll", "getOpen", "iso", "postUp"]),
  handlerSlot: slot.nullable(),
  screenerSlot: slot.nullable(),
  targetSlot: slot.nullable(),
  finish: z.enum(["roll", "pop"]).nullable(),
});

export const PlayerDirectiveSchema = z.object({
  slot: z.number(),
  note: z.string().nullable(),
  tendencyBias: TendenciesSchema.partial().nullable(),
});

export const TeamPlanSchema = z.object({
  handlerSlot: slot.nullable(),
  scorerSlots: z.array(slot),
  actions: z.array(PlanActionSchema),
  directives: z.array(PlayerDirectiveSchema),
  defScheme: z.enum(["man", "switch", "zone"]).nullable(),
  // defaults keep plans saved before matchups/doubles existed loadable
  matchups: z
    .array(z.object({ defenderSlot: slot, targetSlot: slot }))
    .nullable()
    .default(null),
  double: z
    .object({ doublerSlot: slot.nullable(), targetSlot: slot })
    .nullable()
    .default(null),
  pace: z.enum(["fast", "normal", "slow"]).nullable(),
  inbound: z.enum(["full", "side-top", "side-bot", "base-top", "base-bot"]).nullable(),
  inbounderSlot: slot.nullable(),
});

/* ---------- possession simulation: request + recorded replay ----------
   A staged lab possession is simulated on the backend Worker; the request
   carries everything needed to rebuild it (mirrors stageLab + reRunLab), and
   the response is a frame-by-frame Replay the client plays back. */

const VecSchema: z.ZodType<Vec> = z.object({ x: z.number(), y: z.number() });

/** Half-court "attack space" spot a dragged player holds while the play runs. */
const SpotSchema = z.object({
  ax: z.number(),
  ay: z.number(),
  cat: z.enum(["three", "mid", "inside"]),
});

export const LabSetupSchema = z.object({
  players: z.array(
    z.object({
      team: z.number(),
      slot: z.number(),
      pos: VecSchema,
      moveTarget: VecSchema.nullable(),
      path: z.array(VecSchema).nullable(),
      pathHold: z.boolean(),
    })
  ),
  assignTargets: z.array(z.tuple([z.number(), SpotSchema])),
  inbSpot: VecSchema,
  inbounderSlot: z.number(),
  labTeam: z.number(),
  gameClock: z.number(),
  startShotClock: z.number().min(1).max(24).default(24),
  live: z.boolean().default(false),
});

export const SimulateRequestSchema = z.object({
  config: GameConfigSchema,
  offense: z.number(),
  plan: TeamPlanSchema.nullable(),
  defPlan: TeamPlanSchema.nullable(),
  setup: LabSetupSchema,
});

export const ReplayMetaSchema = z.object({
  dt: z.number(),
  teams: z.array(
    z.object({
      name: z.string(),
      abbr: z.string(),
      color: z.string(),
      players: z.array(
        z.object({
          number: z.number(),
          name: z.string(),
          heightIn: z.number(),
          annotation: z.string().nullable(),
        })
      ),
    })
  ),
});

export const ReplayFrameSchema = z.object({
  players: z.array(z.object({ x: z.number(), y: z.number() })),
  ball: z.object({
    x: z.number(),
    y: z.number(),
    air: z.number(),
    holder: z.number(),
  }),
  scores: z.tuple([z.number(), z.number()]),
  clock: z.number(),
  shot: z.number(),
  shotActive: z.boolean(),
  poss: z.number(),
  quarter: z.number(),
  phase: z.enum(["setup", "live", "over"]),
  over: z.boolean(),
});

export const SimEventSchema = z.object({
  type: z
    .enum([
      "period",
      "final",
      "score",
      "dunk",
      "miss",
      "block",
      "steal",
      "turnover",
      "rebound",
      "recover",
      "loose",
      "pass",
      "foul",
      "freethrow",
      "info",
    ])
    .describe("The kind of play this line records."),
  text: z.string().describe("Human-readable play-by-play line."),
  team: z.number().nullable().describe("Team the event is credited to: 0 = teamA, 1 = teamB, null = neutral."),
  qLabel: z.string().describe("Period label, e.g. 'Q1' or 'OT'."),
  clock: z.string().describe("Game clock when the event fired, 'MM:SS'."),
});

/* ---------- structured player contributions ---------- */

export const shotTypeEnum = z.enum(["three", "mid", "inside", "dunk", "ft"]);
export const opennessEnum = z.enum(["wide_open", "open", "contested", "smothered"]);
export const passTypeEnum = z.enum([
  "chest",
  "bounce",
  "skip",
  "lob",
  "entry",
  "outlet",
  "hitAhead",
  "pocket",
  "kickout",
  "noLook",
  "handoff",
]);
export const contribKindEnum = z.enum([
  "shot_make",
  "shot_miss",
  "assist",
  "pass",
  "turnover",
  "steal",
  "block",
  "off_reb",
  "def_reb",
  "recover",
  "foul_committed",
  "foul_drawn",
  "ft_make",
  "ft_miss",
]);

export const ContributionSchema = z.object({
  eventIndex: z
    .number()
    .describe("FK → events.eventIndex within the same simId: the event this contribution belongs to."),
  playerId: z.number().describe("FK → players.id (global id = team*5 + slot)."),
  team: z.number().describe("0 = teamA, 1 = teamB."),
  kind: contribKindEnum.describe("What the player did on this event."),
  shotType: shotTypeEnum.optional().describe("Range bucket of the shot (shot_make/shot_miss/ft_*)."),
  points: z.number().optional().describe("Points booked on this contribution (a make or a made free throw)."),
  defDist: z.number().optional().describe("Defender distance at the shot's release, in feet."),
  shotQuality: z.number().optional().describe("Engine make-probability at release, 0–1."),
  openness: opennessEnum.optional().describe("Bucketed defDist."),
  pullUp: z.boolean().optional().describe("Shot taken off the dribble, not a set catch-and-shoot."),
  blocked: z.boolean().optional().describe("The shot attempt was swatted."),
  passType: passTypeEnum.optional().describe("Kind of pass thrown (pass/assist)."),
  relatedPlayerId: z
    .number()
    .optional()
    .describe("The other player in the play (assister↔shooter, robbed passer↔thief, fouler↔fouled), as players.id."),
});

export const ReplaySchema = z.object({
  meta: ReplayMetaSchema,
  frames: z.array(ReplayFrameSchema),
  events: z.array(SimEventSchema),
  contributions: z.array(ContributionSchema),
});

/* ---------- the matchup play library (backed by simulation analytics) ---------- */

/** A recorded possession pulled back from analytics: the authored request (to
    re-stage it) plus the exact Replay that ran (to play it back faithfully — the
    sim is random, so the recorded frames are the only reproducible result). */
export const StoredPlaySchema = z.object({
  request: SimulateRequestSchema,
  replay: ReplaySchema,
});
export type StoredPlay = z.infer<typeof StoredPlaySchema>;

/** A one-line summary of a recorded play, listed for a matchup so the library
    can show each outcome without loading the full replay. */
export const PlaySummarySchema = z.object({
  /** analytics run id — the handle used to load the full recorded play */
  simId: z.string(),
  /** the possession's outcome, verbatim from the play-by-play
      (e.g. "Wembanyama buries the triple") */
  result: z.string(),
  /** points the offense scored on the possession (0 on a miss/turnover) */
  points: z.number(),
  /** which side had the ball (0 = teamA, 1 = teamB) */
  offense: z.number(),
  offenseTeam: z.string(),
  /** when the play was run (ClickHouse DateTime64 string, newest first) */
  timestamp: z.string(),
});
export type PlaySummary = z.infer<typeof PlaySummarySchema>;

/* ---------- batch run results ----------
   One /simulate call runs N possessions in memory and returns one item per run:
   the outcome line + points, which side had the ball, and the full play-by-play.
   Frames (the movement "paths") are NOT inline — they're written to R2 and pulled
   on demand by `simId` via GET /simulate/{id}, keeping this list light. */
export const BatchRunSchema = z.object({
  /** handle for this run — the key used to pull its paths (Replay) from R2 */
  simId: z.string(),
  /** the possession's outcome, verbatim from the play-by-play */
  result: z.string(),
  /** points the offense scored on the possession (0 on a miss/turnover) */
  points: z.number(),
  /** which side had the ball (0 = teamA, 1 = teamB) */
  offense: z.number(),
  /** display name of the team on offense */
  offenseTeam: z.string(),
  /** the full play-by-play for this run, in emission order */
  events: z.array(SimEventSchema),
});
export type BatchRun = z.infer<typeof BatchRunSchema>;

/* ---------- batch analytics artifact ----------
   One /simulate call returns this single normalized dataset: the ten players,
   one feature row per possession, the flat event + contribution tables (joined
   on (simId, eventIndex)), and the config-level rollup. Consumed as relational
   tables by the browser or a CLI — no persistence involved. */

export const simEventTypeEnum = z.enum([
  "period",
  "final",
  "score",
  "dunk",
  "miss",
  "block",
  "steal",
  "turnover",
  "rebound",
  "recover",
  "loose",
  "pass",
  "foul",
  "freethrow",
  "info",
]);

export const ArtifactPlayerSchema = z.object({
  id: z.number().describe("Global player id = team*5 + slot; the key contributions.playerId points at."),
  team: z.number().describe("0 = teamA, 1 = teamB."),
  slot: z.number().describe("Index within the team's five (0–4)."),
  name: z.string().describe("Player name."),
  number: z.number().describe("Jersey number."),
  position: z.string().describe("Position label (PG/SG/SF/PF/C)."),
  nbaId: z.number().optional().describe("balldontlie id when sourced from real NBA data."),
});

export const ArtifactEventSchema = SimEventSchema.extend({
  simId: z.string().describe("The run this event belongs to; half of the (simId, eventIndex) key."),
  eventIndex: z.number().describe("Position within the run's event stream; the other half of the key."),
});

export const ArtifactContributionSchema = ContributionSchema.extend({
  simId: z.string().describe("The run this contribution belongs to; joins with eventIndex to events."),
});

export const PossessionSummarySchema = z.object({
  offense: z.number().describe("Which side had the ball: 0 = teamA, 1 = teamB."),
  result: z.string().describe("The possession's outcome, verbatim from the play-by-play."),
  outcomeType: simEventTypeEnum.describe("The decisive event's type — the coarse outcome bucket."),
  points: z.number().describe("Points the offense scored on the possession."),
  assisted: z.boolean().describe("The made field goal had an assist."),
  passes: z.number().describe("Completed passes thrown by the offense."),
  offReb: z.number().describe("Offensive rebounds grabbed on the possession."),
  turnover: z.boolean().describe("Ended in a live-ball turnover (giveaway or steal)."),
  fgAttempted: z.boolean().describe("A field goal was attempted to end the possession."),
  fgMade: z.boolean().describe("That field goal went in."),
  shotType: shotTypeEnum.optional().describe("The final shot's range bucket."),
  openness: opennessEnum.optional().describe("The final shot's openness."),
  shotQuality: z.number().optional().describe("The final shot's make-probability at release, 0–1."),
});

export const ArtifactPossessionSchema = PossessionSummarySchema.extend({
  simId: z.string().describe("FK → events.simId: the run these feature values summarize."),
});

export const BatchAggregateSchema = z.object({
  n: z.number().describe("Possessions in the batch."),
  pointsPerPossession: z.number().describe("Mean points scored per possession."),
  scoredPct: z.number().describe("Share of possessions that scored (points > 0)."),
  assistRate: z.number().describe("Share of made field goals that were assisted."),
  turnoverRate: z.number().describe("Share of possessions ending in a live-ball turnover."),
  offRebRate: z.number().describe("Share of possessions with at least one offensive rebound."),
  avgPasses: z.number().describe("Mean completed passes per possession."),
  shotTypeMix: z.record(z.string(), z.number()).describe("Fraction of shot-ending possessions by shot type."),
  opennessMix: z.record(z.string(), z.number()).describe("Fraction of shot-ending possessions by openness."),
  outcomeHistogram: z.record(z.string(), z.number()).describe("Count of possessions by decisive-event type."),
});

/* ---------- self-documenting data dictionary ----------
   `meta` travels inside every artifact so a first-time consumer learns the
   tables, every column's meaning + type + enum domain, and — critically — how
   the tables join, without any external doc. `tables[*].columns` is generated
   from the schemas above via z.toJSONSchema(), so it can never drift from the
   data; only `grain` and `relationships` are hand-authored. */

export const ColumnDocSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

export const TableDocSchema = z.object({
  grain: z.string(),
  columns: z.record(z.string(), ColumnDocSchema),
});

export const RelationshipSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** one entry per key column; fromCol may differ from toCol (e.g. playerId → id). */
  on: z.array(z.object({ fromCol: z.string(), toCol: z.string() })),
});

export const ArtifactMetaSchema = z.object({
  version: z.number(),
  tables: z.record(z.string(), TableDocSchema),
  relationships: z.array(RelationshipSchema),
});

export const SimArtifactSchema = z.object({
  meta: ArtifactMetaSchema,
  config: z.object({
    offense: z.number(),
    offenseTeam: z.string(),
    defenseTeam: z.string(),
    n: z.number(),
    plan: z.string().nullable().optional(),
  }),
  players: z.array(ArtifactPlayerSchema),
  possessions: z.array(ArtifactPossessionSchema),
  events: z.array(ArtifactEventSchema),
  contributions: z.array(ArtifactContributionSchema),
  aggregate: BatchAggregateSchema,
});
export type SimArtifactOut = z.infer<typeof SimArtifactSchema>;

/* ---------- drift guards: schema inference must match the hand-written
   interfaces the engine relies on. These are compile-time only. ---------- */
type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _T = Assert<Extends<z.infer<typeof TendenciesSchema>, Tendencies>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _P = Assert<Extends<z.infer<typeof PlayerConfigSchema>, PlayerConfig>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _C = Assert<Extends<z.infer<typeof TeamConfigSchema>, TeamConfig>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _G = Assert<Extends<z.infer<typeof GameConfigSchema>, GameConfig>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _L = Assert<Extends<z.infer<typeof TeamPlanSchema>, TeamPlan>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _LS = Assert<Extends<z.infer<typeof LabSetupSchema>, LabSetup>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SR = Assert<Extends<z.infer<typeof SimulateRequestSchema>, SimulateRequest>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _RM = Assert<Extends<z.infer<typeof ReplayMetaSchema>, ReplayMeta>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _RF = Assert<Extends<z.infer<typeof ReplayFrameSchema>, ReplayFrame>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _RP = Assert<Extends<z.infer<typeof ReplaySchema>, Replay>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _CO = Assert<Extends<z.infer<typeof ContributionSchema>, Contribution>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _PS = Assert<Extends<z.infer<typeof PossessionSummarySchema>, PossessionSummary>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SA = Assert<Extends<z.infer<typeof SimArtifactSchema>, SimArtifact>>;
