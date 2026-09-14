"use client";

import { memo } from "react";
import type { ClusterEntry } from "@/lib/schemas";
import { ClusterTokenHistoryCard } from "./ClusterTokenHistoryCard";

export const ClusterTokenHistorySection = memo(function ClusterTokenHistorySection({
  clusters,
}: {
  clusters: ClusterEntry[];
}) {
  return (
    <section aria-label="Token throughput history" className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Token throughput history
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Persisted Tokens/s history for each saved cluster.
        </p>
      </div>
      {clusters.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No saved clusters have token history yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {clusters.map((cluster) => (
            <ClusterTokenHistoryCard key={cluster.name} cluster={cluster} range="15m" />
          ))}
        </div>
      )}
    </section>
  );
});
