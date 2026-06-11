"use client";
/* ============================================================
   PossessionLab — script a single possession: pick who has the
   ball, what play they run, and what defense they see, then
   watch it on the court. The sim freezes when the possession
   ends so you can run it back or resume the full game.
   ============================================================ */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BoxTeam, PossessionOpts, Snapshot } from "@/hooks/useGame";
import type { DefScheme, PlayCall } from "@/lib/types";

const PLAYS: { value: PlayCall; label: string; blurb: string }[] = [
  { value: "motion", label: "Motion", blurb: "free-flowing offense, everyone hunts a spot" },
  { value: "iso", label: "Isolation", blurb: "clear out and let the star go to work" },
  { value: "pnr", label: "Pick & roll", blurb: "screen for the handler, roll to the rim" },
  { value: "post", label: "Post-up", blurb: "feed the big on the block" },
];

const SCHEMES: { value: DefScheme; label: string; blurb: string }[] = [
  { value: "man", label: "Man-to-man", blurb: "stick with your matchup" },
  { value: "switch", label: "Switch everything", blurb: "trade assignments on every screen" },
  { value: "zone", label: "2-3 Zone", blurb: "guard your area, pack the paint" },
];

interface PossessionLabProps {
  teams: BoxTeam[];
  snapshot: Snapshot;
  onRun: (opts: PossessionOpts) => void;
  onResume: () => void;
}

export function PossessionLab({ teams, snapshot, onRun, onResume }: PossessionLabProps) {
  const [offense, setOffense] = useState(0);
  const [play, setPlay] = useState<PlayCall>("pnr");
  const [scheme, setScheme] = useState<DefScheme>("man");
  const [focusSlot, setFocusSlot] = useState<string>("auto");

  if (teams.length < 2) return null;
  const offTeam = teams[offense];
  const playMeta = PLAYS.find((p) => p.value === play)!;
  const schemeMeta = SCHEMES.find((s) => s.value === scheme)!;
  const focusLabel = play === "pnr" ? "Screener" : play === "post" ? "Post man" : "Go-to guy";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Script one possession: pick the play and the coverage, then watch it unfold on the
        court. The sim pauses when the possession ends.
      </p>

      <div className="flex flex-col gap-1.5">
        <Label>Offense</Label>
        <div className="flex gap-1.5">
          {teams.map((t, ti) => (
            <Button
              key={ti}
              size="sm"
              variant={offense === ti ? "secondary" : "outline"}
              onClick={() => {
                setOffense(ti);
                setFocusSlot("auto");
              }}
            >
              <span className="mr-1.5 size-2.5 rounded-full" style={{ background: t.color }} />
              {t.name}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Play call</Label>
        <Select value={play} onValueChange={(v) => setPlay(v as PlayCall)}>
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

      {play !== "motion" && (
        <div className="flex flex-col gap-1.5">
          <Label>{focusLabel}</Label>
          <Select value={focusSlot} onValueChange={setFocusSlot}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto (best fit)</SelectItem>
              {offTeam.players.map((bp, slot) => (
                <SelectItem key={bp.id} value={String(slot)}>
                  #{bp.number} {bp.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label>Defense ({teams[1 - offense].name})</Label>
        <Select value={scheme} onValueChange={(v) => setScheme(v as DefScheme)}>
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

      <div className="flex gap-2">
        <Button
          onClick={() =>
            onRun({
              offense,
              play,
              defScheme: scheme,
              focusSlot: focusSlot === "auto" ? null : Number(focusSlot),
            })
          }
        >
          {snapshot.labFrozen ? "Run it again" : "Run possession"}
        </Button>
        {snapshot.labActive && (
          <Button variant="outline" onClick={onResume}>
            Resume full game
          </Button>
        )}
      </div>

      {snapshot.labActive && !snapshot.labFrozen && (
        <p className="text-xs text-muted-foreground">
          Possession in progress — follow it on the court and in the play-by-play.
        </p>
      )}
      {snapshot.labFrozen && (
        <p className="text-xs text-muted-foreground">
          Possession over. Check the play-by-play, run another, or resume the game.
        </p>
      )}
    </div>
  );
}
