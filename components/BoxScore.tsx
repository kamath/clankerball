"use client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { BoxTeam } from "@/hooks/useGame";
import type { Player } from "@/lib/types";

const fmtHeight = (inches: number) => `${Math.floor(inches / 12)}'${inches % 12}"`;

function RatingTip({ p }: { p: Player }) {
  const rows: [string, number | string][] = [
    ["IQ", p.iq],
    ["3PT", p.threePoint],
    ["MID", p.midRange],
    ["LAY", p.layup],
    ["DNK", p.dunk],
    ["SPD", p.speed],
    ["PER-D", p.perimeterD],
    ["INT-D", p.interiorD],
    ["STL", p.steal],
    ["BLK", p.block],
    ["REB", p.rebound],
  ];
  return (
    <div className="flex flex-col gap-1">
      <div className="font-semibold">
        {p.position} · {fmtHeight(p.heightIn)} · {p.weightLb} lb
      </div>
      <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2">
            <span className="text-muted-foreground">{k}</span>
            <span className="tabular-nums">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const HEADERS = ["PTS", "REB", "AST", "STL", "BLK", "TO", "FG", "3PT"];

export function BoxScore({ teams }: { teams: BoxTeam[] }) {
  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-6">
        {teams.map((t, ti) => (
          <div key={ti} className="flex flex-col gap-2">
            <h3 className="flex items-center gap-2 text-lg font-semibold">
              <span className="size-3 rounded-full" style={{ background: t.color }} />
              {t.name}
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40%]">PLAYER</TableHead>
                  {HEADERS.map((h) => (
                    <TableHead key={h} className="text-right tabular-nums">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {t.players.map((bp) => {
                  const s = bp.player.stats;
                  return (
                    <TableRow key={bp.id}>
                      <TableCell className="font-medium">
                        <Tooltip>
                          <TooltipTrigger className="text-left">
                            <span className="text-muted-foreground">#{bp.number}</span> {bp.name}
                          </TooltipTrigger>
                          <TooltipContent side="right">
                            <RatingTip p={bp.player} />
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{s.pts}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.reb}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.ast}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.stl}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.blk}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.tov}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.fgm}-{s.fga}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.tpm}-{s.tpa}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}
