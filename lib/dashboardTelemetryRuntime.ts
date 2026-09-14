import type { DashboardTelemetryBroker } from "./dashboardTelemetry";
import type { MonitorTick } from "./monitor";
import { streamMonitor, type MonitorStreamInput } from "./rpc/procedures/monitor";
import { healthForHost } from "./rpc/procedures/services";
import { fetchStatus } from "./rpc/procedures/status";
import type { ClusterEntry, ClusterStatus } from "./schemas";
import type { ServiceHealth } from "./serviceHealth";
import {
  reconcileProductionTokenHistoryRecorder,
  startTokenHistoryRecorder,
} from "./tokenHistoryRecorder";
import { POLL_INTERVAL_MS, type VllmCollectorRegistry } from "./vllmCollector";
import {
  getProductionVllmCollectorRuntime,
  type VllmCollectorRuntimeDependencies,
} from "./vllmCollectorRuntime";
import { unavailableClusterSnapshot, type VllmClusterSnapshot } from "./vllmMetrics";
import { getProductionDashboardTelemetryBroker } from "./dashboardTelemetry";

export const MONITOR_INTERVAL_SEC = 2;
export const STATUS_INTERVAL_MS = 3_000;
export const SERVICE_INTERVAL_MS = 10_000;
export const DISCOVERY_INTERVAL_MS = 5_000;
export const RETRY_DELAY_MS = 3_000;

type MonitorSource = (
  input: MonitorStreamInput,
  signal?: AbortSignal,
) => AsyncIterable<MonitorTick>;

type Wait = (ms: number, signal: AbortSignal) => Promise<void>;

export type DashboardTelemetryRuntimeDependencies = {
  listSavedClusters: VllmCollectorRuntimeDependencies["listSavedClusters"];
  registry: VllmCollectorRegistry;
  broker: DashboardTelemetryBroker;
  streamMonitor?: MonitorSource;
  fetchStatus?: (cluster?: string, signal?: AbortSignal) => Promise<ClusterStatus>;
  healthForHost?: (
    cluster: string,
    host: string | null,
    signal?: AbortSignal,
  ) => Promise<ServiceHealth>;
  /** Reconcile recorder sources against this exact runtime topology before a reset. */
  reconcileTokenHistoryRecorder?: (topology: readonly ClusterEntry[]) => Promise<boolean>;
  wallNow?: () => number;
  monotonicNow?: () => number;
  wait?: Wait;
  discoveryIntervalMs?: number;
  monitorIntervalSec?: number;
  statusIntervalMs?: number;
  serviceIntervalMs?: number;
  retryDelayMs?: number;
};

type Target = {
  cluster: ClusterEntry;
  hosts: string[];
  fingerprint: string;
  leaderHost: string | null;
};

type ActiveCluster = {
  target: Target;
  controller: AbortController;
  signal: AbortSignal;
  vllmUnsubscribe: () => void;
  vllmStopped: boolean;
  closed: boolean;
  tasks: Promise<void>[];
};

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
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

function normalizedNow(now: () => number): number {
  return Math.max(0, Math.trunc(now()));
}

function normalizeHosts(hosts: string[]): string[] {
  return hosts.map((host) => host.trim()).filter((host) => host.length > 0);
}

