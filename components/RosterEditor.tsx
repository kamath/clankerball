"use client";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import type { BoxTeam } from "@/hooks/useGame";
import type { Player } from "@/lib/types";

const fmtHeight = (v: number) => `${Math.floor(v / 12)}'${v % 12}"`;

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

interface RosterEditorProps {
  teams: BoxTeam[];
  onEdit: (teamIdx: number, slot: number, mutate: (p: Player) => void) => void;
}

export function RosterEditor({ teams, onEdit }: RosterEditorProps) {
  const [sel, setSel] = useState<{ ti: number; slot: number }>({ ti: 0, slot: 0 });
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  const player = useMemo(
    () => teams[sel.ti]?.players[sel.slot]?.player,
    [teams, sel]
  );

  if (!teams.length || !player) return null;

  const setAttr = (key: keyof Player, v: number) => {
    onEdit(sel.ti, sel.slot, (p) => {
      (p[key] as number) = v;
    });
    rerender();
  };
  const setTend = (key: keyof Player["tend"], v: number) => {
    onEdit(sel.ti, sel.slot, (p) => {
      p.tend[key] = v;
    });
    rerender();
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Changes apply to the game in progress immediately.</p>

      {teams.map((t, ti) => (
        <div key={ti} className="flex flex-col gap-1.5">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <span className="size-2.5 rounded-full" style={{ background: t.color }} />
            {t.name}
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {t.players.map((bp, slot) => {
              const on = sel.ti === ti && sel.slot === slot;
              return (
                <Button
                  key={bp.id}
                  size="sm"
                  variant={on ? "secondary" : "outline"}
                  onClick={() => setSel({ ti, slot })}
                >
                  #{bp.number} {bp.name.split(" ").slice(-1)[0]}
                </Button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex gap-2">
        <Input
          value={player.name}
          maxLength={24}
          onChange={(e) => {
            const name = e.target.value;
            onEdit(sel.ti, sel.slot, (p) => {
              p.name = name;
            });
            rerender();
          }}
          className="flex-1"
        />
        <Input
          type="number"
          value={player.number}
          min={0}
          max={99}
          onChange={(e) => {
            const num = Math.max(0, Math.min(99, Number(e.target.value) || 0));
            onEdit(sel.ti, sel.slot, (p) => {
              p.number = num;
            });
            rerender();
          }}
          className="w-20"
        />
      </div>

      {SECTIONS.map(([title, rows]) => (
        <div key={title} className="flex flex-col gap-3">
          <h4 className="text-xs font-medium text-muted-foreground">
            {title}
          </h4>
          {rows.map(([key, label, min, max, fmt]) => {
            const val = player[key] as number;
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
                  onValueChange={([v]) => setAttr(key, v)}
                />
              </div>
            );
          })}
        </div>
      ))}

      <div className="flex flex-col gap-3">
        <h4 className="text-xs font-medium text-muted-foreground">TENDENCIES</h4>
        {TENDENCIES.map(([key, label]) => {
          const val = player.tend[key];
          return (
            <div key={key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-sm">
                <Label>{label}</Label>
                <span className="tabular-nums text-muted-foreground">{val}</span>
              </div>
              <Slider min={1} max={99} value={[val]} onValueChange={([v]) => setTend(key, v)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
