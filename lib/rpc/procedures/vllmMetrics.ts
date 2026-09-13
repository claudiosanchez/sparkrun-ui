import { eventIterator, os } from "@orpc/server";
import { z } from "zod";
import { POLL_INTERVAL_MS, type VllmCollectorRegistry } from "@/lib/vllmCollector";
import {
  unavailableClusterSnapshot,
  VllmClusterSnapshotSchema,
  type VllmClusterSnapshot,
} from "@/lib/vllmMetrics";
import {
  getProductionVllmCollectorRuntime,
  type VllmCollectorRuntimeDependencies,
} from "@/lib/vllmCollectorRuntime";
import type { ClusterEntry } from "@/lib/schemas";

export type VllmCollectorDependencies = VllmCollectorRuntimeDependencies;

function unavailable(
  cluster: string,
  wallNow: () => number,
  error: string | null,
): VllmClusterSnapshot {
  return unavailableClusterSnapshot(cluster, Math.max(0, Math.trunc(wallNow())), null, error);
}

function canUseSavedHost(host: string): boolean {
  const value = host.trim();
  return value.length > 0 && !/[\s/?#\\]/.test(value) && !value.includes("@");
}

export async function* streamClusterMetrics(
  input: { cluster: string },
  signal: AbortSignal | undefined,
  registry: VllmCollectorRegistry,
  loadClusters: VllmCollectorDependencies["listSavedClusters"],
  wallNow: () => number = () => Date.now(),
): AsyncGenerator<VllmClusterSnapshot> {
  const owner = signal ?? new AbortController().signal;
  let savedClusters: ClusterEntry[];
  try {
    savedClusters = await loadClusters(owner);
  } catch {
    if (!owner.aborted) yield unavailable(input.cluster, wallNow, "unreachable");
    return;
  }
  if (owner.aborted) return;

  const savedCluster = savedClusters.find((entry) => entry.name === input.cluster);
  const leaderHost = savedCluster?.hosts[0]?.trim() ?? null;
  if (!leaderHost || !canUseSavedHost(leaderHost)) {
    yield unavailable(input.cluster, wallNow, null);
    return;
  }

  const queue: VllmClusterSnapshot[] = [];
  const streamController = new AbortController();
  const streamSignal = AbortSignal.any([owner, streamController.signal]);
  let wake: (() => void) | null = null;
  const notify = (snapshot: VllmClusterSnapshot) => {
    queue.push(snapshot);
    wake?.();
    wake = null;
  };
  const unsubscribe = registry.subscribe(
    input.cluster,
    leaderHost,
    notify,
    () => {
      streamController.abort();
    },
    POLL_INTERVAL_MS,
  );
  const onAbort = () => {
    wake?.();
    wake = null;
  };
  streamSignal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!streamSignal.aborted) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (streamSignal.aborted) {
          wake = null;
          resolve();
        }
      });
    }
  } finally {
    streamSignal.removeEventListener("abort", onAbort);
    unsubscribe();
  }
}

export const stream = os
  .input(z.object({ cluster: z.string().min(1) }))
  .output(eventIterator(VllmClusterSnapshotSchema))
  .handler(({ input, signal }) => {
    const runtime = getProductionVllmCollectorRuntime();
    return streamClusterMetrics(
      input,
      signal,
      runtime.registry,
      runtime.listSavedClusters ?? runtime.dependencies.listSavedClusters,
    );
  });
