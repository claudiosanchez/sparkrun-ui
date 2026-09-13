"use client";
import { useCallback, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Rocket } from "lucide-react";
import type { ClusterEntry, ClusterStatus } from "@/lib/schemas";
import type { RunningRecipeDisplay } from "@/lib/runningRecipes";
import { Card, CardBody } from "@/app/components/ui/Card";
import { Badge } from "@/app/components/ui/Badge";
import { Button } from "@/app/components/ui/Button";
import { WorkloadCard } from "./WorkloadCard";
import { TwinReactorFleet } from "./TwinReactorFleet";

function formatHostError(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) {
    return String((value as { message: unknown }).message);
  }
  return JSON.stringify(value);
}

export function DashboardLive({
  clusters,
  initialStatuses,
  recipeByCluster,
}: {
  clusters: ClusterEntry[];
  initialStatuses: Record<string, ClusterStatus | null>;
  recipeByCluster: Map<string, RunningRecipeDisplay>;
}) {
  const [statuses, setStatuses] = useState(initialStatuses);
  const updateStatus = useCallback((name: string, status: ClusterStatus) => {
    setStatuses((previous) => ({ ...previous, [name]: status }));
  }, []);
  const savedStatuses = clusters.map((cluster) => ({ cluster, status: statuses[cluster.name] }));
  const workloads = savedStatuses.flatMap(({ cluster, status }) =>
    (status?.solo_entries ?? []).map((workload) => ({ cluster: cluster.name, workload })),
  );
  const errors = savedStatuses.flatMap(({ cluster, status }) =>
    Object.entries(status?.errors ?? {}).map(([host, error]) => ({
      cluster: cluster.name,
      host,
      error,
    })),
  );
  const unavailableCount = savedStatuses.filter(({ status }) => !status).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
          <Badge tone="sky">
            {clusters.length} saved cluster{clusters.length === 1 ? "" : "s"}
          </Badge>
          <Badge tone="green">
            {workloads.length} known managed workload{workloads.length === 1 ? "" : "s"}
          </Badge>
        </div>
      </div>

      <TwinReactorFleet
        clusters={clusters}
        initialStatuses={initialStatuses}
        onStatus={updateStatus}
      />

      {errors.length > 0 && (
        <Card className="border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40">
          <CardBody className="flex gap-3">
            <AlertTriangle
              className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
              size={18}
            />
            <div className="flex flex-col gap-1 text-sm">
              <h3 className="font-medium text-amber-900 dark:text-amber-200">
                Cluster status reported errors
              </h3>
              <ul className="flex flex-col gap-1 text-amber-800 dark:text-amber-300">
                {errors.map(({ cluster, host, error }) => (
                  <li key={`${cluster}:${host}`} className="font-mono text-xs">
                    <span className="font-semibold">
                      {cluster} · {host}:
                    </span>{" "}
                    {formatHostError(error)}
                  </li>
                ))}
              </ul>
            </div>
          </CardBody>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Workloads</h2>
        {unavailableCount > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            Managed workload status is unavailable for {unavailableCount} saved cluster
            {unavailableCount === 1 ? "" : "s"}. This list may be incomplete.
          </p>
        )}
        {workloads.length === 0 ? (
          <Card>
            <CardBody className="flex flex-col items-center gap-4 py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-sky-50 text-sky-600 dark:bg-sky-950 dark:text-sky-400">
                <Rocket size={22} />
              </div>
              <div className="flex flex-col gap-1">
                <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  {unavailableCount > 0
                    ? "No managed workload data available"
                    : "No managed workloads"}
                </h3>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Model services started outside Sparkrun appear in the fleet above. Launch a recipe
                  to add a managed workload.
                </p>
              </div>
              <Link href="/launch">
                <Button variant="primary">
                  <Rocket size={14} />
                  Launch a recipe
                </Button>
              </Link>
            </CardBody>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {workloads.map(({ cluster, workload: w }) => (
              <WorkloadCard
                key={`${cluster}:${w.cluster_id}`}
                cluster={cluster}
                workload={w}
                recipe={recipeByCluster.get(w.cluster_id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
