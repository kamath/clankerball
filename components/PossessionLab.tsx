"use client";
/* ============================================================
   PossessionLab — interactive play designer on a sandboxed game.
   Picking a play / defense / start instantly stages the players
   into their formation on the court. While staged you can drag
   players, draw motion paths, and hand out roles; Run plays the
   possession and freezes when it ends. The real game is paused
   and untouched the whole time.
   ============================================================ */
import { useEffect, useState } from "react";
import { MousePointer2, PenLine, Eraser } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { BoxTeam, LabPhase, LabTool, PossessionOpts, Snapshot } from "@/hooks/useGame";
import type { DefScheme, InboundLoc, PlayCall, PlayerAssignment, SimEvent } from "@/lib/types";

const PLAYS: { value: PlayCall; label: string; blurb: string }[] = [
  { value: "motion", label: "Motion", blurb: "free-flowing offense, everyone hunts a spot" },
  { value: "iso", label: "Isolation", blurb: "clear out and let the go-to guy work" },
  { value: "pnr", label: "Pick & roll", blurb: "screen for the handler, roll to the rim" },
  { value: "dho", label: "Dribble hand-off", blurb: "dribble at the receiver, hand it off, attack" },
  { value: "post", label: "Post-up", blurb: "feed the big on the block" },
];

const SCHEMES: { value: DefScheme; label: string; blurb: string }[] = [
  { value: "man", label: "Man-to-man", blurb: "stick with your matchup" },
  { value: "switch", label: "Switch everything", blurb: "trade assignments on every screen" },
  { value: "zone", label: "2-3 Zone", blurb: "guard your area, pack the paint" },
];

const INBOUNDS: { value: InboundLoc; label: string }[] = [
  { value: "full", label: "Full court — baseline" },
  { value: "side-top", label: "Sideline — top" },
  { value: "side-bot", label: "Sideline — bottom" },
  { value: "base-top", label: "Baseline — top (under basket)" },
  { value: "base-bot", label: "Baseline — bottom (under basket)" },
];

const ASSIGNMENTS: { value: PlayerAssignment | "auto"; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "handler", label: "Ball handler" },
  { value: "screener", label: "Screener" },
  { value: "focus", label: "Go-to guy" },
  { value: "corner", label: "Corner" },
  { value: "wing", label: "Wing" },
  { value: "top", label: "Top of key" },
  { value: "dunker", label: "Dunker spot" },
];

interface PossessionLabProps {
  teams: BoxTeam[];
  snapshot: Snapshot;
  events: SimEvent[];
  labPhase: LabPhase;
  labTool: LabTool;
  onStage: (opts: PossessionOpts) => void;
  onConfirm: () => void;
  onEdit: () => void;
  onRun: () => void;
  onToolChange: (t: LabTool) => void;
  onClearPaths: () => void;
}

export function PossessionLab({
  teams,
  events,
  labPhase,
  labTool,
  onStage,
  onConfirm,
  onEdit,
  onRun,
  onToolChange,
  onClearPaths,
}: PossessionLabProps) {
  const [offense, setOffense] = useState(0);
  const [play, setPlay] = useState<PlayCall>("pnr");
  const [scheme, setScheme] = useState<DefScheme>("man");
  const [start, setStart] = useState<InboundLoc>("side-top");
  const [assignments, setAssignments] = useState<(PlayerAssignment | "auto")[]>(
    Array(5).fill("auto")
  );
  const [inbounder, setInbounder] = useState<number | "auto">("auto");
  const [rev, setRev] = useState(0); // bump to re-stage with same options

  // while configuring, any change to the script instantly re-stages the
  // formation. once the lineup is confirmed the config controls lock, so this
  // never fires under authored moves/paths and wipes them.
  useEffect(() => {
    onStage({
      offense,
      play,
      defScheme: scheme,
      start,
      assignments: assignments.map((a) => (a === "auto" ? null : a)),
      inbounder: inbounder === "auto" ? null : inbounder,
    });
  }, [offense, play, scheme, start, assignments, inbounder, rev, onStage]);

  if (teams.length < 2) return null;
  // config controls are live only while configuring; confirming locks them so
  // court edits survive
  const configurable = labPhase === "config" || labPhase === "idle";
  const offTeam = teams[offense];
  const playMeta = PLAYS.find((p) => p.value === play)!;
  const schemeMeta = SCHEMES.find((s) => s.value === scheme)!;

  const setAssignment = (slot: number, v: PlayerAssignment | "auto") => {
    setAssignments((prev) => {
      const next = [...prev];
      // unique roles: claiming handler/screener/go-to releases it elsewhere
      if (v === "handler" || v === "screener" || v === "focus") {
        for (let i = 0; i < next.length; i++) if (next[i] === v) next[i] = "auto";
      }
      next[slot] = v;
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
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
                  setAssignments(Array(5).fill("auto"));
                  setInbounder("auto");
                }}
              >
                <span className="mr-1.5 size-2.5 rounded-full" style={{ background: t.color }} />
                {t.name.split(" ")[0]}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Inbound location</Label>
          <Select
            value={start}
            onValueChange={(v) => setStart(v as InboundLoc)}
            disabled={!configurable}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INBOUNDS.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Inbounder</Label>
        <Select
          value={String(inbounder)}
          onValueChange={(v) => setInbounder(v === "auto" ? "auto" : Number(v))}
          disabled={!configurable}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto (nearest to the ball)</SelectItem>
            {offTeam.players.map((bp, slot) => (
              <SelectItem key={bp.id} value={String(slot)}>
                #{bp.number} {bp.name.split(" ").slice(-1)[0]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Who throws the ball in to start the play.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Play call</Label>
          <Select value={play} onValueChange={(v) => setPlay(v as PlayCall)} disabled={!configurable}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAYS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{playMeta.blurb}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Defense</Label>
          <Select value={scheme} onValueChange={(v) => setScheme(v as DefScheme)} disabled={!configurable}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEMES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{schemeMeta.blurb}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Roles ({offTeam.name})</Label>
        {offTeam.players.map((bp, slot) => (
          <div key={bp.id} className="flex items-center gap-2">
            <span className="w-32 truncate text-sm">
              #{bp.number} {bp.name.split(" ").slice(-1)[0]}
            </span>
            <Select
              value={assignments[slot]}
              onValueChange={(v) => setAssignment(slot, v as PlayerAssignment | "auto")}
              disabled={!configurable}
            >
              <SelectTrigger className="h-8 flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNMENTS.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

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
                ? "Possession over — reset to tweak it and run it back."
                : "Lock the lineup below to unlock moves & paths."}
        </p>
      </div>

      <div className="flex gap-2">
        {configurable ? (
          <Button onClick={onConfirm} className="flex-1">
            Confirm lineup & roles
          </Button>
        ) : (
          <>
            <Button onClick={onRun} disabled={labPhase !== "staged"}>
              Run play
            </Button>
            {labPhase === "staged" && (
              <Button variant="outline" onClick={onEdit}>
                Edit setup
              </Button>
            )}
          </>
        )}
        <Button variant="outline" onClick={() => setRev((r) => r + 1)}>
          Reset formation
        </Button>
      </div>

      {(labPhase === "running" || labPhase === "ended") && (
        <div className="flex flex-col gap-1.5">
          <Label>Possession play-by-play</Label>
          <div className="flex flex-col rounded-md border">
            {events.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">Ball is in…</div>
            )}
            {events.map((e, i) => (
              <div
                key={i}
                className={cn(
                  "px-3 py-1.5 text-sm",
                  (e.type === "pass" || e.type === "info") && "text-muted-foreground"
                )}
              >
                {e.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
