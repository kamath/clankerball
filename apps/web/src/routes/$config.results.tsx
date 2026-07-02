import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { Simulator } from "@/components/Simulator";

// /{config}/results — the outcome distribution for a submitted config. Stages
// the stored play and runs the batch (`?runs=N` possessions) on mount, so the
// results are reproducible from the URL alone (refresh / deep-link re-runs).
// A Back button on the Simulator returns to /{config} to edit and re-submit.
export const Route = createFileRoute("/$config/results")({
  validateSearch: (search: Record<string, unknown>): { runs: number } => {
    const n = Number(search.runs);
    const runs = Number.isFinite(n) ? Math.min(500, Math.max(1, Math.floor(n))) : 100;
    return { runs };
  },
  component: ConfigResultsPage,
});

function ConfigResultsPage() {
  const play = useLoaderData({ from: "/$config" });
  const { config } = Route.useParams();
  const { runs } = Route.useSearch();
  return (
    <Simulator
      initialConfig={play.config}
      initialPlay={play}
      view="results"
      configId={config}
      runs={runs}
    />
  );
}
