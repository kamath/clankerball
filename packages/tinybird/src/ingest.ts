/* ============================================================
   ingest.ts — ship a completed simulation to Tinybird.

   The engine produces a Replay (frames + play-by-play) from a
   SimulateRequest (config + staged setup). This module reshapes that
   pair into rows for Tinybird and an external movement artifact store:

     simulation_runs        1 row  — the config the run used + a summary
     simulation_events      M rows — the play-by-play, oldest first
     movements.json         N rows — every entity's position per frame

   It is dependency-free (uses fetch) so it runs unchanged on a Cloudflare
   Worker, in Node, or in the browser. The caller provides movement artifact
   storage (R2 in production). Ingestion is best-effort: callers typically
   fire it without blocking the response (e.g. waitUntil).
   ============================================================ */
import { hashConfig, summarizePossession } from "@repo/shared";
import type { Replay, SimEvent, SimulateRequest } from "@repo/shared";

/** Where to send events and how to authenticate. */
export interface TinybirdConfig {
  /** Tinybird API host, e.g. https://api.us-west-2.aws.tinybird.co */
  host: string;
  /** A token with append (DATASOURCES:APPEND) scope. */
  token: string;
}

const DS_RUNS = "simulation_runs";
const DS_EVENTS = "simulation_events";

/* ---------- what to export ----------
   A simulation produces four independent artifacts; a caller can ship any
   subset. This keeps high-volume batch runs cheap (e.g. tabular-only) and lets
   the single-run path stay "all" so the play library keeps working.

     config     → simulation_runs   (Tinybird)  the run summary + verbatim config
     events     → simulation_events (Tinybird)  the play-by-play
     movements  → movements.json    (R2 put)    per-frame positions (1 subrequest)
     replay     → replay.json       (R2 put)    the full Replay for exact playback
*/
export type ExportTarget = "config" | "events" | "movements" | "replay";
export type ExportSelection = "all" | ExportTarget[];
const ALL_TARGETS: ExportTarget[] = ["config", "events", "movements", "replay"];
/** Normalize a selection (or the "all" shorthand / undefined default) to a set. */
export function resolveExport(sel: ExportSelection = "all"): Set<ExportTarget> {
  return new Set(sel === "all" ? ALL_TARGETS : sel);
}

/* ---------- Events API limits ----------
   The Events API caps a request at 10 MB and ~1000 req/s / 20 MB/s per Data
   Source. We chunk large appends well under 10 MB and cap rows/request so a
   batch of many simulations collapses into a handful of POSTs. */
const MAX_ROWS_PER_APPEND = 1000;
const MAX_BYTES_PER_APPEND = 8 * 1024 * 1024;
/** How many times to retry a throttled/5xx append before giving up. */
const MAX_APPEND_RETRIES = 4;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface IngestOptions {
  /** Unique id for this run. Defaults to a random UUID. */
  simId?: string;
  /** Event time for every row. Defaults to now, formatted for DateTime64(3). */
  timestamp?: Date;
  /** Which artifacts to write. Defaults to "all" (config + events + movements +
      replay) so the single-run path keeps the play library fully populated. */
  export?: ExportSelection;
  /** Store the movement artifact and return its object key. */
  putMovements?: (artifact: MovementArtifact) => Promise<string>;
  /** Store the full Replay (so a run can be played back exactly) and return its
      object key. The movement artifact drops per-frame scoreboard/clock, so the
      play library reads this back instead of reconstructing from movements. */
  putReplay?: (replay: Replay, simId: string) => Promise<string>;
}

export interface IngestResult {
  simId: string;
  runs: number;
  movements: number;
  events: number;
  movementObjectKey: string;
}

export interface MovementRow {
  sim_id: string;
  timestamp: string;
  frame: number;
  sim_time: number;
  entity: "player" | "ball";
  team: number;
  slot: number;
  player_number: number;
  player_name: string;
  x: number;
  y: number;
  air: number;
  has_ball: number;
}

