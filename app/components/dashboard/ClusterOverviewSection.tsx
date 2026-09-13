"use client";

import { memo } from "react";
import type { ClusterEntry } from "@/lib/schemas";
import { Card, CardBody } from "@/app/components/ui/Card";
import { ClusterOverviewCard } from "./ClusterOverviewCard";

export const ClusterOverviewSection = memo(function ClusterOverviewSection({
  clusters,
}: {
  clusters: ClusterEntry[];
}) {
  return (
    <section aria-label="Saved cluster overview" className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Clusters</h2>
      {clusters.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-zinc-500 dark:text-zinc-400">
            No saved clusters. Save a cluster in Sparkrun to see its telemetry here.
          </CardBody>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {clusters.map((cluster) => (
            <ClusterOverviewCard key={cluster.name} cluster={cluster} />
          ))}
        </div>
      )}
    </section>
  );
});
