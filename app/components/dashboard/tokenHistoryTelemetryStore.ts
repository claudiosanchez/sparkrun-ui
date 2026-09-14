import {
  DashboardTelemetryEventSchema,
  type DashboardTelemetryEvent,
} from "@/lib/dashboardTelemetry";
import type { TokenObservation } from "@/lib/tokenHistory";
import { reduceLiveTokenObservations } from "./liveTokenHistory";

export type TokenHistoryTelemetrySnapshot = Readonly<{
  connectionHealthy: boolean;
  observations: readonly TokenObservation[];
}>;

export type TokenHistoryTelemetryStore = {
  publish: (event: unknown) => boolean;
  getSnapshot: (cluster: string) => TokenHistoryTelemetrySnapshot;
  subscribe: (cluster: string, listener: () => void) => () => void;
  setConnectionHealthy: (healthy: boolean) => void;
};

const noOp = () => {};

export function createTokenHistoryTelemetryStore(): TokenHistoryTelemetryStore {
  const snapshots = new Map<string, TokenHistoryTelemetrySnapshot>();
  const listeners = new Map<string, Set<() => void>>();
  let connectionHealthy = false;

  const getSnapshot = (cluster: string): TokenHistoryTelemetrySnapshot => {
    const existing = snapshots.get(cluster);
    if (existing !== undefined) return existing;
    const initial = { connectionHealthy, observations: [] } as const;
    snapshots.set(cluster, initial);
    return initial;
  };

  const notify = (cluster: string) => {
    for (const listener of listeners.get(cluster) ?? []) listener();
  };

  return {
    publish(input) {
      const parsed = DashboardTelemetryEventSchema.safeParse(input);
      if (!parsed.success || parsed.data.topic !== "token-history") return false;

      const event: Extract<DashboardTelemetryEvent, { topic: "token-history" }> = parsed.data;
      const previous = getSnapshot(event.cluster);
      snapshots.set(event.cluster, {
        connectionHealthy,
        observations: reduceLiveTokenObservations(previous.observations, event.payload),
      });
      notify(event.cluster);
      return true;
    },
    getSnapshot,
    subscribe(cluster, listener) {
      if (cluster.length === 0 || typeof listener !== "function") return noOp;
      let clusterListeners = listeners.get(cluster);
      if (clusterListeners === undefined) {
        clusterListeners = new Set();
        listeners.set(cluster, clusterListeners);
      }
      clusterListeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        clusterListeners?.delete(listener);
        if (clusterListeners?.size === 0) listeners.delete(cluster);
      };
    },
    setConnectionHealthy(healthy) {
      if (connectionHealthy === healthy) return;
      connectionHealthy = healthy;
      const clusters = new Set([...snapshots.keys(), ...listeners.keys()]);
      for (const cluster of clusters) {
        const previous = getSnapshot(cluster);
        snapshots.set(cluster, {
          connectionHealthy,
          observations: previous.observations,
        });
        notify(cluster);
      }
    },
  };
}

export const tokenHistoryTelemetryStore = createTokenHistoryTelemetryStore();
