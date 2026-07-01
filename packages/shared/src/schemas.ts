/* ============================================================
   schemas.ts — zod schemas for everything that crosses the wire
   between the Next.js client and the Hono API. These are the
   single source of truth for the API's input/output validation
   and its generated OpenAPI document. The hand-written domain
   interfaces in ./types and ./plan stay authoritative for the
   engine; the assertions at the bottom keep the two in lockstep.
   ============================================================ */
import { z } from "zod";
import type { GameConfig, PlayerConfig, TeamConfig, Tendencies, Vec } from "./types";
import type { TeamPlan } from "./plan";
import type { LabSetup } from "./engine";
import type { Replay, ReplayFrame, ReplayMeta, SimulateRequest } from "./replay";

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
  summary: z.string(),
  handlerSlot: slot.nullable(),
  scorerSlots: z.array(slot),
  actions: z.array(PlanActionSchema),
  directives: z.array(PlayerDirectiveSchema),
  defScheme: z.enum(["man", "switch", "zone"]).nullable(),
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
  type: z.enum([
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
    "info",
  ]),
  text: z.string(),
  team: z.number().nullable(),
  qLabel: z.string(),
  clock: z.string(),
});

export const ReplaySchema = z.object({
  meta: ReplayMetaSchema,
  frames: z.array(ReplayFrameSchema),
  events: z.array(SimEventSchema),
});

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
