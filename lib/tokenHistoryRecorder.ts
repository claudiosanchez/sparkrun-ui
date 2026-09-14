import { createHash } from "node:crypto";
import type { ClusterEntry } from "./schemas";
import type { VllmCollectorRegistry } from "./vllmCollector";
import type { VllmClusterSnapshot } from "./vllmMetrics";
import type { TokenHistoryStore, TokenObservation } from "./tokenHistory";
import { getProductionDashboardTelemetryBroker } from "./dashboardTelemetry";
import { getProductionVllmCollectorRuntime } from "./vllmCollectorRuntime";

export const RECORDER_POLL_INTERVAL_MS = 1_000;
export const DISCOVERY_INTERVAL_MS = 5_000;

type ClusterSource =
  | ClusterEntry[]
  | Promise<ClusterEntry[]>
  | ((signal: AbortSignal) => ClusterEntry[] | Promise<ClusterEntry[]>);

export type TokenHistoryRecorderDependencies = {
  clusters: ClusterSource;
  registry: VllmCollectorRegistry;
  store: TokenHistoryStore;
  now: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  discoveryIntervalMs?: number;
  publishObservation?: (observation: TokenObservation) => void | Promise<void>;
};

type RecorderSubscription = {
  cluster: string;
  hosts: string[];
  fingerprint: string;
  unsubscribe: () => void;
  lastSeenAtMs: number | null;
  lastRecordedAtMs: number | null;
  previousLastSeenAtMs: number | null;
  stopped: boolean;
};

