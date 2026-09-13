"use client";

import type { ClusterEntry } from "@/lib/schemas";
import { Card, CardBody, CardHeader, CardTitle } from "@/app/components/ui/Card";
import { Badge } from "@/app/components/ui/Badge";
import { useReactorState } from "./ReactorStateContext";

export function ClusterOverviewCard({ cluster }: { cluster: ClusterEntry }) {
  const state = useReactorState(cluster);
  const reachable = state.telemetryState === "live" || state.telemetryState === "reconnecting";

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
          <Badge
            tone={
              state.telemetryState === "live"
                ? "green"
                : state.telemetryState === "reconnecting"
                  ? "amber"
                  : "neutral"
            }
          >
            {state.telemetryText}
          </Badge>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {reachable ? cluster.hosts.length : 0}/{cluster.hosts.length || 0} reachable
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Metric label="CPU" value={state.metrics.cpuText} />
          <Metric label="GPU" value={state.metrics.gpuText} />
          <Metric label="Memory" value={state.metrics.memoryText} />
          <Metric label="GPU temperature" value={state.metrics.gpuTemperatureText} />
          <Metric label="CPU temperature" value={state.metrics.cpuTemperatureText} />
          <Metric label="Power" value={state.metrics.powerText} />
        </dl>
        <p aria-live="polite" className="text-xs text-zinc-500 dark:text-zinc-400">
          {state.freshnessText}
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
