"use client";
/* ============================================================
   CourtTools — the staging tools for the possession designer.
   Move players, or author the play right on the court in one
   diagram language: draw a Route (freehand), drag a Screen from
   the screener through the man he frees (release toward the rim
   = roll, out to the arc = pop), tap Post / Iso on a player.
   Everything drawn compiles into the plan's Actions list.
   Rendered beneath the court board so editing happens right
   where you see it. Only active while a possession is staged.
   ============================================================ */
import { Anchor, CircleDashed, Eraser, MousePointer2, PenLine, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LabPhase, LabTool } from "@/hooks/useGame";

interface CourtToolsProps {
  labPhase: LabPhase;
  labTool: LabTool;
  onToolChange: (t: LabTool) => void;
  onClearPaths: () => void;
}

const TOOLS: { tool: LabTool; label: string; icon: typeof PenLine; title: string }[] = [
  { tool: "move", label: "Move", icon: MousePointer2, title: "Drag players into position; click an arrow to select it, then hit its ✕ to remove the action" },
  { tool: "path", label: "Route", icon: PenLine, title: "Drag from a player to draw the route he runs" },
  { tool: "screen", label: "Screen", icon: Shield, title: "Drag from the screener onto a teammate — onto the initiator it's a pick & roll (keep dragging to the rim for roll, to the arc for pop); onto anyone else it screens him open" },
  { tool: "post", label: "Post", icon: Anchor, title: "Tap a player to post him up on the block" },
  { tool: "iso", label: "Iso", icon: CircleDashed, title: "Tap a player to clear out and let him work" },
];

export function CourtTools({ labPhase, labTool, onToolChange, onClearPaths }: CourtToolsProps) {
  const staged = labPhase === "staged";
  return (
    <div className="flex items-center gap-1 rounded-md border p-1">
      {TOOLS.map(({ tool, label, icon: Icon, title }) => (
        <Button
          key={tool}
          size="sm"
          variant={labTool === tool ? "secondary" : "ghost"}
          onClick={() => onToolChange(tool)}
          disabled={!staged}
          title={title}
        >
          <Icon className="mr-1.5 size-3.5" /> {label}
        </Button>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={onClearPaths}
        disabled={!staged}
        title="Erase all drawn routes"
      >
        <Eraser className="mr-1.5 size-3.5" /> Clear routes
      </Button>
    </div>
  );
}
