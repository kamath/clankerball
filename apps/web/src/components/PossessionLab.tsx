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
import { useEffect, useState } from "react";
import { Eraser, MousePointer2, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PlanEditor } from "@/components/PlanEditor";
import type { TeamPlan } from "@repo/shared";
import type { BoxTeam, LabPhase, LabTool, PossessionOpts } from "@/hooks/useGame";

interface PossessionLabProps {
  teams: BoxTeam[];
  labPhase: LabPhase;
  labTool: LabTool;
  labRoles: (string | null)[];
  simulating: boolean;
  onStage: (opts: PossessionOpts) => void;
  onRun: () => void;
  onReRun: () => void;
  onToolChange: (t: LabTool) => void;
  onClearPaths: () => void;
}

const lastName = (n: string) => n.split(" ").slice(-1)[0];

export function PossessionLab({
  teams,
  labPhase,
  labTool,
  labRoles,
  simulating,
  onStage,
  onRun,
  onReRun,
  onToolChange,
  onClearPaths,
}: PossessionLabProps) {
  const [offense, setOffense] = useState(0);
  // the hand-built plans currently staged on the court
  const [plans, setPlans] = useState<{ plan: TeamPlan | null; defPlan: TeamPlan | null }>({
    plan: null,
    defPlan: null,
  });
  const [rev, setRev] = useState(0); // bump to re-stage with the same plans
  // bumped whenever the offense flips so the editors re-seed from staged plans
  const [buildSeed, setBuildSeed] = useState(0);

  // any change to the offense or the staged plans re-stages a clean
  // formation. once the play is running the config controls lock.
  useEffect(() => {
    onStage({ offense, plan: plans.plan, defPlan: plans.defPlan });
  }, [offense, plans, rev, onStage]);

  if (teams.length < 2) return null;
  const configurable = labPhase !== "running";
  const offTeam = teams[offense];
  const defTeam = teams[1 - offense];
  const offNames = offTeam.players.map((bp) => lastName(bp.name));
  const defNames = defTeam.players.map((bp) => lastName(bp.name));
  const handlerSlot = labRoles.findIndex((r) => r === "HANDLER");

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
              {t.name.split(" ")[0]}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Offense plan ({offTeam.name})</Label>
          <PlanEditor
            key={`off-${buildSeed}`}
            names={offNames}
            context="lab-offense"
            initialPlan={plans.plan}
            disabled={!configurable}
            onApply={(plan) => setPlans((p) => ({ ...p, plan }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Defense plan ({defTeam.name}) — optional</Label>
          <PlanEditor
            key={`def-${buildSeed}`}
            names={defNames}
            context="lab-defense"
            initialPlan={plans.defPlan}
            disabled={!configurable}
            onApply={(defPlan) => setPlans((p) => ({ ...p, defPlan }))}
          />
        </div>
      </div>

      {handlerSlot >= 0 && offTeam.players[handlerSlot] && (
        <p className="text-xs text-muted-foreground">
          Bringing it up:{" "}
          <span className="font-medium">
            #{offTeam.players[handlerSlot].number} {lastName(offTeam.players[handlerSlot].name)}
          </span>
        </p>
      )}

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

      <div className="flex gap-2">
        {labPhase === "ended" ? (
          <Button onClick={onReRun} disabled={simulating} className="flex-1">
            {simulating ? "Simulating…" : "Re-run play"}
          </Button>
        ) : (
          <Button
            onClick={onRun}
            disabled={labPhase !== "staged" || simulating}
            className="flex-1"
          >
            {simulating ? "Simulating…" : "Run play"}
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => setRev((r) => r + 1)}
          disabled={!configurable || simulating}
        >
          Reset formation
        </Button>
      </div>
    </div>
  );
}
