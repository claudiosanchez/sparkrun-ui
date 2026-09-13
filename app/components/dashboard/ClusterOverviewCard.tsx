"use client";

import { memo } from "react";
import type { ReactNode } from "react";
import { Cpu, MemoryStick, Server, Thermometer, Zap } from "lucide-react";
import type { ClusterEntry } from "@/lib/schemas";
import { Card, CardBody } from "@/app/components/ui/Card";
import { useReactorState } from "./ReactorStateContext";

export const ClusterOverviewCard = memo(function ClusterOverviewCard({
  cluster,
}: {
  cluster: ClusterEntry;
}) {
  const state = useReactorState(cluster);
  const cpu = numberFrom(state.metrics.cpuText);
  const gpu = numberFrom(state.metrics.gpuText);
  const memPct = ratioFrom(state.metrics.memoryText);
  const gpuMemPct = ratioFrom(state.metrics.gpuMemoryText);
  const hostCount = cluster.hosts.length;
  const reachable = state.telemetryState === "live" || state.telemetryState === "reconnecting";
  const workloadCount = state.managedWorkloadCount;
  const temperatureValue =
    state.metrics.gpuTemperatureText === "—" && state.metrics.cpuTemperatureText === "—"
      ? "—"
      : `${state.metrics.gpuTemperatureText} / ${state.metrics.cpuTemperatureText}`;

  return (
    <Card className="min-w-0">
      <CardBody className="p-5">
        <div className="mb-4 flex items-baseline justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Server size={14} className="shrink-0 text-zinc-500" />
            <span className="truncate text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {cluster.name}
            </span>
            <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              · {reachable ? hostCount : 0}/{hostCount} host{hostCount === 1 ? "" : "s"} ·{" "}
              {workloadCount === null ? "—" : workloadCount} job
              {workloadCount === 1 ? "" : "s"}
            </span>
          </div>
          <span
            className={
              "inline-flex h-2 w-2 shrink-0 rounded-full " +
              (state.telemetryState === "live"
                ? "animate-pulse bg-emerald-500"
                : state.telemetryState === "reconnecting"
                  ? "bg-amber-500"
                  : "bg-zinc-300")
            }
            title={state.telemetryText}
          />
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <OverviewStat
            icon={<Cpu size={14} />}
            tone="sky"
            label="CPU"
            value={state.metrics.cpuText}
            sub={`avg across ${hostCount}`}
            pct={cpu ?? 0}
            spark={state.trends.cpu}
          />
          <OverviewStat
            icon={<Zap size={14} />}
            tone="purple"
            label="GPU"
            value={state.metrics.gpuText}
            sub={`avg across ${hostCount}`}
            pct={gpu ?? 0}
            spark={state.trends.gpu}
          />
          <OverviewStat
            icon={<MemoryStick size={14} />}
            tone="green"
            label="Memory"
            value={state.metrics.memoryText}
            sub={memPct === null ? "usage unavailable" : `${memPct.toFixed(0)}% used`}
            pct={memPct ?? 0}
          />
          <OverviewStat
            icon={<Zap size={14} />}
            tone="amber"
            label="Power"
            value={state.metrics.powerText}
            sub={
              state.metrics.gpuMemoryText === "—"
                ? "total GPU draw"
                : `GPU mem ${state.metrics.gpuMemoryText}`
            }
            pct={gpuMemPct ?? 0}
          />
          <OverviewStat
            icon={<Thermometer size={14} />}
            tone="red"
            label="Temps"
            value={temperatureValue}
            sub="GPU / CPU avg"
            pct={temperaturePercent(state.metrics.gpuTemperatureText)}
          />
        </div>

        <p aria-live="polite" className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
          {state.freshnessText}
        </p>
      </CardBody>
    </Card>
  );
});

function numberFrom(text: string): number | null {
  if (text === "—") return null;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
}

function ratioFrom(text: string): number | null {
  const [used, total] = text.split("/").map((value) => Number.parseFloat(value));
  return Number.isFinite(used) && Number.isFinite(total) && total > 0 ? (used / total) * 100 : null;
}

function temperaturePercent(text: string): number {
  const temperature = numberFrom(text);
  return temperature === null ? 0 : Math.min(100, Math.max(0, temperature));
}

const toneBg: Record<string, string> = {
  sky: "bg-sky-500 dark:bg-sky-400",
  purple: "bg-purple-500 dark:bg-purple-400",
  green: "bg-emerald-500 dark:bg-emerald-400",
  amber: "bg-amber-500 dark:bg-amber-400",
  red: "bg-red-500 dark:bg-red-400",
};
const toneStroke: Record<string, string> = {
  sky: "stroke-sky-500 dark:stroke-sky-400",
  purple: "stroke-purple-500 dark:stroke-purple-400",
};
const toneText: Record<string, string> = {
  sky: "text-sky-600 dark:text-sky-400",
  purple: "text-purple-600 dark:text-purple-400",
  green: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
};

function OverviewStat({
  icon,
  label,
  value,
  sub,
  pct,
  tone,
  spark,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  pct: number;
  tone: string;
  spark?: number[];
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-1">
        <div className={`flex items-center gap-1.5 text-xs font-medium ${toneText[tone]}`}>
          {icon}
          {label}
        </div>
        {spark && spark.length > 2 && <Sparkline values={spark} className={toneStroke[tone]} />}
      </div>
      <div className="truncate font-mono text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {value}
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`${toneBg[tone]} h-full transition-all duration-300`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{sub}</div>
    </div>
  );
}

function Sparkline({ values, className }: { values: number[]; className: string }) {
  const width = 56;
  const height = 16;
  const max = Math.max(100, ...values);
  const step = width / Math.max(1, values.length - 1);
  const path = values
    .map(
      (value, index) =>
        `${index === 0 ? "M" : "L"} ${index * step} ${height - (value / max) * height}`,
    )
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0">
      <path d={path} fill="none" strokeWidth={1.25} className={className} />
    </svg>
  );
}
