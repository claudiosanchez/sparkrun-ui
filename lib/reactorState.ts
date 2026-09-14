import { monitorHostViews, numberMetric, type MonitorTick } from "./monitor";
import type { ClusterEntry, ClusterStatus } from "./schemas";
import type { ServiceHealth } from "./rpc/procedures/services";
import type { VllmClusterSnapshot, VllmMetricState, VllmReading } from "./vllmMetrics";

type RingTone = "success" | "info" | "warning" | "pressure" | "critical" | "neutral";

type RingSemanticState = {
  percent: number | null;
  status: string;
  tone: RingTone;
  state: VllmMetricState;
};

function neutralReadingState(state: VllmMetricState): RingSemanticState {
  return {
    percent: null,
    status:
      state === "warming"
        ? "Warming"
        : state === "reset"
          ? "Reset"
          : state === "stale"
            ? "Stale"
            : "Unavailable",
    tone: "neutral",
    state,
  };
}

function kvPressure(value: number | null, state: VllmMetricState): RingSemanticState {
  if (value === null || state === "warming" || state === "reset" || state === "unavailable") {
    return neutralReadingState(state);
  }
  if (state === "stale") return { percent: value, status: "Stale", tone: "neutral", state };
  if (value < 70) return { percent: value, status: "Headroom", tone: "success", state };
  if (value < 85) return { percent: value, status: "Watch", tone: "warning", state };
  if (value < 95) return { percent: value, status: "Tight", tone: "pressure", state };
  return { percent: value, status: "Critical", tone: "critical", state };
}

function activePressure(
  value: number | null,
  target: number | undefined,
  state: VllmMetricState,
): RingSemanticState {
  if (target === undefined || !Number.isFinite(target) || target <= 0) {
    return { percent: null, status: "Target not set", tone: "neutral", state: "unavailable" };
  }
  if (value === null || state === "warming" || state === "reset" || state === "unavailable") {
    return neutralReadingState(state);
  }
  const percent = (value / target) * 100;
  if (state === "stale") return { percent, status: "Stale", tone: "neutral", state };
  if (percent === 0) return { percent, status: "Idle", tone: "neutral", state };
  if (percent < 70) return { percent, status: "Serving", tone: "info", state };
  if (percent < 85) return { percent, status: "Busy", tone: "warning", state };
  if (percent <= 100) return { percent, status: "At capacity", tone: "pressure", state };
  return { percent, status: "Over capacity", tone: "critical", state };
}

function queuePressure(
  value: number | null,
  target: number | undefined,
  state: VllmMetricState,
): RingSemanticState {
  if (target === undefined || !Number.isFinite(target) || target <= 0) {
    return { percent: null, status: "Target not set", tone: "neutral", state: "unavailable" };
  }
  if (value === null || state === "warming" || state === "reset" || state === "unavailable") {
    return neutralReadingState(state);
  }
  const percent = (value / target) * 100;
  if (state === "stale") return { percent, status: "Stale", tone: "neutral", state };
  if (percent === 0) return { percent, status: "Clear", tone: "success", state };
  if (percent < 50) return { percent, status: "Waiting", tone: "warning", state };
  if (percent < 100) return { percent, status: "Backed up", tone: "pressure", state };
  return { percent, status: "Queue limit reached", tone: "critical", state };
}

