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

/** One pinned defensive assignment: this team's defender (by roster slot)
    guards that opposing roster slot. Unlisted defenders are auto-matched. */
export interface MatchupPair {
  defenderSlot: number;
  targetSlot: number;
}

/** A coached double-team: when the opposing `targetSlot` holds the ball in
    the frontcourt, `doublerSlot` leaves his man to trap (null = whichever
    helper is nearest). */
export interface DoubleTeam {
  doublerSlot: number | null;
  targetSlot: number;
}

export interface TeamPlan {
  /** who initiates the offense; null = best ball-handler */
  handlerSlot: number | null;
  /** scoring options in priority order (max 3) */
  scorerSlots: number[];
  actions: PlanAction[];
  directives: PlayerDirective[];
  /** how THIS team defends when the other team has the ball */
  defScheme: DefScheme | null;
  /** pinned man-to-man assignments (who guards who); null/[] = auto */
  matchups: MatchupPair[] | null;
  /** send a double at a chosen opponent when he has the ball */
  double: DoubleTeam | null;
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
  // matchups: valid slots only, one assignment per defender and per target
  // (first entry wins), so the engine always applies a clean permutation
  const seenDef = new Set<number>();
  const seenTgt = new Set<number>();
  const matchups = (raw.matchups ?? []).filter((m) => {
    if (!okSlot(m.defenderSlot) || !okSlot(m.targetSlot)) return false;
    if (seenDef.has(m.defenderSlot) || seenTgt.has(m.targetSlot)) return false;
    seenDef.add(m.defenderSlot);
    seenTgt.add(m.targetSlot);
    return true;
  });
  const double =
    raw.double && okSlot(raw.double.targetSlot)
      ? {
          doublerSlot: okSlot(raw.double.doublerSlot) ? raw.double.doublerSlot : null,
          targetSlot: raw.double.targetSlot,
        }
      : null;
  return {
    handlerSlot: okSlot(raw.handlerSlot) ? raw.handlerSlot : null,
    scorerSlots,
    actions,
    directives,
    defScheme: raw.defScheme ?? null,
    matchups: matchups.length ? matchups : null,
    double,
    pace: raw.pace ?? null,
    inbound: raw.inbound ?? null,
    inbounderSlot: okSlot(raw.inbounderSlot) ? raw.inbounderSlot : null,
  };
}
