import {
  DashboardTelemetryEventSchema,
  type DashboardTelemetryEvent,
} from "@/lib/dashboardTelemetry";
import { monitorHostViews, numberMetric, type MonitorTick } from "@/lib/monitor";
import { deriveReactorState } from "@/lib/reactorState";
import { appendReactorTrend, type ReactorTrend } from "@/lib/reactorTrend";
import type { ClusterEntry, ClusterStatus } from "@/lib/schemas";
import type { ServiceHealth } from "@/lib/serviceHealth";
import type { VllmClusterSnapshot } from "@/lib/vllmMetrics";

type Listener = () => void;
const TREND_HISTORY = 40;
const emptyTrends: ReactorTrend = { cpu: [], gpu: [] };

export type DashboardClusterTelemetrySnapshot = Readonly<{
  status: ClusterStatus | null;
  monitor: MonitorTick | null;
  vllm: VllmClusterSnapshot | null;
  service: ServiceHealth | null;
  trends: ReactorTrend;
  connectionHealthy: boolean;
}>;

export type DashboardOverviewTelemetrySnapshot = Readonly<{
  monitor: MonitorTick | null;
  trends: ReactorTrend;
  connectionHealthy: boolean;
}>;

export type DashboardTelemetryStore = {
  readonly connectionHealthy: boolean;
  publish: (event: unknown) => boolean;
  getClusterSnapshot: (cluster: string) => DashboardClusterTelemetrySnapshot;
  getOverviewSnapshot: () => DashboardOverviewTelemetrySnapshot;
  getStatusesSnapshot: () => Readonly<Record<string, ClusterStatus | null>>;
  subscribeCluster: (cluster: string, listener: Listener) => () => void;
  subscribeOverview: (listener: Listener) => () => void;
  subscribeStatuses: (listener: Listener) => () => void;
  setConnectionHealthy: (healthy: boolean) => void;
};

const noOp = () => {};

function clusterKey(
  event: Exclude<DashboardTelemetryEvent, { topic: "overview-monitor" }>,
): string {
  return `${event.topic}\u0000${event.cluster}`;
}

