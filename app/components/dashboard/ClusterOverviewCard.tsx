"use client";

import { useEffect, useMemo, useState } from "react";
import { rpc } from "@/lib/rpc/client";
import { monitorHostViews, numberMetric, type MonitorTick } from "@/lib/monitor";
import type { ClusterEntry } from "@/lib/schemas";
import { Card, CardBody, CardHeader, CardTitle } from "@/app/components/ui/Card";
import { Badge } from "@/app/components/ui/Badge";

const metricKeys = [
  "gpu_util_pct",
  "cpu_usage_pct",
  "mem_used_mb",
  "mem_total_mb",
  "gpu_temp_c",
  "cpu_temp_c",
  "gpu_power_w",
];

type TelemetryState = "live" | "reconnecting" | "unavailable";

function formatMetric(value: number | null, unit: string, decimals = 0): string {
  return value === null ? "—" : `${value.toFixed(decimals)}${unit}`;
}

function useClusterTelemetry(cluster: ClusterEntry) {
  const [tick, setTick] = useState<MonitorTick | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const name = cluster.name;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    function waitToRetry() {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }

    async function subscribe() {
      while (!signal.aborted) {
        try {
          const stream = await rpc.monitor.stream({ cluster: name, intervalSec: 2 }, { signal });
          for await (const next of stream) {
            if (signal.aborted) return;
            setTick(next);
            setReconnecting(false);
          }
        } catch {
          // The card keeps its last valid sample while its named stream retries.
        }
        if (signal.aborted) return;
        setReconnecting(true);
        await waitToRetry();
      }
    }

    void subscribe();
    return () => controller.abort();
  }, [name]);

  return { tick, reconnecting };
}

export function ClusterOverviewCard({ cluster }: { cluster: ClusterEntry }) {
  const { tick, reconnecting } = useClusterTelemetry(cluster);
  const telemetry = useMemo(() => summarizeTelemetry(cluster, tick), [cluster, tick]);
  const state: TelemetryState = reconnecting
    ? telemetry.valid
      ? "reconnecting"
      : "unavailable"
    : telemetry.valid
      ? "live"
      : "unavailable";

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{cluster.name}</CardTitle>
          {cluster.is_default && <Badge>Default</Badge>}
        </div>
        <p className="font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">
          {cluster.hosts.length} configured host{cluster.hosts.length === 1 ? "" : "s"}
        </p>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone={state === "live" ? "green" : state === "reconnecting" ? "amber" : "neutral"}>
            {state === "live"
              ? "Telemetry live"
              : state === "reconnecting"
                ? "Reconnecting"
                : "Telemetry unavailable"}
          </Badge>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {telemetry.reachableHosts}/{cluster.hosts.length || 0} reachable
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Metric label="CPU" value={formatMetric(telemetry.cpu, "%", 1)} />
          <Metric label="GPU" value={formatMetric(telemetry.gpu, "%")} />
          <Metric label="Memory" value={formatMemory(telemetry.memoryUsed, telemetry.memoryTotal)} />
          <Metric label="GPU temperature" value={formatMetric(telemetry.gpuTemperature, "°C")} />
          <Metric label="CPU temperature" value={formatMetric(telemetry.cpuTemperature, "°C")} />
          <Metric label="Power" value={formatMetric(telemetry.power, " W", 1)} />
        </dl>
        <p aria-live="polite" className="text-xs text-zinc-500 dark:text-zinc-400">
          {state === "live"
            ? `${telemetry.reachableHosts} host${telemetry.reachableHosts === 1 ? "" : "s"} reporting`
            : state === "reconnecting" && telemetry.valid
              ? "Last measurements retained while reconnecting"
              : "Host measurements are unavailable"}
        </p>
      </CardBody>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-1 font-mono text-sm font-medium text-zinc-900 tabular-nums dark:text-zinc-100">
        {value}
      </dd>
    </div>
  );
}

function formatMemory(used: number | null, total: number | null): string {
  return used === null || total === null || total <= 0
    ? "—"
    : `${(used / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} GB`;
}

function summarizeTelemetry(cluster: ClusterEntry, tick: MonitorTick | null) {
  const views = tick ? monitorHostViews(tick) : {};
  const hosts = cluster.hosts.map((host) => views[host]);
  const validHosts = hosts.filter(
    (host) =>
      host &&
      host.error == null &&
      host.sample &&
      metricKeys.some((key) => numberMetric(host.sample?.[key]) !== null),
  );
  const valid = cluster.hosts.length > 0 && validHosts.length === cluster.hosts.length;

  function metric(key: string, average = false): number | null {
    const values = validHosts.map((host) => numberMetric(host.sample?.[key]));
    if (!valid || values.length === 0 || values.some((value) => value === null)) return null;
    const total = values.reduce<number>((sum, value) => sum + value!, 0);
    return average ? total / values.length : total;
  }

  return {
    valid,
    reachableHosts: validHosts.length,
    cpu: metric("cpu_usage_pct", true),
    gpu: metric("gpu_util_pct", true),
    memoryUsed: metric("mem_used_mb"),
    memoryTotal: metric("mem_total_mb"),
    gpuTemperature: metric("gpu_temp_c", true),
    cpuTemperature: metric("cpu_temp_c", true),
    power: metric("gpu_power_w"),
  };
}
