/* Server entry for @repo/api — the Hono app (mounted by the Next.js route
   handler) and its AppType. Import the RPC client from "@repo/api/client". */
export { app } from "./app";
export type { AppType } from "./app";
export { createApiClient } from "./client";
export type { ApiClient } from "./client";
