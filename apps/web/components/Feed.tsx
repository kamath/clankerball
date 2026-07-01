"use client";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { Snapshot } from "@/hooks/useGame";
import type { SimEvent } from "@repo/shared";

const SCORE_TYPES = new Set(["score", "dunk"]);

export function Feed({ events, snapshot }: { events: SimEvent[]; snapshot: Snapshot }) {
  const colors = snapshot.teamMeta.map((t) => t.color);
  return (
    <ScrollArea className="h-[60vh] rounded-md border">
      <div className="flex flex-col">
        {events.map((e, i) => {
          if (e.type === "period" || e.type === "final" || e.type === "info") {
            return (
              <div key={i} className="px-3 py-2 text-center text-sm text-muted-foreground">
                {e.text}
              </div>
            );
          }
          const tc = e.team == null ? "#888" : colors[e.team];
          return (
            <div
              key={i}
              className="flex items-start gap-2 px-3 py-1.5 text-sm"
              style={{ borderLeft: `3px solid ${tc}` }}
            >
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {e.qLabel} {e.clock}
              </span>
              <span
                className={cn(
                  SCORE_TYPES.has(e.type) && "font-medium",
                  e.type === "pass" && "text-muted-foreground"
                )}
              >
                {e.text}
              </span>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
