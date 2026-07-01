import { Simulator } from "@/components/Simulator";
import { DEFAULT_CONFIG } from "@/lib/players";

export default function Home() {
  // The sim boots on the curated default matchup so it runs instantly; the
  // team list for the picker is loaded client-side over the Hono RPC client
  // (React Query), so a missing API key just leaves the picker empty.
  return <Simulator initialConfig={DEFAULT_CONFIG} />;
}
