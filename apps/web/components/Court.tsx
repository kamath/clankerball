"use client";
import { Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

const SPEEDS = [1, 2, 4, 8, 16];

interface CourtProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  playing: boolean;
  speed: number;
  onTogglePlay: () => void;
  onNewGame: () => void;
  onSetSpeed: (s: number) => void;
}

export function Court({
  canvasRef,
  playing,
  speed,
  onTogglePlay,
  onNewGame,
  onSetSpeed,
}: CourtProps) {
  return (
    <div className="flex flex-col gap-3">
      <canvas ref={canvasRef} className="court-canvas" />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onTogglePlay} variant="default" className="gap-2">
          {playing ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
          {playing ? "Pause" : "Play"}
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
        <Button onClick={onNewGame} variant="outline" className="gap-2">
          <RotateCcw data-icon="inline-start" />
          New Game
        </Button>
      </div>
    </div>
  );
}
