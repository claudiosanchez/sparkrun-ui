"use client";

import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ClusterEntry } from "@/lib/schemas";
import type { TrendRange } from "@/lib/tokenHistory";
import { ClusterTokenHistoryCard } from "./ClusterTokenHistoryCard";
import { TOKEN_HISTORY_RANGES } from "./tokenHistoryData";

const rangeTabIds: Record<TrendRange, string> = {
  "15m": "token-history-tab-15m",
  "1d": "token-history-tab-1d",
  "7d": "token-history-tab-7d",
  "30d": "token-history-tab-30d",
};

export const ClusterTokenHistorySection = memo(function ClusterTokenHistorySection({
  clusters,
}: {
  clusters: ClusterEntry[];
}) {
  const [range, setRange] = useState<TrendRange>("15m");
  const tabRefs = useRef<Record<TrendRange, HTMLButtonElement | null>>({
    "15m": null,
    "1d": null,
    "7d": null,
    "30d": null,
  });
  const didMount = useRef(false);

  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    tabRefs.current[range]?.focus();
  }, [range]);

  const selectRangeWithKeyboard = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      let nextIndex: number | null = null;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % TOKEN_HISTORY_RANGES.length;
      if (event.key === "ArrowLeft") {
        nextIndex = (index - 1 + TOKEN_HISTORY_RANGES.length) % TOKEN_HISTORY_RANGES.length;
      }
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = TOKEN_HISTORY_RANGES.length - 1;
      if (nextIndex === null) return;

      event.preventDefault();
      setRange(TOKEN_HISTORY_RANGES[nextIndex]);
    },
    [],
  );

  return (
    <section aria-label="Token throughput history" className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Token throughput history
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Persisted Tokens/s history for each saved cluster.
        </p>
      </div>
      <div role="tablist" aria-label="Token throughput range" className="flex flex-wrap gap-1">
        {TOKEN_HISTORY_RANGES.map((item, index) => (
          <button
            key={item}
            ref={(element) => {
              tabRefs.current[item] = element;
            }}
            id={rangeTabIds[item]}
            type="button"
            role="tab"
            aria-selected={range === item}
            aria-controls="token-history-cards"
            tabIndex={range === item ? 0 : -1}
            onClick={() => setRange(item)}
            onKeyDown={(event) => selectRangeWithKeyboard(event, index)}
            className={
              range === item
                ? "rounded-md border border-sky-600 bg-sky-50 px-3 py-1.5 text-sm font-semibold text-sky-700 focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:outline-none dark:border-sky-400 dark:bg-sky-950 dark:text-sky-200"
                : "rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:outline-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }
          >
            {item}
            {range === item && <span className="sr-only"> selected</span>}
          </button>
        ))}
      </div>
      <div
        id="token-history-cards"
        role="tabpanel"
        aria-labelledby={rangeTabIds[range]}
        className="grid grid-cols-1 gap-4 lg:grid-cols-2"
      >
        {clusters.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No saved clusters have token history yet.
          </p>
        ) : (
          clusters.map((cluster) => (
            <ClusterTokenHistoryCard key={cluster.name} cluster={cluster} range={range} />
          ))
        )}
      </div>
    </section>
  );
});
