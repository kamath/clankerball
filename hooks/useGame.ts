"use client";
/* ============================================================
   useGame — owns the engine instance, the canvas renderer, and
   the rAF loop. The canvas is drawn every frame imperatively;
   React state (scoreboard, feed, box) is sampled at a low rate
   so 60fps rendering never depends on React re-renders.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import { COURT, Game, fmtClock } from "@/lib/engine";
import { PAD, Renderer, SCALE } from "@/lib/renderer";
import type {
  DefScheme,
  GameConfig,
  InboundLoc,
  Player,
  SimEvent,
  Vec,
} from "@/lib/types";

export type LabPhase = "idle" | "config" | "staged" | "running" | "ended";
export type LabTool = "move" | "path";

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
  defScheme: DefScheme;
  start: InboundLoc;
  /** offensive roster slots to score through, in priority order */
  scorers: number[];
  inbounder: number | null;
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

  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [labEvents, setLabEvents] = useState<SimEvent[]>([]);
  const [labPhase, setLabPhaseState] = useState<LabPhase>("idle");
  const [labTool, setLabToolState] = useState<LabTool>("move");
  // resolved on-court role label per offensive roster slot (HANDLER, SPACE…)
  const [labRoles, setLabRoles] = useState<(string | null)[]>([]);
  const [boxTeams, setBoxTeams] = useState<BoxTeam[]>([]);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeedState] = useState(2);
  const [version, setVersion] = useState(0); // bumps when a new game is built

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

  const newGame = useCallback(
    (config?: GameConfig) => {
      if (config) configRef.current = config;
      const cfg = configRef.current;
      setEvents([]);
      const game = new Game(cfg, {
        onEvent: (e) => setEvents((prev) => (prev.length > 250 ? [e, ...prev.slice(0, 250)] : [e, ...prev])),
      });
      gameRef.current = game;
      // a new game always exits the lab
      modeRef.current = "game";
      labGameRef.current = null;
      labPhaseRef.current = "idle";
      setLabPhaseState("idle");
      setLabEvents([]);
      rendererRef.current?.setTeams([cfg.teamA.color, cfg.teamB.color]);
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

      if (playingRef.current && !game.over) {
        let sim = real * speedRef.current;
        while (sim > 0) {
          const s = Math.min(sim, 1 / 30);
          game.step(s);
          sim -= s;
        }
      }
      // the lab possession just ended (engine froze itself)
      if (inLab && game.frozen && labPhaseRef.current === "running") {
        labPhaseRef.current = "ended";
        setLabPhaseState("ended");
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
  }, [sampleSnapshot, sampleBox]);

  const togglePlay = useCallback(() => {
    playingRef.current = !playingRef.current;
    setPlaying(playingRef.current);
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
      labReadyRef.current = false; // mute events until the play actually runs
      labSetupRef.current = null; // a fresh stage drops any captured re-run
      const lab = new Game(configRef.current, {
        onEvent: (e) => {
          if (!labReadyRef.current) return;
          setLabEvents((prev) => (prev.length > 100 ? [e, ...prev.slice(0, 100)] : [e, ...prev]));
        },
      });
      lab.runPossession({ ...opts, inbounderSlot: opts.inbounder });
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

  /** Let the staged possession play out, remembering the exact setup first so
      it can be re-run. */
  const runLab = useCallback(() => {
    const lab = labGameRef.current;
    if (!lab || labPhaseRef.current !== "staged") return;
    labSetupRef.current = lab.labCaptureSetup();
    labReadyRef.current = true;
    lab.frozen = false;
    setLabPhase("running");
    playingRef.current = true;
    setPlaying(true);
  }, [setLabPhase]);

  /** Run the exact same play again from the spots and routes you authored. */
  const reRunLab = useCallback(() => {
    const lab = labGameRef.current;
    const setup = labSetupRef.current;
    if (!lab || !setup || labPhaseRef.current !== "ended") return;
    lab.labReplaySetup(setup);
    setLabRoles(lab.teams[setup.labTeam].players.map((p) => p.annotation));
    setLabEvents([]);
    labReadyRef.current = true;
    setLabPhase("running");
    playingRef.current = true;
    setPlaying(true);
    setSnapshot(sampleSnapshot(lab));
  }, [sampleSnapshot, setLabPhase]);

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

  /** Swap the defensive scheme in place — only the defense re-shapes, the
      offense and any authored moves/paths are left exactly as they are. */
  const setLabDefense = useCallback(
    (scheme: DefScheme) => {
      const lab = labGameRef.current;
      if (!lab) return;
      lab.labSetDefense(scheme);
      setSnapshot(sampleSnapshot(lab));
    },
    [sampleSnapshot]
  );

  /** Leave the lab; the real game continues exactly where it was. */
  const exitLab = useCallback(() => {
    modeRef.current = "game";
    labGameRef.current = null;
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
    setLabDefense,
    getConfig: () => configRef.current,
  };
}
