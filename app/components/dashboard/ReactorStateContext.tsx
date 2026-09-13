"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { deriveReactorState, type ReactorState } from "@/lib/reactorState";
import type { ClusterEntry, ClusterStatus } from "@/lib/schemas";
import { useReactor, type ReactorStatusUpdate } from "./useReactor";

type StateMap = Record<string, ReactorState>;
type StateUpdater = (name: string, state: ReactorState) => void;

const stateContext = createContext<StateMap | null>(null);
const updaterContext = createContext<StateUpdater | null>(null);

export function ReactorStateProvider({
  clusters,
  initialStatuses,
  onStatus,
  children,
}: {
  clusters: ClusterEntry[];
  initialStatuses: Record<string, ClusterStatus | null>;
  onStatus: ReactorStatusUpdate;
  children: ReactNode;
}) {
  const initialState = useMemo(
    () =>
      Object.fromEntries(
        clusters.map((cluster) => [
          cluster.name,
          deriveReactorState({
            cluster,
            status: initialStatuses[cluster.name] ?? null,
          }),
        ]),
      ),
    [clusters, initialStatuses],
  );
  const [states, setStates] = useState<StateMap>(initialState);
  const update = useCallback((name: string, next: ReactorState) => {
    setStates((previous) => (previous[name] === next ? previous : { ...previous, [name]: next }));
  }, []);

  return (
    <stateContext.Provider value={states}>
      <updaterContext.Provider value={update}>
        {clusters.map((cluster) => (
          <ReactorStateSource
            key={cluster.name}
            cluster={cluster}
            initial={initialStatuses[cluster.name] ?? null}
            onStatus={onStatus}
          />
        ))}
        {children}
      </updaterContext.Provider>
    </stateContext.Provider>
  );
}

function ReactorStateSource({
  cluster,
  initial,
  onStatus,
}: {
  cluster: ClusterEntry;
  initial: ClusterStatus | null;
  onStatus: ReactorStatusUpdate;
}) {
  const state = useReactor(cluster, initial, onStatus);
  const update = useContext(updaterContext);

  useEffect(() => {
    update?.(cluster.name, state);
  }, [cluster.name, state, update]);

  return null;
}

export function useReactorState(
  cluster: ClusterEntry,
  initial: ClusterStatus | null = null,
): ReactorState {
  const states = useContext(stateContext);
  const state = states?.[cluster.name];
  return state ?? deriveReactorState({ cluster, status: initial });
}
