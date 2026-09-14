import { describe, expect, it, vi } from "vitest";
import { createDashboardTelemetryBroker } from "./dashboardTelemetry";
import { createDashboardTelemetryRuntime } from "./dashboardTelemetryRuntime";
import type { MonitorTick } from "./monitor";
import type { ClusterStatus } from "./schemas";
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
});