function aggregateMonitorPercent(
  tick: MonitorTick,
  key: "cpu_usage_pct" | "gpu_util_pct",
): number | null {
  const values = Object.values(monitorHostViews(tick)).flatMap((host) => {
    const value = host.error === null && host.sample ? numberMetric(host.sample[key]) : null;
    return value === null ? [] : [value];
  });
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function clusterTrends(
  previous: ReactorTrend,
  cluster: ClusterEntry | undefined,
  tick: MonitorTick | null,
): ReactorTrend {
  if (!tick) return emptyTrends;
  if (!cluster) return previous;
  const metrics = deriveReactorState({ cluster, tick }).metrics;
  return appendReactorTrend(
    previous,
    { cpu: metrics.cpuPercent, gpu: metrics.gpuPercent },
    TREND_HISTORY,
  );
}

function overviewTrends(previous: ReactorTrend, tick: MonitorTick | null): ReactorTrend {
  if (!tick) return emptyTrends;
  return appendReactorTrend(
    previous,
    {
      cpu: aggregateMonitorPercent(tick, "cpu_usage_pct"),
      gpu: aggregateMonitorPercent(tick, "gpu_util_pct"),
    },
    TREND_HISTORY,
  );
}

function clusterSnapshot(
  status: ClusterStatus | null,
  connectionHealthy: boolean,
): DashboardClusterTelemetrySnapshot {
  return {
    status,
    monitor: null,
    vllm: null,
    service: null,
    trends: emptyTrends,
    connectionHealthy,
  };
}

export function createDashboardTelemetryStore(
  initialStatuses: Record<string, ClusterStatus | null> = {},
  configuredClusters: ClusterEntry[] = [],
): DashboardTelemetryStore {
  const clusterByName = new Map(configuredClusters.map((cluster) => [cluster.name, cluster]));
  const clusters = new Map<string, DashboardClusterTelemetrySnapshot>();
  const clusterListeners = new Map<string, Set<Listener>>();
  const statusListeners = new Set<Listener>();
  const overviewListeners = new Set<Listener>();
  const revisions = new Map<string, number>();
  let connectionHealthy = false;
  let statuses: Readonly<Record<string, ClusterStatus | null>> = { ...initialStatuses };
  let overview: DashboardOverviewTelemetrySnapshot = {
    monitor: null,
    trends: emptyTrends,
    connectionHealthy,
  };

  for (const [cluster, status] of Object.entries(initialStatuses)) {
    clusters.set(cluster, clusterSnapshot(status, connectionHealthy));
  }

  const notifyCluster = (cluster: string) => {
    for (const listener of clusterListeners.get(cluster) ?? []) listener();
  };

  const notifyStatuses = () => {
    for (const listener of statusListeners) listener();
  };

  const getClusterSnapshot = (cluster: string): DashboardClusterTelemetrySnapshot => {
    const existing = clusters.get(cluster);
    if (existing) return existing;
    const initial = clusterSnapshot(statuses[cluster] ?? null, connectionHealthy);
    clusters.set(cluster, initial);
    return initial;
  };

  const updateCluster = (
    cluster: string,
    update: Partial<DashboardClusterTelemetrySnapshot>,
  ): boolean => {
    const previous = getClusterSnapshot(cluster);
    const next = { ...previous, ...update };
    if (
      next.status === previous.status &&
      next.monitor === previous.monitor &&
      next.vllm === previous.vllm &&
      next.service === previous.service &&
      next.trends === previous.trends &&
      next.connectionHealthy === previous.connectionHealthy
    ) {
      return false;
    }
    clusters.set(cluster, next);
    notifyCluster(cluster);
    return true;
  };

  return {
    get connectionHealthy() {
      return connectionHealthy;
    },
    publish(input) {
      const parsed = DashboardTelemetryEventSchema.safeParse(input);
      if (!parsed.success || parsed.data.topic === "token-history") return false;
      const event = parsed.data;
      const key = event.topic === "overview-monitor" ? event.topic : clusterKey(event);
      const previousRevision = revisions.get(key);
      if (previousRevision !== undefined && event.revision <= previousRevision) return false;
      revisions.set(key, event.revision);

      if (event.topic === "overview-monitor") {
        const next = {
          monitor: event.payload,
          trends: overviewTrends(overview.trends, event.payload),
          connectionHealthy,
        };
        if (
          next.monitor === overview.monitor &&
          next.trends === overview.trends &&
          next.connectionHealthy === overview.connectionHealthy
        ) {
          return false;
        }
        overview = next;
        for (const listener of overviewListeners) listener();
        return true;
      }

      if (event.topic === "status") {
        const previousStatus = statuses[event.cluster] ?? null;
        const statusChanged = previousStatus !== event.payload;
        if (statusChanged) {
          statuses = { ...statuses, [event.cluster]: event.payload };
          notifyStatuses();
        }
        const clusterChanged = updateCluster(event.cluster, { status: event.payload });
        return statusChanged || clusterChanged;
      }
      if (event.topic === "monitor") {
        const previous = getClusterSnapshot(event.cluster);
        return updateCluster(event.cluster, {
          monitor: event.payload,
          trends: clusterTrends(previous.trends, clusterByName.get(event.cluster), event.payload),
        });
      }
      if (event.topic === "vllm") {
        return updateCluster(event.cluster, { vllm: event.payload });
      }
      return updateCluster(event.cluster, { service: event.payload });
    },
    getClusterSnapshot,
    getOverviewSnapshot: () => overview,
    getStatusesSnapshot: () => statuses,
    subscribeCluster(cluster, listener) {
      if (cluster.length === 0 || typeof listener !== "function") return noOp;
      let listeners = clusterListeners.get(cluster);
      if (!listeners) {
        listeners = new Set();
        clusterListeners.set(cluster, listeners);
      }
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners?.delete(listener);
        if (listeners?.size === 0) clusterListeners.delete(cluster);
      };
    },
    subscribeOverview(listener) {
      if (typeof listener !== "function") return noOp;
      overviewListeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        overviewListeners.delete(listener);
      };
    },
    subscribeStatuses(listener) {
      if (typeof listener !== "function") return noOp;
      statusListeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        statusListeners.delete(listener);
      };
    },
    setConnectionHealthy(healthy) {
      if (connectionHealthy === healthy) return;
      connectionHealthy = healthy;
      for (const [cluster, previous] of clusters) {
        clusters.set(cluster, { ...previous, connectionHealthy });
        notifyCluster(cluster);
      }
      overview = { ...overview, connectionHealthy };
      for (const listener of overviewListeners) listener();
    },
  };
}
