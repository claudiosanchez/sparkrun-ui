"use client";

import type { ReactorState } from "@/lib/reactorState";

type RingValue = ReactorState["rings"][keyof ReactorState["rings"]];
type RingKey = keyof ReactorState["rings"];

const ringOrder: Array<{
  key: RingKey;
  color: string;
  track: string;
}> = [
  { key: "memory", color: "stroke-emerald-500 dark:stroke-emerald-400", track: "r-[54]" },
  { key: "kv", color: "stroke-cyan-500 dark:stroke-cyan-400", track: "r-[42]" },
  { key: "gpu", color: "stroke-sky-500 dark:stroke-sky-400", track: "r-[30]" },
];

function clampPercent(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.min(100, value));
}

function ringColor(key: RingKey, state: ReactorState["rings"]["kv"]["state"] | undefined): string {
  if (key === "kv" && (state === "unavailable" || state === "warming")) {
    return "stroke-zinc-300 dark:stroke-zinc-600";
  }
  return ringOrder.find((ring) => ring.key === key)!.color;
}

function ReactorRing({ ring, color, radius }: { ring: RingValue; color: string; radius: number }) {
  const value = clampPercent(ring.percent);
  return (
    <circle
      cx="60"
      cy="60"
      r={radius}
      fill="none"
      strokeWidth={radius === 54 ? 5 : radius === 42 ? 6 : 7}
      pathLength="100"
      strokeDasharray={value === null ? "0 100" : `${value} 100`}
      strokeLinecap="round"
      className={`${color} transition-[stroke-dasharray] duration-500 motion-reduce:transition-none`}
      role="progressbar"
      aria-label={ring.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : value}
      aria-valuetext={value === null ? "Not reported" : undefined}
    />
  );
}

export function ReactorRings({
  rings,
  inference,
  modelText,
}: {
  rings: ReactorState["rings"];
  inference: ReactorState["inference"];
  modelText: string;
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
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    key === "memory"
                      ? "bg-emerald-500"
                      : key === "kv"
                        ? "bg-cyan-500"
                        : "bg-sky-500"
                  }`}
                />
                <div className="min-w-0">
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400">{ring.label}</dt>
                  <dd className="font-mono text-sm font-medium text-zinc-900 tabular-nums dark:text-zinc-100">
                    {ring.percent === null ? "—" : `${ring.percent.toFixed(1)}%`}
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
            {ringOrder.map(({ key, track }) => (
              <circle
                key={`${key}-track`}
                cx="60"
                cy="60"
                r={Number(track.slice(3, -1))}
                fill="none"
                strokeWidth={key === "memory" ? 5 : key === "kv" ? 6 : 7}
                className="stroke-zinc-100 dark:stroke-zinc-800"
              />
            ))}
            <ReactorRing ring={rings.memory} color={ringColor("memory", undefined)} radius={54} />
            <ReactorRing ring={rings.kv} color={ringColor("kv", rings.kv.state)} radius={42} />
            <ReactorRing ring={rings.gpu} color={ringColor("gpu", undefined)} radius={30} />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
            <p className="max-w-full truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
              {modelText}
            </p>
            <p className="mt-1 font-mono text-3xl font-semibold text-zinc-900 tabular-nums dark:text-zinc-100">
              {inference.tokensPerSecondText}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Tokens / sec</p>
            <span className="sr-only">GPU utilization is shown by the inner ring.</span>
          </div>
        </div>
      </div>

      <p aria-live="polite" className="text-center text-xs text-zinc-500 dark:text-zinc-400">
        {inference.stateText}
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