function canUseSavedHost(host: string | null): host is string {
  return host !== null && host.length > 0 && !/[\s/?#\\]/.test(host) && !host.includes("@");
}

function targetFor(cluster: ClusterEntry): Target {
  const hosts = normalizeHosts(cluster.hosts);
  return {
    cluster,
    hosts,
    fingerprint: JSON.stringify(hosts),
    leaderHost: hosts[0] ?? null,
  };
}

function unavailableService(cluster: string): ServiceHealth {
  return { cluster, host: null, state: "unavailable", model: null };
}

/**
 * Own the dashboard's upstream collectors once per server process. Browser
 * subscribers receive only broker events; they never start a source loop.
 */
export function createDashboardTelemetryRuntime(
  dependencies: DashboardTelemetryRuntimeDependencies,
) {
  const streamMonitorSource = dependencies.streamMonitor ?? streamMonitor;
  const fetchClusterStatus = dependencies.fetchStatus ?? fetchStatus;
  const fetchServiceHealth = dependencies.healthForHost ?? healthForHost;
  const reconcileTokenHistoryRecorder =
    dependencies.reconcileTokenHistoryRecorder ?? reconcileProductionTokenHistoryRecorder;
  const wallNow = dependencies.wallNow ?? (() => Date.now());
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const wait = dependencies.wait ?? defaultWait;
  const discoveryIntervalMs = dependencies.discoveryIntervalMs ?? DISCOVERY_INTERVAL_MS;
  const monitorIntervalSec = dependencies.monitorIntervalSec ?? MONITOR_INTERVAL_SEC;
  const statusIntervalMs = dependencies.statusIntervalMs ?? STATUS_INTERVAL_MS;
  const serviceIntervalMs = dependencies.serviceIntervalMs ?? SERVICE_INTERVAL_MS;
  const retryDelayMs = dependencies.retryDelayMs ?? RETRY_DELAY_MS;
  const controller = new AbortController();
  const active = new Map<string, ActiveCluster>();
  const background = new Set<Promise<void>>();
  let reconciliationQueue = Promise.resolve();
  let started = false;
  let initialReconcile: Promise<void> | null = null;
  let discoveryLoop: Promise<void> | null = null;
  let overviewLoop: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  function publishVllm(snapshot: VllmClusterSnapshot): void {
    dependencies.broker.publish({
      topic: "vllm",
      cluster: snapshot.cluster,
      observedAtMs: snapshot.polledAtMs,
      payload: snapshot,
    });
  }

  function publishClusterUnavailable(cluster: string): void {
    const observedAtMs = normalizedNow(wallNow);
    for (const topic of [
      "vllm",
      "monitor",
      "status",
      "service",
      "token-history",
      "token-history-reset",
    ] as const) {
      dependencies.broker.evict({ topic, cluster });
    }
    dependencies.broker.publishTransient({
      topic: "vllm",
      cluster,
      observedAtMs,
      payload: unavailableClusterSnapshot(cluster, observedAtMs, null, null),
    });
    dependencies.broker.publishTransient({
      topic: "monitor",
      cluster,
      observedAtMs,
      payload: null,
    });
    dependencies.broker.publishTransient({ topic: "status", cluster, observedAtMs, payload: null });
    dependencies.broker.publishTransient({
      topic: "service",
      cluster,
      observedAtMs,
      payload: unavailableService(cluster),
    });
    dependencies.broker.publishTransient({
      topic: "token-history-reset",
      cluster,
      observedAtMs,
      payload: { reason: "topology-change" },
    });
  }

  async function periodically(
    signal: AbortSignal,
    intervalMs: number,
    collect: () => Promise<void>,
  ) {
    while (!signal.aborted) {
      const startedAtMs = monotonicNow();
      await collect();
      if (signal.aborted) return;
      const remainingMs = Math.max(0, startedAtMs + intervalMs - monotonicNow());
      await wait(remainingMs, signal);
    }
  }

  async function collectMonitor(
    input: MonitorStreamInput,
    signal: AbortSignal,
    publish: (tick: MonitorTick | null) => void,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const tick of streamMonitorSource(input, signal)) {
          if (signal.aborted) return;
          publish(tick);
        }
      } catch {
        // The null event below keeps source freshness separate from SSE health.
      }
      if (signal.aborted) return;
      publish(null);
      await wait(retryDelayMs, signal);
    }
  }

  function startCluster(target: Target): ActiveCluster {
    const sourceController = new AbortController();
    const signal = AbortSignal.any([controller.signal, sourceController.signal]);
    const source: ActiveCluster = {
      target,
      controller: sourceController,
      signal,
      vllmUnsubscribe: () => {},
      vllmStopped: false,
      closed: false,
      tasks: [],
    };
    const cluster = target.cluster.name;

    if (canUseSavedHost(target.leaderHost)) {
      source.vllmUnsubscribe = dependencies.registry.subscribe(
        cluster,
        target.leaderHost,
        (snapshot) => {
          if (!source.signal.aborted) publishVllm(snapshot);
        },
        () => {
          if (source.signal.aborted || source.closed) return;
          source.vllmStopped = true;
          publishVllm(unavailableClusterSnapshot(cluster, normalizedNow(wallNow), null, null));
          void reconcile();
        },
        POLL_INTERVAL_MS,
      );
    } else {
      publishVllm(unavailableClusterSnapshot(cluster, normalizedNow(wallNow), null, null));
    }

    const monitorTask = collectMonitor(
      { cluster, intervalSec: monitorIntervalSec },
      signal,
      (tick) => {
        dependencies.broker.publish({
          topic: "monitor",
          cluster,
          observedAtMs: normalizedNow(wallNow),
          payload: tick,
        });
      },
    ).catch(() => undefined);
    const statusTask = periodically(signal, statusIntervalMs, async () => {
      let payload: ClusterStatus | null = null;
      try {
        payload = await fetchClusterStatus(cluster, signal);
      } catch {
        // A nullable status tells the browser that this source is unavailable.
      }
      if (!signal.aborted) {
        dependencies.broker.publish({
          topic: "status",
          cluster,
          observedAtMs: normalizedNow(wallNow),
          payload,
        });
      }
    }).catch(() => undefined);
    const serviceTask = periodically(signal, serviceIntervalMs, async () => {
      let payload: ServiceHealth;
      try {
        payload = await fetchServiceHealth(cluster, target.leaderHost, signal);
      } catch {
        payload = unavailableService(cluster);
      }
      if (!signal.aborted) {
        dependencies.broker.publish({
          topic: "service",
          cluster,
          observedAtMs: normalizedNow(wallNow),
          payload,
        });
      }
    }).catch(() => undefined);
    source.tasks.push(monitorTask, statusTask, serviceTask);
    for (const task of source.tasks) background.add(task);
    return source;
  }

  function stopCluster(source: ActiveCluster): void {
    if (source.closed) return;
    source.closed = true;
    source.controller.abort();
    source.vllmUnsubscribe();
  }

  async function performReconcile(): Promise<void> {
    if (controller.signal.aborted) return;
    let clusters: ClusterEntry[];
    try {
      clusters = await dependencies.listSavedClusters(controller.signal);
      if (!Array.isArray(clusters)) throw new Error("Invalid saved cluster list");
    } catch {
      // Retain known targets through a transient discovery failure.
      return;
    }
    if (controller.signal.aborted) return;

    const desired = new Map<string, Target>();
    for (const cluster of clusters) {
      if (!cluster || typeof cluster.name !== "string" || !Array.isArray(cluster.hosts)) return;
      desired.set(cluster.name, targetFor(cluster));
    }

    const resetSources = new Map<string, ActiveCluster>();
    const startTargets = new Map<string, Target>();
    for (const [cluster, target] of desired) {
      const source = active.get(cluster);
      if (!source) {
        startTargets.set(cluster, target);
        continue;
      }
      if (source.target.fingerprint === target.fingerprint && !source.vllmStopped) continue;
      resetSources.set(cluster, source);
      startTargets.set(cluster, target);
    }
    for (const [cluster, source] of active) {
      if (!desired.has(cluster)) resetSources.set(cluster, source);
    }

    let recorderSynced = false;
    try {
      // Pass every exact discovery snapshot to the recorder. Once it owns a
      // reset, its independent discovery result may be stale; additions must
      // therefore advance that same authoritative topology too.
      recorderSynced = await reconcileTokenHistoryRecorder(clusters);
    } catch {
      recorderSynced = false;
    }
    if (controller.signal.aborted || (resetSources.size > 0 && !recorderSynced)) return;

    for (const [cluster, source] of resetSources) {
      if (source) {
        stopCluster(source);
        active.delete(cluster);
        publishClusterUnavailable(cluster);
      }
    }
    for (const [cluster, target] of startTargets) {
      if (active.has(cluster)) continue;
      active.set(cluster, startCluster(target));
    }
  }

  function reconcile(): Promise<void> {
    const operation = reconciliationQueue.then(() => performReconcile());
    reconciliationQueue = operation.catch(() => undefined);
    return operation;
  }

  function start(): Promise<void> {
    if (started) return initialReconcile ?? Promise.resolve();
    started = true;
    overviewLoop = collectMonitor(
      { intervalSec: monitorIntervalSec },
      controller.signal,
      (tick) => {
        dependencies.broker.publish({
          topic: "overview-monitor",
          observedAtMs: normalizedNow(wallNow),
          payload: tick,
        });
      },
    ).catch(() => undefined);
    background.add(overviewLoop);
    initialReconcile = reconcile();
    discoveryLoop = (async () => {
      await initialReconcile;
      while (!controller.signal.aborted) {
        await wait(discoveryIntervalMs, controller.signal);
        if (controller.signal.aborted) return;
        await reconcile();
      }
    })().catch(() => undefined);
    background.add(discoveryLoop);
    return initialReconcile;
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    controller.abort();
    for (const source of active.values()) stopCluster(source);
    active.clear();
    stopPromise = Promise.allSettled([...background]).then(() => undefined);
    return stopPromise;
  }

  return {
    start,
    stop,
    reconcile,
    get activeClusters() {
      return new Map(active);
    },
  };
}

