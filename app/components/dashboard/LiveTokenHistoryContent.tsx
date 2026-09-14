"use client";

import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { TokenHistoryResult } from "@/lib/tokenHistory";
import { applyLiveTokenHistory } from "./liveTokenHistory";
import { tokenHistoryTelemetryStore } from "./tokenHistoryTelemetryStore";

export function LiveTokenHistoryContent({
  clusterName,
  result,
  children,
}: {
  clusterName: string;
  result: TokenHistoryResult;
  children: (result: TokenHistoryResult) => ReactNode;
}) {
  const subscribe = useCallback(
    (listener: () => void) => tokenHistoryTelemetryStore.subscribe(clusterName, listener),
    [clusterName],
  );
  const getSnapshot = useCallback(
    () => tokenHistoryTelemetryStore.getSnapshot(clusterName),
    [clusterName],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const liveResult = useMemo(
    () => applyLiveTokenHistory(result, snapshot.observations),
    [result, snapshot.observations],
  );

  return children(liveResult);
}