type ReactorInput = {
  cluster: ClusterEntry;
  status?: ClusterStatus | null;
  tick?: MonitorTick | null;
  service?: ServiceHealth | null;
  reconnecting?: boolean;
  vllm?: VllmClusterSnapshot | null;
  vllmReconnecting?: boolean;
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
  vllm = null,
  vllmReconnecting = false,
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
  function tokenCountText(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return String(Math.round(value));
  }

  const telemetryState = reconnecting ? "reconnecting" : valid ? "live" : "unavailable";
  const serviceState = service?.state ?? "checking";
  const managedWorkloadCount = status ? status.solo_entries.length : null;
  const cpuPercent = metric("cpu_usage_pct", true);
  const gpuPercent = metric("gpu_util_pct", true);

  const unavailableVllmReading: VllmReading = {
    value: null,
    state: "unavailable",
    observedAtMs: null,
  };
  const effectiveState = (reading: VllmReading): VllmMetricState =>
    vllmReconnecting && reading.state === "live" ? "stale" : reading.state;
  const vllmReading = (key: keyof VllmClusterSnapshot["metrics"]): VllmReading =>
    vllm?.metrics[key] ?? unavailableVllmReading;
  const tokenReading = vllmReading("tokensPerSecond");
  const rateState = effectiveState(tokenReading);
  const rateText =
    tokenReading.value === null ||
    rateState === "warming" ||
    rateState === "unavailable" ||
    rateState === "reset"
      ? "—"
      : tokenReading.value.toFixed(1);
  const rateStateText =
    rateState === "warming"
      ? "Warming · calculating rate"
      : rateState === "reset"
        ? "Counter reset · calculating rate"
        : rateState === "stale"
          ? "Stale · last value"
          : rateState === "unavailable"
            ? "Tokens per second unavailable"
            : "Tokens per second live";
  const requestText = (reading: VllmReading) => {
    if (reading.value === null) return "—";
    const value = Number.isInteger(reading.value)
      ? String(reading.value)
      : reading.value.toFixed(1);
    return effectiveState(reading) === "stale" ? `${value} · stale` : value;
  };
  const kvReading = vllmReading("kvCachePercent");
  const kvState = effectiveState(kvReading);
  const runningReading = vllmReading("runningRequests");
  const runningState = effectiveState(runningReading);
  const waitingReading = vllmReading("waitingRequests");
  const waitingState = effectiveState(waitingReading);
  const kvCapacityReading = vllmReading("kvCacheCapacityTokens");
  const kvDetail =
    kvCapacityReading.value === null
      ? "Capacity not reported"
      : `${tokenCountText(kvCapacityReading.value)} cache-token capacity`;
  const requestCountText = (value: number) =>
    Number.isInteger(value) ? String(value) : value.toFixed(1);
  const activeTarget = cluster.reactorCapacity?.safeConcurrentRequests;
  const queueTarget = cluster.reactorCapacity?.queueBudget;
  const kvSemantic = kvPressure(kvReading.value, kvState);
  const activeSemantic = activePressure(runningReading.value, activeTarget, runningState);
  const queueSemantic = queuePressure(waitingReading.value, queueTarget, waitingState);
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
    rings: {
      kv: {
        label: "KV cache occupancy",
        ...kvSemantic,
        detail: kvDetail,
        source: "vllm-metrics" as const,
      },
      active: {
        label: "Active request capacity",
        ...activeSemantic,
        detail:
          activeTarget === undefined || !Number.isFinite(activeTarget) || activeTarget <= 0
            ? "Safe request target not set"
            : activeSemantic.percent === null
              ? "Running requests unavailable"
              : `${requestCountText(runningReading.value!)} / ${activeTarget} safe requests`,
        source: "vllm-metrics" as const,
      },
      queue: {
        label: "Queue pressure",
        ...queueSemantic,
        detail:
          queueTarget === undefined || !Number.isFinite(queueTarget) || queueTarget <= 0
            ? "Queued-request budget not set"
            : queueSemantic.percent === null
              ? "Waiting requests unavailable"
              : `${requestCountText(waitingReading.value!)} / ${queueTarget} queued-request budget`,
        source: "vllm-metrics" as const,
      },
    },
    inference: {
      state: rateState,
      stateText: rateStateText,
      tokensPerSecond: tokenReading.value,
      tokensPerSecondText: rateText,
      runningText: requestText(runningReading),
      queuedText: requestText(waitingReading),
      clientsText: "—" as const,
      sessionsText: "—" as const,
    },
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
