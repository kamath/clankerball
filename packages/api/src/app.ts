/* ============================================================
   app.ts — the Hono API. One OpenAPIHono app defines every route
   with zod input + output schemas; that single definition powers
   (a) runtime request/response validation, (b) the generated
   OpenAPI document (/api/openapi.json) + Swagger UI (/api/ui), and
   (c) the AppType that types the auto-generated hc() RPC client.
   Mounted inside the Next.js app at app/api/[[...route]].
   ============================================================ */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import {
  BuildMatchupInputSchema,
  GameConfigSchema,
  PlaySummarySchema,
  ReplaySchema,
  RosterPlayerSchema,
  SimulateRequestSchema,
  StoredPlaySchema,
  TeamOptionSchema,
  hashConfig,
  simulatePossession,
} from "@repo/shared";
import {
  batchIngestSimulations,
  getRunConfig,
  ingestSimulation,
  listPlaysForConfig,
  type ExportTarget,
} from "@repo/tinybird";
import { buildMatchup, listAllPlayers, listTeams } from "./lib/teams";

const ErrorSchema = z.object({ error: z.string() });
const jsonError = { content: { "application/json": { schema: ErrorSchema } } };

/* ---------- analytics export selection ----------
   Which artifacts a simulation ships to the analytics backend. "config" and
   "events" are Tinybird rows; "movements" and "replay" are per-sim R2 objects
   (one subrequest each). "all" writes everything (the single-run default, which
   keeps the play library fully populated). */
const ExportTargetSchema = z.enum(["config", "events", "movements", "replay"]);
const ExportSelectionSchema = z.union([z.literal("all"), z.array(ExportTargetSchema).min(1)]);
const ALL_EXPORT_TARGETS: ExportTarget[] = ["config", "events", "movements", "replay"];
/** Cap on simulations per batch request: bounds Worker CPU/memory and the total
    subrequest count so one HTTP call can't blow the Worker's limits. */
const MAX_BATCH = 500;
/** Keep total per-invocation subrequests (R2 puts + Tinybird appends) safely
    under the Worker's ~1000 cap. */
const SUBREQUEST_BUDGET = 800;
/** How many recorded possessions the matchup play library fetches. Comfortably
    covers several max-size batches; each row is a tiny outcome summary. */
const LIBRARY_LIMIT = 2000;

/* ---------- Worker bindings ----------
   KV bindings live on the Hono request context (c.env), NOT on process.env —
   only vars/secrets are mirrored to process.env by nodejs_compat. A minimal
   structural type keeps this package free of a hard @cloudflare/workers-types
   dependency. */
interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
interface R2ObjectBodyLike {
  text(): Promise<string>;
}
interface R2BucketLike {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
}
type Bindings = { PLAYS: KVNamespaceLike; SIMULATION_ARTIFACTS: R2BucketLike };

/* R2 putters for the two per-sim artifacts, used by the /simulate ingest path.
   Ingest only invokes these when "movements"/"replay" are in the export
   selection, so unselected artifacts cost nothing. */
const artifactStore = (bucket: R2BucketLike) => ({
  putMovements: async (artifact: { sim_id: string }) => {
    const key = `simulations/${artifact.sim_id}/movements.json`;
    await bucket.put(key, JSON.stringify(artifact), {
      httpMetadata: { contentType: "application/json" },
    });
    return key;
  },
  // Persist the whole Replay so the library can reproduce a possession exactly
  // (the R2 movement rows drop per-frame scoreboard/clock).
  putReplay: async (replay: unknown, simId: string) => {
    const key = `simulations/${simId}/replay.json`;
    await bucket.put(key, JSON.stringify(replay), {
      httpMetadata: { contentType: "application/json" },
    });
    return key;
  },
});

/* ---------- content-addressed play ids ----------
   A play's id is a hash of its canonical JSON, so re-saving an identical play
   is a harmless overwrite (natural dedupe) and equal plays share one link. */
const canonical = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
};
// 6 bytes → 12 hex chars: short, shareable, collision-safe at app scale.
const hashHex = async (v: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(canonical(v));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 6)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};
/** A play's id hashes its whole authored request, so re-saving an identical
    play is a harmless overwrite (natural dedupe) and equal plays share a link. */
const playId = (play: unknown): Promise<string> => hashHex(play);

