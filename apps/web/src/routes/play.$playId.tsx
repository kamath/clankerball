import { createFileRoute } from "@tanstack/react-router";
import { Simulator } from "@/components/Simulator";
import { fetchPlay } from "@/lib/api";

// /play/{id} — load a shared play config from KV and boot the lab on it. The
// loader fetches the stored SimulateRequest; the Simulator preloads its
// matchup, plans, and the exact authored formation.
export const Route = createFileRoute("/play/$playId")({
  loader: ({ params }) => fetchPlay(params.playId),
  component: PlayPage,
  errorComponent: () => (
    <div className="mx-auto max-w-[1400px] p-6 text-sm text-muted-foreground">
      That play couldn’t be found — it may have been removed, or the link is wrong.
    </div>
  ),
});

function PlayPage() {
  const play = Route.useLoaderData();
  return <Simulator initialConfig={play.config} initialPlay={play} />;
}
