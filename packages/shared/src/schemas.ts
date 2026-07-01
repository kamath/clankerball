/* ============================================================
   schemas.ts — zod schemas for everything that crosses the wire
   between the Next.js client and the Hono API. These are the
   single source of truth for the API's input/output validation
   and its generated OpenAPI document. The hand-written domain
   interfaces in ./types and ./plan stay authoritative for the
   engine; the assertions at the bottom keep the two in lockstep.
   ============================================================ */
import { z } from "zod";
import type { GameConfig, PlayerConfig, TeamConfig, Tendencies } from "./types";
import type { TeamPlan } from "./plan";

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

/* ---------- scouting snapshot + plan compilation ---------- */

export const ScoutPlayerSchema = z.object({
  slot: z.number(),
  name: z.string(),
  number: z.number(),
  pos: z.string(),
  heightIn: z.number(),
  ratings: z.object({
    iq: z.number(),
    threePoint: z.number(),
    midRange: z.number(),
    layup: z.number(),
    dunk: z.number(),
    ballHandle: z.number(),
    passAcc: z.number(),
    speed: z.number(),
    strength: z.number(),
    perimeterD: z.number(),
    interiorD: z.number(),
    steal: z.number(),
    block: z.number(),
    rebound: z.number(),
  }),
  tendencies: TendenciesSchema,
});
export type ScoutPlayer = z.infer<typeof ScoutPlayerSchema>;

export const CompileRequestSchema = z.object({
  instructions: z.string(),
  teamName: z.string(),
  roster: z.array(ScoutPlayerSchema),
  opponentName: z.string(),
  opponentRoster: z.array(ScoutPlayerSchema),
  context: z.enum(["lab-offense", "lab-defense", "game"]),
});
export type CompileRequest = z.infer<typeof CompileRequestSchema>;

/* The compiled plan, mirroring the TeamPlan interface in ./plan. */
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

export const CompileResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), plan: TeamPlanSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type CompileResult = z.infer<typeof CompileResultSchema>;

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
