# @repo/tinybird

Analytics for the possession simulator. Every time a simulation runs, this
package records queryable run/event data to [Tinybird](https://www.tinybird.co)
and stores high-volume movement artifacts in R2 so any run can be described and
replayed later:

1. **What the config was** — the exact `GameConfig`, `plan`, `defPlan`, and
   staged `setup` the run used, stored verbatim plus flattened summary columns.
2. **The sequence of play-by-play events** — the engine's `SimEvent` calls, in
   order.
3. **The sequence of movements** — every entity's position on every frame,
   stored as `simulations/{sim_id}/movements.json` in R2 and referenced by
   `simulation_runs.movement_object_key`.

It contains both the **Tinybird project** (Data Sources + API Endpoints) and a
dependency-free **ingest client** used by the backend Worker.

## Data model

`datasources/`

| Data Source | Grain | Purpose |
|---|---|---|
| `simulation_runs` | 1 row / run | The config, R2 movement object key, and outcome summary |
| `simulation_events` | 1 row / event | Play-by-play, ordered by `seq` |

Each Tinybird row carries a `sim_id` that ties the config, R2 movement artifact,
and play-by-play of a single run together.

`endpoints/` (read APIs)

| Endpoint | Params | Returns |
|---|---|---|
| `recent_simulations` | `limit` (default 50) | Latest runs, newest first |
| `get_config` | `id` (required) | One run's config + summary |
| `get_play_by_play` | `id` (required); optional `event_type` | Play-by-play, ordered by `seq` |

> Endpoint params are named `id` / `*_filter` rather than reusing column names
> (`sim_id`, `entity`, …) because Tinybird requires parameter names to differ
> from column names.

## How ingestion is wired

The backend's `POST /api/simulate` route runs the possession and then, when
`TINYBIRD_HOST` and `TINYBIRD_TOKEN` are set, ships the run summary and events
to Tinybird via `ingestSimulation()` and writes movement rows to R2 through the
backend's `SIMULATION_ARTIFACTS` binding. This runs fire-and-forget through
`executionCtx.waitUntil` so it never blocks or fails the response. Unset either
Tinybird var and analytics/artifact ingestion is skipped (the default in local
dev). See `packages/api/src/app.ts`.

```ts
import { ingestSimulation } from "@repo/tinybird";

await ingestSimulation(
  { host: process.env.TINYBIRD_HOST!, token: process.env.TINYBIRD_TOKEN! },
  simulateRequest, // the SimulateRequest
  replay,          // the Replay returned by simulatePossession()
  { putMovements } // stores simulations/{sim_id}/movements.json in R2
);
```

The token needs `DATASOURCES:APPEND` scope for `simulation_runs` and
`simulation_events`.

## Working on the project

Runs from this folder (the repo-root `.tinyb` supplies credentials).

```bash
tb local start        # start Tinybird Local (Docker)
tb dev                # watch + rebuild datasources/endpoints
tb build              # one-shot validate all datafiles
tb test run           # run endpoint tests against fixtures/

tb --cloud deploy --check   # validate a cloud deployment
tb --cloud deploy           # deploy to Tinybird Cloud production
```

`tinybird.config.json` sets `dev_mode` and scopes `include` to the datafile
folders (`datasources`, `endpoints`, `fixtures`) so `tb` doesn't try to read
`src/` as TypeScript SDK definitions.

`fixtures/` holds small deterministic sample rows for local testing.
