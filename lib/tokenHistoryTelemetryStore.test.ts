import { describe, expect, it, vi } from "vitest";
import { createTokenHistoryTelemetryStore } from "@/app/components/dashboard/tokenHistoryTelemetryStore";

function observationEvent(cluster: string, revision: number) {
  return {
    version: 1 as const,
    revision,
    topic: "token-history" as const,
    cluster,
    observedAtMs: revision * 1_000,
    payload: {
      atMs: revision * 1_000,
      cluster,
      fingerprint: `fingerprint-${cluster}`,
      tokensPerSecond: revision,
    },
  };
}

describe("token history telemetry store", () => {
  it("clears only the live overlay when the shared feed reports a topology change", () => {
    const store = createTokenHistoryTelemetryStore();
    const listener = vi.fn();
    store.subscribe("c032", listener);

    expect(store.getTopologyGeneration("c032")).toBe(0);
    expect(store.publish(observationEvent("c032", 10))).toBe(true);
    expect(store.getSnapshot("c032").observations).toHaveLength(1);

    expect(
      store.publish({
        version: 1,
        revision: 11,
        topic: "token-history-reset",
        cluster: "c032",
        observedAtMs: 11_000,
        payload: { reason: "topology-change" },
      }),
    ).toBe(true);

    expect(store.getSnapshot("c032").observations).toEqual([]);
    expect(store.getTopologyGeneration("c032")).toBe(1);
    expect(listener).toHaveBeenCalledTimes(2);

    expect(
      store.publish({
        version: 1,
        revision: 12,
        topic: "token-history-reset",
        cluster: "c032",
        observedAtMs: 12_000,
        payload: { reason: "topology-change" },
      }),
    ).toBe(true);
    expect(store.getTopologyGeneration("c032")).toBe(2);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
