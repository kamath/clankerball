# @repo/tinybird

Analytics for the possession simulator. Every time a simulation runs, this
package records three things to [Tinybird](https://www.tinybird.co) so any run
can be described and replayed later:

1. **What the config was** — the exact `GameConfig`, `plan`, `defPlan`, and
   staged `setup` the run used, stored verbatim plus flattened summary columns.
2. **The sequence of movements** — every entity's position on every frame (the
   ten players and the ball).
3. **The sequence of play-by-play events** — the engine's `SimEvent` calls, in
   order.

It contains both the **Tinybird project** (Data Sources + API Endpoints) and a
dependency-free **ingest client** used by the backend Worker.

## Data model

`datasources/`

| Data Source | Grain | Purpose |
|---|---|---|
| `simulation_runs` | 1 row / run | The config + a summary of the outcome |
| `simulation_movements` | 1 row / entity / frame | Player + ball positions over time |
| `simulation_events` | 1 row / event | Play-by-play, ordered by `seq` |

Each row carries a `sim_id` that ties the config, the movements, and the
play-by-play of a single run together.

`endpoints/` (read APIs)

| Endpoint | Params | Returns |
|---|---|---|
| `recent_simulations` | `limit` (default 50) | Latest runs, newest first |
| `get_config` | `id` (required) | One run's config + summary |
| `get_movements` | `id` (required); optional `entity_filter` (`player`\|`ball`), `team_filter`, `slot_filter` | Movement sequence, ordered by frame |
| `get_play_by_play` | `id` (required); optional `event_type` | Play-by-play, ordered by `seq` |

> Endpoint params are named `id` / `*_filter` rather than reusing column names
> (`sim_id`, `entity`, …) because Tinybird requires parameter names to differ
> from column names.

## How ingestion is wired

The backend's `POST /api/simulate` route runs the possession and then, when
`TINYBIRD_HOST` and `TINYBIRD_TOKEN` are set, ships the result to Tinybird via
`ingestSimulation()` — fire-and-forget through `executionCtx.waitUntil` so it
never blocks or fails the response. Unset either var and ingestion is skipped
(the default in local dev). See `packages/api/src/app.ts`.

```ts
import { ingestSimulation } from "@repo/tinybird";

await ingestSimulation(
  { host: process.env.TINYBIRD_HOST!, token: process.env.TINYBIRD_TOKEN! },
  simulateRequest, // the SimulateRequest
  replay,          // the Replay returned by simulatePossession()
);
```

The token needs `DATASOURCES:APPEND` scope. Movements are chunked
(`MOVEMENT_BATCH`) to stay under the Events API request-size limit.

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
