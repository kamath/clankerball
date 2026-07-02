"use client";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Play, Share2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGame } from "@/hooks/useGame";
import { useBuildMatchup, useConfigPlays, useTeams } from "@/lib/queries";
import { fetchLibraryPlay, savePlay } from "@/lib/api";
import type { GameConfig, PlayerConfig, SimulateRequest } from "@repo/shared";
import { BatchOutcomes } from "./BatchOutcomes";
import { Court } from "./Court";
import { Feed } from "./Feed";
import { PlayLibrary } from "./PlayLibrary";
import { PossessionLab } from "./PossessionLab";
import { RosterEditor } from "./RosterEditor";
import { ShotClock } from "./ShotClock";

interface SimulatorProps {
  initialConfig: GameConfig;
  /** a shared play (from /play/{id}) to preload into the lab on first mount. */
  initialPlay?: SimulateRequest;
}

/** The two teams' full selectable rosters, in [home, away] order. */
const rostersOf = (cfg: GameConfig): [PlayerConfig[], PlayerConfig[]] => [
  cfg.teamA.roster ?? [],
  cfg.teamB.roster ?? [],
];

/** Upper bound on simulations per Run, matching the API's MAX_BATCH. */
const MAX_RUNS = 500;
const clampRuns = (n: number): number =>
  Number.isFinite(n) ? Math.min(MAX_RUNS, Math.max(1, Math.floor(n))) : 1;

