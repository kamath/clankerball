"use client";
import { useState } from "react";
import { FlaskConical, Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGame } from "@/hooks/useGame";
import { useTeams } from "@/lib/queries";
import type { GameConfig } from "@repo/shared";
import { BoxScore } from "./BoxScore";
import { CoachPanel } from "./CoachPanel";
import { Court } from "./Court";
import { Feed } from "./Feed";
import { PossessionLab } from "./PossessionLab";
import { RosterEditor } from "./RosterEditor";
import { Scorebug } from "./Scorebug";
import { TeamPicker } from "./TeamPicker";

interface SimulatorProps {
  initialConfig: GameConfig;
}

export function Simulator({ initialConfig }: SimulatorProps) {
  const game = useGame(initialConfig);
  const { data: teams = [] } = useTeams();
  const { snapshot } = game;
  const names = snapshot.teamMeta;
  // Lab is the default view — the sim opens straight into the possession designer.
  const [panel, setPanel] = useState<"game" | "lab">("lab");
  // active sub-tab within the lab panel (designer / roster edit / team picker)
  const [labTab, setLabTab] = useState("lab");

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
        <div className="flex flex-col gap-4">
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
          <Feed
            events={panel === "lab" ? game.labEvents : game.events}
            snapshot={snapshot}
            title={panel === "lab" ? "Possession play-by-play" : "Play-by-play"}
            className="h-[220px]"
          />
        </div>

        {panel === "lab" ? (
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
        ) : (
          <Tabs defaultValue="coach" className="flex flex-col">
            <TabsList className="grid grid-cols-4">
              <TabsTrigger value="coach">Coach</TabsTrigger>
              <TabsTrigger value="box">Box score</TabsTrigger>
              <TabsTrigger value="edit">Edit</TabsTrigger>
              <TabsTrigger value="teams">Teams</TabsTrigger>
            </TabsList>

            <TabsContent value="coach">
              <ScrollArea className="h-[60vh] pr-3">
                <CoachPanel
                  teams={game.boxTeams}
                  plans={game.teamPlans}
                  onApply={game.setTeamPlan}
                />
              </ScrollArea>
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
