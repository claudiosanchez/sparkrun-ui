import type { TokenObservation } from "@/lib/tokenHistory";
import {
  TokenHistoryTelemetryStreamEventSchema,
  type TokenHistoryTelemetryStreamEvent,
} from "@/lib/tokenHistoryTelemetry";
import { reduceLiveTokenObservations } from "./liveTokenHistory";

export type TokenHistoryTelemetrySnapshot = Readonly<{
  observations: readonly TokenObservation[];
}>;

export type TokenHistoryTelemetryStore = {
  readonly connectionHealthy: boolean;
  publish: (event: unknown) => boolean;
  getSnapshot: (cluster: string) => TokenHistoryTelemetrySnapshot;
  getTopologyGeneration: (cluster: string) => number;
  subscribe: (cluster: string, listener: () => void) => () => void;
  setConnectionHealthy: (healthy: boolean) => void;
};

const noOp = () => {};

export function createTokenHistoryTelemetryStore(): TokenHistoryTelemetryStore {
  const snapshots = new Map<string, TokenHistoryTelemetrySnapshot>();
  const topologyGenerations = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  let connectionHealthy = false;

  const getSnapshot = (cluster: string): TokenHistoryTelemetrySnapshot => {
    const existing = snapshots.get(cluster);
    if (existing !== undefined) return existing;
    const initial = { observations: [] } as const;
    snapshots.set(cluster, initial);
    return initial;
  };

  const notify = (cluster: string) => {
    for (const listener of listeners.get(cluster) ?? []) listener();
  };

  return {
    get connectionHealthy() {
      return connectionHealthy;
    },
    publish(input) {
      const parsed = TokenHistoryTelemetryStreamEventSchema.safeParse(input);
      if (!parsed.success) return false;

      const event: TokenHistoryTelemetryStreamEvent = parsed.data;
      if (event.topic === "token-history-reset") {
        topologyGenerations.set(event.cluster, (topologyGenerations.get(event.cluster) ?? 0) + 1);
        const previous = snapshots.get(event.cluster);
        if (previous?.observations.length) snapshots.set(event.cluster, { observations: [] });
        notify(event.cluster);
        return true;
      }
      const previous = getSnapshot(event.cluster);
      const observations = reduceLiveTokenObservations(previous.observations, event.payload);
      if (observations === previous.observations) return false;
      snapshots.set(event.cluster, {
        observations,
      });
      notify(event.cluster);
      return true;
    },
    getSnapshot,
    getTopologyGeneration: (cluster) => topologyGenerations.get(cluster) ?? 0,
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
      connectionHealthy = healthy;
    },
  };
}

export const tokenHistoryTelemetryStore = createTokenHistoryTelemetryStore();
