import { describe, expect, it, vi } from "vitest";
import { createDashboardTelemetryStore } from "@/app/components/dashboard/dashboardTelemetryStore";

function vllmEvent(cluster: string, revision: number, tokensPerSecond = 12) {
  return {
    version: 1 as const,
    revision,
    topic: "vllm" as const,
    cluster,
    observedAtMs: revision * 1_000,
    payload: {
      cluster,
      polledAtMs: revision * 1_000,
      sourceHost: `${cluster}.local`,
      state: "live" as const,
      error: null,
      metrics: {
        tokensPerSecond: {
          value: tokensPerSecond,
          state: "live" as const,
          observedAtMs: revision * 1_000,
        },
        runningRequests: { value: 1, state: "live" as const, observedAtMs: revision * 1_000 },
        waitingRequests: { value: 0, state: "live" as const, observedAtMs: revision * 1_000 },
        kvCachePercent: { value: 25, state: "live" as const, observedAtMs: revision * 1_000 },
        kvCacheCapacityTokens: {
          value: 1_000,
          state: "live" as const,
          observedAtMs: revision * 1_000,
        },
      },
    },
  };
}

describe("dashboard telemetry store", () => {
  it("accepts a restarted broker revision after a new SSE connection", () => {
    const store = createDashboardTelemetryStore({ c032: null });

    expect(store.publish(vllmEvent("c032", 42, 42))).toBe(true);

    store.beginConnection();

    expect(store.publish(vllmEvent("c032", 1, 1))).toBe(true);
    expect(store.getClusterSnapshot("c032").vllm?.metrics.tokensPerSecond.value).toBe(1);
  });

  it("rejects an older revision within one SSE connection", () => {
    const store = createDashboardTelemetryStore({ c032: null });

    expect(store.publish(vllmEvent("c032", 2, 2))).toBe(true);
    expect(store.publish(vllmEvent("c032", 1, 1))).toBe(false);
    expect(store.getClusterSnapshot("c032").vllm?.metrics.tokensPerSecond.value).toBe(2);
  });

  it("notifies only the affected cluster for a vLLM update", () => {
    const store = createDashboardTelemetryStore({ c032: null, c458: null });
    const c032Listener = vi.fn();
    const c458Listener = vi.fn();
    const statusesListener = vi.fn();
    store.subscribeCluster("c032", c032Listener);
    store.subscribeCluster("c458", c458Listener);
    store.subscribeStatuses(statusesListener);
    const c032Before = store.getClusterSnapshot("c032");
    const c458Before = store.getClusterSnapshot("c458");

    expect(store.publish(vllmEvent("c032", 1))).toBe(true);

    expect(c032Listener).toHaveBeenCalledTimes(1);
    expect(c458Listener).not.toHaveBeenCalled();
    expect(statusesListener).not.toHaveBeenCalled();
    expect(store.getClusterSnapshot("c032")).not.toBe(c032Before);
    expect(store.getClusterSnapshot("c458")).toBe(c458Before);
    expect(store.getClusterSnapshot("c032").vllm?.metrics.tokensPerSecond.value).toBe(12);
  });

  it("turns a failed status source into an unavailable cluster status", () => {
    const store = createDashboardTelemetryStore({
      c032: {
        groups: {},
        solo_entries: [],
        idle_hosts: [],
        pending_ops: [],
        errors: {},
        total_containers: 0,
        host_count: 1,
      },
    });
    const statusListener = vi.fn();
    store.subscribeStatuses(statusListener);

    expect(
      store.publish({
        version: 1,
        revision: 2,
        topic: "status",
        cluster: "c032",
        observedAtMs: 2_000,
        payload: null,
      }),
    ).toBe(true);

    expect(statusListener).toHaveBeenCalledTimes(1);
    expect(store.getClusterSnapshot("c032").status).toBeNull();
    expect(store.getStatusesSnapshot()).toEqual({ c032: null });
  });
});
