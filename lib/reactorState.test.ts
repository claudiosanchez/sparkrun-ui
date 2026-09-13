import { describe, expect, it } from "vitest";
import { MonitorTickSchema } from "./monitor";
import { ClusterStatusSchema, type ClusterEntry } from "./schemas";
import { deriveReactorState } from "./reactorState";

const c032Entry: ClusterEntry = { name: "c032", hosts: ["100.65.40.24"], is_default: true };
const c458Entry: ClusterEntry = { name: "c458", hosts: ["100.83.161.109"], is_default: false };
const sample = {
  gpu_util_pct: "70",
  cpu_usage_pct: "12.5",
  mem_used_mb: "65536",
  mem_total_mb: "131072",
  gpu_mem_used_mb: "",
  gpu_mem_total_mb: "",
  gpu_temp_c: "62",
  cpu_temp_c: "55",
  gpu_power_w: "42.5",
};
const c032Tick = MonitorTickSchema.parse({
  timestamp: 100,
  hosts: [{ host: c032Entry.hosts[0], sample }],
});
const c458Tick = MonitorTickSchema.parse({
  timestamp: 101,
  hosts: [{ host: c458Entry.hosts[0], sample: { ...sample, gpu_util_pct: "0" } }],
});
const emptyStatus = ClusterStatusSchema.parse({ host_count: 1 });

describe("deriveReactorState", () => {
  it("keeps C032 live when C458 model health is unavailable", () => {
    const c032 = deriveReactorState({
      cluster: c032Entry,
      tick: c032Tick,
      service: { cluster: "c032", host: c032Entry.hosts[0], state: "ready", model: "served-model" },
    });
    const c458 = deriveReactorState({
      cluster: c458Entry,
      tick: c458Tick,
      service: { cluster: "c458", host: c458Entry.hosts[0], state: "unavailable", model: null },
    });
    expect(c032.telemetryState).toBe("live");
    expect(c032.serviceState).toBe("ready");
    expect(c032.modelText).toBe("served-model");
    expect(c458.serviceState).toBe("unavailable");
    expect(c458.telemetryState).toBe("live");
    expect(c458.metrics.gpuMemoryText).toBe("—");
    expect(c458.metrics.gpuText).toBe("0%");
  });

  it("uses visible labels for each model health state", () => {
    const checking = deriveReactorState({ cluster: c032Entry });
    const unavailable = deriveReactorState({
      cluster: c032Entry,
      service: { cluster: "c032", host: c032Entry.hosts[0], state: "unavailable", model: null },
    });
    const ready = deriveReactorState({
      cluster: c032Entry,
      service: { cluster: "c032", host: c032Entry.hosts[0], state: "ready", model: "qwen" },
    });

    expect(checking.serviceText).toBe("Checking model API");
    expect(unavailable.serviceText).toBe("Model API unavailable");
    expect(ready.serviceText).toBe("Model API ready");
    expect(ready.modelText).toBe("qwen");
  });

  it("labels a direct service with zero managed workloads", () => {
    expect(
      deriveReactorState({ cluster: c458Entry, status: emptyStatus }).managedWorkloadText,
    ).toBe("0 managed workloads");
  });

  it("does not report an initial status failure as zero workloads", () => {
    const state = deriveReactorState({ cluster: c458Entry, status: null });
    expect(state.managedWorkloadCount).toBeNull();
    expect(state.managedWorkloadText).toBe("Managed workloads unavailable");
    expect(state.telemetryState).toBe("unavailable");
    expect(state.metrics.gpuText).toBe("—");
  });

  it("formats current measurements without fabricating GPU memory", () => {
    const { metrics } = deriveReactorState({ cluster: c032Entry, tick: c032Tick });
    expect(metrics).toMatchObject({
      cpuPercent: 12.5,
      gpuPercent: 70,
      gpuText: "70%",
      cpuText: "12.5%",
      memoryText: "64.0 / 128.0 GB",
      gpuMemoryText: "—",
      gpuTemperatureText: "62°C",
      cpuTemperatureText: "55°C",
      powerText: "42.5 W",
    });
  });

  it("retains the last valid measurements with a stale label while reconnecting", () => {
    const state = deriveReactorState({ cluster: c032Entry, tick: c032Tick, reconnecting: true });
    expect(state.telemetryState).toBe("reconnecting");
    expect(state.freshnessText).toContain("stale");
    expect(state.metrics.gpuText).toBe("70%");
  });

  it.each([
    { error: "Permission denied", sample },
    { error: null, sample: null },
    { error: null, sample: {} },
  ])("clears invalid host measurements: %j", (host) => {
    const tick = MonitorTickSchema.parse({
      timestamp: 102,
      hosts: [{ host: c032Entry.hosts[0], ...host }],
    });
    const state = deriveReactorState({ cluster: c032Entry, tick });
    expect(state.telemetryState).toBe("unavailable");
    expect(state.metrics.gpuPercent).toBeNull();
    expect(state.metrics.memoryText).toBe("—");
  });

  it("uses only the configured hosts and supports arbitrary cluster names", () => {
    const cluster = { ...c032Entry, name: "lab" };
    const tick = { ...c032Tick, hosts: [...c032Tick.hosts, ...c458Tick.hosts] };
    const state = deriveReactorState({ cluster, tick });
    expect(state.name).toBe("lab");
    expect(state.metrics.gpuPercent).toBe(70);
  });

  it("does not treat missing hosts or missing metrics as zero in multi-host totals", () => {
    const cluster = {
      name: "pair",
      hosts: [...c032Entry.hosts, ...c458Entry.hosts],
      is_default: false,
    };
    expect(deriveReactorState({ cluster, tick: c032Tick }).telemetryState).toBe("unavailable");
    const tick = { ...c032Tick, hosts: [...c032Tick.hosts, ...c458Tick.hosts] };
    const state = deriveReactorState({ cluster, tick });
    expect(state.metrics.gpuPercent).toBe(35);
    expect(state.metrics.memoryText).toBe("128.0 / 256.0 GB");
    expect(state.metrics.powerText).toBe("85.0 W");
    expect(state.metrics.gpuMemoryText).toBe("—");
  });
});
