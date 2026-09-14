"use client";

import type { ReactorState } from "@/lib/reactorState";

type RingValue = ReactorState["rings"][keyof ReactorState["rings"]];
type RingKey = keyof ReactorState["rings"];

const ringOrder: Array<{
  key: RingKey;
  radius: number;
}> = [
  { key: "kv", radius: 54 },
  { key: "active", radius: 42 },
  { key: "queue", radius: 30 },
];

const toneClasses: Record<RingValue["tone"], { dot: string; stroke: string }> = {
  success: {
    dot: "bg-emerald-500 dark:bg-emerald-400",
    stroke: "stroke-emerald-500 dark:stroke-emerald-400",
  },
  info: {
    dot: "bg-sky-500 dark:bg-sky-400",
    stroke: "stroke-sky-500 dark:stroke-sky-400",
  },
  warning: {
    dot: "bg-amber-500 dark:bg-amber-400",
    stroke: "stroke-amber-500 dark:stroke-amber-400",
  },
  pressure: {
    dot: "bg-orange-500 dark:bg-orange-400",
    stroke: "stroke-orange-500 dark:stroke-orange-400",
  },
  critical: {
    dot: "bg-rose-500 dark:bg-rose-400",
    stroke: "stroke-rose-500 dark:stroke-rose-400",
  },
  neutral: {
    dot: "bg-zinc-500 dark:bg-zinc-400",
    stroke: "stroke-zinc-500 dark:stroke-zinc-400",
  },
};

function clampPercent(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.min(100, value));
}

function ringValueText(ring: RingValue): string {
  return ring.percent === null ? ring.status : `${ring.percent.toFixed(1)}% · ${ring.status}`;
}

function ReactorRing({ ring, radius }: { ring: RingValue; radius: number }) {
  const visualPercent = clampPercent(ring.percent);
  return (
    <circle
      cx="60"
      cy="60"
      r={radius}
      fill="none"
      strokeWidth={radius === 54 ? 5 : radius === 42 ? 6 : 7}
      pathLength="100"
      strokeDasharray={visualPercent === null ? "0 100" : `${visualPercent} 100`}
      strokeLinecap="round"
      className={`${toneClasses[ring.tone].stroke} transition-[stroke-dasharray] duration-500 motion-reduce:transition-none`}
      role="progressbar"
      aria-label={ring.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={visualPercent === null ? undefined : visualPercent}
      aria-valuetext={ringValueText(ring)}
    />
  );
}

export function ReactorRings({
  rings,
  inference,
}: {
  rings: ReactorState["rings"];
  inference: ReactorState["inference"];
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-center">
        <dl className="order-1 grid grid-cols-1 gap-2 sm:order-2 sm:min-w-44">
          {ringOrder.map(({ key }) => {
            const ring = rings[key];
            return (
              <div key={ring.label} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${toneClasses[ring.tone].dot}`}
                />
                <div className="min-w-0">
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400">{ring.label}</dt>
                  <dd className="font-mono text-sm font-medium text-zinc-900 tabular-nums dark:text-zinc-100">
                    {ringValueText(ring)}
                  </dd>
                  <dd className="text-[11px] text-zinc-500 dark:text-zinc-400">{ring.detail}</dd>
                </div>
              </div>
            );
          })}
        </dl>

        <div className="relative order-2 mx-auto h-56 w-56 shrink-0 sm:order-1">
          <svg
            viewBox="0 0 120 120"
            className="h-full w-full -rotate-90"
            aria-label="Reactor utilization"
          >
            {ringOrder.map(({ key, radius }) => (
              <circle
                key={`${key}-track`}
                cx="60"
                cy="60"
                r={radius}
                fill="none"
                strokeWidth={radius === 54 ? 5 : radius === 42 ? 6 : 7}
                className="stroke-zinc-100 dark:stroke-zinc-800"
              />
            ))}
            {ringOrder.map(({ key, radius }) => (
              <ReactorRing key={key} ring={rings[key]} radius={radius} />
            ))}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
            <p className="font-mono text-3xl font-semibold text-zinc-900 tabular-nums dark:text-zinc-100">
              {inference.tokensPerSecondText}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Tokens / sec</p>
          </div>
        </div>
      </div>

      <p aria-live="polite" className="text-center text-xs text-zinc-500 dark:text-zinc-400">
        {inference.stateText}
      </p>
      <p className="text-center text-[11px] text-zinc-500 dark:text-zinc-400">
        KV cache occupancy is shown separately from host memory.
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Clients</dt>
          <dd className="mt-1 font-mono text-sm font-medium text-zinc-900 tabular-nums dark:text-zinc-100">
            {inference.clientsText}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Sessions</dt>
          <dd className="mt-1 font-mono text-sm font-medium text-zinc-900 tabular-nums dark:text-zinc-100">
            {inference.sessionsText}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Running</dt>
          <dd className="mt-1 font-mono text-sm font-medium text-zinc-900 tabular-nums dark:text-zinc-100">
            {inference.runningText}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Queued</dt>
          <dd className="mt-1 font-mono text-sm font-medium text-zinc-900 tabular-nums dark:text-zinc-100">
            {inference.queuedText}
          </dd>
        </div>
      </dl>
      <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
        Client and session counts are not collected.
      </p>
    </div>
  );
}
