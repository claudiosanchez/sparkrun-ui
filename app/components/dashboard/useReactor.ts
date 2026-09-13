"use client";

import { useEffect, useMemo, useState } from "react";
import { rpc } from "@/lib/rpc/client";
import { deriveReactorState } from "@/lib/reactorState";
import { appendReactorTrend, type ReactorTrend } from "@/lib/reactorTrend";
import type { MonitorTick } from "@/lib/monitor";
import type { ClusterEntry, ClusterStatus } from "@/lib/schemas";
import type { ServiceHealth } from "@/lib/rpc/procedures/services";
import type { VllmClusterSnapshot } from "@/lib/vllmMetrics";

export type ReactorStatusUpdate = (cluster: string, status: ClusterStatus) => void;

const HEALTH_TIMEOUT_MS = 4_000;
const TREND_HISTORY = 40;

export function healthSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)]);
}

export function useReactor(
  cluster: ClusterEntry,
  initial: ClusterStatus | null,
  onStatus: ReactorStatusUpdate,
) {
  const [status, setStatus] = useState(initial);
  const [tick, setTick] = useState<MonitorTick | null>(null);
  const [service, setService] = useState<ServiceHealth | null>(null);
  const [vllm, setVllm] = useState<VllmClusterSnapshot | null>(null);
  const [trends, setTrends] = useState<ReactorTrend>({ cpu: [], gpu: [] });
  const [statusReconnecting, setStatusReconnecting] = useState(false);
  const [monitorReconnecting, setMonitorReconnecting] = useState(false);
  const [vllmReconnecting, setVllmReconnecting] = useState(false);
  const name = cluster.name;

  useEffect(() => {
    // Each mounted card owns its requests, retry waits, and health timer.
    const ac = new AbortController();
    const { signal } = ac;
    function waitToRetry() {
      return new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 3000);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
    async function subscribe<T>(
      open: () => Promise<AsyncIterable<T>>,
      receive: (value: T) => void,
      setReconnecting: (value: boolean) => void,
    ) {
      while (!signal.aborted) {
        try {
          const stream = await open();
          for await (const next of stream) {
            if (signal.aborted) return;
            receive(next);
            setReconnecting(false);
          }
        } catch {
          // Retain this card's last data while its stream reconnects.
        }
        if (signal.aborted) return;
        setReconnecting(true);
        await waitToRetry();
      }
    }
    void subscribe(
      () => rpc.status.stream({ cluster: name, intervalMs: 3000 }, { signal }),
      (next) => {
        setStatus(next);
        onStatus(name, next);
      },
      setStatusReconnecting,
    );
    void subscribe(
      () => rpc.monitor.stream({ cluster: name, intervalSec: 2 }, { signal }),
      (next) => {
        setTick(next);
        const metrics = deriveReactorState({ cluster, tick: next }).metrics;
        setTrends((previous) =>
          appendReactorTrend(
            previous,
            { cpu: metrics.cpuPercent, gpu: metrics.gpuPercent },
            TREND_HISTORY,
          ),
        );
      },
      setMonitorReconnecting,
    );
    void subscribe(
      () => rpc.vllmMetrics.stream({ cluster: name }, { signal }),
      setVllm,
      setVllmReconnecting,
    );

    let healthPending = false;
    async function checkHealth() {
      if (healthPending || signal.aborted) return;
      healthPending = true;
      try {
        const bounded = healthSignal(signal);
        const next = await rpc.services.health({ cluster: name }, { signal: bounded });
        if (!signal.aborted) setService(next);
      } catch {
        if (!signal.aborted)
          setService({ cluster: name, host: null, state: "unavailable", model: null });
      } finally {
        healthPending = false;
      }
    }
    void checkHealth();
    const healthTimer = setInterval(checkHealth, 10_000);
    return () => {
      ac.abort();
      clearInterval(healthTimer);
    };
  }, [cluster, name, onStatus]);

  return useMemo(
    () => ({
      ...deriveReactorState({
        cluster,
        status,
        tick,
        service,
        reconnecting: statusReconnecting || monitorReconnecting,
        vllm,
        vllmReconnecting,
      }),
      trends,
    }),
    [
      cluster,
      status,
      tick,
      service,
      vllm,
      statusReconnecting,
      monitorReconnecting,
      vllmReconnecting,
      trends,
    ],
  );
}
