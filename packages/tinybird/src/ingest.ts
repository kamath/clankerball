/* ============================================================
   ingest.ts — ship a completed simulation to Tinybird.

   The engine produces a Replay (frames + play-by-play) from a
   SimulateRequest (config + staged setup). This module reshapes that
   pair into rows for the three landing Data Sources and streams them to
   the Tinybird Events API (HTTP append, one NDJSON row per line):

     simulation_runs        1 row  — the config the run used + a summary
     simulation_movements   N rows — every entity's position per frame
     simulation_events      M rows — the play-by-play, oldest first

   It is dependency-free (uses fetch) so it runs unchanged on a Cloudflare
   Worker, in Node, or in the browser. Ingestion is best-effort: callers
   typically fire it without blocking the response (e.g. waitUntil).
   ============================================================ */
import type { Replay, SimEvent, SimulateRequest } from "@repo/shared";

/** Where to send events and how to authenticate. */
export interface TinybirdConfig {
  /** Tinybird API host, e.g. https://api.us-west-2.aws.tinybird.co */
  host: string;
  /** A token with append (DATASOURCES:APPEND) scope. */
  token: string;
}

const DS_RUNS = "simulation_runs";
const DS_MOVEMENTS = "simulation_movements";
const DS_EVENTS = "simulation_events";

/** Events API caps request bodies; movements are chunked to stay well under it. */
const MOVEMENT_BATCH = 2000;

export interface IngestOptions {
  /** Unique id for this run. Defaults to a random UUID. */
  simId?: string;
  /** Event time for every row. Defaults to now, formatted for DateTime64(3). */
  timestamp?: Date;
}

export interface IngestResult {
  simId: string;
  runs: number;
  movements: number;
  events: number;
}

/** Format a Date as ClickHouse DateTime64(3): "YYYY-MM-DD HH:MM:SS.mmm" (UTC). */
function tbTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function randomId(): string {
  // crypto.randomUUID exists on Workers, modern Node, and browsers.
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${tbTimestamp(new Date())}-${Math.round(performance.now())}`;
  return uuid.replace(/-/g, "");
}

const defScheme = (r: SimulateRequest): string =>
  r.plan?.defScheme ?? r.defPlan?.defScheme ?? "man";

/** Build the single summary row that records what the run was configured with. */
function runRow(
  input: SimulateRequest,
  replay: Replay,
  simId: string,
  ts: string
): Record<string, unknown> {
  const last = replay.frames.at(-1);
  const [scoreA, scoreB] = last?.scores ?? [0, 0];
  const { config } = input;
  return {
    sim_id: simId,
    timestamp: ts,
    offense: input.offense,
    team_a_name: config.teamA.name,
    team_a_abbr: config.teamA.abbr ?? "",
    team_b_name: config.teamB.name,
    team_b_abbr: config.teamB.abbr ?? "",
    def_scheme: defScheme(input),
    quarter_minutes: config.quarterMinutes ?? 0,
    frame_count: replay.frames.length,
    event_count: replay.events.length,
    final_score_a: scoreA,
    final_score_b: scoreB,
    // Verbatim JSON so the exact run can be described and reproduced.
    config: JSON.stringify(config),
    plan: JSON.stringify(input.plan),
    def_plan: JSON.stringify(input.defPlan),
    setup: JSON.stringify(input.setup),
  };
}

/** Expand the recorded frames into one movement row per entity (players + ball). */
function movementRows(
  replay: Replay,
  simId: string,
  ts: string
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  // meta.teams[].players lines up with frame.players: team0 slots 0..n then team1.
  const roster = replay.meta.teams.flatMap((t, team) =>
    t.players.map((p, slot) => ({ team, slot, number: p.number, name: p.name }))
  );
  const dt = replay.meta.dt;

  replay.frames.forEach((frame, f) => {
    const simTime = f * dt;
    frame.players.forEach((pos, idx) => {
      const who = roster[idx];
      rows.push({
        sim_id: simId,
        timestamp: ts,
        frame: f,
        sim_time: simTime,
        entity: "player",
        team: who?.team ?? -1,
        slot: who?.slot ?? -1,
        player_number: who?.number ?? -1,
        player_name: who?.name ?? "",
        x: pos.x,
        y: pos.y,
        air: 0,
        has_ball: frame.ball.holder === idx ? 1 : 0,
      });
    });
    rows.push({
      sim_id: simId,
      timestamp: ts,
      frame: f,
      sim_time: simTime,
      entity: "ball",
      team: -1,
      slot: -1,
      player_number: -1,
      player_name: "",
      x: frame.ball.x,
      y: frame.ball.y,
      air: frame.ball.air,
      has_ball: 0,
    });
  });
  return rows;
}

/** One row per play-by-play call, preserving emission order via `seq`. */
function eventRows(
  events: SimEvent[],
  simId: string,
  ts: string
): Record<string, unknown>[] {
  return events.map((e, seq) => ({
    sim_id: simId,
    timestamp: ts,
    seq,
    type: e.type,
    text: e.text,
    team: e.team ?? -1,
    q_label: e.qLabel,
    clock: e.clock,
  }));
}

/** POST an array of rows to a Data Source via the Events API as NDJSON. */
async function append(
  cfg: TinybirdConfig,
  datasource: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (rows.length === 0) return;
  const url = `${cfg.host.replace(/\/$/, "")}/v0/events?name=${datasource}`;
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/x-ndjson",
    },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Tinybird append to ${datasource} failed: ${res.status} ${res.statusText} ${detail}`
    );
  }
}

/**
 * Ship a finished simulation to Tinybird: its config, its movement sequence,
 * and its play-by-play. Returns the sim id used and the row counts sent.
 */
export async function ingestSimulation(
  cfg: TinybirdConfig,
  input: SimulateRequest,
  replay: Replay,
  opts: IngestOptions = {}
): Promise<IngestResult> {
  const simId = opts.simId ?? randomId();
  const ts = tbTimestamp(opts.timestamp ?? new Date());

  const runs = [runRow(input, replay, simId, ts)];
  const movements = movementRows(replay, simId, ts);
  const events = eventRows(replay.events, simId, ts);

  await append(cfg, DS_RUNS, runs);
  for (let i = 0; i < movements.length; i += MOVEMENT_BATCH) {
    await append(cfg, DS_MOVEMENTS, movements.slice(i, i + MOVEMENT_BATCH));
  }
  await append(cfg, DS_EVENTS, events);

  return {
    simId,
    runs: runs.length,
    movements: movements.length,
    events: events.length,
  };
}
