"use client";

import { useEffect, useState } from "react";
import { rpc } from "@/lib/rpc/client";
import { deriveReactorState } from "@/lib/reactorState";
import type { MonitorTick } from "@/lib/monitor";
import type { ClusterEntry, ClusterStatus } from "@/lib/schemas";
import type { ServiceHealth } from "@/lib/rpc/procedures/services";

export type ReactorStatusUpdate = (cluster: string, status: ClusterStatus) => void;

export function useReactor(
  cluster: ClusterEntry,
  initial: ClusterStatus | null,
  onStatus: ReactorStatusUpdate,
) {
  const [status, setStatus] = useState(initial);
  const [tick, setTick] = useState<MonitorTick | null>(null);
  const [service, setService] = useState<ServiceHealth | null>(null);
  const [statusReconnecting, setStatusReconnecting] = useState(false);
  const [monitorReconnecting, setMonitorReconnecting] = useState(false);
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
      setTick,
      setMonitorReconnecting,
    );

    let healthPending = false;
    async function checkHealth() {
      if (healthPending || signal.aborted) return;
      healthPending = true;
      try {
        const next = await rpc.services.health({ cluster: name }, { signal });
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
  }, [name, onStatus]);

  return deriveReactorState({
    cluster,
    status,
    tick,
    service,
    reconnecting: statusReconnecting || monitorReconnecting,
  });
}