/* ---------- route definitions (zod input + output) ---------- */
const teamsRoute = createRoute({
  method: "get",
  path: "/teams",
  summary: "List NBA teams available for a matchup",
  tags: ["teams"],
  responses: {
    200: {
      description: "Every team the picker can load",
      content: { "application/json": { schema: z.array(TeamOptionSchema) } },
    },
    500: { description: "Upstream/data error", ...jsonError },
  },
});

const playersRoute = createRoute({
  method: "get",
  path: "/players",
  summary: "List every rated NBA player available to sub into a lineup",
  tags: ["teams"],
  responses: {
    200: {
      description: "The leaguewide rated player pool",
      content: { "application/json": { schema: z.array(RosterPlayerSchema) } },
    },
    500: { description: "Upstream/data error", ...jsonError },
  },
});

const matchupRoute = createRoute({
  method: "post",
  path: "/matchup",
  summary: "Assemble a real NBA head-to-head into a GameConfig",
  tags: ["matchup"],
  request: {
    body: { required: true, content: { "application/json": { schema: BuildMatchupInputSchema } } },
  },
  responses: {
    200: {
      description: "A ready-to-run game configuration",
      content: { "application/json": { schema: GameConfigSchema } },
    },
    500: { description: "Upstream/data error", ...jsonError },
  },
});

// The simulate body is a SimulateRequest plus two optional controls: how many
// possessions to run (Monte-Carlo — the sim is random, so each run differs) and
// which analytics artifacts to write. Omitting both preserves today's behavior:
// one possession, ingested in full.
const SimulateBodySchema = SimulateRequestSchema.extend({
  /** How many independent possessions to simulate. Defaults to 1. All runs are
      ingested; the response returns every run's replay, in order. */
  count: z.number().int().min(1).max(MAX_BATCH).optional(),
  /** Which artifacts to write. Defaults to "all" for a single run and to
      config+events for a multi-run batch (no per-sim R2 writes). */
  export: ExportSelectionSchema.optional(),
});

const simulateRoute = createRoute({
  method: "post",
  path: "/simulate",
  summary: "Run a staged lab possession N times and return every replay",
  tags: ["simulate"],
  request: {
    body: { required: true, content: { "application/json": { schema: SimulateBodySchema } } },
  },
  responses: {
    200: {
      description: "One frame-by-frame recording per simulated possession, in order",
      content: { "application/json": { schema: z.array(ReplaySchema) } },
    },
    400: { description: "Batch too large for the requested export", ...jsonError },
    500: { description: "Simulation error", ...jsonError },
  },
});

const PlayIdParamSchema = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "a1b2c3d4e5f6" }),
});
const SavePlayResponseSchema = z.object({ id: z.string() });

const savePlayRoute = createRoute({
  method: "post",
  path: "/plays",
  summary: "Persist a play config to KV and return its shareable id",
  tags: ["plays"],
  request: {
    body: { required: true, content: { "application/json": { schema: SimulateRequestSchema } } },
  },
  responses: {
    200: {
      description: "The content-addressed id under which the play was stored",
      content: { "application/json": { schema: SavePlayResponseSchema } },
    },
    500: { description: "Storage error", ...jsonError },
  },
});

const getPlayRoute = createRoute({
  method: "get",
  path: "/plays/{id}",
  summary: "Load a previously stored play config by id",
  tags: ["plays"],
  request: { params: PlayIdParamSchema },
  responses: {
    200: {
      description: "The stored play config, ready to hand back to /simulate",
      content: { "application/json": { schema: SimulateRequestSchema } },
    },
    404: { description: "No play with that id", ...jsonError },
    500: { description: "Storage error", ...jsonError },
  },
});

/* ---------- play library (Tinybird-backed) ----------
   Every simulation is ingested to Tinybird (run summary + play-by-play) with its
   full Replay stored to R2. The library reads that history back: list the plays
   run on a given matchup, then replay any one exactly. */
const SimIdParamSchema = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "9f8e7d6c5b4a" }),
});

const librarySearchRoute = createRoute({
  method: "post",
  path: "/library/search",
  summary: "List prior plays run on a matchup (exact config match), newest first",
  tags: ["library"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ config: GameConfigSchema }) } },
    },
  },
  responses: {
    200: {
      description: "Outcome summaries of every recorded play on this exact config",
      content: { "application/json": { schema: z.array(PlaySummarySchema) } },
    },
    500: { description: "Analytics read error", ...jsonError },
  },
});

