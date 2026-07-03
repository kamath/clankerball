"use client";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PlayerCombobox } from "@/components/PlayerCombobox";
import { TeamCombobox } from "@/components/TeamCombobox";
import type { BoxTeam } from "@/hooks/useGame";
import type { Player, PlayerConfig, TeamOption } from "@repo/shared";

const fmtHeight = (v: number) => `${Math.floor(v / 12)}'${v % 12}"`;
const lastName = (n: string) => n.split(" ").slice(-1)[0];

type Row = [key: keyof Player, label: string, min: number, max: number, fmt?: (v: number) => string];

const SECTIONS: [string, Row[]][] = [
  ["PHYSICAL", [
    ["heightIn", "HEIGHT", 66, 90, fmtHeight],
    ["weightLb", "WEIGHT", 150, 300, (v) => `${v} lb`],
    ["speed", "SPEED", 25, 99],
    ["acceleration", "ACCELERATION", 25, 99],
    ["strength", "STRENGTH", 25, 99],
    ["vertical", "VERTICAL", 25, 99],
  ]],
  ["OFFENSE", [
    ["threePoint", "3-POINT", 25, 99],
    ["midRange", "MID-RANGE", 25, 99],
    ["layup", "LAYUP", 25, 99],
    ["dunk", "DUNK", 25, 99],
    ["freeThrow", "FREE THROW", 25, 99],
    ["ballHandle", "BALL HANDLE", 25, 99],
    ["passAcc", "PASS ACCURACY", 25, 99],
  ]],
  ["DEFENSE", [
    ["perimeterD", "PERIMETER D", 25, 99],
    ["interiorD", "INTERIOR D", 25, 99],
    ["steal", "STEAL", 25, 99],
    ["block", "BLOCK", 25, 99],
    ["rebound", "REBOUND", 25, 99],
  ]],
  ["MENTAL", [["iq", "BBALL IQ", 25, 99]]],
];

const ATTR_KEYS = SECTIONS.flatMap(([, rows]) => rows.map(([key]) => key));

const TENDENCIES: [keyof Player["tend"], string][] = [
  ["shoot", "SHOOT"],
  ["three", "TAKE 3s"],
  ["drive", "DRIVE"],
  ["pass", "PASS"],
  ["kickout", "KICK OUT"],
  ["help", "HELP D"],
  ["crash", "CRASH GLASS"],
  ["gamble", "GAMBLE"],
];

/** The subset of a player the sheet edits — held as a local draft so nothing
    reaches the game until the edit is confirmed. */
type Draft = {
  ti: number;
  slot: number;
  name: string;
  number: number;
  ratings: Partial<Record<keyof Player, number>>;
  tend: Player["tend"];
};

const makeDraft = (ti: number, slot: number, p: Player): Draft => ({
  ti,
  slot,
  name: p.name,
  number: p.number,
  ratings: Object.fromEntries(ATTR_KEYS.map((k) => [k, p[k] as number])),
  tend: { ...p.tend },
});

interface RosterEditorProps {
  teams: BoxTeam[];
  /** each team's full selectable roster, in the same order as `teams`; enables
      swapping a starter for a teammate. Empty when a config carries no roster. */
  rosters?: PlayerConfig[][];
  /** the NBA team list, for the per-side team pickers in each roster header */
  teamOptions?: TeamOption[];
  /** which NBA team fills each slot, in `teams` order (null if unresolved) */
  selectedTeamIds?: [number | null, number | null];
  /** which side is currently rebuilding after a team pick (null when idle) */
  teamLoading?: 0 | 1 | null;
  onSelectTeam?: (teamIdx: 0 | 1, teamId: number) => void;
  onEdit: (teamIdx: number, slot: number, mutate: (p: Player) => void) => void;
  onSwap?: (teamIdx: number, slot: number, replacement: PlayerConfig) => void;
}

