"use client";
/* ============================================================
   PossessionLab — interactive possession designer on a sandboxed
   game. Pick the offense, then build each team's plan by hand:
   the initiator, scoring options, the actions they run (pick and
   roll, iso, post up), and the defense's scheme. The players
   optimize for that plan on top of their attributes and
   tendencies. While staged you can still drag players anywhere
   and draw the routes they run. Run plays the possession and
   freezes when it ends; nothing outside the sandbox is touched.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PlanEditor } from "@/components/PlanEditor";
import type { InboundLoc, SimulateRequest, TeamPlan } from "@repo/shared";
import type { BoxTeam, CourtPlanEdit, LabPhase, PossessionOpts } from "@/hooks/useGame";

const NONE = "none";
const BLANK_PLAN: TeamPlan = {
  handlerSlot: null,
  scorerSlots: [],
  actions: [],
  directives: [],
  defScheme: null,
  pace: null,
  inbound: null,
  inbounderSlot: null,
};

interface PossessionLabProps {
  teams: BoxTeam[];
  labPhase: LabPhase;
  onStage: (opts: PossessionOpts) => void;
  /** apply edited plans onto the staged formation in place (players stay
      put). Returns false when nothing is staged, in which case the editor
      falls back to a clean re-stage. */
  onUpdatePlans?: (opts: {
    offense: number;
    plan: TeamPlan | null;
    defPlan: TeamPlan | null;
  }) => boolean;
  /** register how court gestures (screen/post/iso, glyph delete) edit the
      plan owned here; called with null-safe replacement on remount. */
  registerCourtEdit?: (fn: ((edit: CourtPlanEdit) => void) | null) => void;
  /** plan-action index the court pointer is over (glows the sidebar row) */
  hoveredAction?: number | null;
  /** sidebar row hover → glow the matching arrows on the court */
  onHighlightAction?: (i: number | null) => void;
  /** fired the first time the user touches the config, so the caller can set
      the matchup's previous plays aside and reveal the court to re-simulate. */
  onEdit?: () => void;
  /** a shared play to preload: seeds the offense + plans and restores the
      authored formation onto the first stage. */
  initialPlay?: SimulateRequest;
}

const lastName = (n: string) => n.split(" ").slice(-1)[0];

