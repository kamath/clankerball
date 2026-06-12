"use client";
import { useState } from "react";
import { FlaskConical, Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGame } from "@/hooks/useGame";
import type { GameConfig } from "@/lib/types";
import type { TeamOption } from "@/app/actions";
import { BoxScore } from "./BoxScore";
import { Court } from "./Court";
import { Feed } from "./Feed";
import { PossessionLab } from "./PossessionLab";
import { RosterEditor } from "./RosterEditor";
import { Scorebug } from "./Scorebug";
import { TeamPicker } from "./TeamPicker";

interface SimulatorProps {
  initialConfig: GameConfig;
  teams: TeamOption[];
}

export function Simulator({ initialConfig, teams }: SimulatorProps) {
  const game = useGame(initialConfig);
  const { snapshot } = game;
  const names = snapshot.teamMeta;
  const [panel, setPanel] = useState<"game" | "lab">("game");

  const showGame = () => {
    setPanel("game");
    game.exitLab();
  };
  const showLab = () => setPanel("lab");

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold">Fable Fieldhouse</h1>
        <span className="text-sm text-muted-foreground">
          {panel === "lab" ? "Play Lab" : "Live Simulation"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {names.length === 2 && (
            <span className="text-sm text-muted-foreground">
              {names[0].name} vs {names[1].name}
            </span>
          )}
          <div className="flex rounded-md border p-0.5">
            <Button
              size="sm"
              variant={panel === "game" ? "secondary" : "ghost"}
              className="h-7"
              onClick={showGame}
            >
              <Tv className="mr-1.5 size-3.5" /> Game
            </Button>
            <Button
              size="sm"
              variant={panel === "lab" ? "secondary" : "ghost"}
              className="h-7"
              onClick={showLab}
            >
              <FlaskConical className="mr-1.5 size-3.5" /> Lab
            </Button>
          </div>
        </div>
      </header>

      <Scorebug snapshot={snapshot} />

      <main className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <Court
          canvasRef={game.canvasRef}
          playing={game.playing}
          speed={game.speed}
          onTogglePlay={game.togglePlay}
          onNewGame={() => {
            setPanel("game");
            game.newGame();
          }}
          onSetSpeed={game.setSpeed}
        />

        {panel === "lab" ? (
          <ScrollArea className="h-[72vh] pr-3">
            <PossessionLab
              teams={game.boxTeams}
              snapshot={snapshot}
              events={game.labEvents}
              labPhase={game.labPhase}
              labTool={game.labTool}
              onStage={game.stageLab}
              onRun={game.runLab}
              onToolChange={game.setLabTool}
              onClearPaths={game.clearLabPaths}
            />
          </ScrollArea>
        ) : (
          <Tabs defaultValue="feed" className="flex flex-col">
            <TabsList className="grid grid-cols-4">
              <TabsTrigger value="feed">Play-by-play</TabsTrigger>
              <TabsTrigger value="box">Box score</TabsTrigger>
              <TabsTrigger value="edit">Edit</TabsTrigger>
              <TabsTrigger value="teams">Teams</TabsTrigger>
            </TabsList>

            <TabsContent value="feed">
              <Feed events={game.events} snapshot={snapshot} />
            </TabsContent>

            <TabsContent value="box">
              <ScrollArea className="h-[60vh] pr-3">
                <BoxScore teams={game.boxTeams} />
              </ScrollArea>
            </TabsContent>

            <TabsContent value="edit">
              <ScrollArea className="h-[60vh] pr-3">
                <RosterEditor teams={game.boxTeams} onEdit={game.editPlayer} />
              </ScrollArea>
            </TabsContent>

            <TabsContent value="teams">
              <TeamPicker teams={teams} onLoad={(config) => game.newGame(config)} />
            </TabsContent>
          </Tabs>
        )}
      </main>
    </div>
  );
}