export function RosterEditor({
  teams,
  rosters,
  teamOptions,
  selectedTeamIds,
  teamLoading,
  onSelectTeam,
  onEdit,
  onSwap,
}: RosterEditorProps) {
  // the player currently open in the edit sheet, staged as a local draft
  const [draft, setDraft] = useState<Draft | null>(null);

  const openEditor = (ti: number, slot: number) => {
    const p = teams[ti]?.players[slot]?.player;
    if (p) setDraft(makeDraft(ti, slot, p));
  };
  const closeEditor = () => setDraft(null);

  // Commit every staged field to the game in one edit, then dismiss the sheet.
  const confirmEdit = () => {
    if (!draft) return;
    const d = draft;
    onEdit(d.ti, d.slot, (p) => {
      p.name = d.name;
      p.number = d.number;
      for (const k of ATTR_KEYS) (p[k] as number) = d.ratings[k] as number;
      for (const [k] of TENDENCIES) {
        if (p.tend) p.tend[k] = d.tend[k];
        // keep the base in sync so coaching-plan biases re-apply on top of the
        // edited value, not the original one
        if (p.baseTend) p.baseTend[k] = d.tend[k];
      }
    });
    closeEditor();
  };

  const setRating = (key: keyof Player, v: number) =>
    setDraft((d) => (d ? { ...d, ratings: { ...d.ratings, [key]: v } } : d));
  const setTend = (key: keyof Player["tend"], v: number) =>
    setDraft((d) => (d ? { ...d, tend: { ...d.tend, [key]: v } } : d));

  if (!teams.length) return null;

  // Everyone currently on the court, both teams — no player can start twice,
  // whether that's a duplicate on one side or a face-off against himself.
  const onCourtIds = new Set(teams.flatMap((t) => t.players.map((bp) => bp.player.nbaId)));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Pick each side's real NBA team, swap in teammates, or edit a player's
        ratings. Ratings come from 2024-25 season stats — including hustle and
        defensive-impact metrics.
      </p>

      {teams.map((t, ti) => {
        const pool = rosters?.[ti] ?? [];
        return (
          <div key={ti} className="flex flex-col gap-1.5">
            {teamOptions?.length ? (
              <TeamCombobox
                teams={teamOptions}
                selectedId={selectedTeamIds?.[ti] ?? null}
                excludeId={selectedTeamIds?.[ti === 0 ? 1 : 0] ?? null}
                loading={teamLoading === ti}
                color={t.color}
                onSelect={(teamId) => onSelectTeam?.(ti as 0 | 1, teamId)}
              />
            ) : (
              <h4 className="flex items-center gap-2 text-sm font-semibold">
                <span className="size-2.5 rounded-full" style={{ background: t.color }} />
                {t.name}
              </h4>
            )}

            {pool.length === 0 ? (
              // Hand-authored config (no roster to swap from): pick a player to edit.
              <div className="flex flex-wrap gap-1.5">
                {t.players.map((bp, slot) => (
                  <Button
                    key={bp.id}
                    size="sm"
                    variant="outline"
                    onClick={() => openEditor(ti, slot)}
                  >
                    #{bp.number} {lastName(bp.name)}
                  </Button>
                ))}
              </div>
            ) : (
              // One row per on-court slot: swap the starter, or pencil to edit him.
              <div className="flex flex-col gap-1.5">
                {t.players.map((bp, slot) => (
                  <div key={bp.id} className="flex items-center gap-1.5">
                    <PlayerCombobox
                      current={{
                        number: bp.number,
                        name: bp.name,
                        pos: bp.player.position,
                        nbaId: bp.player.nbaId,
                      }}
                      teamPool={pool}
                      excludeIds={onCourtIds}
                      onSelect={(repl) => onSwap?.(ti, slot, repl)}
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      className="size-8 shrink-0"
                      onClick={() => openEditor(ti, slot)}
                      title="Edit ratings"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <Sheet open={!!draft} onOpenChange={(o) => (o ? undefined : closeEditor())}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
        >
          <SheetHeader className="border-b border-border p-6">
            <SheetTitle>Edit player</SheetTitle>
            <SheetDescription>
              Adjust ratings and tendencies, then confirm to apply them to the game.
            </SheetDescription>
          </SheetHeader>

          {draft && (
            <div className="flex-1 overflow-y-auto p-6">
              <div className="flex flex-col gap-4">
                <div className="flex gap-2">
                  <Input
                    value={draft.name}
                    maxLength={24}
                    onChange={(e) =>
                      setDraft((d) => (d ? { ...d, name: e.target.value } : d))
                    }
                    className="flex-1"
                  />
                  <Input
                    type="number"
                    value={draft.number}
                    min={0}
                    max={99}
                    onChange={(e) =>
                      setDraft((d) =>
                        d
                          ? { ...d, number: Math.max(0, Math.min(99, Number(e.target.value) || 0)) }
                          : d
                      )
                    }
                    className="w-20"
                  />
                </div>

                {SECTIONS.map(([title, rows]) => (
                  <div key={title} className="flex flex-col gap-3">
                    <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
                    {rows.map(([key, label, min, max, fmt]) => {
                      const val = draft.ratings[key] as number;
                      return (
                        <div key={String(key)} className="flex flex-col gap-1">
                          <div className="flex items-center justify-between text-sm">
                            <Label>{label}</Label>
                            <span className="tabular-nums text-muted-foreground">
                              {fmt ? fmt(val) : val}
                            </span>
                          </div>
                          <Slider
                            min={min}
                            max={max}
                            value={[val]}
                            onValueChange={([v]) => setRating(key, v)}
                          />
                        </div>
                      );
                    })}
                  </div>
                ))}

                <div className="flex flex-col gap-3">
                  <h4 className="text-xs font-medium text-muted-foreground">TENDENCIES</h4>
                  {TENDENCIES.map(([key, label]) => {
                    const val = draft.tend[key];
                    return (
                      <div key={key} className="flex flex-col gap-1">
                        <div className="flex items-center justify-between text-sm">
                          <Label>{label}</Label>
                          <span className="tabular-nums text-muted-foreground">{val}</span>
                        </div>
                        <Slider
                          min={1}
                          max={99}
                          value={[val]}
                          onValueChange={([v]) => setTend(key, v)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <SheetFooter className="border-t border-border p-6">
            <Button variant="outline" onClick={closeEditor}>
              Cancel
            </Button>
            <Button onClick={confirmEdit}>Confirm</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
