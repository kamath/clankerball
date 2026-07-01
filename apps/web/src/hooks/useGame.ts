"use client";
/* ============================================================
   useGame — owns the engine instance, the canvas renderer, and
   the rAF loop. The canvas is drawn every frame imperatively;
   React state (scoreboard, feed, box) is sampled at a low rate
   so 60fps rendering never depends on React re-renders.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import { COURT, Game, fmtClock } from "@repo/shared";
import { PAD, Renderer, SCALE, type DrawScene } from "@/lib/renderer";
import { fetchSimulation } from "@/lib/api";
import type { TeamPlan } from "@repo/shared";
import type {
  GameConfig,
  Player,
  Replay,
  ReplayFrame,
  ReplayMeta,
  SimEvent,
  SimulateRequest,
  Vec,
} from "@repo/shared";

export type LabPhase = "idle" | "config" | "staged" | "running" | "ended";
export type LabTool = "move" | "path";

const replayQLabel = (quarter: number, over: boolean) => {
  if (over) return "FINAL";
  if (quarter <= 4) return "Q" + quarter;
  const n = quarter - 4;
  return n > 1 ? "OT" + n : "OT";
};

export interface Snapshot {
  scores: [number, number];
  qLabel: string;
  clock: string;
  shotClock: number;
  shotClockActive: boolean;
  possession: number;
  over: boolean;
  labActive: boolean;
  labFrozen: boolean;
  teamMeta: { name: string; abbr: string; color: string }[];
}

export interface PossessionOpts {
  offense: number;
  /** compiled coaching instructions for the offense; null = let it flow */
  plan: TeamPlan | null;
  /** compiled instructions for the defending team; null = base man-to-man */
  defPlan: TeamPlan | null;
}

export interface BoxPlayer {
  id: number;
  number: number;
  name: string;
  player: Player;
}
export interface BoxTeam {
  name: string;
  color: string;
  players: BoxPlayer[];
}

const emptySnapshot = (): Snapshot => ({
  scores: [0, 0],
  qLabel: "Q1",
  clock: "12:00",
  shotClock: 24,
  shotClockActive: false,
  possession: 0,
  over: false,
  labActive: false,
  labFrozen: false,
  teamMeta: [],
});

