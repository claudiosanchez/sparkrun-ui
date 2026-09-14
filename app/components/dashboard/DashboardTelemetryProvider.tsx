"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ClusterEntry, ClusterStatus } from "@/lib/schemas";
import { rpc } from "@/lib/rpc/client";
import { tokenHistoryTelemetryStore } from "./tokenHistoryTelemetryStore";
import {
  createDashboardTelemetryStore,
  type DashboardClusterTelemetrySnapshot,
  type DashboardOverviewTelemetrySnapshot,
  type DashboardTelemetryStore,
} from "./dashboardTelemetryStore";

const RETRY_DELAY_MS = 3_000;
const storeContext = createContext<DashboardTelemetryStore | null>(null);

function waitForRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, RETRY_DELAY_MS);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function DashboardTelemetryProvider({
  clusters,
  initialStatuses,
  children,
}: {
  clusters: ClusterEntry[];
  initialStatuses: Record<string, ClusterStatus | null>;
  children: ReactNode;
}) {
  const [store] = useState(() => createDashboardTelemetryStore(initialStatuses, clusters));

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function subscribe(): Promise<void> {
      while (!signal.aborted) {
        try {
          const stream = await rpc.telemetry.stream({}, { signal });
          store.setConnectionHealthy(true);
          tokenHistoryTelemetryStore.setConnectionHealthy(true);
          for await (const event of stream) {
            if (signal.aborted) return;
            store.publish(event);
            tokenHistoryTelemetryStore.publish(event);
          }
        } catch {
          // Both keyed stores retain their last source snapshots while reconnecting.
        } finally {
          store.setConnectionHealthy(false);
          tokenHistoryTelemetryStore.setConnectionHealthy(false);
        }
        if (!signal.aborted) await waitForRetry(signal);
      }
    }

    void subscribe();
    return () => {
      controller.abort();
      store.setConnectionHealthy(false);
      tokenHistoryTelemetryStore.setConnectionHealthy(false);
    };
  }, [store]);

  return <storeContext.Provider value={store}>{children}</storeContext.Provider>;
}

function useDashboardTelemetryStore(): DashboardTelemetryStore {
  const store = useContext(storeContext);
  if (!store)
    throw new Error("Dashboard telemetry consumers must be inside DashboardTelemetryProvider");
  return store;
}

export function useDashboardClusterTelemetry(cluster: string): DashboardClusterTelemetrySnapshot {
  const store = useDashboardTelemetryStore();
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeCluster(cluster, listener),
    [cluster, store],
  );
  const getSnapshot = useCallback(() => store.getClusterSnapshot(cluster), [cluster, store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useDashboardOverviewTelemetry(): DashboardOverviewTelemetrySnapshot {
  const store = useDashboardTelemetryStore();
  return useSyncExternalStore(
    store.subscribeOverview,
    store.getOverviewSnapshot,
    store.getOverviewSnapshot,
  );
}

export function useDashboardStatuses(): Readonly<Record<string, ClusterStatus | null>> {
  const store = useDashboardTelemetryStore();
  return useSyncExternalStore(
    store.subscribeStatuses,
    store.getStatusesSnapshot,
    store.getStatusesSnapshot,
  );
}
