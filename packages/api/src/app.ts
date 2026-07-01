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
  CompileRequestSchema,
  CompileResultSchema,
  GameConfigSchema,
  TeamOptionSchema,
} from "@repo/shared";
import { buildMatchup, listTeams } from "./lib/teams";
import { compileTeamPlan } from "./lib/ai/compile";

const ErrorSchema = z.object({ error: z.string() });
const jsonError = { content: { "application/json": { schema: ErrorSchema } } };

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

const compileRoute = createRoute({
  method: "post",
  path: "/compile",
  summary: "Compile free-text coaching instructions into a TeamPlan",
  tags: ["compile"],
  request: {
    body: { required: true, content: { "application/json": { schema: CompileRequestSchema } } },
  },
  responses: {
    200: {
      description: "The compiled plan, or a structured error",
      content: { "application/json": { schema: CompileResultSchema } },
    },
  },
});

/* ---------- app ---------- */
const base = new OpenAPIHono({
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
  .openapi(matchupRoute, async (c) => {
    const { teamAId, teamBId, season } = c.req.valid("json");
    const config = await buildMatchup(teamAId, teamBId, season);
    return c.json(GameConfigSchema.parse(config), 200);
  })
  .openapi(compileRoute, async (c) => {
    const req = c.req.valid("json");
    const result = await compileTeamPlan(req);
    return c.json(CompileResultSchema.parse(result), 200);
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
