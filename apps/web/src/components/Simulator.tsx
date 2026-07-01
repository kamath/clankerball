"use client";
import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGame } from "@/hooks/useGame";
import { useTeams } from "@/lib/queries";
import type { GameConfig } from "@repo/shared";
import { Court } from "./Court";
import { Feed } from "./Feed";
import { PossessionLab } from "./PossessionLab";
import { RosterEditor } from "./RosterEditor";
import { ShotClock } from "./ShotClock";
import { TeamPicker } from "./TeamPicker";

interface SimulatorProps {
  initialConfig: GameConfig;
}

export function Simulator({ initialConfig }: SimulatorProps) {
  const game = useGame(initialConfig);
  const { data: teams = [] } = useTeams();
  const { snapshot } = game;
  const names = snapshot.teamMeta;
  // active sub-tab within the lab panel (designer / roster edit / team picker)
  const [labTab, setLabTab] = useState("lab");

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold">Fable Fieldhouse</h1>
        <span className="text-sm text-muted-foreground">Play Lab</span>
        {names.length === 2 && (
          <span className="ml-auto text-sm text-muted-foreground">
            {names[0].name} vs {names[1].name}
          </span>
        )}
      </header>

      <ShotClock snapshot={snapshot} />

      <main className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex flex-col gap-4">
          <Court
            canvasRef={game.canvasRef}
            playing={game.playing}
            speed={game.speed}
            canReplay={game.hasReplay}
            onTogglePlay={game.togglePlay}
            onReplay={game.replay}
            onExport={game.exportReplay}
            onSetSpeed={game.setSpeed}
          />
          <Feed
            events={game.labEvents}
            snapshot={snapshot}
            title="Possession play-by-play"
            className="h-[220px]"
          />
        </div>

        <Tabs value={labTab} onValueChange={setLabTab} className="flex flex-col">
          <TabsList className="grid grid-cols-3">
            <TabsTrigger value="lab">Play Lab</TabsTrigger>
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="teams">Teams</TabsTrigger>
          </TabsList>

          {/* forceMount keeps the staged possession alive while you peek at the
              Edit/Teams tabs; a new matchup bumps game.version, which remounts
              the designer on a fresh formation. */}
          <TabsContent value="lab" forceMount className="data-[state=inactive]:hidden">
            <ScrollArea className="h-[68vh] pr-3">
              <PossessionLab
                key={game.version}
                teams={game.boxTeams}
                labPhase={game.labPhase}
                labTool={game.labTool}
                labRoles={game.labRoles}
                simulating={game.simulating}
                onStage={game.stageLab}
                onRun={game.runLab}
                onReRun={game.reRunLab}
                onToolChange={game.setLabTool}
                onClearPaths={game.clearLabPaths}
              />
            </ScrollArea>
          </TabsContent>

          <TabsContent value="edit">
            <ScrollArea className="h-[68vh] pr-3">
              <RosterEditor teams={game.boxTeams} onEdit={game.editPlayer} />
            </ScrollArea>
          </TabsContent>

          <TabsContent value="teams">
            <TeamPicker
              teams={teams}
              onLoad={(config) => {
                game.newGame(config);
                setLabTab("lab");
              }}
            />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
