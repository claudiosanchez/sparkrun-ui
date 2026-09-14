"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { deriveReactorState, type ReactorState } from "@/lib/reactorState";
import { createReactorStateStore, type ReactorStateStore } from "@/lib/reactorStateStore";
import type { ClusterEntry, ClusterStatus } from "@/lib/schemas";
import { useReactor } from "./useReactor";

const stateContext = createContext<ReactorStateStore | null>(null);
const emptySubscribe = () => () => {};

export function ReactorStateProvider({
  clusters,
  initialStatuses,
  children,
}: {
  clusters: ClusterEntry[];
  initialStatuses: Record<string, ClusterStatus | null>;
  children: ReactNode;
}) {
  const [store] = useState(() =>
    createReactorStateStore(
      Object.fromEntries(
        clusters.map((cluster) => [
          cluster.name,
          deriveReactorState({
            cluster,
            status: initialStatuses[cluster.name] ?? null,
          }),
        ]),
      ),
    ),
  );

  return (
    <stateContext.Provider value={store}>
      {clusters.map((cluster) => (
        <ReactorStateSource key={cluster.name} cluster={cluster} store={store} />
      ))}
      {children}
    </stateContext.Provider>
  );
}

function ReactorStateSource({
  cluster,
  store,
}: {
  cluster: ClusterEntry;
  store: ReactorStateStore;
}) {
  const state = useReactor(cluster);

  useEffect(() => {
    store.publish(cluster.name, state);
  }, [cluster.name, state, store]);

  return null;
}

export function useReactorState(
  cluster: ClusterEntry,
  initial: ClusterStatus | null = null,
): ReactorState {
  const store = useContext(stateContext);
  const name = cluster.name;
  const fallback = useMemo(
    () => deriveReactorState({ cluster, status: initial }),
    [cluster, initial],
  );
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(name, listener) ?? emptySubscribe(),
    [name, store],
  );
  const getSnapshot = useCallback(
    () => store?.getSnapshot(name) ?? fallback,
    [fallback, name, store],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
