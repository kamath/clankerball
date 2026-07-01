/* ============================================================
   backend — the standalone Hono API, deployed to Cloudflare
   Workers. It serves the OpenAPIHono app defined in @repo/api
   (routes under /api, zod validation, OpenAPI doc + Swagger UI,
   CORS). The Next.js web app talks to it over the generated Hono
   RPC client (typed from @repo/api's AppType).

   Env (wrangler secrets / .dev.vars, exposed via process.env with
   the nodejs_compat flag):
     BALLDONTLIE_API_KEY  — NBA roster/stats source
     CORS_ORIGIN          — optional comma-separated allowlist
   ============================================================ */
import { Hono } from "hono";
import { app } from "@repo/api";

// The API lives under /api (the app's basePath). Wrap it so the bare root is a
// friendly pointer to the docs instead of a 404.
const root = new Hono();
root.get("/", (c) => c.redirect("/api/ui"));
root.route("/", app);

export default root;
