"use client";
/* ============================================================
   PossessionLab — interactive possession designer on a sandboxed
   game. Pick the team, where it inbounds, who throws it in, the
   defense it's working against, and your scoring options (a top
   option plus optional second and third looks). The players snap
   into formation; while staged you can drag them anywhere and draw
   the motion paths they run. Run plays the possession and freezes
   when it ends. The real game is paused and untouched the whole time.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
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
import type { DefScheme, InboundLoc, SimEvent } from "@/lib/types";

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

const OPTION_LABELS = ["Top option", "Second option", "Third option"];
const OPTION_HINTS = [
  "your go-to scorer — the offense looks here first",
  "optional — the next look when the top option is covered",
  "optional — the third release valve",
];

interface PossessionLabProps {
  teams: BoxTeam[];
  snapshot: Snapshot;
  events: SimEvent[];
  labPhase: LabPhase;
  labTool: LabTool;
  labRoles: (string | null)[];
  onStage: (opts: PossessionOpts) => void;
  onRun: () => void;
  onReRun: () => void;
  onToolChange: (t: LabTool) => void;
  onClearPaths: () => void;
  onSetDefense: (scheme: DefScheme) => void;
}

export function PossessionLab({
  teams,
  events,
  labPhase,
  labTool,
  labRoles,
  onStage,
  onRun,
  onReRun,
  onToolChange,
  onClearPaths,
  onSetDefense,
}: PossessionLabProps) {
  const [offense, setOffense] = useState(0);
  const [scheme, setScheme] = useState<DefScheme>("man");
  const [start, setStart] = useState<InboundLoc>("side-top");
  // scoring options in priority order: [top, second, third]; null = unset
  const [scorers, setScorers] = useState<(number | null)[]>([null, null, null]);
  const [inbounder, setInbounder] = useState<number | "auto">("auto");
  const [rev, setRev] = useState(0); // bump to re-stage with same options

  // the defensive scheme rides along on re-stages but must NOT trigger one
  // (that would re-randomize the offense and wipe authored routes); a ref
  // carries the latest value into onStage.
  const schemeRef = useRef(scheme);
  schemeRef.current = scheme;

  // while configuring, any change to the offensive setup instantly re-stages
  // the formation. the defense is handled separately (see the scheme select),
  // so changing it never disturbs the offense. once the lineup is confirmed the
  // config controls lock, so this never fires under authored moves/paths.
  useEffect(() => {
    onStage({
      offense,
      defScheme: schemeRef.current,
      start,
      scorers: scorers.filter((s): s is number => s !== null),
      inbounder: inbounder === "auto" ? null : inbounder,
    });
  }, [offense, start, scorers, inbounder, rev, onStage]);

  if (teams.length < 2) return null;
  // config controls are live whenever the play isn't actively running; changing
  // one re-stages a clean formation (which resets spots and clears routes)
  const configurable = labPhase !== "running";
  const offTeam = teams[offense];
  const schemeMeta = SCHEMES.find((s) => s.value === scheme)!;
  const handlerSlot = labRoles.findIndex((r) => r === "HANDLER");

  // pick a scoring option, keeping the three slots unique
  const setScorer = (idx: number, v: number | null) => {
    setScorers((prev) => {
      const next = [...prev];
      if (v !== null) {
        for (let i = 0; i < next.length; i++) if (next[i] === v) next[i] = null;
      }
      next[idx] = v;
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
                  setScorers([null, null, null]);
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

      <div className="grid grid-cols-2 gap-3">
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
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Defense</Label>
          <Select
            value={scheme}
            onValueChange={(v) => {
              setScheme(v as DefScheme);
              onSetDefense(v as DefScheme); // re-shape only the defense, in place
            }}
            disabled={!configurable}
          >
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
        <Label>Scoring options ({offTeam.name})</Label>
        {OPTION_LABELS.map((label, idx) => (
          <div key={idx} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-sm font-medium">{label}</span>
              <Select
                value={scorers[idx] === null ? "none" : String(scorers[idx])}
                onValueChange={(v) => setScorer(idx, v === "none" ? null : Number(v))}
                disabled={!configurable}
              >
                <SelectTrigger className="h-8 flex-1">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{idx === 0 ? "None (let it flow)" : "None"}</SelectItem>
                  {offTeam.players.map((bp, slot) => (
                    <SelectItem key={bp.id} value={String(slot)}>
                      #{bp.number} {bp.name.split(" ").slice(-1)[0]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="pl-[6.5rem] text-xs text-muted-foreground">{OPTION_HINTS[idx]}</p>
          </div>
        ))}
        {handlerSlot >= 0 && offTeam.players[handlerSlot] && (
          <p className="text-xs text-muted-foreground">
            Bringing it up:{" "}
            <span className="font-medium">
              #{offTeam.players[handlerSlot].number}{" "}
              {offTeam.players[handlerSlot].name.split(" ").slice(-1)[0]}
            </span>
          </p>
        )}
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
                ? "Possession over — re-run it, or tweak the setup to restage."
                : "Drag players and draw their routes, then run the play."}
        </p>
      </div>

      <div className="flex gap-2">
        {labPhase === "ended" ? (
          <Button onClick={onReRun} className="flex-1">
            Re-run play
          </Button>
        ) : (
          <Button onClick={onRun} disabled={labPhase !== "staged"} className="flex-1">
            Run play
          </Button>
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
