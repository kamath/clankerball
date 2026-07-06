"use client";
/* ============================================================
   useGame — owns the engine instance, the canvas renderer, and
   the rAF loop. The canvas is drawn every frame imperatively;
   React state (scoreboard, feed, box) is sampled at a low rate
   so 60fps rendering never depends on React re-renders.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import { COURT, Game, fmtClock } from "@repo/shared";
import { PAD, Renderer, SCALE, type DrawScene, type OverlayGlyph } from "@/lib/renderer";
import { fetchSimReplay, fetchSimulation } from "@/lib/api";
import type { PlanAction, TeamPlan } from "@repo/shared";
import type {
  Contribution,
  GameConfig,
  LabSetup,
  Player,
  PlayerConfig,
  Replay,
  ReplayFrame,
  ReplayMeta,
  SimArtifact,
  SimEvent,
  SimulateRequest,
  Vec,
} from "@repo/shared";

export type LabPhase = "idle" | "config" | "staged" | "running" | "ended";
export type LabTool = "move" | "path" | "screen" | "post" | "iso";

/** A plan edit authored by a court gesture, applied to the sidebar's plan. */
export type CourtPlanEdit =
  | { kind: "add"; action: PlanAction }
  | { kind: "remove"; index: number }
  | { kind: "clear" };

/** The distilled result of one simulated possession — the play-by-play outcome
    line, the points the offense scored, and the run's simId (the handle used to
    pull its Replay from R2 to play it back). One per run of a Run ×N batch. */