const libraryReplayRoute = createRoute({
  method: "get",
  path: "/library/{id}",
  summary: "Load a recorded play by sim id — its authored request plus exact replay",
  tags: ["library"],
  request: { params: SimIdParamSchema },
  responses: {
    200: {
      description: "The recorded play: authored request + the replay that ran",
      content: { "application/json": { schema: StoredPlaySchema } },
    },
    404: { description: "No recorded play with that id", ...jsonError },
    500: { description: "Analytics/artifact read error", ...jsonError },
  },
});

/* ---------- app ---------- */
const base = new OpenAPIHono<{ Bindings: Bindings }>({
  // Surface zod validation failures as clean 400s.
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ error: result.error.issues.map((i) => i.message).join("; ") }, 400);
    }
  },
}).basePath("/api");

// The API now runs on its own origin (the backend Worker), so the browser
// calls it cross-origin. CORS_ORIGIN is a comma-separated allowlist, read
// lazily per request (Worker env is populated per invocation); when unset it
// reflects "*" for easy local dev.
const resolveCorsOrigin = (origin: string): string => {
  const allow = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allow || allow.length === 0) return "*";
  return allow.includes(origin) ? origin : allow[0];
};

// CORS is registered before the routes so it applies to them (OpenAPIHono's
// .use() returns a plain Hono, so it can't sit inside the .openapi() chain).
base.use("*", cors({ origin: resolveCorsOrigin }));

