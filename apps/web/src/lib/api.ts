/* ============================================================
   api.ts — the browser's typed Hono RPC client for the API.
   `createApiClient` returns a fully-typed hc<AppType> client
   generated from the API's route definitions. Every call below
   is an RPC call (`api.api.<route>.$get/$post`); the response is
   read with `res.json()`, whose type is INFERRED from the route's
   zod output schema — no hand-written request/response types.
   The only manual bit is turning a non-2xx response into a throw
   so React Query hooks see an error.
   ============================================================ */
"use client";
import { createApiClient } from "@repo/api/client";
import type { BuildMatchupInput, SimulateRequest } from "@repo/shared";

/** Origin of the backend Worker that hosts the API. The /api base path is
    baked into the route types, so this is just the origin. Configure per
    environment via VITE_API_URL; defaults to the local `wrangler dev`. */
const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

/** Typed Hono RPC client bound to the backend origin. */
export const api = createApiClient(API_BASE_URL);

/** Read the JSON error body a non-2xx RPC response carries, as an Error. */
async function toError(res: Response): Promise<Error> {
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    /* non-JSON body; keep the status message */
  }
  return new Error(message);
}

export async function fetchTeams() {
  const res = await api.api.teams.$get();
  if (!res.ok) throw await toError(res);
  return res.json(); // inferred: TeamOption[]
}

export async function fetchAllPlayers() {
  const res = await api.api.players.$get();
  if (!res.ok) throw await toError(res);
  return res.json(); // inferred: RosterPlayer[]
}

export async function fetchMatchup(input: BuildMatchupInput) {
  const res = await api.api.matchup.$post({ json: input });
  if (!res.ok) throw await toError(res);
  return res.json(); // inferred: GameConfig
}

/** Run a staged lab possession on the backend Worker; returns the recorded
    Replay ({ meta, frames }) for the client to play back. */
export async function fetchSimulation(input: SimulateRequest) {
  const res = await api.api.simulate.$post({ json: input });
  if (!res.ok) throw await toError(res);
  return res.json(); // inferred: Replay
}

/** Persist a staged play to KV; returns its content-addressed id for building
    a shareable /play/{id} link. */
export async function savePlay(input: SimulateRequest) {
  const res = await api.api.plays.$post({ json: input });
  if (!res.ok) throw await toError(res);
  return res.json(); // inferred: { id: string }
}

/** Load a previously stored play config by id. */
export async function fetchPlay(id: string) {
  const res = await api.api.plays[":id"].$get({ param: { id } });
  if (!res.ok) throw await toError(res);
  return res.json(); // inferred: SimulateRequest
}
