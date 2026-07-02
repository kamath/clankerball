"use client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Snapshot } from "@/hooks/useGame";

interface ShotClockProps {
  snapshot: Snapshot;
  /** in the lab, the starting shot clock is editable (1–24) */
  editable?: boolean;
  value?: number;
  onChange?: (v: number) => void;
}

/** A bare shot clock for the lab — counts down while a possession plays,
    reads "--" when nothing is running. In edit mode the starting value
    (1–24) is editable and seeds the simulated possession. */
export function ShotClock({ snapshot, editable = false, value = 24, onChange }: ShotClockProps) {
  const { shotClock, shotClockActive, over } = snapshot;
  const live = !over && shotClockActive;
  return (
    <Card>
      <CardContent className="flex items-center justify-center gap-3 py-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Shot clock
        </span>
        {editable ? (
          <Input
            type="number"
            min={1}
            max={24}
            value={value}
            onChange={(e) => onChange?.(e.target.valueAsNumber)}
            className="h-12 w-20 text-center text-4xl font-semibold tabular-nums"
            title="Starting shot clock (1–24)"
          />
        ) : (
          <span
            className={cn(
              "text-4xl font-semibold tabular-nums",
              !live && "text-muted-foreground",
              live && shotClock <= 5 && "text-destructive"
            )}
          >
            {live ? shotClock : "--"}
          </span>
        )}
      </CardContent>
    </Card>
  );
}
