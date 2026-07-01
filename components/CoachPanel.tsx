"use client";
/* ============================================================
   CoachPanel — standing coaching instructions for the live game.
   Each team gets a free-text box ("run everything through LeBron",
   "switch every screen, crash the glass"); instructions compile
   into a plan the engine optimizes for on every possession, on
   top of the players' attributes and tendencies. Plans persist
   across possessions and carry into new games until cleared.
   ============================================================ */
import { useState } from "react";
import { Loader2, Wand2, X } from "lucide-react";
import { compilePlan } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PlanSummary } from "@/components/PlanSummary";
import { scoutRoster } from "@/lib/roster-scout";
import type { TeamPlan } from "@/lib/plan";
import type { BoxTeam } from "@/hooks/useGame";

interface CoachPanelProps {
  teams: BoxTeam[];
  plans: (TeamPlan | null)[];
  onApply: (teamIdx: number, plan: TeamPlan | null) => void;
}

const lastName = (n: string) => n.split(" ").slice(-1)[0];

function TeamCoach({
  team,
  opponent,
  plan,
  onApply,
}: {
  team: BoxTeam;
  opponent: BoxTeam;
  plan: TeamPlan | null;
  onApply: (plan: TeamPlan | null) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = team.players.map((bp) => lastName(bp.name));

  const apply = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await compilePlan({
        instructions: text,
        teamName: team.name,
        roster: scoutRoster(team.players.map((bp) => bp.player)),
        opponentName: opponent.name,
        opponentRoster: scoutRoster(opponent.players.map((bp) => bp.player)),
        context: "game",
      });
      if (res.ok) onApply(res.plan);
      else setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Compilation failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <span className="size-2.5 rounded-full" style={{ background: team.color }} />
        <Label className="font-semibold">{team.name}</Label>
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder={`e.g. "run everything through ${names[0] ?? "your star"}", "switch every screen, push the pace"`}
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={apply} disabled={busy || !text.trim()} className="flex-1">
          {busy ? (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <Wand2 className="mr-1.5 size-3.5" />
          )}
          {busy ? "Compiling…" : "Apply instructions"}
        </Button>
        {plan && (
          <Button size="sm" variant="outline" onClick={() => onApply(null)}>
            <X className="mr-1.5 size-3.5" /> Clear
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {plan && <PlanSummary title="Active plan" plan={plan} names={names} />}
    </div>
  );
}

export function CoachPanel({ teams, plans, onApply }: CoachPanelProps) {
  if (teams.length < 2) return null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Standing instructions each team plays to, every possession — layered on top of player
        attributes and tendencies. They stay on until cleared, including across new games.
      </p>
      {teams.map((t, ti) => (
        <TeamCoach
          key={ti}
          team={t}
          opponent={teams[1 - ti]}
          plan={plans[ti] ?? null}
          onApply={(p) => onApply(ti, p)}
        />
      ))}
    </div>
  );
}
