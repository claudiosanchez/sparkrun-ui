import { serverClient } from "@/lib/rpc/server";
import {
  applyReactorCapacityPolicies,
  loadReactorCapacityPolicies,
} from "@/lib/reactorCapacityPolicy";
import { resolveRunningRecipeDisplay, type RunningRecipeDisplay } from "@/lib/runningRecipes";
import { DashboardLive } from "@/app/components/dashboard/DashboardLive";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [clusters, recipes, policies] = await Promise.all([
    serverClient.clusters.list(),
    serverClient.recipes.list({ all: true }),
    loadReactorCapacityPolicies(),
  ]);
  const statuses = await Promise.all(
    clusters.map((cluster) => serverClient.status.get({ cluster: cluster.name }).catch(() => null)),
  );
  const initialStatuses = Object.fromEntries(
    clusters.map((cluster, index) => [cluster.name, statuses[index]]),
  );
  const recipeByCluster = new Map<string, RunningRecipeDisplay>();
  for (const w of statuses.flatMap((status) => status?.solo_entries ?? [])) {
    const display = await resolveRunningRecipeDisplay(w, recipes);
    if (display) recipeByCluster.set(w.cluster_id, display);
  }
  return (
    <DashboardLive
      clusters={applyReactorCapacityPolicies(clusters, policies)}
      initialStatuses={initialStatuses}
      recipeByCluster={recipeByCluster}
    />
  );
}
