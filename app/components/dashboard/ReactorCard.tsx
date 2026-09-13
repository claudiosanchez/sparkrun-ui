"use client";

import { Card, CardBody, CardHeader, CardTitle } from "@/app/components/ui/Card";
import { Badge } from "@/app/components/ui/Badge";
import type { ClusterEntry } from "@/lib/schemas";
import { useReactorState } from "./ReactorStateContext";

export function ReactorCard({ cluster }: { cluster: ClusterEntry }) {
  const state = useReactorState(cluster);
  const { metrics } = state;
  const gpu = metrics.gpuPercent === null ? null : Math.max(0, Math.min(100, metrics.gpuPercent));
  const measurements = [
    ["CPU utilization", metrics.cpuText],
    ["Unified memory", metrics.memoryText],
    ["GPU temperature", metrics.gpuTemperatureText],
    ["CPU temperature", metrics.cpuTemperatureText],
    ["GPU power", metrics.powerText],
    ["GPU memory", metrics.gpuMemoryText],
  ];

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-lg">{state.name}</CardTitle>
          {cluster.is_default && <Badge>Default cluster</Badge>}
        </div>
        <p className="font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">
          {state.hostText}
        </p>
      </CardHeader>
      <CardBody className="flex flex-col gap-5">
        <div className="flex flex-wrap gap-2">
          <Badge tone={state.telemetryState === "live" ? "sky" : "amber"}>
            {state.telemetryText}
          </Badge>
          <Badge
            tone={
              state.serviceState === "ready"
                ? "green"
                : state.serviceState === "checking"
                  ? "neutral"
                  : "amber"
            }
          >
            {state.serviceText}
          </Badge>
          <Badge>{state.managedWorkloadText}</Badge>
        </div>

        <div className="flex flex-col items-center gap-2 py-2">
          <div className="relative flex h-44 w-44 items-center justify-center">
            <svg
              aria-hidden="true"
              viewBox="0 0 120 120"
              className="absolute inset-0 h-full w-full -rotate-90"
            >
              <circle
                cx="60"
                cy="60"
                r="52"
                fill="none"
                strokeWidth="5"
                className="stroke-zinc-100 dark:stroke-zinc-800"
              />
              {gpu !== null && (
                <circle
                  cx="60"
                  cy="60"
                  r="52"
                  fill="none"
                  strokeWidth="5"
                  pathLength="100"
                  strokeDasharray={`${gpu} 100`}
                  strokeLinecap="round"
                  className={
                    state.telemetryState === "live"
                      ? "stroke-sky-500 dark:stroke-sky-400"
                      : "stroke-amber-500 dark:stroke-amber-400"
                  }
                />
              )}
            </svg>
            <div className="text-center">
              <p className="font-mono text-4xl font-semibold text-zinc-900 tabular-nums dark:text-zinc-100">
                {metrics.gpuText}
              </p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">GPU utilization</p>
            </div>
          </div>
          <p aria-live="polite" className="text-center text-xs text-zinc-500 dark:text-zinc-400">
            {state.freshnessText}
          </p>
          {cluster.hosts.length > 1 && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Utilization and temperatures average {cluster.hosts.length} hosts; memory and power
              show totals.
            </p>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-5 border-t border-zinc-200 pt-5 dark:border-zinc-800">
          {measurements.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
              <dd className="mt-1 font-mono text-sm font-medium break-words text-zinc-900 tabular-nums dark:text-zinc-100">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="border-t border-zinc-200 pt-4 text-xs dark:border-zinc-800">
          <p className="text-zinc-500 dark:text-zinc-400">Served model</p>
          <p className="mt-1 font-mono break-all text-zinc-900 dark:text-zinc-100">
            {state.modelText}
          </p>
          {state.serviceState === "unavailable" && (
            <p className="mt-2 text-amber-700 dark:text-amber-300">
              The model API did not return a served model. Host telemetry is checked separately.
            </p>
          )}
          <p className="mt-2 text-zinc-500 dark:text-zinc-400">
            — means the measurement is unavailable.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