export interface SimOutcome {
  simId: string;
  result: string;
  points: number;
}

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
  /** start the possession live (the offense already holds the ball in the
      frontcourt, clock running) instead of from an inbound. */
  live?: boolean;
  /** an authored formation to restore onto the staged possession (exact
      positions + routes). Used to preload a shared play; null = a clean stage. */
  setup?: LabSetup | null;
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
  // starting shot-clock (1–24) the staged possession runs with; ref so stageLab
  // reads the latest without re-creating the callback
  const shotClockRef = useRef(24);
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
  const replayContribsRef = useRef<Contribution[]>([]); // structured contributions, FK'd to events
  const hasReplayRef = useRef(false);
  // replay playback state (playback reuses playingRef/speedRef for pause/speed)
  const replayingRef = useRef(false);
  const replayTimeRef = useRef(0);

  // court-authored plan edits are applied by whoever owns the plan state
  // (PossessionLab registers its handler here)
  const courtEditRef = useRef<((edit: CourtPlanEdit) => void) | null>(null);

  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [events, setEvents] = useState<SimEvent[]>([]);
  // plan-action index whose glyphs the pointer is over (drives sidebar glow)
  const [hoveredAction, setHoveredAction] = useState<number | null>(null);
  const [labEvents, setLabEvents] = useState<SimEvent[]>([]);
  const [labPhase, setLabPhaseState] = useState<LabPhase>("idle");
  const [labTool, setLabToolState] = useState<LabTool>("move");
  // editable starting shot clock shown above the court in the lab
  const [labShotClock, setLabShotClockState] = useState(24);
  // resolved on-court role label per offensive roster slot (HANDLER, SPACE…)
  const [labRoles, setLabRoles] = useState<(string | null)[]>([]);
  const [boxTeams, setBoxTeams] = useState<BoxTeam[]>([]);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeedState] = useState(2);
  const [version, setVersion] = useState(0); // bumps when a new game is built
  const [replaying, setReplaying] = useState(false);
  const [hasReplay, setHasReplay] = useState(false); // a recording is available
  const [simulating, setSimulating] = useState(false); // backend sim in flight
  // one outcome per run of the last batch; length > 1 means a Run ×N was fired
  const [simOutcomes, setSimOutcomes] = useState<SimOutcome[]>([]);
  // the full normalized analytics artifact for the last batch (players +
  // possessions + events + contributions + aggregate), for the Aggregate tab
  const [simArtifact, setSimArtifact] = useState<SimArtifact | null>(null);
  // simId of the run currently loaded on the court, so the list can mark it
  const [activeSimId, setActiveSimId] = useState<string | null>(null);
  // wall-clock ms the last batch took to compute (round-trip to the backend)
  const [simDurationMs, setSimDurationMs] = useState<number | null>(null);

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

  /** Build the staged plan's action diagram (screens, rolls, cuts) from the
      lab game. Glyphs reference live Player objects, so the arrows track
      drags; recomputed whenever the plan changes or the lab restages. Also
      reports which players an action owns (their routes draw dimmed, since
      the engine gives the action precedence over an authored route). */
  const computePlanOverlay = useCallback(
    (lab: Game): { glyphs: OverlayGlyph[] | null; owned: Player[] } => {
      const off = lab.possession;
      const plan = lab.tactics[off]?.plan;
      const owned: Player[] = [];
      if (!plan?.actions.length) return { glyphs: null, owned };
      const ps = lab.teams[off].players;
      const hoop = lab.hoops[off];
      const roles = lab.roles;
      const glyphs: OverlayGlyph[] = [];
      plan.actions.forEach((a, i) => {
        if (a.type === "pickAndRoll") {
          const handler = (a.handlerSlot != null ? ps[a.handlerSlot] : roles.handler) ?? null;
          const screener = (a.screenerSlot != null ? ps[a.screenerSlot] : roles.screener) ?? null;
          if (!handler || !screener || screener === handler) return;
          owned.push(screener);
          glyphs.push({ kind: "screen", from: screener, to: handler, action: i });
          const finish = a.finish ?? "roll";
          const to =
            finish === "roll"
              ? { x: hoop.x, y: hoop.y }
              : lab.spotPos(off, {
                  ax: 23,
                  ay: screener.pos.y >= COURT.H / 2 ? 9 : -9,
                  cat: "three",
                });
          glyphs.push({ kind: "cut", from: screener, to, action: i });
          glyphs.push({
            kind: "drive",
            from: handler,
            via: screener,
            to: { x: hoop.x, y: hoop.y },
            action: i,
          });
        } else if (a.type === "getOpen") {
          const target = a.targetSlot != null ? (ps[a.targetSlot] ?? null) : null;
          if (!target) return;
          // mirror the engine's screener fallback: the named one, else the best body
          let scr = a.screenerSlot != null ? (ps[a.screenerSlot] ?? null) : null;
          if (!scr || scr === target) {
            scr =
              ps
                .filter((q) => q !== target && q !== roles.handler)
                .sort(
                  (a2, b) => b.strength + b.heightIn * 2 - (a2.strength + a2.heightIn * 2)
                )[0] ?? null;
          }
          const def = lab.nearestOppTo(off, target.pos).p;
          if (scr) owned.push(scr);
          if (scr && def) glyphs.push({ kind: "screen", from: scr, to: def, action: i });
          if (def) glyphs.push({ kind: "free", from: target, away: def, action: i });
        } else if (a.type === "postUp") {
          const target = a.targetSlot != null ? (ps[a.targetSlot] ?? null) : null;
          if (!target) return;
          owned.push(target);
          const side = target.pos.y >= COURT.H / 2 ? 1 : -1;
          glyphs.push({
            kind: "cut",
            from: target,
            to: lab.spotPos(off, { ax: 4.5, ay: side * 8.6, cat: "inside" }),
            action: i,
          });
        } else if (a.type === "iso") {
          const target = a.targetSlot != null ? (ps[a.targetSlot] ?? null) : null;
          if (target) glyphs.push({ kind: "ring", on: target, action: i });
        }
      });
      return { glyphs, owned };
    },
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
      // a fresh roster always drops back to an unstaged lab
      modeRef.current = "game";
      labGameRef.current = null;
      labPhaseRef.current = "idle";
      setLabPhaseState("idle");
      setLabEvents([]);
      rendererRef.current?.setTeams([cfg.teamA.color, cfg.teamB.color]);
      rendererRef.current?.setPlanOverlay(null);
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

  // Lab editing: drag players, draw routes, and author plan actions (screen /
  // post / iso gestures, glyph select + delete) on the staged court.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
    let dragP: Player | null = null;
    let pathP: Player | null = null;
    let pts: Vec[] = [];
    let screenP: Player | null = null; // screen gesture: who sets it
    let screenOver: Player | null = null; // last teammate the drag crossed
    let lastHover: number | null = null;

    const toCourt = (e: PointerEvent): Vec => {
      const rect = cv.getBoundingClientRect();
      const lw = COURT.W * SCALE + PAD * 2;
      const lh = COURT.H * SCALE + PAD * 2;
      return {
        x: (((e.clientX - rect.left) / rect.width) * lw - PAD) / SCALE,
        y: (((e.clientY - rect.top) / rect.height) * lh - PAD) / SCALE,
      };
    };

    const authorAction = (action: PlanAction) =>
      courtEditRef.current?.({ kind: "add", action });

    const down = (e: PointerEvent) => {
      const lab = labGameRef.current;
      if (modeRef.current !== "lab" || !lab || labPhaseRef.current !== "staged") return;
      const c = toCourt(e);
      const rend = rendererRef.current;
      // the selected glyph's ✕ badge outranks everything under it
      if (labToolRef.current === "move" && rend) {
        const del = rend.hitDelete(c.x, c.y);
        if (del != null) {
          rend.setSelectedAction(null);
          courtEditRef.current?.({ kind: "remove", index: del });
          return;
        }
      }
      let best: Player | null = null,
        bd = 2.6;
      for (const p of lab.allPlayers()) {
        const d = Math.hypot(p.pos.x - c.x, p.pos.y - c.y);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      // a glyph handle wins when it's closer to the click than any player,
      // so short arrows that hug their player stay selectable
      if (labToolRef.current === "move" && rend) {
        const hit = rend.hitAction(c.x, c.y);
        const handleD = hit != null ? rend.handleDist(c.x, c.y) : Infinity;
        if (hit != null && (!best || handleD < bd)) {
          rend.setSelectedAction(hit);
          return;
        }
        if (!best) {
          rend.setSelectedAction(null);
          return;
        }
      }
      if (!best) return;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      rend?.setSelectedAction(null);
      const tool = labToolRef.current;
      if (tool === "path") {
        if (best.team !== lab.possession) return; // routes are for the offense
        pathP = best;
        pts = [{ x: best.pos.x, y: best.pos.y }];
        best.path = pts;
        best.pathIdx = 0;
      } else if (tool === "screen") {
        if (best.team !== lab.possession) return; // actions are offense-only
        screenP = best;
        screenOver = null;
        rend?.setPending({ from: best, to: { ...c }, over: null });
      } else if (tool === "post" || tool === "iso") {
        if (best.team !== lab.possession) return;
        authorAction({
          type: tool === "post" ? "postUp" : "iso",
          targetSlot: best.slot,
          handlerSlot: null,
          screenerSlot: null,
          finish: null,
        });
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
        // the ball rides with whoever's holding it (live start: the handler)
        const lab = labGameRef.current;
        if (lab && lab.ball.holder === dragP) {
          lab.ball.pos = { x: dragP.pos.x, y: dragP.pos.y };
        }
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
      } else if (screenP) {
        // screen gesture in flight: track the teammate under the pointer
        const lab = labGameRef.current;
        if (!lab) return;
        const c = toCourt(e);
        let over: Player | null = null,
          od = 2.6;
        for (const p of lab.teams[lab.possession].players) {
          if (p === screenP) continue;
          const d = Math.hypot(p.pos.x - c.x, p.pos.y - c.y);
          if (d < od) {
            od = d;
            over = p;
          }
        }
        if (over) screenOver = over;
        rendererRef.current?.setPending({
          from: screenP,
          to: { ...c },
          over: over ?? screenOver,
        });
      } else if (
        e.buttons === 0 &&
        labToolRef.current === "move" &&
        modeRef.current === "lab" &&
        labPhaseRef.current === "staged"
      ) {
        // plain hover: glow the action diagram under the pointer and tell
        // the sidebar so its matching row lights up too
        const rend = rendererRef.current;
        if (!rend) return;
        const c = toCourt(e);
        const hit = rend.hitAction(c.x, c.y);
        if (hit !== lastHover) {
          lastHover = hit;
          rend.setHighlightAction(hit);
          setHoveredAction(hit);
        }
      }
    };

    const up = (e: PointerEvent) => {
      const lab = labGameRef.current;
      if (dragP && lab) lab.setHoldSpot(dragP);
      if (pathP && pts.length < 2) pathP.path = null; // a tap, not a route
      if (screenP && lab) {
        rendererRef.current?.setPending(null);
        const B = screenOver;
        if (B && B !== screenP) {
          // dropped on the initiator → pick & roll (where the drag ended past
          // him sets the finish: toward the rim = roll, out to the arc = pop);
          // dropped on anyone else → screen to get him open
          const handlerP = lab.roles.handler ?? lab.ball.holder;
          if (B === handlerP) {
            const c = toCourt(e);
            const hoop = lab.hoops[lab.possession];
            let finish: "roll" | "pop" | null = null;
            if (Math.hypot(B.pos.x - c.x, B.pos.y - c.y) > 3) {
              const dC = Math.hypot(hoop.x - c.x, hoop.y - c.y);
              const dB = Math.hypot(hoop.x - B.pos.x, hoop.y - B.pos.y);
              finish = dC < dB - 2 ? "roll" : dC > 19 ? "pop" : null;
            }
            authorAction({
              type: "pickAndRoll",
              handlerSlot: B.slot,
              screenerSlot: screenP.slot,
              targetSlot: null,
              finish,
            });
          } else {
            authorAction({
              type: "getOpen",
              targetSlot: B.slot,
              screenerSlot: screenP.slot,
              handlerSlot: null,
              finish: null,
            });
          }
        }
      }
      dragP = null;
      pathP = null;
      screenP = null;
      screenOver = null;
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
      contributions: replayContribsRef.current,
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
      players and draw routes right away. Only formation-shaping controls
      (offense side, start mode, inbound spot/thrower) come through here; plan
      edits go through updateLabPlans and leave the formation alone. */
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
      // A preloaded setup carries its own start mode; otherwise honor the
      // control. labReplaySetup below rebuilds it exactly when a setup exists.
      const live = opts.setup?.live ?? opts.live ?? false;
      lab.runPossession({ offense: opts.offense, plan: opts.plan, defPlan: opts.defPlan, live });
      // Preloading a shared play: drop every player back on his authored spot
      // and route (labReplaySetup unfreezes, so re-freeze right after).
      if (opts.setup) {
        lab.labReplaySetup(opts.setup);
        labSetupRef.current = opts.setup; // so an immediate re-run replays it exactly
      }
      // Honor the chosen starting shot clock: a loaded play carries its own,
      // otherwise keep whatever the user last set. Frozen, so it won't tick.
      const startSc = opts.setup?.startShotClock ?? shotClockRef.current;
      lab.shotClock = startSc;
      shotClockRef.current = startSc;
      setLabShotClockState(startSc);
      lab.frozen = true; // hold the formation for editing
      labGameRef.current = lab;
      // surface the engine's resolved roles so the UI can show them
      setLabRoles(lab.teams[opts.offense].players.map((p) => p.annotation));
      // draw the plan's action diagram over the staged formation
      const ov = computePlanOverlay(lab);
      rendererRef.current?.setPlanOverlay(ov.glyphs, ov.owned);
      setHoveredAction(null);
      if (import.meta.env.DEV) (window as unknown as { __lab?: Game }).__lab = lab;
      setLabEvents([]);
      // a fresh formation drops any prior batch distribution
      setSimOutcomes([]);
      setSimArtifact(null);
      setActiveSimId(null);
      setSimDurationMs(null);
      modeRef.current = "lab";
      setLabPhase("staged");
      playingRef.current = true;
      setPlaying(true);
      setSnapshot(sampleSnapshot(lab));
    },
    [sampleSnapshot, setLabPhase, computePlanOverlay]
  );

  /** Apply edited plans onto the already-staged possession WITHOUT rebuilding
      the formation: positions, drags, and routes all stay put — only roles,
      tendencies, annotations, and the action diagram update. The defense
      re-shapes only when its scheme actually changed. Returns false when
      nothing is staged (the caller should re-stage instead). */
  const updateLabPlans = useCallback(
    (opts: { offense: number; plan: TeamPlan | null; defPlan: TeamPlan | null }): boolean => {
      const lab = labGameRef.current;
      if (!lab || modeRef.current !== "lab" || labPhaseRef.current !== "staged") return false;
      if (lab.possession !== opts.offense) return false;
      const def = 1 - opts.offense;
      const prevScheme = lab.tactics[def].defScheme;
      const prevDef = lab.tactics[def].plan;
      // setPlan → setRoles clears dragged hold-spots; those are authored
      // court state, not plan state — keep them
      const held = new Map(lab.assignTargets);
      lab.setPlan(opts.offense, opts.plan);
      lab.setPlan(def, opts.defPlan);
      lab.assignTargets = held;
      const scheme = opts.defPlan?.defScheme ?? "man";
      lab.tactics[def].defScheme = scheme;
      // re-shape (snap) the staged defenders when anything that moves them
      // changed: the scheme, pinned matchups, or the double-team assignment
      const shape = (p: TeamPlan | null | undefined) =>
        JSON.stringify([p?.matchups ?? null, p?.double ?? null]);
      if (scheme !== prevScheme || shape(prevDef) !== shape(opts.defPlan))
        lab.labSetDefense(scheme);
      // a new initiator takes over the ball: he receives the inbound, or
      // holds it where he stands on a live start
      const handler = lab.roles.handler;
      if (handler) {
        if (lab.inb && handler !== lab.inb.inbounder) {
          lab.inb.receiver = handler;
        } else if (!lab.inb && lab.ball.holder && lab.ball.holder !== handler) {
          lab.ball.holder = handler;
          lab.ballFollow();
        }
      }
      setLabRoles(lab.teams[opts.offense].players.map((p) => p.annotation));
      const ov = computePlanOverlay(lab);
      rendererRef.current?.setPlanOverlay(ov.glyphs, ov.owned);
      setHoveredAction(null);
      setSnapshot(sampleSnapshot(lab));
      return true;
    },
    [computePlanOverlay, sampleSnapshot]
  );

  /** PossessionLab (the plan owner) registers how court-authored plan edits
      (screen/post/iso gestures, glyph deletes) get applied. */
  const registerCourtEdit = useCallback((fn: ((edit: CourtPlanEdit) => void) | null) => {
    courtEditRef.current = fn;
  }, []);

  /** Sidebar hover → glow the matching arrows on the court. */
  const setActionHighlight = useCallback((i: number | null) => {
    rendererRef.current?.setHighlightAction(i);
  }, []);

  /** Set the starting shot clock (1–24) for the staged possession. Updates the
      frozen lab in place so the court reflects it immediately; the value is
      captured into the LabSetup when the play is run, so it persists with the
      saved config. */
  const setLabShotClock = useCallback(
    (v: number) => {
      if (!Number.isFinite(v)) return;
      const sc = Math.min(24, Math.max(1, Math.round(v)));
      shotClockRef.current = sc;
      setLabShotClockState(sc);
      const lab = labGameRef.current;
      if (lab && labPhaseRef.current === "staged") {
        lab.shotClock = sc;
        setSnapshot(sampleSnapshot(lab));
      }
    },
    [sampleSnapshot]
  );

  /** Load a possession the backend just simulated and start playing it back
      through the replay path. The lab sandbox stays as-is; playback draws
      straight from the recorded frames. */
  const loadReplay = useCallback(
    (rep: Replay) => {
      // playback draws recorded frames; the staged diagram doesn't apply
      rendererRef.current?.setPlanOverlay(null);
      metaRef.current = rep.meta;
      framesRef.current = rep.frames;
      replayEventsRef.current = rep.events;
      replayContribsRef.current = rep.contributions;
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
    async (payload: SimulateRequest, count = 1) => {
      setSimulating(true);
      setSimOutcomes([]);
      setSimArtifact(null);
      setActiveSimId(null);
      setSimDurationMs(null);
      try {
        // Each run returns its outcome + points + simId; frames (paths) stay in
        // R2. Time the batch round-trip so the UI can show how long it took, then
        // record every run for the Aggregate tab + possession list. Nothing is
        // auto-played: the court stays idle until the user picks a possession.
        const started = performance.now();
        const artifact = await fetchSimulation(payload, count);
        setSimDurationMs(performance.now() - started);
        // The batch now returns one normalized analytics artifact: keep the whole
        // thing for the Aggregate tab, and derive the outcome list from its rows.
        setSimArtifact(artifact);
        setSimOutcomes(
          artifact.possessions.map((r) => ({ simId: r.simId, result: r.result, points: r.points }))
        );
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
    [setLabPhase]
  );

  /** Play back a specific run from the current batch on the court: pull its
      Replay (paths + play-by-play) from R2 by simId and load it. The staged
      formation is unchanged, so the run animates over the same lineup. */
  const playRun = useCallback(
    async (simId: string) => {
      try {
        const rep = await fetchSimReplay(simId);
        setActiveSimId(simId);
        loadReplay(rep);
      } catch {
        /* the run's paths couldn't be pulled; leave the current view as-is */
      }
    },
    [loadReplay]
  );

  /** Capture the staged play and simulate it on the backend `count` times (the
      response plays back the first run; every run is recorded to the library). */
  const runLab = useCallback((count = 1) => {
    const lab = labGameRef.current;
    if (!lab || labPhaseRef.current !== "staged" || simulating) return;
    const setup = lab.labCaptureSetup();
    labSetupRef.current = setup;
    const offense = setup.labTeam;
    setLabRoles(lab.teams[offense].players.map((p) => p.annotation));
    setLabEvents([]);
    void runSimulation(
      {
        config: configRef.current,
        offense,
        plan: lab.tactics[offense].plan ?? null,
        defPlan: lab.tactics[1 - offense].plan ?? null,
        setup,
      },
      count
    );
  }, [runSimulation, simulating]);

  /** Snapshot the currently staged (or just-run) play as a SimulateRequest,
      for persisting to a shareable /play/{id} link. Returns null if nothing is
      staged yet. */
  const capturePlay = useCallback((): SimulateRequest | null => {
    const lab = labGameRef.current;
    if (!lab || labPhaseRef.current === "idle" || labPhaseRef.current === "config") return null;
    const setup = lab.labCaptureSetup();
    const offense = setup.labTeam;
    return {
      config: configRef.current,
      offense,
      plan: lab.tactics[offense].plan ?? null,
      defPlan: lab.tactics[1 - offense].plan ?? null,
      setup,
    };
  }, []);


  /** Erase everything authored on the staged court: drawn routes AND the
      plan actions the gestures compiled (routes and arrows are one diagram,
      so Clear wipes the whole diagram). Scorers/emphasis/pace are untouched. */
  const clearLabAuthoring = useCallback(() => {
    const lab = labGameRef.current;
    if (!lab) return;
    for (const t of lab.teams) {
      for (const p of t.players) {
        p.path = null;
        p.pathIdx = 0;
      }
    }
    courtEditRef.current?.({ kind: "clear" });
  }, []);

  const setLabTool = useCallback((t: LabTool) => {
    labToolRef.current = t;
    setLabToolState(t);
  }, []);

  /** Swap the player in one on-court slot for another, then rebuild the game on
      the new lineup. No-ops if that player is already on the court for either
      team (bar the slot being replaced), so nobody starts twice or faces
      himself. */
  const swapPlayer = useCallback(
    (teamIdx: number, slot: number, replacement: PlayerConfig) => {
      const cfg = configRef.current;
      const team = teamIdx === 0 ? cfg.teamA : cfg.teamB;
      if (!team) return;
      const clashes = (t: typeof cfg.teamA, isTarget: boolean) =>
        t.players.some(
          (p, i) => p.nbaId != null && p.nbaId === replacement.nbaId && !(isTarget && i === slot)
        );
      if (clashes(cfg.teamA, teamIdx === 0) || clashes(cfg.teamB, teamIdx === 1)) return;
      const players = team.players.map((p, i) => (i === slot ? structuredClone(replacement) : p));
      const nextTeam = { ...team, players };
      newGame(teamIdx === 0 ? { ...cfg, teamA: nextTeam } : { ...cfg, teamB: nextTeam });
    },
    [newGame]
  );

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
    labShotClock,
    setLabShotClock,
    boxTeams,
    playing,
    speed,
    version,
    replaying,
    hasReplay,
    simulating,
    simOutcomes,
    simArtifact,
    activeSimId,
    simDurationMs,
    replay,
    exportReplay,
    newGame,
    togglePlay,
    setSpeed,
    editPlayer,
    swapPlayer,
    stageLab,
    updateLabPlans,
    registerCourtEdit,
    setActionHighlight,
    hoveredAction,
    runLab,
    capturePlay,
    playRun,
    clearLabAuthoring,
    setLabTool,
    getConfig: () => configRef.current,
  };
}
