"use client";
/* ============================================================
   PossessionLab — interactive possession designer on a sandboxed
   game. Pick the offense, then coach both teams in plain language:
   "pick and roll — Jokic screener, Curry ball handler", "get Steph
   open", "2-3 zone, gamble for steals". The instructions are
   compiled (AI Gateway) into a plan the players optimize for, on
   top of their attributes and tendencies. While staged you can
   still drag players anywhere and draw the routes they run. Run
   plays the possession and freezes when it ends; the real game is
   paused and untouched the whole time.
   ============================================================ */
import { useEffect, useState } from "react";
import { Eraser, Loader2, MousePointer2, PenLine, Wand2 } from "lucide-react";
import { useCompilePlan } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlanSummary } from "@/components/PlanSummary";
import { PlanEditor } from "@/components/PlanEditor";
import { scoutRoster, type TeamPlan } from "@repo/shared";
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
  const [offText, setOffText] = useState("");
  const [defText, setDefText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const compilePlan = useCompilePlan();
  const busy = compilePlan.isPending;
  // the compiled plans currently staged on the court
  const [plans, setPlans] = useState<{ plan: TeamPlan | null; defPlan: TeamPlan | null }>({
    plan: null,
    defPlan: null,
  });
  const [rev, setRev] = useState(0); // bump to re-stage with the same plans
  const [coachMode, setCoachMode] = useState("ai");
  // bumped whenever we (re-)enter Build so the editors re-seed from staged plans
  const [buildSeed, setBuildSeed] = useState(0);

  // any change to the offense or the compiled plans re-stages a clean
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
  const canCompile = offText.trim().length > 0 || defText.trim().length > 0;

  const compile = async () => {
    if (busy || !canCompile) return;
    setError(null);
    try {
      const offRoster = scoutRoster(offTeam.players.map((bp) => bp.player));
      const defRoster = scoutRoster(defTeam.players.map((bp) => bp.player));
      const [off, def] = await Promise.all([
        offText.trim()
          ? compilePlan.mutateAsync({
              instructions: offText,
              teamName: offTeam.name,
              roster: offRoster,
              opponentName: defTeam.name,
              opponentRoster: defRoster,
              context: "lab-offense",
            })
          : Promise.resolve(null),
        defText.trim()
          ? compilePlan.mutateAsync({
              instructions: defText,
              teamName: defTeam.name,
              roster: defRoster,
              opponentName: offTeam.name,
              opponentRoster: offRoster,
              context: "lab-defense",
            })
          : Promise.resolve(null),
      ]);
      const failed = [off, def].find((r) => r && !r.ok);
      if (failed && !failed.ok) setError(failed.error);
      setPlans({
        plan: off?.ok ? off.plan : null,
        defPlan: def?.ok ? def.plan : null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Compilation failed.");
    }
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
                // compiled plans reference roster slots of a specific side
                setPlans({ plan: null, defPlan: null });
                setBuildSeed((s) => s + 1); // re-seed hand editors for the new side
                setError(null);
              }}
            >
              <span className="mr-1.5 size-2.5 rounded-full" style={{ background: t.color }} />
              {t.name.split(" ")[0]}
            </Button>
          ))}
        </div>
      </div>

      <Tabs
        value={coachMode}
        onValueChange={(v) => {
          if (v === "build") setBuildSeed((s) => s + 1); // re-seed from staged plans
          setCoachMode(v);
        }}
      >
        <TabsList className="grid grid-cols-2">
          <TabsTrigger value="ai" disabled={!configurable}>AI compile</TabsTrigger>
          <TabsTrigger value="build" disabled={!configurable}>Build by hand</TabsTrigger>
        </TabsList>

        <TabsContent value="ai" className="mt-2 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Offense instructions ({offTeam.name})</Label>
            <Textarea
              value={offText}
              onChange={(e) => setOffText(e.target.value)}
              disabled={!configurable}
              rows={3}
              placeholder={`e.g. "pick and roll — ${offNames[4] ?? "the center"} screener, ${offNames[0] ?? "the point guard"} ball handler", "get ${offNames[0] ?? "your star"} open", "post up ${offNames[4] ?? "the big"}, everyone else space the floor"`}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Defense instructions ({defTeam.name}) — optional</Label>
            <Textarea
              value={defText}
              onChange={(e) => setDefText(e.target.value)}
              disabled={!configurable}
              rows={2}
              placeholder={`e.g. "switch everything", "2-3 zone, ${defNames[4] ?? "the center"} protect the rim", "deny ${offNames[0] ?? "their star"} the ball, gamble for steals"`}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={compile} disabled={!configurable || busy || !canCompile} className="flex-1">
              {busy ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <Wand2 className="mr-1.5 size-3.5" />
              )}
              {busy ? "Compiling…" : "Compile & stage"}
            </Button>
            {(plans.plan || plans.defPlan) && (
              <Button
                variant="outline"
                disabled={!configurable || busy}
                onClick={() => {
                  setPlans({ plan: null, defPlan: null });
                  setError(null);
                }}
              >
                Clear plan
              </Button>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}

          {plans.plan && (
            <PlanSummary title={`${offTeam.name} — offense`} plan={plans.plan} names={offNames} />
          )}
          {plans.defPlan && (
            <PlanSummary title={`${defTeam.name} — defense`} plan={plans.defPlan} names={defNames} />
          )}
        </TabsContent>

        <TabsContent value="build" className="mt-2 flex flex-col gap-4">
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
        </TabsContent>
      </Tabs>
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
                ? "Possession over — re-run it, or tweak the instructions to restage."
                : "Coach both teams, then run the play."}
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
