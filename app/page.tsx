import { Simulator } from "@/components/Simulator";
import { listTeams } from "./actions";
import { DEFAULT_CONFIG } from "@/lib/players";

export default async function Home() {
  // Team list for the picker. The sim boots on the curated default matchup so
  // it runs instantly; the user can load a real NBA matchup from the Teams tab.
  let teams: Awaited<ReturnType<typeof listTeams>> = [];
  try {
    teams = await listTeams();
  } catch {
    // If the API key is missing/unauthorized the picker is simply empty —
    // the curated default game still runs.
  }
  return <Simulator initialConfig={DEFAULT_CONFIG} teams={teams} />;
}