export function Simulator({ initialConfig, initialPlay }: SimulatorProps) {
  const game = useGame(initialConfig);
  const { data: teams = [] } = useTeams();
  const { snapshot } = game;
  const names = snapshot.teamMeta;
  // active sub-tab within the lab panel (teams + roster edit / designer)
  const [labTab, setLabTab] = useState("teams");
  // each team's full roster, so the editor can swap a starter for a teammate
  const [rosters, setRosters] = useState<[PlayerConfig[], PlayerConfig[]]>(() =>
    rostersOf(initialConfig)
  );
  // which NBA team fills each side, in [home, away] order — drives the per-side
  // team pickers that replaced the old "Real NBA matchup" card. Resolved from
  // the loaded config's abbreviations once the team list arrives.
  const [teamIds, setTeamIds] = useState<[number | null, number | null]>([null, null]);
  const [teamLoading, setTeamLoading] = useState<0 | 1 | null>(null);
  const matchup = useBuildMatchup();
  useEffect(() => {
    if (!teams.length) return;
    setTeamIds((prev) => {
      if (prev[0] != null || prev[1] != null) return prev; // already resolved / picked
      const cfg = game.getConfig();
      const idOf = (abbr?: string) => teams.find((t) => t.abbr === abbr)?.id ?? null;
      return [idOf(cfg.teamA.abbr), idOf(cfg.teamB.abbr)];
    });
  }, [teams, game]);

  // Pick a real NBA team for one side and rebuild that lineup, keeping the
  // other side as-is. Builds once both sides are known.
  const selectTeam = async (idx: 0 | 1, teamId: number) => {
    const other = teamIds[idx === 0 ? 1 : 0];
    const nextIds: [number | null, number | null] =
      idx === 0 ? [teamId, other] : [other, teamId];
    setTeamIds(nextIds);
    if (nextIds[0] == null || nextIds[1] == null) return; // wait for both sides
    setTeamLoading(idx);
    try {
      const config = await matchup.mutateAsync({ teamAId: nextIds[0], teamBId: nextIds[1] });
      game.newGame(config);
      setRosters(rostersOf(config));
    } catch {
      /* leave the prior matchup in place on failure */
    } finally {
      setTeamLoading(null);
    }
  };
  // share-link state: idle → the saved /play/{id} url once copied
  const [shareStatus, setShareStatus] = useState<"idle" | "saving" | "copied">("idle");
  // how many possessions the header Run button simulates in one go
  const [runCount, setRunCount] = useState(1);
  const queryClient = useQueryClient();

  // The matchup's play library: prior possessions recorded on this exact config.
  // Keyed by game.version so it re-searches when the matchup / roster changes.
  const { data: plays = [] } = useConfigPlays(game.getConfig(), game.version);
  // Show the library over the court on load / config change, until dismissed or
  // a play is picked. Reset the dismissal whenever the matchup changes.
  const [libraryDismissed, setLibraryDismissed] = useState(false);
  const [loadingPlay, setLoadingPlay] = useState<string | null>(null);
  useEffect(() => {
    setLibraryDismissed(false);
  }, [game.version]);
  // A freshly-run possession is auto-recorded; refresh the library so it shows up.
  useEffect(() => {
    if (game.labPhase === "ended") {
      queryClient.invalidateQueries({ queryKey: ["configPlays"] });
    }
  }, [game.labPhase, queryClient]);

  const showLibrary = !libraryDismissed && plays.length > 0;

  // Editing any config (the plan, the court, or the roster) sets the previous
  // plays aside and reveals the court so the edit can be re-simulated. This
  // replaces the old explicit "Build a new play" button.
  const startEditing = () => setLibraryDismissed(true);

  // Pick a recorded play: load its exact replay and reveal the court to watch it.
  const onSelectPlay = async (simId: string) => {
    setLoadingPlay(simId);
    try {
      const stored = await fetchLibraryPlay(simId);
      game.playStored(stored.request, stored.replay);
      setLibraryDismissed(true);
    } catch {
      /* leave the library open so another play can be tried */
    } finally {
      setLoadingPlay(null);
    }
  };

  // Run the staged (or already-run) play runCount times. runLab captures the
  // current formation; reRunLab re-runs the last authored play. Both record every
  // run to the library and play back the first.
  const canRun = game.labPhase === "staged" || game.labPhase === "ended";
  const onRunBatch = () => {
    if (game.labPhase === "staged") game.runLab(runCount);
    else if (game.labPhase === "ended") game.reRunLab(runCount);
  };

  const onShare = async () => {
    const play = game.capturePlay();
    if (!play) return;
    setShareStatus("saving");
    try {
      const { id } = await savePlay(play);
      const url = `${window.location.origin}/play/${id}`;
      await navigator.clipboard?.writeText(url).catch(() => {});
      setShareStatus("copied");
      window.setTimeout(() => setShareStatus("idle"), 2500);
    } catch {
      setShareStatus("idle");
    }
  };

  return (
    <div className="mx-auto flex h-screen max-w-[1400px] flex-col gap-4 overflow-hidden p-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold">Fable Fieldhouse</h1>
        <span className="text-sm text-muted-foreground">Play Lab</span>
        {names.length === 2 && (
          <span className="ml-auto text-sm text-muted-foreground">
            {names[0].name} vs {names[1].name}
          </span>
        )}
        <div className={`flex items-center gap-2 ${names.length === 2 ? "" : "ml-auto"}`}>
          <label htmlFor="run-count" className="text-sm text-muted-foreground">
            Runs
          </label>
          <Input
            id="run-count"
            type="number"
            min={1}
            max={MAX_RUNS}
            value={runCount}
            onChange={(e) => setRunCount(clampRuns(e.target.valueAsNumber))}
            className="h-8 w-16"
            title={`How many possessions to simulate (1–${MAX_RUNS})`}
          />
          <Button
            size="sm"
            className="gap-2"
            onClick={onRunBatch}
            disabled={!canRun || game.simulating}
            title="Simulate the staged play this many times"
          >
            <Play data-icon="inline-start" />
            {game.simulating ? "Running…" : runCount > 1 ? `Run ×${runCount}` : "Run"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={onShare}
            disabled={shareStatus === "saving"}
            title="Save this play and copy a shareable link"
          >
            {shareStatus === "copied" ? (
              <Check data-icon="inline-start" />
            ) : (
              <Share2 data-icon="inline-start" />
            )}
            {shareStatus === "copied"
              ? "Link copied"
              : shareStatus === "saving"
                ? "Saving…"
                : "Share play"}
          </Button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[420px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
        <Tabs value={labTab} onValueChange={setLabTab} className="flex min-h-0 flex-col">
          <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b border-border bg-transparent p-0">
            <TabsTrigger
              value="teams"
              className="rounded-none border-b-2 border-transparent px-1 pb-2.5 pt-0 text-base font-semibold text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              Teams
            </TabsTrigger>
            <TabsTrigger
              value="lab"
              className="rounded-none border-b-2 border-transparent px-1 pb-2.5 pt-0 text-base font-semibold text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              Play Lab
            </TabsTrigger>
          </TabsList>

          {/* Teams: pick each side's real NBA team right on its roster header,
              then swap teammates or edit whoever's on the court. */}
          <TabsContent value="teams" className="flex-1 min-h-0">
            <ScrollArea className="h-full pr-3">
              <RosterEditor
                teams={game.boxTeams}
                rosters={rosters}
                teamOptions={teams}
                selectedTeamIds={teamIds}
                teamLoading={teamLoading}
                onSelectTeam={selectTeam}
                onEdit={(...args) => {
                  startEditing();
                  game.editPlayer(...args);
                }}
                onSwap={(...args) => {
                  startEditing();
                  game.swapPlayer(...args);
                }}
              />
            </ScrollArea>
          </TabsContent>

          {/* forceMount keeps the staged possession alive while you peek at the
              Teams tab; a new matchup bumps game.version, which remounts the
              designer on a fresh formation. */}
          <TabsContent value="lab" forceMount className="flex-1 min-h-0 data-[state=inactive]:hidden">
            <ScrollArea className="h-full pr-3">
              <PossessionLab
                key={game.version}
                teams={game.boxTeams}
                labPhase={game.labPhase}
                labTool={game.labTool}
                onEdit={startEditing}
                onStage={game.stageLab}
                onToolChange={(t) => {
                  startEditing();
                  game.setLabTool(t);
                }}
                onClearPaths={() => {
                  startEditing();
                  game.clearLabPaths();
                }}
                initialPlay={game.version === 0 ? initialPlay : undefined}
              />
            </ScrollArea>
          </TabsContent>
        </Tabs>

        <div className="relative flex flex-col gap-4">
          <ShotClock snapshot={snapshot} />
          <Court
            canvasRef={game.canvasRef}
            playing={game.playing}
            speed={game.speed}
            canReplay={game.hasReplay}
            labPhase={game.labPhase}
            simulating={game.simulating}
            onTogglePlay={game.togglePlay}
            onReplay={game.replay}
            onExport={game.exportReplay}
            onSetSpeed={game.setSpeed}
            onRun={() => game.runLab()}
            onReRun={() => game.reRunLab()}
            onReset={game.resetLab}
          />
          {game.simOutcomes.length > 1 ? (
            <BatchOutcomes outcomes={game.simOutcomes} className="h-[220px]" />
          ) : (
            <Feed
              events={game.labEvents}
              snapshot={snapshot}
              title="Possession play-by-play"
              className="h-[220px]"
            />
          )}
          {showLibrary && (
            <PlayLibrary plays={plays} loadingId={loadingPlay} onSelect={onSelectPlay} />
          )}
        </div>
      </main>
    </div>
  );
}
