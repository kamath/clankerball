import { createFileRoute } from "@tanstack/react-router";
import { Simulator } from "@/components/Simulator";
import { DEFAULT_CONFIG } from "@/lib/players";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  // The sim boots on the curated default matchup so it runs instantly; the
  // team list loads client-side over the Hono RPC client (React Query).
  return <Simulator initialConfig={DEFAULT_CONFIG} />;
}
