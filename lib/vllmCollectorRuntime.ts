import { homedir, platform } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createTokenHistoryFileStore } from "./tokenHistoryFileStore";
import {
  createVllmCollectorRegistry,
  type VllmCollectorDependencies as CollectorDependencies,
  type VllmCollectorRegistry,
} from "./vllmCollector";
import { runSparkrunJson } from "./sparkrun";
import { ClusterEntrySchema, type ClusterEntry } from "./schemas";
import type { TokenHistoryStore } from "./tokenHistory";

export const CLUSTER_DISCOVERY_TIMEOUT_MS = 3_000;

export type VllmCollectorRuntimeDependencies = CollectorDependencies & {
  listSavedClusters: (signal: AbortSignal) => Promise<ClusterEntry[]>;
};

export type ProductionVllmCollectorRuntime = {
  registry: VllmCollectorRegistry;
  dependencies: VllmCollectorRuntimeDependencies;
  store: TokenHistoryStore;
  dataDir: string;
  listSavedClusters: (signal: AbortSignal) => Promise<ClusterEntry[]>;
};

const RawClusterEntrySchema = z.object({
  name: z.string(),
  hosts: z.array(z.string()).default([]),
  description: z.string().optional(),
  default: z.boolean().optional(),
  is_default: z.boolean().optional(),
});

function parseClusterEntry(value: unknown): ClusterEntry {
  const raw = RawClusterEntrySchema.safeParse(value);
  if (raw.success) {
    return {
      name: raw.data.name,
      hosts: raw.data.hosts,
      ...(raw.data.description === undefined ? {} : { description: raw.data.description }),
      is_default: raw.data.is_default ?? raw.data.default ?? false,
    };
  }
  return ClusterEntrySchema.parse(value);
}

export async function listSavedClusters(signal: AbortSignal): Promise<ClusterEntry[]> {
  const raw = await runSparkrunJson<unknown>(["cluster", "list", "--json"], {
    signal,
    timeoutMs: CLUSTER_DISCOVERY_TIMEOUT_MS,
  });
  return z.array(z.unknown()).parse(raw).map(parseClusterEntry);
}

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

export function defaultTokenHistoryDataDir(
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = platform(),
  homeDirectory: string = homedir(),
): string {
  const configured = environment.SPARKRUN_UI_DATA_DIR?.trim();
  if (configured) return configured;

  const cacheRoot =
    hostPlatform === "win32"
      ? environment.LOCALAPPDATA || join(homeDirectory, "AppData", "Local")
      : hostPlatform === "darwin"
        ? join(homeDirectory, "Library", "Caches")
        : environment.XDG_CACHE_HOME || join(homeDirectory, ".cache");
  return join(cacheRoot, "sparkrun-ui", "telemetry");
}

function createRuntime(): ProductionVllmCollectorRuntime {
  const dependencies: VllmCollectorRuntimeDependencies = {
    fetch: globalThis.fetch.bind(globalThis),
    listSavedClusters,
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
    wait,
  };
  const registry = createVllmCollectorRegistry(dependencies);
  const dataDir = defaultTokenHistoryDataDir();
  const store = createTokenHistoryFileStore({ dataDir, now: dependencies.wallNow });
  return { registry, dependencies, store, dataDir, listSavedClusters };
}

declare global {
  var __sparkrunVllmCollectorRuntime: ProductionVllmCollectorRuntime | undefined;
}

/** Return the one collector/store pair shared by all server entry points. */
export function getProductionVllmCollectorRuntime(): ProductionVllmCollectorRuntime {
  if (!globalThis.__sparkrunVllmCollectorRuntime) {
    globalThis.__sparkrunVllmCollectorRuntime = createRuntime();
  }
  return globalThis.__sparkrunVllmCollectorRuntime;
}

/** Test/HMR seam; production code should retain the process-global runtime. */
export function resetProductionVllmCollectorRuntime(): void {
  globalThis.__sparkrunVllmCollectorRuntime?.registry.stopAll();
  globalThis.__sparkrunVllmCollectorRuntime = undefined;
}
