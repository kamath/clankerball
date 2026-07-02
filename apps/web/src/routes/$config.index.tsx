import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { Simulator } from "@/components/Simulator";

// /{config} — edit a saved play config, then re-submit. Boots the Simulator on
// the stored matchup with the authored formation restored, exactly like opening
// a shared play. Submitting persists the (possibly edited) play and routes to
// /{config}/results.
export const Route = createFileRoute("/$config/")({
  component: ConfigEditPage,
});

function ConfigEditPage() {
  const play = useLoaderData({ from: "/$config" });
  const { config } = Route.useParams();
  return <Simulator initialConfig={play.config} initialPlay={play} configId={config} />;
}
