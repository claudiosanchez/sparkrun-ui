import { describe, expect, it, vi } from "vitest";
import { createDashboardTelemetryBroker } from "./dashboardTelemetry";
import { createDashboardTelemetryRuntime } from "./dashboardTelemetryRuntime";
import type { MonitorTick } from "./monitor";
import type { ClusterStatus } from "./schemas";
import type { TokenHistoryStore } from "./tokenHistory";
import { createTokenHistoryRecorder } from "./tokenHistoryRecorder";
import type { VllmClusterSnapshot } from "./vllmMetrics";

type Listener = (snapshot: VllmClusterSnapshot) => void;

function snapshot(cluster: string, polledAtMs: number): VllmClusterSnapshot {
  return {
    cluster,
    polledAtMs,
    sourceHost: `${cluster}.local`,
    state: "live",
    error: null,
    metrics: {
      tokensPerSecond: { value: 12, state: "live", observedAtMs: polledAtMs },
      runningRequests: { value: 1, state: "live", observedAtMs: polledAtMs },
      waitingRequests: { value: 0, state: "live", observedAtMs: polledAtMs },
      kvCachePercent: { value: 25, state: "live", observedAtMs: polledAtMs },
      kvCacheCapacityTokens: { value: 1_000, state: "live", observedAtMs: polledAtMs },
    },
  };
}

function createRegistry() {
  const listeners = new Map<string, Listener>();
  return {
    subscribe: vi.fn((cluster: string, _host: string, listener: Listener) => {
      listeners.set(cluster, listener);
      return () => listeners.delete(cluster);
    }),
    emit(cluster: string, next: VllmClusterSnapshot) {
      listeners.get(cluster)?.(next);
    },
  };
}

function createSharedRegistry() {
  type Entry = {
    leaderHost: string;
    subscribers: Set<Listener>;
    onStopped: Map<Listener, () => void>;
  };
  const entries = new Map<string, Entry>();

  const stopEntry = (cluster: string, entry: Entry) => {
    for (const onStopped of entry.onStopped.values()) onStopped();
    entry.subscribers.clear();
    entry.onStopped.clear();
    if (entries.get(cluster) === entry) entries.delete(cluster);
  };

  return {
    subscribe: vi.fn(
      (
        cluster: string,
        leaderHost: string,
        listener: Listener,
        onStopped: () => void = () => {},
      ) => {
        let entry = entries.get(cluster);
        if (entry && entry.leaderHost !== leaderHost) {
          stopEntry(cluster, entry);
          entry = undefined;
        }
        if (!entry) {
          entry = { leaderHost, subscribers: new Set(), onStopped: new Map() };
          entries.set(cluster, entry);
        }
        entry.subscribers.add(listener);
        entry.onStopped.set(listener, onStopped);
        const subscribedEntry = entry;
        return () => {
          subscribedEntry.subscribers.delete(listener);
          subscribedEntry.onStopped.delete(listener);
        };
      },
    ),
    getEntry: (cluster: string) => entries.get(cluster),
    stop: (cluster: string) => {
      const entry = entries.get(cluster);
      if (entry) stopEntry(cluster, entry);
    },
    emitFrom(cluster: string, leaderHost: string, next: VllmClusterSnapshot): boolean {
      const entry = entries.get(cluster);
      if (!entry || entry.leaderHost !== leaderHost) return false;
      for (const listener of entry.subscribers) listener(next);
      return true;
    },
  };
}

const emptyStatus: ClusterStatus = {
  groups: {},
  solo_entries: [],
  idle_hosts: [],
  pending_ops: [],
  errors: {},
  total_containers: 0,
  host_count: 1,
};

