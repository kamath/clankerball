"use client";
import { Download, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

const SPEEDS = [0.25, 0.5, 1, 2, 4];

interface CourtProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  playing: boolean;
  speed: number;
  /** a recording exists — enables Replay / Export */
  canReplay: boolean;
  onTogglePlay: () => void;
  onReplay: () => void;
  onExport: () => void;
  onSetSpeed: (s: number) => void;
  /** the Run control (count + submit), rendered at the end of the toolbar */
  runControl?: React.ReactNode;
}

export function Court({
  canvasRef,
  playing,
  speed,
  canReplay,
  onTogglePlay,
  onReplay,
  onExport,
  onSetSpeed,
  runControl,
}: CourtProps) {
  return (
    <div className="flex flex-col gap-3">
      <canvas ref={canvasRef} className="court-canvas" />
      <div className="flex flex-wrap items-center gap-2">
        {canReplay && (
          <>
            <Button onClick={onTogglePlay} variant="default" className="gap-2">
              {playing ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
              {playing ? "Pause" : "Play"}
            </Button>
            <Button onClick={onReplay} variant="outline" className="gap-2">
              <RotateCcw data-icon="inline-start" />
              Replay
            </Button>
            <Button
              onClick={onExport}
              variant="ghost"
              className="gap-2"
              title="Download this game as a replay file"
            >
              <Download data-icon="inline-start" />
              Export
            </Button>
            <div className="flex items-center gap-1 rounded-md border p-1">
              <span className="px-2 text-xs text-muted-foreground">Speed</span>
              {SPEEDS.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={speed === s ? "secondary" : "ghost"}
                  onClick={() => onSetSpeed(s)}
                >
                  {s}×
                </Button>
              ))}
            </div>
          </>
        )}
        {runControl && (
          <div className="ml-auto flex items-center gap-2">{runControl}</div>
        )}
      </div>
    </div>
  );
}