export function useGame(initialConfig: GameConfig) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<Game | null>(null);
  // lab mode runs on its own sandboxed Game so the real game's score,
  // stats, and clock are untouched
  const labGameRef = useRef<Game | null>(null);
  const modeRef = useRef<"game" | "lab">("game");
  const labReadyRef = useRef(false);
  const labPhaseRef = useRef<LabPhase>("idle");
  const labToolRef = useRef<LabTool>("move");
  // the exact staged play, captured when it's run so it can be re-run
  const labSetupRef = useRef<ReturnType<Game["labCaptureSetup"]> | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const configRef = useRef<GameConfig>(initialConfig);
  const playingRef = useRef(true);
  const speedRef = useRef(2);
  const lastTRef = useRef(0);
  // recording of the current lab possession: static roster meta + one frame
  // per sim tick, captured while the staged play runs so it can be replayed
  // back exactly (the sim is random, so a re-run wouldn't reproduce it).
  const framesRef = useRef<ReplayFrame[]>([]);
  const metaRef = useRef<ReplayMeta | null>(null);
  const replayEventsRef = useRef<SimEvent[]>([]); // play-by-play of the recording
  const hasReplayRef = useRef(false);
  // replay playback state (playback reuses playingRef/speedRef for pause/speed)
  const replayingRef = useRef(false);
  const replayTimeRef = useRef(0);

  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [labEvents, setLabEvents] = useState<SimEvent[]>([]);
  const [labPhase, setLabPhaseState] = useState<LabPhase>("idle");
  const [labTool, setLabToolState] = useState<LabTool>("move");
  // resolved on-court role label per offensive roster slot (HANDLER, SPACE…)
  const [labRoles, setLabRoles] = useState<(string | null)[]>([]);
  const [boxTeams, setBoxTeams] = useState<BoxTeam[]>([]);
  // standing coaching plans for the real game, re-applied on a new game
  const plansRef = useRef<(TeamPlan | null)[]>([null, null]);
  const [teamPlans, setTeamPlans] = useState<(TeamPlan | null)[]>([null, null]);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeedState] = useState(2);
  const [version, setVersion] = useState(0); // bumps when a new game is built
  const [replaying, setReplaying] = useState(false);
  const [hasReplay, setHasReplay] = useState(false); // a recording is available
  const [simulating, setSimulating] = useState(false); // backend sim in flight

  const sampleSnapshot = useCallback((game: Game): Snapshot => {
    const sc = Math.max(0, Math.ceil(game.shotClock));
    return {
      scores: [game.teams[0].score, game.teams[1].score],
      qLabel: game.over ? "FINAL" : game.qLabel(),
      clock: fmtClock(game.gameClock),
      shotClock: sc,
      shotClockActive: game.shotClockActive,
      possession: game.possession,
      over: game.over,
      labActive: game.lab != null,
      labFrozen: game.frozen,
      teamMeta: game.teams.map((t) => ({ name: t.name, abbr: t.abbr, color: t.color })),
    };
  }, []);

  const sampleBox = useCallback((game: Game): BoxTeam[] => {
    return game.teams.map((t) => ({
      name: t.name,
      color: t.color,
      players: t.players.map((p) => ({ id: p.id, number: p.number, name: p.name, player: p })),
    }));
  }, []);

  // reconstruct a drawable scene for one recorded frame
  const buildScene = useCallback((meta: ReplayMeta, fr: ReplayFrame): DrawScene => {
    const t0 = meta.teams[0].players.length;
    const players = meta.teams.map((t, ti) =>
      t.players.map((pp, si) => {
        const f = fr.players[ti === 0 ? si : t0 + si];
        return {
          pos: { x: f.x, y: f.y },
          heightIn: pp.heightIn,
          number: pp.number,
          name: pp.name,
          annotation: pp.annotation,
          path: null,
        };
      })
    );
    const h = fr.ball.holder;
    const holder = h < 0 ? null : h < t0 ? players[0][h] : players[1][h - t0];
    return {
      // truthy so the renderer draws the lab role labels above players
      lab: {},
      teams: meta.teams.map((t, ti) => ({
        name: t.name,
        score: fr.scores[ti],
        color: t.color,
        players: players[ti],
      })),
      ball: { pos: { x: fr.ball.x, y: fr.ball.y }, air: fr.ball.air, holder },
      phase: fr.phase,
      inb: null,
      over: fr.over,
    };
  }, []);

  const replaySnapshot = useCallback(
    (meta: ReplayMeta, fr: ReplayFrame): Snapshot => ({
      scores: fr.scores,
      qLabel: replayQLabel(fr.quarter, fr.over),
      clock: fmtClock(fr.clock),
      shotClock: Math.max(0, Math.ceil(fr.shot)),
      shotClockActive: fr.shotActive,
      possession: fr.poss,
      over: fr.over,
      labActive: false,
      labFrozen: false,
      teamMeta: meta.teams.map((t) => ({ name: t.name, abbr: t.abbr, color: t.color })),
    }),
    []
  );

  const newGame = useCallback(
    (config?: GameConfig) => {
      if (config) configRef.current = config;
      const cfg = configRef.current;
      setEvents([]);
      const game = new Game(cfg, {
        onEvent: (e) => setEvents((prev) => (prev.length > 250 ? [e, ...prev.slice(0, 250)] : [e, ...prev])),
      });
      gameRef.current = game;
      // standing instructions carry over into the new game
      plansRef.current.forEach((plan, ti) => {
        if (plan) game.setPlan(ti, plan);
      });
      // a new game always exits the lab
      modeRef.current = "game";
      labGameRef.current = null;
      labPhaseRef.current = "idle";
      setLabPhaseState("idle");
      setLabEvents([]);
      rendererRef.current?.setTeams([cfg.teamA.color, cfg.teamB.color]);
      // drop any recorded possession from the previous matchup
      framesRef.current = [];
      metaRef.current = null;
      hasReplayRef.current = false;
      setHasReplay(false);
      replayingRef.current = false;
      replayTimeRef.current = 0;
      setReplaying(false);
      setSnapshot(sampleSnapshot(game));
      setBoxTeams(sampleBox(game));
      setVersion((v) => v + 1);
      playingRef.current = true;
      setPlaying(true);
    },
    [sampleSnapshot, sampleBox]
  );

  // Initialize renderer + first game once the canvas mounts.
  useEffect(() => {
    if (!canvasRef.current) return;
    rendererRef.current = new Renderer(canvasRef.current);
    newGame(configRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lab editing: drag players / draw motion paths on the staged court.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
    let dragP: Player | null = null;
    let pathP: Player | null = null;
    let pts: Vec[] = [];

    const toCourt = (e: PointerEvent): Vec => {
      const rect = cv.getBoundingClientRect();
      const lw = COURT.W * SCALE + PAD * 2;
      const lh = COURT.H * SCALE + PAD * 2;
      return {
        x: (((e.clientX - rect.left) / rect.width) * lw - PAD) / SCALE,
        y: (((e.clientY - rect.top) / rect.height) * lh - PAD) / SCALE,
      };
    };

    const down = (e: PointerEvent) => {
      const lab = labGameRef.current;
      if (modeRef.current !== "lab" || !lab || labPhaseRef.current !== "staged") return;
      const c = toCourt(e);
      let best: Player | null = null,
        bd = 2.6;
      for (const p of lab.allPlayers()) {
        const d = Math.hypot(p.pos.x - c.x, p.pos.y - c.y);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      if (!best) return;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      if (labToolRef.current === "path") {
        if (best.team !== lab.possession) return; // routes are for the offense
        pathP = best;
        pts = [{ x: best.pos.x, y: best.pos.y }];
        best.path = pts;
        best.pathIdx = 0;
      } else {
        // the inbounder is throwing it in from out of bounds — he stays put
        if (lab.inb && best === lab.inb.inbounder) return;
        dragP = best;
      }
    };

    const move = (e: PointerEvent) => {
      if (dragP) {
        const c = toCourt(e);
        dragP.pos.x = clamp(c.x, -2.5, COURT.W + 2.5);
        dragP.pos.y = clamp(c.y, -2.5, COURT.H + 2.5);
        dragP.vel = { x: 0, y: 0 };
        // the route starts where the player stands, so drag its base along
        if (dragP.path && dragP.path.length) {
          dragP.path[0] = { x: dragP.pos.x, y: dragP.pos.y };
        }
      } else if (pathP) {
        const c = toCourt(e);
        const last = pts[pts.length - 1];
        if (Math.hypot(c.x - last.x, c.y - last.y) > 2) {
          pts.push({ x: clamp(c.x, 1, COURT.W - 1), y: clamp(c.y, 1, COURT.H - 1) });
        }
      }
    };

    const up = () => {
      const lab = labGameRef.current;
      if (dragP && lab) lab.setHoldSpot(dragP);
      if (pathP && pts.length < 2) pathP.path = null; // a tap, not a route
      dragP = null;
      pathP = null;
      pts = [];
    };

    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    return () => {
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
    };
  }, []);

  // The animation + simulation loop.
  useEffect(() => {
    let raf = 0;
    let snapAccum = 0;
    let boxAccum = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const inLab = modeRef.current === "lab" && labGameRef.current;
      const game = inLab ? labGameRef.current! : gameRef.current;
      const renderer = rendererRef.current;
      if (!game || !renderer) return;
      const last = lastTRef.current || now;
      const real = Math.min(0.1, (now - last) / 1000);
      lastTRef.current = now;

      // ---- Replay: play recorded frames back, no simulation ----
      if (replayingRef.current) {
        const meta = metaRef.current;
        const frames = framesRef.current;
        if (meta && frames.length) {
          if (playingRef.current) replayTimeRef.current += real * speedRef.current;
          let idx = Math.floor(replayTimeRef.current / meta.dt);
          if (idx >= frames.length - 1) {
            idx = frames.length - 1;
            if (playingRef.current) {
              playingRef.current = false; // hold on the final frame
              setPlaying(false);
            }
          }
          const fr = frames[idx];
          renderer.draw(buildScene(meta, fr), real);
          snapAccum += real;
          if (snapAccum > 0.1) {
            snapAccum = 0;
            setSnapshot(replaySnapshot(meta, fr));
          }
        }
        return;
      }

      // The live game steps here; a staged lab formation is frozen, so its
      // step() is a no-op — the possession itself is simulated on the backend
      // and played back through the replay branch above.
      if (playingRef.current && !game.over) {
        let sim = real * speedRef.current;
        while (sim > 0) {
          const s = Math.min(sim, 1 / 30);
          game.step(s);
          sim -= s;
        }
      }
      renderer.draw(game, real);

      snapAccum += real;
      if (snapAccum > 0.1) {
        snapAccum = 0;
        setSnapshot(sampleSnapshot(game));
      }
      boxAccum += real;
      if (boxAccum > 0.25) {
        boxAccum = 0;
        // box score always reflects the real game, not the lab sandbox
        if (gameRef.current) setBoxTeams(sampleBox(gameRef.current));
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [sampleSnapshot, sampleBox, buildScene, replaySnapshot]);

  const togglePlay = useCallback(() => {
    // hitting play on a replay that has run to the end restarts it
    if (replayingRef.current && !playingRef.current && metaRef.current) {
      const end = (framesRef.current.length - 1) * metaRef.current.dt;
      if (replayTimeRef.current >= end) replayTimeRef.current = 0;
    }
    playingRef.current = !playingRef.current;
    setPlaying(playingRef.current);
  }, []);

  /** Restart playback of the recorded possession from its first frame. */
  const replay = useCallback(() => {
    if (!metaRef.current || framesRef.current.length === 0) return;
    replayTimeRef.current = 0;
    replayingRef.current = true;
    setReplaying(true);
    playingRef.current = true;
    setPlaying(true);
    setSnapshot(replaySnapshot(metaRef.current, framesRef.current[0]));
  }, [replaySnapshot]);

  /** Download the recorded possession (roster + every frame) as JSON. */
  const exportReplay = useCallback(() => {
    if (!metaRef.current || framesRef.current.length === 0) return;
    const data: Replay = {
      meta: metaRef.current,
      frames: framesRef.current,
      events: replayEventsRef.current,
    };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "possession.json";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const setSpeed = useCallback((s: number) => {
    speedRef.current = s;
    setSpeedState(s);
  }, []);

  const setLabPhase = useCallback((p: LabPhase) => {
    labPhaseRef.current = p;
    setLabPhaseState(p);
  }, []);

  /** Stage a possession in a fresh sandboxed game (real game untouched):
      players snap into formation and the court is immediately editable — drag
      players and draw routes right away. Changing a config control (offense,
      start, inbounder, scorers) re-stages a clean formation, which resets the
      spots and clears the routes; the defense re-shapes in place. */
  const stageLab = useCallback(
    (opts: PossessionOpts) => {
      replayingRef.current = false; // entering the lab leaves any replay
      setReplaying(false);
      framesRef.current = []; // a fresh formation invalidates the old recording
      hasReplayRef.current = false;
      setHasReplay(false);
      labReadyRef.current = false; // mute events until the play actually runs
      labSetupRef.current = null; // a fresh stage drops any captured re-run
      const lab = new Game(configRef.current, {
        onEvent: (e) => {
          if (!labReadyRef.current) return;
          setLabEvents((prev) => (prev.length > 100 ? [e, ...prev.slice(0, 100)] : [e, ...prev]));
        },
      });
      lab.runPossession({ offense: opts.offense, plan: opts.plan, defPlan: opts.defPlan });
      lab.frozen = true; // hold the formation for editing
      labGameRef.current = lab;
      // surface the engine's resolved roles so the UI can show them
      setLabRoles(lab.teams[opts.offense].players.map((p) => p.annotation));
      setLabEvents([]);
      modeRef.current = "lab";
      setLabPhase("staged");
      playingRef.current = true;
      setPlaying(true);
      setSnapshot(sampleSnapshot(lab));
    },
    [sampleSnapshot, setLabPhase]
  );

  /** Load a possession the backend just simulated and start playing it back
      through the replay path. The lab sandbox stays as-is; playback draws
      straight from the recorded frames. */
  const loadReplay = useCallback(
    (rep: Replay) => {
      metaRef.current = rep.meta;
      framesRef.current = rep.frames;
      replayEventsRef.current = rep.events;
      const has = rep.frames.length > 0;
      hasReplayRef.current = has;
      setHasReplay(has);
      // newest-first, matching how the live feed prepended events
      setLabEvents([...rep.events].reverse());
      setLabPhase("ended");
      replayTimeRef.current = 0;
      replayingRef.current = true;
      setReplaying(true);
      playingRef.current = true;
      setPlaying(true);
      if (has) setSnapshot(replaySnapshot(rep.meta, rep.frames[0]));
    },
    [replaySnapshot, setLabPhase]
  );

  /** Ship a staged possession to the backend Worker, which runs the actual
      simulation and returns the recorded replay; then play it back. */
  const runSimulation = useCallback(
    async (payload: SimulateRequest) => {
      setSimulating(true);
      try {
        const rep = await fetchSimulation(payload);
        loadReplay(rep);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "simulation failed";
        setLabEvents((prev) => [
          { type: "info", text: `Simulation failed: ${msg}`, team: null, qLabel: "", clock: "" },
          ...prev,
        ]);
        // stay staged so the play can be tweaked and re-run
        setLabPhase("staged");
      } finally {
        setSimulating(false);
      }
    },
    [loadReplay, setLabPhase]
  );

  /** Capture the staged play and simulate it on the backend. */
  const runLab = useCallback(() => {
    const lab = labGameRef.current;
    if (!lab || labPhaseRef.current !== "staged" || simulating) return;
    const setup = lab.labCaptureSetup();
    labSetupRef.current = setup;
    const offense = setup.labTeam;
    setLabRoles(lab.teams[offense].players.map((p) => p.annotation));
    setLabEvents([]);
    void runSimulation({
      config: configRef.current,
      offense,
      plan: lab.tactics[offense].plan ?? null,
      defPlan: lab.tactics[1 - offense].plan ?? null,
      setup,
    });
  }, [runSimulation, simulating]);

  /** Re-simulate the exact same authored play (fresh random outcome). */
  const reRunLab = useCallback(() => {
    const lab = labGameRef.current;
    const setup = labSetupRef.current;
    if (!lab || !setup || labPhaseRef.current !== "ended" || simulating) return;
    const offense = setup.labTeam;
    setLabRoles(lab.teams[offense].players.map((p) => p.annotation));
    setLabEvents([]);
    void runSimulation({
      config: configRef.current,
      offense,
      plan: lab.tactics[offense].plan ?? null,
      defPlan: lab.tactics[1 - offense].plan ?? null,
      setup,
    });
  }, [runSimulation, simulating]);

  /** Erase all authored motion paths on the staged formation. */
  const clearLabPaths = useCallback(() => {
    const lab = labGameRef.current;
    if (!lab) return;
    for (const t of lab.teams) {
      for (const p of t.players) {
        p.path = null;
        p.pathIdx = 0;
      }
    }
  }, []);

  const setLabTool = useCallback((t: LabTool) => {
    labToolRef.current = t;
    setLabToolState(t);
  }, []);

  /** Give a team standing coaching instructions for the real game. The
      engine starts optimizing for them on its next possession; they also
      carry over to new games. */
  const setTeamPlan = useCallback((teamIdx: number, plan: TeamPlan | null) => {
    plansRef.current[teamIdx] = plan;
    setTeamPlans([...plansRef.current]);
    gameRef.current?.setPlan(teamIdx, plan);
  }, []);

  /** Leave the lab; the real game continues exactly where it was. */
  const exitLab = useCallback(() => {
    modeRef.current = "game";
    labGameRef.current = null;
    replayingRef.current = false; // switching to the live game stops replay
    setReplaying(false);
    setLabPhase("idle");
    setLabEvents([]);
    const game = gameRef.current;
    if (game) setSnapshot(sampleSnapshot(game));
  }, [sampleSnapshot, setLabPhase]);

  /** Mutate a live player's field in place (engine reads the same object). */
  const editPlayer = useCallback((teamIdx: number, slot: number, mutate: (p: Player) => void) => {
    const game = gameRef.current;
    if (!game) return;
    const live = game.teams[teamIdx]?.players[slot];
    if (live) mutate(live);
    // keep the source config in sync so a re-sim preserves the edit
    const cfgPlayer = (teamIdx === 0 ? configRef.current.teamA : configRef.current.teamB).players[slot];
    if (cfgPlayer) mutate(cfgPlayer as unknown as Player);
    setBoxTeams(sampleBox(game));
  }, [sampleBox]);

  return {
    canvasRef,
    snapshot,
    events,
    labEvents,
    labPhase,
    labTool,
    labRoles,
    boxTeams,
    playing,
    speed,
    version,
    replaying,
    hasReplay,
    simulating,
    replay,
    exportReplay,
    newGame,
    togglePlay,
    setSpeed,
    editPlayer,
    stageLab,
    runLab,
    reRunLab,
    exitLab,
    clearLabPaths,
    setLabTool,
    teamPlans,
    setTeamPlan,
    getConfig: () => configRef.current,
  };
}