export interface MovementArtifact {
  sim_id: string;
  timestamp: string;
  movements: MovementRow[];
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

/** Build the single summary row that records what the run was configured with.
    `configHash` (the matchup key) and the outcome summary are precomputed by the
    caller since hashing is async. */
function runRow(
  input: SimulateRequest,
  replay: Replay,
  simId: string,
  ts: string,
  movementObjectKey: string,
  configHash: string,
  result: string,
  points: number
): Record<string, unknown> {
  const last = replay.frames.at(-1);
  const [scoreA, scoreB] = last?.scores ?? [0, 0];
  const { config } = input;
  return {
    sim_id: simId,
    timestamp: ts,
    offense: input.offense,
    config_hash: configHash,
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
    result,
    points,
    movement_object_key: movementObjectKey,
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
): MovementRow[] {
  const rows: MovementRow[] = [];
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

/** POST one batch of rows to a Data Source via the Events API as NDJSON.
    Retries on 429/5xx with backoff (honoring Retry-After) since a burst of
    simulations can briefly exceed the per-Data-Source rate limit. */
async function append(
  cfg: TinybirdConfig,
  datasource: string,
  rows: Record<string, unknown>[],
  attempt = 0
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
  if (res.ok) return;
  // Throttled or transient upstream error → back off and retry.
  if ((res.status === 429 || res.status >= 500) && attempt < MAX_APPEND_RETRIES) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
    await sleep(backoff);
    return append(cfg, datasource, rows, attempt + 1);
  }
  const detail = await res.text().catch(() => "");
  throw new Error(
    `Tinybird append to ${datasource} failed: ${res.status} ${res.statusText} ${detail}`
  );
}

/** Append rows in batches that stay under the Events API's per-request size and
    row caps. Batches are sent sequentially to avoid bursting the rate limit. */
async function appendChunked(
  cfg: TinybirdConfig,
  datasource: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  let chunk: Record<string, unknown>[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (chunk.length === 0) return;
    await append(cfg, datasource, chunk);
    chunk = [];
    bytes = 0;
  };
  for (const row of rows) {
    const size = JSON.stringify(row).length + 1; // +1 for the NDJSON newline
    if (chunk.length > 0 && (chunk.length >= MAX_ROWS_PER_APPEND || bytes + size > MAX_BYTES_PER_APPEND)) {
      await flush();
    }
    chunk.push(row);
    bytes += size;
  }
  await flush();
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
  const targets = resolveExport(opts.export);
  const simId = opts.simId ?? randomId();
  const ts = tbTimestamp(opts.timestamp ?? new Date());
  const { result, points } = summarizePossession(input.offense, replay);

  // R2 artifacts first — the run row records the movement object key.
  let movementCount = 0;
  let movementObjectKey = "";
  if (targets.has("movements") && opts.putMovements) {
    const movements = movementRows(replay, simId, ts);
    movementCount = movements.length;
    movementObjectKey = await opts.putMovements({ sim_id: simId, timestamp: ts, movements });
  }
  if (targets.has("replay")) {
    // Store the full Replay for faithful playback (best-effort; key unused here).
    await opts.putReplay?.(replay, simId);
  }

  let runsLen = 0;
  if (targets.has("config")) {
    const configHash = await hashConfig(input.config);
    const runs = [
      runRow(input, replay, simId, ts, movementObjectKey, configHash, result, points),
    ];
    await appendChunked(cfg, DS_RUNS, runs);
    runsLen = runs.length;
  }

  let eventsLen = 0;
  if (targets.has("events")) {
    const events = eventRows(replay.events, simId, ts);
    await appendChunked(cfg, DS_EVENTS, events);
    eventsLen = events.length;
  }

  return {
    simId,
    runs: runsLen,
    movements: movementCount,
    events: eventsLen,
    movementObjectKey,
  };
}

/* ============================================================
   Batch ingest — ship many finished simulations in as few requests as
   possible. Instead of 2 Events API POSTs per simulation, run + event rows are
   collected across every simulation and flushed in size-capped chunks (a few
   POSTs total), keeping thousands of runs well under the rate limit.

   The caller runs the simulations (the engine is pure CPU) and hands the
   finished (input, replay) pairs here. Per-sim R2 artifacts (movements/replay)
   each cost one subrequest, so only select them for modest batch sizes — the
   default "config" + "events" selection writes zero R2 objects.
   ============================================================ */
export interface BatchIngestItem {
  input: SimulateRequest;
  replay: Replay;
  /** Optional explicit id; a random UUID is assigned otherwise. */
  simId?: string;
}

export interface BatchIngestOptions {
  /** Event time stamped on every row. Defaults to now. */
  timestamp?: Date;
  /** Which artifacts to write. Defaults to "all"; batch callers typically pass
      ["config", "events"] to avoid per-sim R2 writes. */
  export?: ExportSelection;
  putMovements?: (artifact: MovementArtifact) => Promise<string>;
  putReplay?: (replay: Replay, simId: string) => Promise<string>;
}

/** One run's outcome, returned so the caller can aggregate without re-walking
    the replays it already discarded. */
export interface BatchIngestSummary {
  simId: string;
  offense: number;
  result: string;
  points: number;
}

export interface BatchIngestResult {
  simIds: string[];
  summaries: BatchIngestSummary[];
  /** The artifacts actually written. */
  exported: ExportTarget[];
  counts: { runs: number; events: number; movements: number; replays: number };
}

export async function batchIngestSimulations(
  cfg: TinybirdConfig,
  items: BatchIngestItem[],
  opts: BatchIngestOptions = {}
): Promise<BatchIngestResult> {
  const targets = resolveExport(opts.export);
  const ts = tbTimestamp(opts.timestamp ?? new Date());

  const runRows: Record<string, unknown>[] = [];
  const eventRowsAll: Record<string, unknown>[] = [];
  const summaries: BatchIngestSummary[] = [];
  const simIds: string[] = [];
  let movements = 0;
  let replays = 0;

  // A batch usually shares one config; memoize the hash by config identity so we
  // hash once instead of once per simulation.
  const hashCache = new Map<unknown, string>();
  const configHashFor = async (config: SimulateRequest["config"]): Promise<string> => {
    const cached = hashCache.get(config);
    if (cached) return cached;
    const h = await hashConfig(config);
    hashCache.set(config, h);
    return h;
  };

  for (const item of items) {
    const simId = item.simId ?? randomId();
    simIds.push(simId);
    const { result, points } = summarizePossession(item.input.offense, item.replay);
    summaries.push({ simId, offense: item.input.offense, result, points });

    let movementObjectKey = "";
    if (targets.has("movements") && opts.putMovements) {
      const rows = movementRows(item.replay, simId, ts);
      movementObjectKey = await opts.putMovements({ sim_id: simId, timestamp: ts, movements: rows });
      movements++;
    }
    if (targets.has("replay") && opts.putReplay) {
      await opts.putReplay(item.replay, simId);
      replays++;
    }
    if (targets.has("config")) {
      const configHash = await configHashFor(item.input.config);
      runRows.push(
        runRow(item.input, item.replay, simId, ts, movementObjectKey, configHash, result, points)
      );
    }
    if (targets.has("events")) {
      for (const row of eventRows(item.replay.events, simId, ts)) eventRowsAll.push(row);
    }
  }

  if (targets.has("config")) await appendChunked(cfg, DS_RUNS, runRows);
  if (targets.has("events")) await appendChunked(cfg, DS_EVENTS, eventRowsAll);

  return {
    simIds,
    summaries,
    exported: [...targets],
    counts: { runs: runRows.length, events: eventRowsAll.length, movements, replays },
  };
}
