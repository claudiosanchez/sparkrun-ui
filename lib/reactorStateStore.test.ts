import { describe, expect, it, vi } from "vitest";
import type { ReactorState } from "./reactorState";
import { createReactorStateStore } from "./reactorStateStore";

function reactor(name: string): ReactorState {
  return {
    name,
    hostText: `${name}.test`,
    telemetryState: "live",
    telemetryText: "Telemetry live",
    freshnessText: "Host reachable · receiving measurements",
    serviceState: "ready",
    serviceText: "Model API ready",
    modelText: "test-model",
    managedWorkloadCount: 0,
    managedWorkloadText: "0 managed workloads",
    metrics: {
      gpuPercent: 0,
      gpuText: "0%",
      cpuText: "0.0%",
      memoryText: "1.0 / 2.0 GB",
      gpuMemoryText: "—",
      gpuTemperatureText: "40°C",
      cpuTemperatureText: "40°C",
      powerText: "10.0 W",
    },
  };
}

describe("createReactorStateStore", () => {
  it("notifies only the cluster whose reactor state changed", () => {
    const alpha = reactor("alpha");
    const beta = reactor("beta");
    const store = createReactorStateStore({ alpha, beta });
    const alphaListener = vi.fn();
    const betaListener = vi.fn();

    store.subscribe("alpha", alphaListener);
    store.subscribe("beta", betaListener);
    const nextAlpha = { ...alpha, freshnessText: "Updated" };
    store.publish("alpha", nextAlpha);

    expect(store.getSnapshot("alpha")).toBe(nextAlpha);
    expect(store.getSnapshot("beta")).toBe(beta);
    expect(alphaListener).toHaveBeenCalledTimes(1);
    expect(betaListener).not.toHaveBeenCalled();
  });

  it("does not notify a cluster when its state object is unchanged", () => {
    const alpha = reactor("alpha");
    const store = createReactorStateStore({ alpha });
    const listener = vi.fn();
    store.subscribe("alpha", listener);

    store.publish("alpha", alpha);

    expect(listener).not.toHaveBeenCalled();
  });
});
