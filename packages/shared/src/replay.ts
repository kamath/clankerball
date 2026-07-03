/* ============================================================
   replay.ts — the serializable output of a simulated possession
   plus the headless driver that produces it.

   The sim uses Math.random() throughout, so a possession can't be
   reproduced by re-running it. Instead we record the exact position
   of every player and the ball on each sim tick, plus the scoreboard,
   and play those frames back. This is the payload the backend Worker
   returns and the web client plays back through its replay path.
   ============================================================ */
import type { GameConfig, SimEvent } from "./types";
import type { TeamPlan } from "./plan";
import { Game, type LabSetup } from "./engine";

/** sim seconds represented by each recorded frame (one frame per tick) */
export const STEP = 1 / 30;

/** Safety bound so a pathological possession can't spin forever on the
    Worker. 3000 frames = 100 sim-seconds, far beyond any real possession. */
const MAX_FRAMES = 3000;

export interface ReplayFrame {
  /** [x, y] per player, ordered team0 slots 0-4 then team1 slots 0-4 */
  players: { x: number; y: number }[];
  /** ball position, elevation, and holder (global player index, -1 if loose) */
  ball: { x: number; y: number; air: number; holder: number };
  scores: [number, number];
  clock: number;
  shot: number;
  shotActive: boolean;
  poss: number;
  quarter: number;
  phase: "setup" | "live" | "over";
  over: boolean;
}

export interface ReplayMeta {
  /** sim seconds represented by each frame */
  dt: number;
  teams: {
    name: string;
    abbr: string;
    color: string;
    players: { number: number; name: string; heightIn: number; annotation: string | null }[];
  }[];
}

export interface Replay {
  meta: ReplayMeta;
  frames: ReplayFrame[];
  /** Play-by-play emitted while the possession ran, oldest first. */
  events: SimEvent[];
}

/** Roster/scoreboard metadata needed to draw a recorded possession. */
export function captureMeta(game: Game): ReplayMeta {
  return {
    dt: STEP,
    teams: game.teams.map((t) => ({
      name: t.name,
      abbr: t.abbr,
      color: t.color,
      players: t.players.map((p) => ({
        number: p.number,
        name: p.name,
        heightIn: p.heightIn,
        annotation: p.annotation,
      })),
    })),
  };
}

/** Append one frame capturing exactly what's on the court this tick. */
export function captureFrame(game: Game): ReplayFrame {
  const all = game.allPlayers();
  return {
    players: all.map((p) => ({ x: p.pos.x, y: p.pos.y })),
    ball: {
      x: game.ball.pos.x,
      y: game.ball.pos.y,
      air: game.ball.air || 0,
      holder: game.ball.holder ? all.indexOf(game.ball.holder) : -1,
    },
    scores: [game.teams[0].score, game.teams[1].score],
    clock: game.gameClock,
    shot: game.shotClock,
    shotActive: game.shotClockActive,
    poss: game.possession,
    quarter: game.quarter,
    phase: game.phase,
    over: game.over,
  };
}

/** The input needed to reproduce a staged lab possession headlessly. */
export interface SimulateRequest {
  config: GameConfig;
  offense: number;
  plan: TeamPlan | null;
  defPlan: TeamPlan | null;
  setup: LabSetup;
}

/* ============================================================
   simulatePossession — rebuild a staged possession from scratch and
   run it to completion, recording every frame. Mirrors the client's
   stageLab + reRunLab: runPossession establishes the tactics/roles,
   labReplaySetup drops every player onto the authored spot with his
   route reset, then we step at a fixed dt until the engine freezes
   itself (possession over). The design is replayed exactly; the
   random outcome is drawn here on the server.
   ============================================================ */
export function simulatePossession(input: SimulateRequest): Replay {
  const { config, offense, plan, defPlan, setup } = input;
  // Only collect events emitted once the play is actually running — the setup
  // calls below emit lab/info chatter the client mutes while staging.
  const events: SimEvent[] = [];
  let recording = false;
  const game = new Game(config, { onEvent: (e) => recording && events.push(e) });
  game.runPossession({ offense, plan, defPlan });
  game.labReplaySetup(setup);
  game.frozen = false;
  recording = true;

  const meta = captureMeta(game);
  const frames: ReplayFrame[] = [];
  while (!game.frozen && frames.length < MAX_FRAMES) {
    game.step(STEP);
    frames.push(captureFrame(game));
  }
  return { meta, frames, events };
}

/* The play-by-play events that resolve a possession, newest wins. A possession
   ends on exactly one of these; passes/rebounds/info are just chatter. */
const DECISIVE_EVENTS = new Set([
  "score",
  "dunk",
  "miss",
  "block",
  "steal",
  "turnover",
  "freethrow",
]);

/** Distill a recorded possession into a one-line result for the play library:
    the outcome text (verbatim from the play-by-play) and the points the offense
    scored. Used to index a saved play so its outcome can be shown without
    loading the full replay. */
export function summarizePossession(
  offense: number,
  replay: Replay
): { result: string; points: number } {
  const { frames, events } = replay;
  const points = frames.length
    ? frames[frames.length - 1].scores[offense] - frames[0].scores[offense]
    : 0;
  // walk back to the possession's terminal event; fall back to the last line.
  let outcome: SimEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if (DECISIVE_EVENTS.has(events[i].type)) {
      outcome = events[i];
      break;
    }
  }
  const result = outcome?.text ?? events[events.length - 1]?.text ?? "No result";
  return { result, points };
}
