"use client";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { SimOutcome } from "@/hooks/useGame";

/** The distribution panel for a Run ×N batch: aggregate stats over every
    simulated possession plus the full, scrollable list of each run's outcome. */
export function BatchOutcomes({
  outcomes,
  className,
}: {
  outcomes: SimOutcome[];
  className?: string;
}) {
  const n = outcomes.length;
  const totalPts = outcomes.reduce((sum, o) => sum + o.points, 0);
  const avg = n ? totalPts / n : 0;
  const scored = outcomes.filter((o) => o.points > 0).length;
  // how many possessions landed on each point value (0, 2, 3, …), ascending
  const byPoints = new Map<number, number>();
  for (const o of outcomes) byPoints.set(o.points, (byPoints.get(o.points) ?? 0) + 1);
  const buckets = [...byPoints.entries()].sort((a, b) => a[0] - b[0]);

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{n} possessions</Label>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span>
          <span className="font-medium tabular-nums">{avg.toFixed(2)}</span>{" "}
          <span className="text-muted-foreground">pts/poss</span>
        </span>
        <span>
          <span className="font-medium tabular-nums">
            {n ? Math.round((scored / n) * 100) : 0}%
          </span>{" "}
          <span className="text-muted-foreground">scored</span>
        </span>
        {buckets.map(([pts, count]) => (
          <span key={pts} className="text-muted-foreground">
            <span className="font-medium tabular-nums text-foreground">{count}</span> × {pts}pt
          </span>
        ))}
      </div>
      <ScrollArea className={cn("rounded-md border", className ?? "h-[220px]")}>
        <div className="flex flex-col">
          {outcomes.map((o, i) => (
            <div key={i} className="flex items-start gap-2 px-3 py-1.5 text-sm">
              <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">
                {i + 1}
              </span>
              <span
                className={cn(
                  "w-7 shrink-0 tabular-nums",
                  o.points > 0 ? "font-medium" : "text-muted-foreground"
                )}
              >
                {o.points > 0 ? `+${o.points}` : "0"}
              </span>
              <span className={cn(o.points > 0 && "font-medium")}>{o.result}</span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