export function PossessionLab({
  teams,
  labPhase,
  onStage,
  onUpdatePlans,
  registerCourtEdit,
  hoveredAction,
  onHighlightAction,
  onEdit,
  initialPlay,
}: PossessionLabProps) {
  const [offense, setOffense] = useState(initialPlay?.offense ?? 0);
  // start from an inbound (default) or live, already holding the ball. Flipping
  // this re-stages the formation (the two starts place the ball differently).
  const [live, setLive] = useState(initialPlay?.setup?.live ?? false);
  // inbound spot + inbounder — where the possession starts when it's inbounded.
  // Owned here (above the plan editors) and merged onto the offense plan at stage
  // time, so switching offense or editing the plan never clobbers them.
  const [inbound, setInbound] = useState<InboundLoc | null>(initialPlay?.plan?.inbound ?? null);
  const [inbounderSlot, setInbounderSlot] = useState<number | null>(
    initialPlay?.plan?.inbounderSlot ?? null
  );
  // the hand-built plans currently staged on the court
  const [plans, setPlans] = useState<{ plan: TeamPlan | null; defPlan: TeamPlan | null }>({
    plan: initialPlay?.plan ?? null,
    defPlan: initialPlay?.defPlan ?? null,
  });
  // bumped whenever the offense flips so the editors re-seed from staged plans
  const [buildSeed, setBuildSeed] = useState(0);
  // which side's plan editor is showing — controlled so Clear knows which to wipe
  const [planTab, setPlanTab] = useState("offense");
  // a preloaded formation is applied to the FIRST stage only; any later edit
  // (offense/plan change) restages clean. Consumed once, then dropped.
  const pendingSetup = useRef(initialPlay?.setup ?? null);

  // fold the inbound spot / inbounder onto the offense plan (they don't apply
  // when starting live, so they're dropped in that case).
  const foldInbound = (plan: TeamPlan | null): TeamPlan | null =>
    !live && (inbound !== null || inbounderSlot !== null)
      ? { ...(plan ?? BLANK_PLAN), inbound, inbounderSlot }
      : plan;

  // Formation-shaping config (offense side, start mode, inbound spot/thrower)
  // re-stages a clean formation. Reads the latest plans through a ref so plan
  // edits don't retrigger it.
  const plansRef = useRef(plans);
  plansRef.current = plans;
  const foldRef = useRef(foldInbound);
  foldRef.current = foldInbound;
  useEffect(() => {
    const { plan, defPlan } = plansRef.current;
    onStage({
      offense,
      plan: foldRef.current(plan),
      defPlan,
      live,
      setup: pendingSetup.current,
    });
    pendingSetup.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offense, live, inbound, inbounderSlot, onStage]);

  // Court gestures (screen/post/iso drags, glyph deletes) edit the same plan
  // the sidebar owns; bumping the seed remounts the editors so the Actions
  // list mirrors what was just drawn.
  useEffect(() => {
    if (!registerCourtEdit) return;
    registerCourtEdit((edit) => {
      onEdit?.();
      setPlans((p) => {
        const base = p.plan ?? BLANK_PLAN;
        let actions = base.actions;
        if (edit.kind === "add") {
          if (actions.length >= 3) return p;
          actions = [...actions, edit.action];
        } else {
          actions = actions.filter((_, i) => i !== edit.index);
        }
        return { ...p, plan: { ...base, actions } };
      });
      setBuildSeed((s) => s + 1);
    });
    return () => registerCourtEdit(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerCourtEdit]);

  // Plan edits (actions, emphasis, scorers, …) apply onto the staged formation
  // in place — nobody moves. Falls back to a re-stage when nothing is staged
  // (e.g. editing again after a run).
  const seededPlans = useRef(true);
  useEffect(() => {
    if (seededPlans.current) {
      seededPlans.current = false;
      return;
    }
    const plan = foldRef.current(plans.plan);
    if (!onUpdatePlans?.({ offense, plan, defPlan: plans.defPlan })) {
      onStage({ offense, plan, defPlan: plans.defPlan, live, setup: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans]);

  if (teams.length < 2) return null;
  const configurable = labPhase !== "running";
  const offTeam = teams[offense];
  const defTeam = teams[1 - offense];
  const offNames = offTeam.players.map((bp) => lastName(bp.name));
  const defNames = defTeam.players.map((bp) => lastName(bp.name));

  // Wipe the plan for the side currently being edited, then re-seed the editors
  // (bumping the key remounts them onto the fresh, now-blank plan).
  const clearPlan = () => {
    onEdit?.();
    setPlans((p) => (planTab === "defense" ? { ...p, defPlan: null } : { ...p, plan: null }));
    setBuildSeed((s) => s + 1);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label>Offense</Label>
        <div className="flex gap-1.5">
          {teams.map((t, ti) => (
            <Button
              key={ti}
              size="sm"
              variant={offense === ti ? "secondary" : "outline"}
              disabled={!configurable}
              onClick={() => {
                onEdit?.();
                setOffense(ti);
                // plans + inbounder reference roster slots of a specific side
                setPlans({ plan: null, defPlan: null });
                setInbounderSlot(null);
                setBuildSeed((s) => s + 1); // re-seed hand editors for the new side
              }}
            >
              <span className="mr-1.5 size-2.5 rounded-full" style={{ background: t.color }} />
              {lastName(t.name)}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Possession start</Label>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant={!live ? "secondary" : "outline"}
            disabled={!configurable}
            onClick={() => {
              onEdit?.();
              setLive(false);
            }}
          >
            Inbound
          </Button>
          <Button
            size="sm"
            variant={live ? "secondary" : "outline"}
            disabled={!configurable}
            onClick={() => {
              onEdit?.();
              setLive(true);
            }}
          >
            Live ball
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {live
            ? "The offense starts with the ball in the frontcourt, shot clock running."
            : "The possession starts from an inbound."}
        </p>
      </div>

      {/* Inbound spot + inbounder — only when starting from an inbound. Kept above
          the plan editors so it reads as part of how the possession begins. */}
      {!live && (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Inbound from</Label>
            <Select
              value={inbound ?? NONE}
              onValueChange={(v) => {
                onEdit?.();
                setInbound(v === NONE ? null : (v as InboundLoc));
              }}
            >
              <SelectTrigger className="h-8" disabled={!configurable}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Default</SelectItem>
                <SelectItem value="full">Full court</SelectItem>
                <SelectItem value="side-top">Sideline (top)</SelectItem>
                <SelectItem value="side-bot">Sideline (bottom)</SelectItem>
                <SelectItem value="base-top">Baseline (top)</SelectItem>
                <SelectItem value="base-bot">Baseline (bottom)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Inbounder</Label>
            <Select
              value={inbounderSlot === null ? NONE : String(inbounderSlot)}
              onValueChange={(v) => {
                onEdit?.();
                setInbounderSlot(v === NONE ? null : Number(v));
              }}
            >
              <SelectTrigger className="h-8" disabled={!configurable}>
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Any</SelectItem>
                {offNames.map((n, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* forceMount keeps both editors alive so switching sides never drops an
          in-progress plan or re-stages the formation. */}
      <Tabs value={planTab} onValueChange={setPlanTab} className="flex flex-col gap-2">
        <TabsList className="grid grid-cols-2">
          <TabsTrigger value="offense">Offense</TabsTrigger>
          <TabsTrigger value="defense">Defense</TabsTrigger>
        </TabsList>
        <TabsContent value="offense" forceMount className="data-[state=inactive]:hidden">
          <p className="mb-2 text-xs text-muted-foreground">{offTeam.name}</p>
          <PlanEditor
            key={`off-${buildSeed}`}
            names={offNames}
            context="lab-offense"
            initialPlan={plans.plan}
            disabled={!configurable}
            hoveredAction={hoveredAction}
            onHoverAction={onHighlightAction}
            onApply={(plan) => {
              onEdit?.();
              setPlans((p) => ({ ...p, plan }));
            }}
          />
        </TabsContent>
        <TabsContent value="defense" forceMount className="data-[state=inactive]:hidden">
          <p className="mb-2 text-xs text-muted-foreground">{defTeam.name} — optional</p>
          <PlanEditor
            key={`def-${buildSeed}`}
            names={defNames}
            context="lab-defense"
            initialPlan={plans.defPlan}
            disabled={!configurable}
            onApply={(defPlan) => {
              onEdit?.();
              setPlans((p) => ({ ...p, defPlan }));
            }}
          />
        </TabsContent>
      </Tabs>

      {/* Clears the plan for whichever side is open in the editor above. */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={!configurable} onClick={clearPlan}>
          <X className="mr-1.5 size-3.5" /> Clear
        </Button>
      </div>
    </div>
  );
}
