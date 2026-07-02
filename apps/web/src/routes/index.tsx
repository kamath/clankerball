import { createFileRoute } from "@tanstack/react-router";
import type { GameConfig } from "@repo/shared";
import { Simulator } from "@/components/Simulator";
import { DEFAULT_CONFIG } from "@/lib/players";
import { fetchMatchup, fetchTeams } from "@/lib/api";

// Build the real Spurs vs Knicks matchup up front so the sim boots directly on
// it — no placeholder-then-swap flash on first paint. Falls back to the curated
// default config if the NBA team list / API is unavailable.
async function loadDefaultMatchup(): Promise<GameConfig> {
  try {
    const teams = await fetchTeams();
    const spurs = teams.find((t) => t.abbr === "SAS");
    const knicks = teams.find((t) => t.abbr === "NYK");
    if (!spurs || !knicks) return DEFAULT_CONFIG;
    return await fetchMatchup({ teamAId: spurs.id, teamBId: knicks.id });
  } catch {
    return DEFAULT_CONFIG;
  }
}

export const Route = createFileRoute("/")({
  loader: loadDefaultMatchup,
  component: Home,
});

function Home() {
  const config = Route.useLoaderData();
  return <Simulator initialConfig={config} />;
}
