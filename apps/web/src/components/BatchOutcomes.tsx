"use client";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { SimOutcome } from "@/hooks/useGame";

/** Render a compute time as a compact, human duration (e.g. "842 ms", "1.2 s"). */
const fmtDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;

/** The distribution panel for a Run ×N batch: aggregate stats over every
    simulated possession plus the full, scrollable list of each run's outcome.
    Clicking a run pulls its paths back and plays it on the court; the run
    currently loaded on the court is highlighted. */
export function BatchOutcomes({
  outcomes,
  activeSimId,
  durationMs,
  onSelect,
  className,
}: {
  outcomes: SimOutcome[];
  /** simId of the run currently playing on the court — marked in the list */
  activeSimId?: string | null;
  /** how long the batch took to compute, shown next to the count */
  durationMs?: number | null;
  /** play a run on the court by its simId (pulls its Replay from R2) */
  onSelect?: (simId: string) => void;
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
    <div className="flex min-h-0 flex-col gap-1.5">
      <Label>
        {n} possessions
        {durationMs != null && (
          <span className="ml-2 font-normal text-muted-foreground">
            computed in {fmtDuration(durationMs)}
          </span>
        )}
      </Label>
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
          {outcomes.map((o, i) => {
            const active = o.simId === activeSimId;
            return (
              <button
                key={o.simId}
                type="button"
                onClick={() => onSelect?.(o.simId)}
                disabled={!onSelect}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "flex items-start gap-2 border-l-2 px-3 py-1.5 text-left text-sm",
                  active ? "border-primary bg-muted" : "border-transparent",
                  onSelect && "cursor-pointer hover:bg-muted/50"
                )}
                title={onSelect ? "Play this run on the court" : undefined}
              >
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
                <span className={cn((active || o.points > 0) && "font-medium")}>{o.result}</span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
