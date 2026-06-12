"use client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Snapshot } from "@/hooks/useGame";

function TeamSide({
  meta,
  score,
  hasPoss,
  align,
}: {
  meta?: { abbr: string; color: string };
  score: number;
  hasPoss: boolean;
  align: "start" | "end";
}) {
  return (
    <div className={cn("flex flex-1 items-center gap-3", align === "end" && "flex-row-reverse")}>
      <span className="size-3 rounded-full" style={{ background: meta?.color ?? "#888" }} />
      <span className="text-2xl font-semibold">{meta?.abbr ?? "---"}</span>
      {hasPoss && <Badge variant="secondary">•</Badge>}
      <span className="text-4xl font-semibold tabular-nums">{score}</span>
    </div>
  );
}

export function Scorebug({ snapshot }: { snapshot: Snapshot }) {
  const { teamMeta, scores, qLabel, clock, shotClock, shotClockActive, possession, over } = snapshot;
  return (
    <Card>
      <CardContent className="flex items-center gap-4 py-3">
        <TeamSide meta={teamMeta[0]} score={scores[0]} hasPoss={!over && possession === 0} align="start" />
        <div className="flex flex-col items-center">
          <span className="text-sm text-muted-foreground">{qLabel}</span>
          <span className="text-2xl font-semibold tabular-nums">{clock}</span>
          <span
            className={cn(
              "text-sm tabular-nums",
              (over || !shotClockActive) && "text-muted-foreground",
              !over && shotClockActive && shotClock <= 5 && "text-destructive"
            )}
          >
            {over ? "--" : shotClock}
          </span>
        </div>
        <TeamSide meta={teamMeta[1]} score={scores[1]} hasPoss={!over && possession === 1} align="end" />
      </CardContent>
    </Card>
  );
}
