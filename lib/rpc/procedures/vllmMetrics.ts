import { eventIterator, os } from "@orpc/server";
import { z } from "zod";
import {
  createVllmCollectorRegistry,
  type VllmCollectorDependencies as CollectorDependencies,
  type VllmCollectorRegistry,
} from "@/lib/vllmCollector";
import {
  unavailableClusterSnapshot,
  VllmClusterSnapshotSchema,
  type VllmClusterSnapshot,
} from "@/lib/vllmMetrics";
import { runSparkrunJson } from "@/lib/sparkrun";
import { ClusterEntrySchema, type ClusterEntry } from "@/lib/schemas";

export type VllmCollectorDependencies = CollectorDependencies & {
  listSavedClusters: (signal: AbortSignal) => Promise<ClusterEntry[]>;
};

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) done();
  });
}

async function listSavedClusters(signal: AbortSignal): Promise<ClusterEntry[]> {
  const raw = await runSparkrunJson<unknown>(["cluster", "list", "--json"], { signal });
  return z.array(ClusterEntrySchema).parse(raw);
}

const productionDependencies: VllmCollectorDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  listSavedClusters,
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
  wait,
};
const productionRegistry = createVllmCollectorRegistry(productionDependencies);

function unavailable(cluster: string, wallNow: () => number, error: string): VllmClusterSnapshot {
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
    yield unavailable(input.cluster, wallNow, "unavailable");
    return;
  }

  const queue: VllmClusterSnapshot[] = [];
  let wake: (() => void) | null = null;
  const notify = (snapshot: VllmClusterSnapshot) => {
    queue.push(snapshot);
    wake?.();
    wake = null;
  };
  const unsubscribe = registry.subscribe(input.cluster, leaderHost, notify);
  const onAbort = () => {
    wake?.();
    wake = null;
  };
  owner.addEventListener("abort", onAbort, { once: true });
  try {
    while (!owner.aborted) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (owner.aborted) {
          wake = null;
          resolve();
        }
      });
    }
  } finally {
    owner.removeEventListener("abort", onAbort);
    unsubscribe();
  }
}

export const stream = os
  .input(z.object({ cluster: z.string().min(1) }))
  .output(eventIterator(VllmClusterSnapshotSchema))
  .handler(({ input, signal }) =>
    streamClusterMetrics(
      input,
      signal,
      productionRegistry,
      productionDependencies.listSavedClusters,
    ),
  );
