/* ============================================================
   compile.ts — turn free-text coaching instructions into a
   TeamPlan via the Vercel AI SDK + AI Gateway. Server-side only
   (needs AI_GATEWAY_API_KEY).
   ============================================================ */
import { generateObject } from "ai";
import { z } from "zod";
import {
  sanitizePlan,
  type CompileRequest,
  type CompileResult,
  type ScoutPlayer,
  type TeamPlan,
} from "@repo/shared";

const MODEL = process.env.AI_GATEWAY_MODEL || "minimax/minimax-m3";

export type { CompileRequest, CompileResult, ScoutPlayer };

/* The schema is deliberately lenient (nullish everywhere, defaults for
   arrays) — models routinely omit irrelevant keys, and sanitizePlan()
   normalizes whatever arrives into a strict TeamPlan. */
const slot = z.number().int().min(0).max(4);
const biasVal = z.number().min(-40).max(40).nullish();

const planSchema = z.object({
  summary: z.string().describe("One short sentence restating the plan in plain basketball language."),
  handlerSlot: slot.nullish().describe("Roster slot of the primary ball-handler / initiator, or null to let the best handler bring it up."),
  scorerSlots: z.array(slot).max(3).default([]).describe("Roster slots of the scoring options, highest priority first. Players the offense should look to feed."),
  actions: z
    .array(
      z.object({
        type: z.enum(["pickAndRoll", "getOpen", "iso", "postUp"]),
        handlerSlot: slot.nullish().describe("pickAndRoll only: who uses the screen."),
        screenerSlot: slot.nullish().describe("pickAndRoll/getOpen: who sets the screen."),
        targetSlot: slot.nullish().describe("getOpen/iso/postUp: who the action is for."),
        finish: z.enum(["roll", "pop"]).nullish().describe("pickAndRoll only: screener rolls to the rim or pops to the three-point line."),
      })
    )
    .max(2)
    .default([])
    .describe("On-court actions the offense keeps hunting. Usually 0 or 1; never more than 2."),
  directives: z
    .array(
      z.object({
        slot,
        note: z.string().nullish().describe("Tiny court label for this emphasis, max 10 chars, e.g. 'HUNT 3s', 'CRASH'."),
        tendencyBias: z
          .object({
            shoot: biasVal,
            three: biasVal,
            drive: biasVal,
            pass: biasVal,
            kickout: biasVal,
            help: biasVal,
            crash: biasVal,
            gamble: biasVal,
          })
          .nullish()
          .describe("Deltas added to the player's base tendencies (each 1-99, default ~50). Use moderate values (±10-30). Omit unchanged tendencies."),
      })
    )
    .max(5)
    .default([])
    .describe("Per-player coaching emphasis. Only for players the instructions actually single out."),
  defScheme: z.enum(["man", "switch", "zone"]).nullish().describe("This team's defensive scheme, ONLY if the instructions say how to defend. zone = 2-3 zone."),
  pace: z.enum(["fast", "normal", "slow"]).nullish().describe("Only if the instructions address tempo."),
  inbound: z.enum(["full", "side-top", "side-bot", "base-top", "base-bot"]).nullish().describe("Lab possessions only: where to inbound from. full = bring it up the whole floor, side-* = frontcourt sideline, base-* = under the offensive basket."),
  inbounderSlot: slot.nullish().describe("Lab possessions only: who throws the inbound pass, if specified."),
});

function rosterTable(roster: ScoutPlayer[]): string {
  const head =
    "slot | name (#, pos, height) | 3pt mid lay dnk | hndl pass iq | spd str | perD intD stl blk reb | tend: shoot/three/drive/pass/kick/help/crash/gamble";
  const rows = roster.map((p) => {
    const r = p.ratings;
    const t = p.tendencies;
    const h = `${Math.floor(p.heightIn / 12)}'${p.heightIn % 12}"`;
    return `${p.slot} | ${p.name} (#${p.number}, ${p.pos}, ${h}) | ${r.threePoint} ${r.midRange} ${r.layup} ${r.dunk} | ${r.ballHandle} ${r.passAcc} ${r.iq} | ${r.speed} ${r.strength} | ${r.perimeterD} ${r.interiorD} ${r.steal} ${r.block} ${r.rebound} | ${t.shoot}/${t.three}/${t.drive}/${t.pass}/${t.kickout}/${t.help}/${t.crash}/${t.gamble}`;
  });
  return [head, ...rows].join("\n");
}

const CONTEXT_NOTES: Record<CompileRequest["context"], string> = {
  "lab-offense":
    "These instructions are for the team ON OFFENSE in a single scripted practice possession. inbound/inbounderSlot apply if mentioned.",
  "lab-defense":
    "These instructions are for the team DEFENDING a single scripted practice possession. Focus on defScheme and defensive tendency biases (help, gamble, crash); leave offensive fields (handlerSlot, scorerSlots, actions, inbound) null/empty unless the instructions clearly cover them.",
  game: "These are standing instructions for a team in a live simulated game, covering both ends of the floor. Leave inbound and inbounderSlot null.",
};

const SYSTEM = `You compile a basketball coach's free-text instructions into a machine-readable game plan for a 5-on-5 basketball simulation.

How the simulation uses the plan:
- handlerSlot brings the ball up and initiates; scorerSlots are fed the ball in priority order and hunt their shot.
- actions run continuously: "pickAndRoll" = screener sets ball screens for the handler then rolls/pops; "getOpen" = a teammate sets off-ball screens to free the target (also list the target as the top scorer); "iso" = clear one side for the target; "postUp" = the target seals on the block and gets entry feeds.
- directives nudge individual behaviour via tendencyBias deltas on base tendencies (1-99 scale): shoot (shot hunting), three (prefer 3s), drive (attack rim), pass (willingness), kickout (drive-and-kick), help (defensive help), crash (offensive boards), gamble (steals/lane jumping).
- defScheme/pace only when the coach addresses defense or tempo.

Rules:
- Map player names/nicknames (e.g. "Steph", "Jokic", "SGA") to roster SLOT NUMBERS of the correct team. Never invent slots.
- Be faithful and minimal: encode what was asked, don't pad the plan with extra actions or directives. Vague instructions ("get Steph open") still get a sensible mechanical encoding (getOpen action + top scorer + a screener who fits).
- Choose screeners/roles that fit ratings when the coach doesn't specify (screeners: big/strong; handlers: high ballHandle).
- For getOpen, the target should NOT also be handlerSlot — someone else initiates and feeds him coming off the screens.
- If instructions conflict with a player's skill set, follow the instructions anyway — the coach is the boss.`;

export async function compileTeamPlan(req: CompileRequest): Promise<CompileResult> {
  if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
    return { ok: false, error: "AI_GATEWAY_API_KEY is not set — add it to .env to compile instructions." };
  }
  const prompt = `${CONTEXT_NOTES[req.context]}

TEAM (the one these instructions are for): ${req.teamName}
${rosterTable(req.roster)}

OPPONENT: ${req.opponentName}
${rosterTable(req.opponentRoster)}

COACH'S INSTRUCTIONS:
${req.instructions.trim()}`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { object } = await generateObject({
        model: MODEL,
        schema: planSchema,
        system: SYSTEM,
        prompt,
      });
      return { ok: true, plan: sanitizePlan(object as unknown as TeamPlan) };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: `Couldn't compile the plan: ${lastErr.slice(0, 300)}` };
}
