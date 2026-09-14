"use client";

import { useMemo } from "react";
import { deriveReactorState } from "@/lib/reactorState";
import type { ClusterEntry } from "@/lib/schemas";
import { useDashboardClusterTelemetry } from "./DashboardTelemetryProvider";

export function useReactor(cluster: ClusterEntry) {
  const telemetry = useDashboardClusterTelemetry(cluster.name);

  return useMemo(
    () => ({
      ...deriveReactorState({
        cluster,
        status: telemetry.status,
        tick: telemetry.monitor,
        service: telemetry.service,
        reconnecting: !telemetry.connectionHealthy && telemetry.monitor !== null,
        vllm: telemetry.vllm,
        vllmReconnecting: !telemetry.connectionHealthy && telemetry.vllm !== null,
      }),
      trends: telemetry.trends,
    }),
    [cluster, telemetry],
  );
}
