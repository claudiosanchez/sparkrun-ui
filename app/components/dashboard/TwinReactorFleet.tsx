"use client";

import type { ClusterEntry, ClusterStatus } from "@/lib/schemas";
import { Card, CardBody } from "@/app/components/ui/Card";
import { ReactorCard } from "./ReactorCard";
import type { ReactorStatusUpdate } from "./useReactor";

export function TwinReactorFleet({
  clusters,
  initialStatuses,
  onStatus,
}: {
  clusters: ClusterEntry[];
  initialStatuses: Record<string, ClusterStatus | null>;
  onStatus: ReactorStatusUpdate;
}) {
  const twin = clusters.length === 2;
  return (
    <section aria-label="Saved cluster fleet" className="relative">
      {twin && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-5 left-1/2 hidden w-px bg-zinc-200 sm:block dark:bg-zinc-800"
        />
      )}
      <div
        className={
          twin
            ? "grid grid-cols-1 gap-6 sm:grid-cols-2"
            : "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
        }
      >
        {clusters.map((cluster) => (
          <ReactorCard
            key={cluster.name}
            cluster={cluster}
            initial={initialStatuses[cluster.name] ?? null}
            onStatus={onStatus}
          />
        ))}
      </div>
      {clusters.length === 0 && (
        <Card>
          <CardBody className="text-sm text-zinc-500 dark:text-zinc-400">
            No saved clusters. Save a cluster in Sparkrun to see its telemetry here.
          </CardBody>
        </Card>
      )}
    </section>
  );
}
