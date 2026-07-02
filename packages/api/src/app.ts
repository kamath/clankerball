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
  ReplaySchema,
  RosterPlayerSchema,
  SimulateRequestSchema,
  TeamOptionSchema,
  simulatePossession,
} from "@repo/shared";
import { ingestSimulation } from "@repo/tinybird";
import { buildMatchup, listAllPlayers, listTeams } from "./lib/teams";

const ErrorSchema = z.object({ error: z.string() });
const jsonError = { content: { "application/json": { schema: ErrorSchema } } };

/* ---------- Worker bindings ----------
   KV bindings live on the Hono request context (c.env), NOT on process.env —
   only vars/secrets are mirrored to process.env by nodejs_compat. A minimal
   structural type keeps this package free of a hard @cloudflare/workers-types
   dependency. */
interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
interface R2BucketLike {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
}
type Bindings = { PLAYS: KVNamespaceLike; SIMULATION_ARTIFACTS: R2BucketLike };

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
const playId = async (play: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(canonical(play));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  // 6 bytes → 12 hex chars: short, shareable, collision-safe at app scale.
  return [...new Uint8Array(digest).slice(0, 6)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

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

const simulateRoute = createRoute({
  method: "post",
  path: "/simulate",
  summary: "Run a staged lab possession headlessly and return its replay",
  tags: ["simulate"],
  request: {
    body: { required: true, content: { "application/json": { schema: SimulateRequestSchema } } },
  },
  responses: {
    200: {
      description: "A frame-by-frame recording of the simulated possession",
      content: { "application/json": { schema: ReplaySchema } },
    },
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
    const req = c.req.valid("json");
    const replay = simulatePossession(req);
    // Best-effort analytics: record what was simulated — the config, the
    // movement sequence, and the play-by-play — to Tinybird. Fire-and-forget
    // via waitUntil so it never blocks or fails the response, and no-op when
    // TINYBIRD_* aren't configured (e.g. local dev).
    const host = process.env.TINYBIRD_HOST;
    const token = process.env.TINYBIRD_TOKEN;
    if (host && token) {
      const ingest = ingestSimulation({ host, token }, req, replay, {
        putMovements: async (artifact) => {
          const key = `simulations/${artifact.sim_id}/movements.json`;
          await c.env.SIMULATION_ARTIFACTS.put(key, JSON.stringify(artifact), {
            httpMetadata: { contentType: "application/json" },
          });
          return key;
        },
      }).catch((err) => console.error("Tinybird ingest failed:", err));
      try {
        c.executionCtx.waitUntil(ingest);
      } catch {
        // No execution context outside a Worker — let it run detached.
      }
    }
    return c.json(ReplaySchema.parse(replay), 200);
  })
  .openapi(savePlayRoute, async (c) => {
    const play = c.req.valid("json");
    const id = await playId(play);
    // Content-addressed key: an identical play overwrites in place. No TTL —
    // stored plays are kept until manually removed.
    await c.env.PLAYS.put(`play:${id}`, JSON.stringify(play));
    return c.json({ id }, 200);
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