// Route registrations MUST be chained so `typeof routes` carries every route
// into the generated RPC client type.
const routes = base
  .openapi(teamsRoute, async (c) => {
    const teams = await listTeams();
    return c.json(z.array(TeamOptionSchema).parse(teams), 200);
  })
  .openapi(playersRoute, async (c) => {
    const players = await listAllPlayers();
    return c.json(z.array(RosterPlayerSchema).parse(players), 200);
  })
  .openapi(matchupRoute, async (c) => {
    const { teamAId, teamBId, season } = c.req.valid("json");
    const config = await buildMatchup(teamAId, teamBId, season);
    return c.json(GameConfigSchema.parse(config), 200);
  })
  .openapi(simulateRoute, async (c) => {
    const { count = 1, export: exportSel, ...req } = c.req.valid("json");
    const host = process.env.TINYBIRD_HOST;
    const token = process.env.TINYBIRD_TOKEN;
    const willIngest = Boolean(host && token);

    // A single run defaults to "all" (so the play library can replay it exactly);
    // a multi-run batch defaults to tabular only (config + events) so it doesn't
    // fan out one R2 write per simulation. An explicit selection overrides both.
    const targets: ExportTarget[] =
      exportSel === "all"
        ? [...ALL_EXPORT_TARGETS]
        : exportSel ?? (count > 1 ? ["config", "events"] : [...ALL_EXPORT_TARGETS]);
    const r2PerSim =
      (targets.includes("movements") ? 1 : 0) + (targets.includes("replay") ? 1 : 0);
    // Per-sim R2 artifacts each cost a subrequest; reject a batch that would blow
    // the Worker's cap rather than silently dropping writes.
    if (willIngest && r2PerSim * count > SUBREQUEST_BUDGET) {
      return c.json(
        {
          error: `Batch of ${count} with ${r2PerSim} R2 write(s)/sim exceeds the Worker subrequest budget (${SUBREQUEST_BUDGET}). Reduce count or export only "config"/"events".`,
        },
        400
      );
    }

    // The engine is pure CPU and random per run, so each possession is an
    // independent outcome. Every replay is returned to the caller, in order.
    const replays = Array.from({ length: count }, () => simulatePossession(req));

    // Best-effort analytics: record the runs (any subset of config/events/
    // movements/replay) to Tinybird + R2. Fire-and-forget via waitUntil so it
    // never blocks or fails the response; a multi-run batch collapses into a
    // handful of appends via batchIngestSimulations. No-op when TINYBIRD_* aren't
    // configured (e.g. local dev — the library is then simply empty).
    if (willIngest) {
      const store = artifactStore(c.env.SIMULATION_ARTIFACTS);
      const ingest = (
        count === 1
          ? ingestSimulation({ host: host!, token: token! }, req, replays[0], {
              export: targets,
              ...store,
            })
          : batchIngestSimulations(
              { host: host!, token: token! },
              replays.map((replay) => ({ input: req, replay })),
              { export: targets, ...store }
            )
      ).catch((err) => console.error("Tinybird ingest failed:", err));
      try {
        c.executionCtx.waitUntil(ingest);
      } catch {
        // No execution context outside a Worker — let it run detached.
      }
    }

    return c.json(z.array(ReplaySchema).parse(replays), 200);
  })
  .openapi(savePlayRoute, async (c) => {
    const play = c.req.valid("json");
    const id = await playId(play);
    // Content-addressed key: an identical play overwrites in place. No TTL —
    // stored plays are kept until manually removed.
    await c.env.PLAYS.put(`play:${id}`, JSON.stringify(play));
    return c.json({ id }, 200);
  })
  .openapi(librarySearchRoute, async (c) => {
    const { config } = c.req.valid("json");
    const host = process.env.TINYBIRD_HOST;
    const token = process.env.TINYBIRD_TOKEN;
    // No analytics backend → an empty library (the graceful local-dev default).
    if (!host || !token) return c.json([], 200);
    const matchup = await hashConfig(config);
    // Show the whole matchup library, not just the newest 50 — a single Run ×N
    // can record hundreds of possessions at once.
    const rows = await listPlaysForConfig({ host, token }, matchup, LIBRARY_LIMIT);
    const plays = rows.map((r) => ({
      simId: r.sim_id,
      result: r.result,
      points: r.points,
      offense: r.offense,
      offenseTeam: r.offense_team,
      timestamp: r.timestamp,
    }));
    return c.json(z.array(PlaySummarySchema).parse(plays), 200);
  })
  .openapi(libraryReplayRoute, async (c) => {
    const { id } = c.req.valid("param");
    const host = process.env.TINYBIRD_HOST;
    const token = process.env.TINYBIRD_TOKEN;
    if (!host || !token) return c.json({ error: "Play library not configured" }, 404);
    // The run row carries the verbatim config/plan/setup; the exact Replay lives
    // in R2. Recombine them into a StoredPlay the client can stage + play back.
    const run = await getRunConfig({ host, token }, id);
    if (!run) return c.json({ error: "Play not found" }, 404);
    const artifact = await c.env.SIMULATION_ARTIFACTS.get(`simulations/${id}/replay.json`);
    if (!artifact) return c.json({ error: "Replay artifact missing" }, 404);
    const replay = ReplaySchema.parse(JSON.parse(await artifact.text()));
    const request = SimulateRequestSchema.parse({
      config: JSON.parse(run.config),
      offense: run.offense,
      plan: JSON.parse(run.plan),
      defPlan: JSON.parse(run.def_plan),
      setup: JSON.parse(run.setup),
    });
    return c.json(StoredPlaySchema.parse({ request, replay }), 200);
  })
  .openapi(getPlayRoute, async (c) => {
    const { id } = c.req.valid("param");
    const raw = await c.env.PLAYS.get(`play:${id}`);
    if (!raw) return c.json({ error: "Play not found" }, 404);
    // Re-validate on read so a stored payload that predates a schema change
    // surfaces as a clean error rather than corrupt data downstream.
    return c.json(SimulateRequestSchema.parse(JSON.parse(raw)), 200);
  });

/* ---------- OpenAPI document + Swagger UI ----------
   Auto-generated from the zod route definitions above; the same definitions
   type the RPC client, so the OpenAPI doc and the client never drift. */
routes.doc("/openapi.json", {
  openapi: "3.0.0",
  info: { version: "0.1.0", title: "Fable Fieldhouse API" },
});
routes.get("/ui", swaggerUI({ url: "/api/openapi.json" }));

/** Anything unhandled becomes a JSON 500 (keeps RPC error handling uniform). */
routes.onError((err, c) => {
  const message = err instanceof Error ? err.message : "Internal error";
  return c.json({ error: message }, 500);
});

export { routes as app };
/** The typed surface consumed by the auto-generated hc() RPC client. */
export type AppType = typeof routes;