type RecorderRegistry = VllmCollectorRegistry & {
  stop?: (cluster: string) => void;
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

function normalizeHosts(hosts: string[]): string[] {
  return hosts.map((host) => host.trim()).filter((host) => host.length > 0);
}

function canUseSavedHost(host: string): boolean {
  return host.length > 0 && !/[\s/?#\\]/.test(host) && !host.includes("@");
}

/** Return a stable identity for the complete ordered saved target. */
export function fingerprintHosts(hosts: string[]): string {
  const normalized = normalizeHosts(hosts);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function readClusters(source: ClusterSource, signal: AbortSignal): Promise<ClusterEntry[]> {
  if (Array.isArray(source)) return source;
  if (typeof source === "function") return source(signal);
  return source;
}

function validObservationTime(value: number): number | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function createTokenHistoryRecorder(dependencies: TokenHistoryRecorderDependencies) {
  const registry = dependencies.registry as RecorderRegistry;
  const wait = dependencies.wait ?? defaultWait;
  const discoveryIntervalMs =
    dependencies.discoveryIntervalMs === undefined
      ? DISCOVERY_INTERVAL_MS
      : Math.max(1, Math.trunc(dependencies.discoveryIntervalMs));
  const controller = new AbortController();
  const subscriptions = new Map<string, RecorderSubscription>();
  const pendingWrites = new Set<Promise<void>>();
  let started = false;
  let initialReconcile: Promise<void> | null = null;
  let loopPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let reconciliationQueue = Promise.resolve();

  function trackWrite(observation: Parameters<TokenHistoryStore["record"]>[0]): void {
    let result: Promise<void>;
    try {
      result = dependencies.store.record(observation);
    } catch {
      return;
    }
    const write = Promise.resolve(result).catch(() => undefined);
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write)).catch(() => undefined);
  }

  function publishObservation(observation: TokenObservation): void {
    try {
      const publication = dependencies.publishObservation?.(observation);
      void Promise.resolve(publication).catch(() => undefined);
    } catch {
      // Live publication is best effort and must not interrupt recording.
    }
  }

  function subscribeCluster(
    cluster: ClusterEntry,
    hosts: string[],
    fingerprint: string,
    previous: RecorderSubscription | undefined,
  ): RecorderSubscription | null {
    const leaderHost = hosts[0];
    if (!leaderHost || !canUseSavedHost(leaderHost)) return null;

    const subscription: RecorderSubscription = {
      cluster: cluster.name,
      hosts,
      fingerprint,
      unsubscribe: () => {},
      lastSeenAtMs: null,
      lastRecordedAtMs: null,
      previousLastSeenAtMs: previous?.lastSeenAtMs ?? null,
      stopped: false,
    };
    const onSnapshot = (snapshot: VllmClusterSnapshot) => {
      const atMs = validObservationTime(snapshot.polledAtMs);
      if (atMs === null) return;

      // subscribe() may synchronously replay a cached snapshot. When the
      // saved target changed, never assign that old timestamp to the new
      // series. A second replay at the same timestamp is also redundant.
      if (subscription.previousLastSeenAtMs !== null && atMs <= subscription.previousLastSeenAtMs) {
        return;
      }
      if (subscription.lastRecordedAtMs !== null && atMs <= subscription.lastRecordedAtMs) {
        subscription.lastSeenAtMs = Math.max(subscription.lastSeenAtMs ?? atMs, atMs);
        return;
      }

      subscription.lastSeenAtMs = Math.max(subscription.lastSeenAtMs ?? atMs, atMs);
      subscription.lastRecordedAtMs = atMs;
      const tokensPerSecond =
        snapshot.metrics.tokensPerSecond.state === "live" &&
        snapshot.metrics.tokensPerSecond.value !== null &&
        Number.isFinite(snapshot.metrics.tokensPerSecond.value) &&
        snapshot.metrics.tokensPerSecond.value >= 0
          ? snapshot.metrics.tokensPerSecond.value
          : null;
      const observation: TokenObservation = {
        atMs,
        cluster: cluster.name,
        fingerprint,
        tokensPerSecond,
      };
      publishObservation(observation);
      trackWrite(observation);
    };
    const onStopped = () => {
      // Collector stop callbacks run before the entry is removed. Mark the
      // subscription only; reconciliation performs any replacement later.
      subscription.stopped = true;
    };
    subscription.unsubscribe = registry.subscribe(
      cluster.name,
      leaderHost,
      onSnapshot,
      onStopped,
      RECORDER_POLL_INTERVAL_MS,
    );
    return subscription;
  }

  function removeSubscription(subscription: RecorderSubscription, stopEntry = true): void {
    // The dashboard runtime may have already replaced this cluster's collector
    // with a new leader. Never stop that replacement while cleaning up the
    // recorder's old subscription.
    if (
      stopEntry &&
      registry.getEntry?.(subscription.cluster)?.leaderHost === subscription.hosts[0]
    ) {
      registry.stop?.(subscription.cluster);
    }
    subscription.unsubscribe();
    if (!stopEntry && registry.getEntry?.(subscription.cluster)?.subscribers.size === 0) {
      registry.stop?.(subscription.cluster);
    }
  }

  async function performReconcile(): Promise<void> {
    if (controller.signal.aborted) return;

    let loaded: ClusterEntry[];
    try {
      loaded = await readClusters(dependencies.clusters, controller.signal);
      if (!Array.isArray(loaded)) throw new Error("Invalid saved cluster list");
    } catch {
      // A transient discovery failure must not turn a known list into an
      // empty list. The next loop iteration retries discovery.
      return;
    }
    if (controller.signal.aborted) return;

    const desired = new Map<
      string,
      { cluster: ClusterEntry; hosts: string[]; fingerprint: string }
    >();
    for (const cluster of loaded) {
      if (
        !cluster ||
        typeof cluster.name !== "string" ||
        cluster.name.length === 0 ||
        !Array.isArray(cluster.hosts) ||
        cluster.hosts.some((host) => typeof host !== "string")
      ) {
        return;
      }
      const hosts = normalizeHosts(cluster.hosts);
      desired.set(cluster.name, { cluster, hosts, fingerprint: fingerprintHosts(hosts) });
    }

    for (const [name, current] of [...subscriptions.entries()]) {
      if (desired.has(name)) continue;
      removeSubscription(current);
      subscriptions.delete(name);
    }

    for (const [name, target] of desired) {
      const current = subscriptions.get(name);
      if (
        current &&
        !current.stopped &&
        current.fingerprint === target.fingerprint &&
        current.hosts.join("\u0000") === target.hosts.join("\u0000")
      ) {
        continue;
      }

      if (current) {
        removeSubscription(current);
        subscriptions.delete(name);
      }

      const next = subscribeCluster(target.cluster, target.hosts, target.fingerprint, current);
      if (next) subscriptions.set(name, next);
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
    initialReconcile = reconcile();
    loopPromise = (async () => {
      await initialReconcile;
      while (!controller.signal.aborted) {
        await wait(discoveryIntervalMs, controller.signal);
        if (controller.signal.aborted) return;
        await reconcile();
      }
    })().catch(() => undefined);
    return initialReconcile;
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    controller.abort();
    for (const subscription of subscriptions.values()) removeSubscription(subscription, false);
    subscriptions.clear();
    stopPromise = (async () => {
      await loopPromise?.catch(() => undefined);
      await Promise.allSettled([...pendingWrites]);
    })();
    return stopPromise;
  }

  return {
    start,
    stop,
    reconcile,
    get subscriptions() {
      return new Map(subscriptions);
    },
  };
}

declare global {
  var __sparkrunTokenHistoryStop: (() => void) | undefined;
}

/** Start the one process-owned recorder, returning an idempotent stop hook. */
export function startTokenHistoryRecorder(): () => void {
  if (globalThis.__sparkrunTokenHistoryStop) return globalThis.__sparkrunTokenHistoryStop;

  let recorder: ReturnType<typeof createTokenHistoryRecorder> | null = null;
  try {
    const runtime = getProductionVllmCollectorRuntime();
    recorder = createTokenHistoryRecorder({
      clusters: runtime.listSavedClusters ?? runtime.dependencies.listSavedClusters,
      registry: runtime.registry,
      store: runtime.store,
      now: runtime.dependencies.wallNow,
      publishObservation: (observation) => {
        getProductionDashboardTelemetryBroker().publish({
          topic: "token-history",
          cluster: observation.cluster,
          observedAtMs: observation.atMs,
          payload: observation,
        });
      },
    });
    void recorder.start().catch(() => undefined);
  } catch {
    // Instrumentation must never prevent the UI server from starting.
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (globalThis.__sparkrunTokenHistoryStop === stop)
      globalThis.__sparkrunTokenHistoryStop = undefined;
    void recorder?.stop().catch(() => undefined);
  };
  globalThis.__sparkrunTokenHistoryStop = stop;
  return stop;
}
