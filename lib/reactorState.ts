import { monitorHostViews, numberMetric, type MonitorTick } from "./monitor";
import type { ClusterEntry, ClusterStatus } from "./schemas";
import type { ServiceHealth } from "./rpc/procedures/services";

type ReactorInput = {
  cluster: ClusterEntry;
  status?: ClusterStatus | null;
  tick?: MonitorTick | null;
  service?: ServiceHealth | null;
  reconnecting?: boolean;
};

const metricKeys = [
  "gpu_util_pct",
  "cpu_usage_pct",
  "mem_used_mb",
  "mem_total_mb",
  "gpu_mem_used_mb",
  "gpu_mem_total_mb",
  "gpu_temp_c",
  "cpu_temp_c",
  "gpu_power_w",
];

export function deriveReactorState({
  cluster,
  status,
  tick,
  service,
  reconnecting = false,
}: ReactorInput) {
  const views = tick ? monitorHostViews(tick) : {};
  const hosts = cluster.hosts.map((host) => views[host]);
  const valid =
    hosts.length > 0 &&
    hosts.every(
      (host) =>
        host &&
        host.error == null &&
        host.sample &&
        metricKeys.some((key) => numberMetric(host.sample?.[key]) !== null),
    );
  const samples = valid ? hosts.map((host) => host.sample!) : [];

  // A partial total would hide a missing host or measurement. Keep it unavailable.
  function metric(key: string, average = false): number | null {
    const values = samples.map((sample) => numberMetric(sample[key]));
    if (values.length === 0 || values.some((value) => value === null)) return null;
    const total = values.reduce<number>((sum, value) => sum + value!, 0);
    return average ? total / values.length : total;
  }
  function text(value: number | null, unit: string, decimals = 0) {
    return value === null ? "—" : `${value.toFixed(decimals)}${unit}`;
  }
  function memoryText(prefix: string) {
    const used = metric(`${prefix}_used_mb`);
    const total = metric(`${prefix}_total_mb`);
    return used === null || total === null || total <= 0
      ? "—"
      : `${(used / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} GB`;
  }

  const telemetryState = reconnecting ? "reconnecting" : valid ? "live" : "unavailable";
  const serviceState = service?.state ?? "checking";
  const managedWorkloadCount = status ? status.solo_entries.length : null;
  const cpuPercent = metric("cpu_usage_pct", true);
  const gpuPercent = metric("gpu_util_pct", true);
  return {
    name: cluster.name,
    hostText: cluster.hosts.join(", ") || "No hosts configured",
    telemetryState,
    telemetryText:
      telemetryState === "live"
        ? "Telemetry live"
        : telemetryState === "reconnecting"
          ? "Reconnecting"
          : "Telemetry unavailable",
    freshnessText: reconnecting
      ? valid
        ? "Last received measurements · stale"
        : "Waiting for connection to recover"
      : valid
        ? `${hosts.length === 1 ? "Host reachable" : `${hosts.length} hosts reachable`} · receiving measurements`
        : "Host measurements are unavailable",
    serviceState,
    serviceText:
      serviceState === "ready"
        ? "Model API ready"
        : serviceState === "unavailable"
          ? "Model API unavailable"
          : "Checking model API",
    modelText: service?.state === "ready" ? (service.model ?? "—") : "—",
    managedWorkloadCount,
    managedWorkloadText:
      managedWorkloadCount === null
        ? "Managed workloads unavailable"
        : `${managedWorkloadCount} managed workload${managedWorkloadCount === 1 ? "" : "s"}`,
    trends: { cpu: [] as number[], gpu: [] as number[] },
    metrics: {
      cpuPercent,
      gpuPercent,
      gpuText: text(gpuPercent, "%"),
      cpuText: text(cpuPercent, "%", 1),
      memoryText: memoryText("mem"),
      gpuMemoryText: memoryText("gpu_mem"),
      gpuTemperatureText: text(metric("gpu_temp_c", true), "°C"),
      cpuTemperatureText: text(metric("cpu_temp_c", true), "°C"),
      powerText: text(metric("gpu_power_w"), " W", 1),
    },
  };
}

export type ReactorState = ReturnType<typeof deriveReactorState>;
