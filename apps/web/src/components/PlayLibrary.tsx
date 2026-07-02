"use client";
/* ============================================================
   PlayLibrary — the "previous plays on this matchup" panel shown
   over the court before you start building. Each recorded play is
   a clickable row showing its outcome ("Wembanyama buries the
   triple"); picking one plays that possession back. Editing the
   config (in the lab / roster panel) sets these aside and reveals
   the court to build a new play. Populated from simulation
   analytics for the exact current config, so it re-searches
   whenever the matchup or roster changes.
   ============================================================ */
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlaySummary } from "@repo/shared";

interface PlayLibraryProps {
  plays: PlaySummary[];
  /** the sim id currently being loaded, if any (shows a spinner on that row) */
  loadingId: string | null;
  onSelect: (simId: string) => void;
}

/** ClickHouse DateTime64 ("YYYY-MM-DD HH:MM:SS.mmm", UTC) → a short local time. */
function whenLabel(ts: string): string {
  const d = new Date(ts.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PlayLibrary({ plays, loadingId, onSelect }: PlayLibraryProps) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col rounded-md border bg-background/95 backdrop-blur-sm">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Previous plays on this matchup</h2>
        <p className="text-xs text-muted-foreground">
          {plays.length} recorded {plays.length === 1 ? "possession" : "possessions"} — pick one to
          watch the replay, or edit the config to build a new play
        </p>
      </div>

      {/* Plain overflow container (not Radix ScrollArea): its viewport wraps
          children in a shrink-to-fit display:table div, which defeats truncate. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-1.5 p-3">
          {plays.map((p) => {
            const loading = loadingId === p.simId;
            return (
              <button
                key={p.simId}
                type="button"
                disabled={loading}
                onClick={() => onSelect(p.simId)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                  "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-70"
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{p.result}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {p.offenseTeam} · {whenLabel(p.timestamp)}
                  </span>
                </span>
                {loading && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums",
                    p.points > 0 ? "bg-emerald-500/15 text-emerald-600" : "text-muted-foreground"
                  )}
                >
                  {p.points > 0 ? `+${p.points}` : "no pts"}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
