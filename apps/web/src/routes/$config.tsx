import { Outlet, createFileRoute } from "@tanstack/react-router";
import { fetchPlay } from "@/lib/api";

// /{config} — a saved play config, addressed by its content id. The loader
// pulls the stored SimulateRequest once; both children (the editor at /{config}
// and the results at /{config}/results) read it back, so navigating between
// edit and results is fully driven by the URL.
export const Route = createFileRoute("/$config")({
  loader: ({ params }) => fetchPlay(params.config),
  component: () => <Outlet />,
  errorComponent: () => (
    <div className="mx-auto max-w-[1400px] p-6 text-sm text-muted-foreground">
      That config couldn’t be found — it may have been removed, or the link is wrong.
    </div>
  ),
});
