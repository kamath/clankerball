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
import { Eraser, MousePointer2, PenLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlanEditor } from "@/components/PlanEditor";
import type { SimulateRequest, TeamPlan } from "@repo/shared";
import type { BoxTeam, LabPhase, LabTool, PossessionOpts } from "@/hooks/useGame";

interface PossessionLabProps {
  teams: BoxTeam[];
  labPhase: LabPhase;
  labTool: LabTool;
  onStage: (opts: PossessionOpts) => void;
  onToolChange: (t: LabTool) => void;
  onClearPaths: () => void;
  /** a shared play to preload: seeds the offense + plans and restores the
      authored formation onto the first stage. */
  initialPlay?: SimulateRequest;
}

const lastName = (n: string) => n.split(" ").slice(-1)[0];

export function PossessionLab({
  teams,
  labPhase,
  labTool,
  onStage,
  onToolChange,
  onClearPaths,
  initialPlay,
}: PossessionLabProps) {
  const [offense, setOffense] = useState(initialPlay?.offense ?? 0);
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

  // any change to the offense or the staged plans re-stages a clean
  // formation. once the play is running the config controls lock.
  useEffect(() => {
    onStage({ offense, plan: plans.plan, defPlan: plans.defPlan, setup: pendingSetup.current });
    pendingSetup.current = null;
  }, [offense, plans, onStage]);

  if (teams.length < 2) return null;
  const configurable = labPhase !== "running";
  const offTeam = teams[offense];
  const defTeam = teams[1 - offense];
  const offNames = offTeam.players.map((bp) => lastName(bp.name));
  const defNames = defTeam.players.map((bp) => lastName(bp.name));

  // Wipe the plan for the side currently being edited, then re-seed the editors
  // (bumping the key remounts them onto the fresh, now-blank plan).
  const clearPlan = () => {
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
                setOffense(ti);
                // plans reference roster slots of a specific side
                setPlans({ plan: null, defPlan: null });
                setBuildSeed((s) => s + 1); // re-seed hand editors for the new side
              }}
            >
              <span className="mr-1.5 size-2.5 rounded-full" style={{ background: t.color }} />
              {lastName(t.name)}
            </Button>
          ))}
        </div>
      </div>

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
            onApply={(plan) => setPlans((p) => ({ ...p, plan }))}
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
            onApply={(defPlan) => setPlans((p) => ({ ...p, defPlan }))}
          />
        </TabsContent>
      </Tabs>

      <div className="flex flex-col gap-1.5">
        <Label>Court tools</Label>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant={labTool === "move" ? "secondary" : "outline"}
            onClick={() => onToolChange("move")}
            disabled={labPhase !== "staged"}
          >
            <MousePointer2 className="mr-1.5 size-3.5" /> Move
          </Button>
          <Button
            size="sm"
            variant={labTool === "path" ? "secondary" : "outline"}
            onClick={() => onToolChange("path")}
            disabled={labPhase !== "staged"}
          >
            <PenLine className="mr-1.5 size-3.5" /> Draw path
          </Button>
          <Button size="sm" variant="outline" onClick={onClearPaths} disabled={labPhase !== "staged"}>
            <Eraser className="mr-1.5 size-3.5" /> Clear paths
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {labPhase === "staged"
            ? labTool === "move"
              ? "Drag any player to set his starting spot."
              : "Drag from an offensive player to draw the route he'll run."
            : labPhase === "running"
              ? "Play in progress — watch the court."
              : labPhase === "ended"
                ? "Possession over — re-run it, or tweak the plan to restage."
                : "Build both teams' plans, then run the play."}
        </p>
      </div>

      {/* Clears the plan for whichever side is open in the editor above. */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={!configurable} onClick={clearPlan}>
          <X className="mr-1.5 size-3.5" /> Clear
        </Button>
      </div>
    </div>
  );
}