async function* noMonitor(_input: unknown, signal?: AbortSignal): AsyncGenerator<MonitorTick> {
  await new Promise<void>((resolve) =>
    signal?.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("dashboard telemetry runtime", () => {
  it("shares one one-second vLLM subscription per saved cluster across repeated starts", async () => {
    const registry = createRegistry();
    const broker = createDashboardTelemetryBroker();
    const runtime = createDashboardTelemetryRuntime({
      listSavedClusters: async () => [
        { name: "c032", hosts: ["c032.local"], is_default: true },
        { name: "c458", hosts: ["c458.local"], is_default: false },
      ],
      registry: registry as never,
      broker,
      streamMonitor: noMonitor,
      fetchStatus: async () => emptyStatus,
      healthForHost: async (cluster) => ({
        cluster,
        host: null,
        state: "unavailable",
        model: null,
      }),
      wait: async (_ms, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      wallNow: () => 20_000,
      monotonicNow: () => 20_000,
    });

    await runtime.start();
    await runtime.start();

    expect(registry.subscribe).toHaveBeenCalledTimes(2);
    expect(registry.subscribe).toHaveBeenNthCalledWith(
      1,
      "c032",
      "c032.local",
      expect.any(Function),
      expect.any(Function),
      1_000,
    );
    expect(registry.subscribe).toHaveBeenNthCalledWith(
      2,
      "c458",
      "c458.local",
      expect.any(Function),
      expect.any(Function),
      1_000,
    );

    const feed = broker.subscribe();
    registry.emit("c032", snapshot("c032", 20_001));

    let vllmEvent: Awaited<ReturnType<typeof feed.next>> | null = null;
    for (let index = 0; index < 8; index += 1) {
      const event = await feed.next();
      if (!event.done && event.value.topic === "vllm" && event.value.cluster === "c032") {
        vllmEvent = event;
        break;
      }
    }

    expect(vllmEvent).toEqual({
      done: false,
      value: expect.objectContaining({
        topic: "vllm",
        cluster: "c032",
        observedAtMs: 20_001,
        payload: snapshot("c032", 20_001),
      }),
    });

    await feed.return();
    await runtime.stop();
  });

  it("publishes an unavailable status snapshot when collection fails", async () => {
    const registry = createRegistry();
    const broker = createDashboardTelemetryBroker();
    const feed = broker.subscribe();
    const runtime = createDashboardTelemetryRuntime({
      listSavedClusters: async () => [{ name: "c032", hosts: ["c032.local"], is_default: true }],
      registry: registry as never,
      broker,
      streamMonitor: noMonitor,
      fetchStatus: async () => {
        throw new Error("status source unavailable");
      },
      healthForHost: async (cluster) => ({
        cluster,
        host: null,
        state: "unavailable",
        model: null,
      }),
      wait: async (_ms, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      wallNow: () => 20_000,
      monotonicNow: () => 20_000,
    });

    await runtime.start();

    let statusEvent: Awaited<ReturnType<typeof feed.next>> | null = null;
    for (let index = 0; index < 8; index += 1) {
      const event = await feed.next();
      if (!event.done && event.value.topic === "status") {
        statusEvent = event;
        break;
      }
    }

    expect(statusEvent).toEqual({
      done: false,
      value: expect.objectContaining({
        topic: "status",
        cluster: "c032",
        observedAtMs: 20_000,
        payload: null,
      }),
    });

    await feed.return();
    await runtime.stop();
  });

  it("delivers a topology reset to active clients without caching a removed cluster", async () => {
    const registry = createRegistry();
    const broker = createDashboardTelemetryBroker();
    let clusters = [{ name: "c032", hosts: ["c032.local"], is_default: true }];
    broker.publish({
      topic: "token-history",
      cluster: "c032",
      observedAtMs: 10_000,
      payload: {
        atMs: 10_000,
        cluster: "c032",
        fingerprint: "c032-host-a",
        tokensPerSecond: 12,
      },
    });
    const runtime = createDashboardTelemetryRuntime({
      listSavedClusters: async () => clusters,
      registry: registry as never,
      broker,
      streamMonitor: noMonitor,
      fetchStatus: async (_cluster, signal) => {
        await waitForAbort(signal);
        throw new Error("stopped");
      },
      healthForHost: async (_cluster, _host, signal) => {
        await waitForAbort(signal);
        throw new Error("stopped");
      },
      wait: async (_ms, signal) => waitForAbort(signal),
      wallNow: () => 20_000,
      monotonicNow: () => 20_000,
    });

    await runtime.start();
    const active = broker.subscribe();
    await active.next();
    clusters = [];

    await runtime.reconcile();

    const transitions = [];
    while (active.pendingEventCount > 0) {
      const next = await active.next();
      if (!next.done) transitions.push(next.value);
    }
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "vllm",
          cluster: "c032",
          payload: expect.objectContaining({ state: "unavailable" }),
        }),
        expect.objectContaining({ topic: "monitor", cluster: "c032", payload: null }),
        expect.objectContaining({ topic: "status", cluster: "c032", payload: null }),
        expect.objectContaining({ topic: "service", cluster: "c032" }),
        expect.objectContaining({
          topic: "token-history-reset",
          cluster: "c032",
          payload: { reason: "topology-change" },
        }),
      ]),
    );

    const reconnect = broker.subscribe();
    expect(reconnect.pendingEventCount).toBe(0);

    await active.return();
    await reconnect.return();
    await runtime.stop();
  });

  it("retains the active source when the recorder cannot confirm a topology change", async () => {
    const registry = createRegistry();
    const broker = createDashboardTelemetryBroker();
    let clusters = [{ name: "c032", hosts: ["host-a"], is_default: true }];
    const reconcileTokenHistoryRecorder = vi.fn(async () => false);
    const runtime = createDashboardTelemetryRuntime({
      listSavedClusters: async () => clusters,
      registry: registry as never,
      broker,
      streamMonitor: noMonitor,
      fetchStatus: async (_cluster, signal) => {
        await waitForAbort(signal);
        throw new Error("stopped");
      },
      healthForHost: async (_cluster, _host, signal) => {
        await waitForAbort(signal);
        throw new Error("stopped");
      },
      wait: async (_ms, signal) => waitForAbort(signal),
      wallNow: () => 20_000,
      monotonicNow: () => 20_000,
      reconcileTokenHistoryRecorder,
    });

    await runtime.start();
    const active = broker.subscribe();
    while (active.pendingEventCount > 0) await active.next();
    clusters = [{ name: "c032", hosts: ["host-b"], is_default: true }];

    await runtime.reconcile();

    expect(reconcileTokenHistoryRecorder).toHaveBeenCalledWith([
      { name: "c032", hosts: ["host-b"], is_default: true },
    ]);
    expect(runtime.activeClusters.get("c032")?.target.leaderHost).toBe("host-a");
    const transitions = [];
    while (active.pendingEventCount > 0) {
      const next = await active.next();
      if (!next.done) transitions.push(next.value);
    }
    expect(transitions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topic: "token-history-reset", cluster: "c032" }),
      ]),
    );

    await active.return();
    await runtime.stop();
  });

  it("waits for recorder topology reconciliation before publishing a reset", async () => {
    const registry = createRegistry();
    const broker = createDashboardTelemetryBroker();
    let clusters = [{ name: "c032", hosts: ["host-a"], is_default: true }];
    let releaseBarrier!: (value: boolean) => void;
    const barrier = new Promise<boolean>((resolve) => {
      releaseBarrier = resolve;
    });
    let entered!: () => void;
    const enteredBarrier = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let holdTransition = false;
    const reconcileTokenHistoryRecorder = vi.fn(() => {
      if (!holdTransition) return Promise.resolve(true);
      entered();
      return barrier;
    });
    const runtime = createDashboardTelemetryRuntime({
      listSavedClusters: async () => clusters,
      registry: registry as never,
      broker,
      streamMonitor: noMonitor,
      fetchStatus: async (_cluster, signal) => {
        await waitForAbort(signal);
        throw new Error("stopped");
      },
      healthForHost: async (_cluster, _host, signal) => {
        await waitForAbort(signal);
        throw new Error("stopped");
      },
      wait: async (_ms, signal) => waitForAbort(signal),
      wallNow: () => 20_000,
      monotonicNow: () => 20_000,
      reconcileTokenHistoryRecorder,
    });

    await runtime.start();
    const active = broker.subscribe();
    while (active.pendingEventCount > 0) await active.next();
    holdTransition = true;
    clusters = [];
    const reconciling = runtime.reconcile();
    await enteredBarrier;

    expect(reconcileTokenHistoryRecorder).toHaveBeenCalledWith([]);
    expect(active.pendingEventCount).toBe(0);

    releaseBarrier(true);
    await reconciling;
    const transitions = [];
    while (active.pendingEventCount > 0) {
      const next = await active.next();
      if (!next.done) transitions.push(next.value);
    }
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topic: "token-history-reset", cluster: "c032" }),
      ]),
    );

    await active.return();
    await runtime.stop();
  });

  it("coordinates recorder replacement before emitting a host-change reset", async () => {
    const registry = createSharedRegistry();
    const broker = createDashboardTelemetryBroker();
    let clusters = [{ name: "c032", hosts: ["host-a"], is_default: true }];
    const store: TokenHistoryStore = {
      record: vi.fn(async () => undefined),
      query: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const recorder = createTokenHistoryRecorder({
      clusters: async () => clusters,
      registry: registry as never,
      store,
      now: () => 20_000,
      wait: async (_ms, signal) => waitForAbort(signal),
      publishObservation: (observation) => {
        broker.publish({
          topic: "token-history",
          cluster: observation.cluster,
          observedAtMs: observation.atMs,
          payload: observation,
        });
      },
    });
    const runtime = createDashboardTelemetryRuntime({
      listSavedClusters: async () => clusters,
      registry: registry as never,
      broker,
      streamMonitor: noMonitor,
      fetchStatus: async (_cluster, signal) => {
        await waitForAbort(signal);
        throw new Error("stopped");
      },
      healthForHost: async (_cluster, _host, signal) => {
        await waitForAbort(signal);
        throw new Error("stopped");
      },
      wait: async (_ms, signal) => waitForAbort(signal),
      wallNow: () => 20_000,
      monotonicNow: () => 20_000,
      reconcileTokenHistoryRecorder: (topology) => recorder.reconcile(topology),
    });

    await recorder.start();
    await runtime.start();
    const active = broker.subscribe();
    try {
      expect(registry.emitFrom("c032", "host-a", snapshot("c032", 10_000))).toBe(true);
      while (active.pendingEventCount > 0) await active.next();

      clusters = [{ name: "c032", hosts: ["host-b"], is_default: true }];
      await runtime.reconcile();

      const transitions = [];
      while (active.pendingEventCount > 0) {
        const next = await active.next();
        if (!next.done) transitions.push(next.value);
      }
      expect(transitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ topic: "token-history-reset", cluster: "c032" }),
        ]),
      );
      expect(registry.emitFrom("c032", "host-a", snapshot("c032", 11_000))).toBe(false);
      expect(registry.emitFrom("c032", "host-b", snapshot("c032", 12_000))).toBe(true);

      const refreshed = [];
      while (active.pendingEventCount > 0) {
        const next = await active.next();
        if (!next.done) refreshed.push(next.value);
      }
      expect(refreshed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            topic: "token-history",
            cluster: "c032",
            observedAtMs: 12_000,
            payload: expect.objectContaining({ atMs: 12_000, tokensPerSecond: 12 }),
          }),
        ]),
      );
    } finally {
      await active.return();
      await runtime.stop();
      await recorder.stop();
    }
  });

  it("uses the runtime topology to remove a stale recorder before a removal reset", async () => {
    const registry = createSharedRegistry();
    const broker = createDashboardTelemetryBroker();
    let runtimeClusters = [{ name: "c032", hosts: ["host-a"], is_default: true }];
    const recorderClusters = [{ name: "c032", hosts: ["host-a"], is_default: true }];
    const store: TokenHistoryStore = {
      record: vi.fn(async () => undefined),
      query: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const recorder = createTokenHistoryRecorder({
      // Deliberately stale after removal: the barrier must use runtimeClusters.
      clusters: async () => recorderClusters,
      registry: registry as never,
      store,
      now: () => 20_000,
      wait: async (_ms, signal) => waitForAbort(signal),
      publishObservation: (observation) => {
        broker.publish({
          topic: "token-history",
          cluster: observation.cluster,
          observedAtMs: observation.atMs,
          payload: observation,
        });
      },
    });
    const runtime = createDashboardTelemetryRuntime({
      listSavedClusters: async () => runtimeClusters,
      registry: registry as never,
      broker,
      streamMonitor: noMonitor,
      fetchStatus: async (_cluster, signal) => {
        await waitForAbort(signal);
        throw new Error("stopped");
      },
      healthForHost: async (_cluster, _host, signal) => {
        await waitForAbort(signal);
        throw new Error("stopped");
      },
      wait: async (_ms, signal) => waitForAbort(signal),
      wallNow: () => 20_000,
      monotonicNow: () => 20_000,
      reconcileTokenHistoryRecorder: (topology) => recorder.reconcile(topology),
    });

    await recorder.start();
    await runtime.start();
    const active = broker.subscribe();
    let reconnect: ReturnType<typeof broker.subscribe> | undefined;
    try {
      expect(registry.emitFrom("c032", "host-a", snapshot("c032", 10_000))).toBe(true);
      while (active.pendingEventCount > 0) await active.next();

      runtimeClusters = [];
      await runtime.reconcile();

      const transitions = [];
      while (active.pendingEventCount > 0) {
        const next = await active.next();
        if (!next.done) transitions.push(next.value);
      }
      expect(transitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ topic: "token-history-reset", cluster: "c032" }),
        ]),
      );
      expect(recorder.subscriptions.size).toBe(0);
      expect(runtime.activeClusters.has("c032")).toBe(false);

      // The recorder's later independent discovery result is still stale.
      // It must retain the runtime's authoritative removal instead of
      // subscribing to host-a again.
      await recorder.reconcile();
      expect(recorder.subscriptions.size).toBe(0);

      // If the recorder had only re-read its stale topology, this would publish
      // a new cached token-history event after the reset.
      expect(registry.emitFrom("c032", "host-a", snapshot("c032", 11_000))).toBe(false);
      expect(active.pendingEventCount).toBe(0);

      reconnect = broker.subscribe();
      const replayed = [];
      while (reconnect.pendingEventCount > 0) {
        const next = await reconnect.next();
        if (!next.done) replayed.push(next.value);
      }
      expect(replayed).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ topic: "token-history", cluster: "c032" }),
        ]),
      );

      // A later addition has no existing runtime source to reset. It still
      // must give the recorder the new authoritative topology.
      runtimeClusters = [{ name: "c032", hosts: ["host-b"], is_default: true }];
      await runtime.reconcile();
      expect(recorder.subscriptions.get("c032")?.hosts).toEqual(["host-b"]);
      expect(registry.emitFrom("c032", "host-b", snapshot("c032", 12_000))).toBe(true);
      const restored = [];
      while (active.pendingEventCount > 0) {
        const next = await active.next();
        if (!next.done) restored.push(next.value);
      }
      expect(restored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            topic: "token-history",
            cluster: "c032",
            observedAtMs: 12_000,
          }),
        ]),
      );
    } finally {
      await reconnect?.return();
      await active.return();
      await runtime.stop();
      await recorder.stop();
    }
  });
});
