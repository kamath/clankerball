/* ============================================================
   client.ts — the auto-generated, fully-typed Hono RPC client.
   `hc<AppType>` derives every call signature (paths, params,
   request bodies, response types) straight from the API's route
   definitions — no hand-written client code. The import of
   AppType is type-only, so bundling this into the browser never
   pulls in the server implementation.
   ============================================================ */
import { hc } from "hono/client";
import type { AppType } from "./app";

export type { AppType };

export type ApiClient = ReturnType<typeof hc<AppType>>;

/** Build an RPC client bound to `baseUrl` (default: same origin). */
export function createApiClient(baseUrl = "", options?: Parameters<typeof hc>[1]): ApiClient {
  return hc<AppType>(baseUrl, options);
}
