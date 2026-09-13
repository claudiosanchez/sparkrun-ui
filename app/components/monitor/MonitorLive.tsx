"use client";
import { useEffect, useState } from "react";
import { Card, CardBody } from "@/app/components/ui/Card";
import { Badge } from "@/app/components/ui/Badge";
import { rpc } from "@/lib/rpc/client";
import { MonitorTick, monitorHostViews, MonitorHost } from "@/lib/monitor";
import { HostCard, type HostHistory, type HostMetrics } from "./HostCard";

const HISTORY_LIMIT = 30;

type Tick = { timestamp: number; hosts: MonitorHost[] };

function num(s: string | undefined): number {
  if (s == null || s === "") return 0;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

export function MonitorLive() {
  const [tick, setTick] = useState<Tick | null>(null);
  const [history, setHistory] = useState<Record<string, HostHistory>>({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const iter = await rpc.monitor.stream({ intervalSec: 2 }, { signal: ac.signal });
        setConnected(true);
        for await (const next of iter) {
          if (cancelled) break;
          const tick = next as MonitorTick;
          setTick(tick);
          setHistory((prev) => {
            const views = monitorHostViews(tick);
            const updated = { ...prev };
            for (const [host, h] of Object.entries(views)) {
              const m = h.sample;
              const hostHistory = updated[host] ?? { cpu: [], gpu: [], mem: [], power: [] };
              updated[host] = {
                cpu: push(hostHistory.cpu, num(m?.cpu_usage_pct)),
                gpu: push(hostHistory.gpu, num(m?.gpu_util_pct)),
                mem: push(hostHistory.mem, num(m?.mem_used_pct)),
                power: push(hostHistory.power, num(m?.gpu_power_w)),
              };
            }
            return updated;
          });
        }
      } catch (err) {
        if (!cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
          console.error("[monitor.stream]", err);
        }
      } finally {
        if (!cancelled) setConnected(false);
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, []);

  const hosts = tick ? Object.entries(tick.hosts) : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Cluster monitor</h1>
        <div className="flex items-center gap-2">
          <Badge tone={connected ? "green" : "amber"}>{connected ? "live" : "reconnecting…"}</Badge>
          {tick && (
            <Badge tone="neutral">
              {hosts.length} host{hosts.length === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
      </div>

      {!tick ? (
        <Card>
          <CardBody className="text-sm text-zinc-500 dark:text-zinc-400">
            Waiting for first monitor sample…
          </CardBody>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {hosts.map(([host, h]) => {
            if (h.error && !h.sample) {
              return (
                <Card key={host}>
                  <CardBody className="text-sm text-zinc-500 dark:text-zinc-400">
                    <div className="font-semibold text-zinc-700 dark:text-zinc-300">{host}</div>
                    <div className="mt-1">{String(h.error)}</div>
                  </CardBody>
                </Card>
              );
            }
            const metrics = h.sample || {};
            return (
              <HostCard
                key={host}
                host={host}
                metrics={metrics}
                history={history[host] ?? { cpu: [], gpu: [], mem: [], power: [] }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function push(arr: number[], v: number): number[] {
  const next = arr.concat(v);
  return next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next;
}