declare global {
  var __sparkrunDashboardTelemetryRuntimeStop: (() => void) | undefined;
}

/** Start the process-global runtime once, alongside the durable token recorder. */
export function startDashboardTelemetryRuntime(): () => void {
  if (globalThis.__sparkrunDashboardTelemetryRuntimeStop) {
    return globalThis.__sparkrunDashboardTelemetryRuntimeStop;
  }

  let runtime: ReturnType<typeof createDashboardTelemetryRuntime> | null = null;
  try {
    startTokenHistoryRecorder();
    const vllmRuntime = getProductionVllmCollectorRuntime();
    runtime = createDashboardTelemetryRuntime({
      listSavedClusters:
        vllmRuntime.listSavedClusters ?? vllmRuntime.dependencies.listSavedClusters,
      registry: vllmRuntime.registry,
      broker: getProductionDashboardTelemetryBroker(),
      wallNow: vllmRuntime.dependencies.wallNow,
      monotonicNow: vllmRuntime.dependencies.monotonicNow,
      wait: vllmRuntime.dependencies.wait,
    });
    void runtime.start().catch(() => undefined);
  } catch {
    // Best-effort collection must not prevent the UI process from starting.
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (globalThis.__sparkrunDashboardTelemetryRuntimeStop === stop) {
      globalThis.__sparkrunDashboardTelemetryRuntimeStop = undefined;
    }
    void runtime?.stop().catch(() => undefined);
  };
  globalThis.__sparkrunDashboardTelemetryRuntimeStop = stop;
  return stop;
}

export function resetProductionDashboardTelemetryRuntime(): void {
  globalThis.__sparkrunDashboardTelemetryRuntimeStop?.();
  globalThis.__sparkrunDashboardTelemetryRuntimeStop = undefined;
}
