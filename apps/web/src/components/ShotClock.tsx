"use client";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Snapshot } from "@/hooks/useGame";

/** A bare shot clock for the lab — counts down while a possession plays,
    reads "--" when nothing is running. */
export function ShotClock({ snapshot }: { snapshot: Snapshot }) {
  const { shotClock, shotClockActive, over } = snapshot;
  const live = !over && shotClockActive;
  return (
    <Card>
      <CardContent className="flex items-center justify-center gap-3 py-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Shot clock
        </span>
        <span
          className={cn(
            "text-4xl font-semibold tabular-nums",
            !live && "text-muted-foreground",
            live && shotClock <= 5 && "text-destructive"
          )}
        >
          {live ? shotClock : "--"}
        </span>
      </CardContent>
    </Card>
  );
}
