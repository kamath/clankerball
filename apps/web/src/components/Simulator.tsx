"use client";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check, Play, Share2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGame } from "@/hooks/useGame";
import { useBuildMatchup, useTeams } from "@/lib/queries";
import { savePlay } from "@/lib/api";
import type { GameConfig, PlayerConfig, SimulateRequest } from "@repo/shared";
import { BatchOutcomes } from "./BatchOutcomes";
import { Court } from "./Court";
import { CourtTools } from "./CourtTools";
import { Feed } from "./Feed";
import { PossessionLab } from "./PossessionLab";
import { RosterEditor } from "./RosterEditor";
import { ShotClock } from "./ShotClock";

interface SimulatorProps {
  initialConfig: GameConfig;
  /** a shared play (from /play/{id}) to preload into the lab on first mount. */
  initialPlay?: SimulateRequest;
  /** "edit" (default) shows the config designer; "results" stages the preloaded
      play, runs the batch on mount, and shows the outcome distribution. */
  view?: "edit" | "results";
  /** the content id of the saved config under /{config} — the Back button on the
      results view routes here to re-edit. Absent on the fresh `/` editor. */
  configId?: string;
  /** results view: how many possessions to simulate (from the `?runs=N` search). */
  runs?: number;
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

export function Simulator({
  initialConfig,
  initialPlay,
  view = "edit",
  configId,
  runs,
}: SimulatorProps) {
  const navigate = useNavigate();
  const isResults = view === "results";
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
  // how many possessions submitting simulates in one go
  const [runCount, setRunCount] = useState(runs ?? 100);
  // persisting the play + routing to its results view
  const [submitting, setSubmitting] = useState(false);

  const canRun = game.labPhase === "staged" || game.labPhase === "ended";

  // Submit the config: persist the staged play to its content id and route to
  // /{id}/results, which runs the batch. The results view owns the simulation,
  // so submitting doesn't run it locally — it just saves and navigates.
  const onSubmit = async () => {
    const play = game.capturePlay();
    if (!play) return;
    setSubmitting(true);
    try {
      const { id } = await savePlay(play);
      await navigate({
        to: "/$config/results",
        params: { config: id },
        search: { runs: runCount },
      });
    } catch {
      setSubmitting(false); // stay on the editor so it can be re-submitted
    }
  };

  // The Run control (count + submit) lives in the court toolbar in edit mode;
  // the results view runs the batch on mount, so it needs no control.
  const runControl = isResults ? null : (
    <>
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
        onClick={onSubmit}
        disabled={!canRun || submitting}
        title="Save this config and simulate it"
      >
        <Play data-icon="inline-start" />
        {submitting ? "Submitting…" : runCount > 1 ? `Run ×${runCount}` : "Run"}
      </Button>
    </>
  );

  // Staging tools live under the court board in edit mode; the results view is
  // playback-only, so it has no tools.
  const courtTools = isResults ? null : (
    <CourtTools
      labPhase={game.labPhase}
      labTool={game.labTool}
      onToolChange={game.setLabTool}
      onClearPaths={game.clearLabPaths}
    />
  );

  // Back from the results view to the editor for that same config (or the fresh
  // editor if we arrived without a saved id).
  const onBack = () => {
    if (configId) void navigate({ to: "/$config", params: { config: configId } });
    else void navigate({ to: "/" });
  };

  // ---- Results view: stage the preloaded play, then run the batch once. ----
  // Driven directly here (not via the PossessionLab, which isn't rendered in
  // results mode) so a deep-link / refresh reproduces the batch from the URL.
  const { stageLab, runLab } = game;
  const resultsStaged = useRef(false);
  const resultsRan = useRef(false);
  useEffect(() => {
    if (!isResults || !initialPlay || game.version === 0 || resultsStaged.current) return;
    resultsStaged.current = true;
    stageLab({
      offense: initialPlay.offense,
      plan: initialPlay.plan,
      defPlan: initialPlay.defPlan,
      live: initialPlay.setup?.live ?? false,
      setup: initialPlay.setup ?? null,
    });
  }, [isResults, initialPlay, game.version, stageLab]);
  useEffect(() => {
    if (!isResults || game.labPhase !== "staged" || resultsRan.current) return;
    resultsRan.current = true;
    runLab(runs ?? runCount);
  }, [isResults, game.labPhase, runLab, runs, runCount]);

  // The results view replaces the Teams / Play Lab tabs with the outcome list;
  // the court + play-by-play stay to play back a chosen run.
  const showPlays = isResults;

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
        {isResults && (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 gap-2"
            onClick={onBack}
            title="Edit this config and re-submit"
          >
            <ArrowLeft data-icon="inline-start" />
            Back
          </Button>
        )}
        <h1 className="text-xl font-semibold">Fable Fieldhouse</h1>
        <span className="text-sm text-muted-foreground">
          {isResults ? "Results" : "Play Lab"}
        </span>
        {names.length === 2 && (
          <span className="ml-auto text-sm text-muted-foreground">
            {names[0].name} vs {names[1].name}
          </span>
        )}
        <div className={`flex items-center gap-2 ${names.length === 2 ? "" : "ml-auto"}`}>
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
        {showPlays ? (
          game.simOutcomes.length > 0 ? (
            <BatchOutcomes
              outcomes={game.simOutcomes}
              activeSimId={game.activeSimId}
              durationMs={game.simDurationMs}
              onSelect={game.playRun}
              className="min-h-0 flex-1"
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
              {game.simulating ? "Simulating…" : "Preparing simulation…"}
            </div>
          )
        ) : (
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
                onEdit={game.editPlayer}
                onSwap={game.swapPlayer}
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
                onStage={game.stageLab}
                onUpdatePlans={game.updateLabPlans}
                registerCourtEdit={game.registerCourtEdit}
                hoveredAction={game.hoveredAction}
                onHighlightAction={game.setActionHighlight}
                /* the initial newGame bumps version 0→1 and remounts this
                   designer — keep the preloaded play through that remount so
                   a saved config's formation, routes, and plans survive.
                   Later bumps (roster swaps) reset to a clean designer. */
                initialPlay={game.version <= 1 ? initialPlay : undefined}
              />
            </ScrollArea>
          </TabsContent>
        </Tabs>
        )}

        <div className="relative flex flex-col justify-center gap-4">
          <ShotClock
            snapshot={snapshot}
            editable={!isResults}
            value={game.labShotClock}
            onChange={game.setLabShotClock}
          />
          <Court
            canvasRef={game.canvasRef}
            playing={game.playing}
            speed={game.speed}
            canReplay={game.hasReplay}
            onTogglePlay={game.togglePlay}
            onReplay={game.replay}
            onExport={game.exportReplay}
            onSetSpeed={game.setSpeed}
            runControl={runControl}
            tools={courtTools}
          />
          {isResults && (
            <Feed
              events={game.labEvents}
              snapshot={snapshot}
              title="Possession play-by-play"
              className="h-[220px]"
            />
          )}
        </div>
      </main>
    </div>
  );
}
