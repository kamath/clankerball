/* ============================================================
   plan.ts — the compiled game plan. Free-text coaching
   instructions ("pick and roll, Jokic screener, Curry handler",
   "get Steph open") are compiled by an LLM into this structure,
   which the engine optimizes for while the players run their
   normal attribute/tendency-driven game.
   ============================================================ */
import type { DefScheme, InboundLoc, Tendencies } from "./types";

export type PlanActionType = "pickAndRoll" | "getOpen" | "iso" | "postUp";

/** One on-court action the offense keeps hunting for. Slots are roster
    indices 0-4. Fields irrelevant to the action type are null. */
export interface PlanAction {
  type: PlanActionType;
  /** pickAndRoll: who uses the screen */
  handlerSlot: number | null;
  /** pickAndRoll/getOpen: who sets the screen */
  screenerSlot: number | null;
  /** getOpen/iso/postUp: who the action is for */
  targetSlot: number | null;
  /** pickAndRoll: screener rolls to the rim or pops to the arc */
  finish: "roll" | "pop" | null;
}

/** Per-player coaching emphasis, layered on top of base tendencies. */
export interface PlayerDirective {
  slot: number;
  /** short court label, e.g. "HUNT 3s" (≤10 chars) */
  note: string | null;
  /** deltas (-40..40) applied to the player's base tendencies */
  tendencyBias: Partial<Tendencies> | null;
}

export interface TeamPlan {
  /** one-line readable restatement of the plan */
  summary: string;
  /** who initiates the offense; null = best ball-handler */
  handlerSlot: number | null;
  /** scoring options in priority order (max 3) */
  scorerSlots: number[];
  actions: PlanAction[];
  directives: PlayerDirective[];
  /** how THIS team defends when the other team has the ball */
  defScheme: DefScheme | null;
  pace: "fast" | "normal" | "slow" | null;
  /** lab only: where the scripted possession inbounds from */
  inbound: InboundLoc | null;
  /** lab only: who throws it in */
  inbounderSlot: number | null;
}

const TEND_KEYS: (keyof Tendencies)[] = [
  "shoot", "three", "drive", "pass", "kickout", "help", "crash", "gamble",
];

const okSlot = (s: unknown): s is number =>
  typeof s === "number" && Number.isInteger(s) && s >= 0 && s <= 4;

/** Defensive cleanup of a model-produced plan: drop out-of-range slots,
    dedupe scorers, clamp biases, discard self-screens. */
export function sanitizePlan(raw: TeamPlan): TeamPlan {
  const scorerSlots = [...new Set(raw.scorerSlots ?? [])].filter(okSlot).slice(0, 3);
  const actions = (raw.actions ?? [])
    .map((a): PlanAction => ({
      type: a.type,
      handlerSlot: okSlot(a.handlerSlot) ? a.handlerSlot : null,
      screenerSlot: okSlot(a.screenerSlot) ? a.screenerSlot : null,
      targetSlot: okSlot(a.targetSlot) ? a.targetSlot : null,
      finish: a.finish === "pop" ? "pop" : a.finish === "roll" ? "roll" : null,
    }))
    .filter((a) => {
      if (a.type === "pickAndRoll")
        return a.handlerSlot === null || a.handlerSlot !== a.screenerSlot;
      if (a.type === "getOpen") return a.targetSlot !== null && a.targetSlot !== a.screenerSlot;
      return a.targetSlot !== null; // iso / postUp need a man
    })
    .slice(0, 3);
  const directives = (raw.directives ?? [])
    .filter((d) => okSlot(d.slot))
    .slice(0, 5)
    .map((d) => {
      let bias: Partial<Tendencies> | null = null;
      if (d.tendencyBias) {
        bias = {};
        for (const k of TEND_KEYS) {
          const v = d.tendencyBias[k];
          if (typeof v === "number" && v !== 0)
            bias[k] = Math.max(-40, Math.min(40, Math.round(v)));
        }
        if (!Object.keys(bias).length) bias = null;
      }
      return {
        slot: d.slot,
        note: d.note ? String(d.note).slice(0, 12).toUpperCase() : null,
        tendencyBias: bias,
      };
    });
  return {
    summary: raw.summary || "Custom game plan",
    handlerSlot: okSlot(raw.handlerSlot) ? raw.handlerSlot : null,
    scorerSlots,
    actions,
    directives,
    defScheme: raw.defScheme ?? null,
    pace: raw.pace ?? null,
    inbound: raw.inbound ?? null,
    inbounderSlot: okSlot(raw.inbounderSlot) ? raw.inbounderSlot : null,
  };
}

/** Human-readable lines describing a plan, for the UI summary card. */
export function describePlan(plan: TeamPlan, names: string[]): string[] {
  const nm = (s: number | null) => (s !== null && names[s] ? names[s] : "?");
  const lines: string[] = [];
  if (plan.handlerSlot !== null) lines.push(`${nm(plan.handlerSlot)} initiates`);
  if (plan.scorerSlots.length)
    lines.push(`Options: ${plan.scorerSlots.map(nm).join(" → ")}`);
  for (const a of plan.actions) {
    if (a.type === "pickAndRoll")
      lines.push(
        `Pick & roll: ${nm(a.screenerSlot)} screens for ${nm(a.handlerSlot)}` +
          (a.finish ? ` and ${a.finish}s` : "")
      );
    else if (a.type === "getOpen")
      lines.push(
        `Get ${nm(a.targetSlot)} open` +
          (a.screenerSlot !== null ? ` off ${nm(a.screenerSlot)}'s screens` : "")
      );
    else if (a.type === "iso") lines.push(`Iso for ${nm(a.targetSlot)} — clear out`);
    else if (a.type === "postUp") lines.push(`Post up ${nm(a.targetSlot)} on the block`);
  }
  for (const d of plan.directives) {
    const parts: string[] = [];
    if (d.note) parts.push(d.note.toLowerCase());
    if (d.tendencyBias)
      parts.push(
        Object.entries(d.tendencyBias)
          .map(([k, v]) => `${k} ${(v as number) > 0 ? "+" : ""}${v}`)
          .join(", ")
      );
    if (parts.length) lines.push(`${nm(d.slot)}: ${parts.join(" · ")}`);
  }
  if (plan.defScheme)
    lines.push(
      `Defense: ${plan.defScheme === "man" ? "man-to-man" : plan.defScheme === "switch" ? "switch everything" : "2-3 zone"}`
    );
  if (plan.pace && plan.pace !== "normal") lines.push(`Pace: ${plan.pace}`);
  return lines;
}
