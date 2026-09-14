"use client";

import { memo } from "react";
import type { ClusterEntry } from "@/lib/schemas";
import type { TokenHistoryResult, TrendRange } from "@/lib/tokenHistory";
import { Badge } from "@/app/components/ui/Badge";
import { Button } from "@/app/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/app/components/ui/Card";
import { LiveTokenHistoryContent } from "./LiveTokenHistoryContent";
import { summarizeTokenHistory } from "./tokenHistoryData";
import { TokenHistoryChart } from "./TokenHistoryChart";
import { useTokenHistory, type TokenHistoryQueryState } from "./useTokenHistory";

export const ClusterTokenHistoryCard = memo(function ClusterTokenHistoryCard({
  cluster,
  range,
}: {
  cluster: ClusterEntry;
  range: TrendRange;
}) {
  const query = useTokenHistory(cluster.name, range);
  const hasResult = query.result !== null;
  const requestActive = query.isInitialLoading || query.isRefreshing;
  const displayedRange = query.displayedRange ?? query.result?.range ?? null;
  const unavailable = !hasResult || query.result?.state === "unavailable";
  const requestFailed = query.error !== null;
  const hasUsableResult = hasResult && !unavailable;
  const retainedFailure = hasUsableResult && requestFailed;
  const staleResult = hasUsableResult && (query.isStale || retainedFailure);

  let badge: { label: string; tone: "neutral" | "green" | "amber" | "red" };
  if (!hasResult && query.isInitialLoading) {
    badge = { label: "Loading history", tone: "neutral" };
  } else if (unavailable) {
    badge = { label: "History unavailable", tone: "red" };
  } else if (query.result?.state === "empty") {
    badge = { label: "Collecting history", tone: "neutral" };
  } else if (staleResult) {
    badge = { label: "Stale", tone: "amber" };
  } else if (query.result?.state === "partial") {
    badge = { label: "Partial history", tone: "amber" };
  } else {
    badge = { label: "Ready", tone: "green" };
  }

  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="truncate">{cluster.name}</CardTitle>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </CardHeader>
      <CardBody>
        {hasResult && !unavailable ? (
          displayedRange === "5m" ? (
            <LiveTokenHistoryContent clusterName={cluster.name} result={query.result!}>
              {(liveResult) => (
                <HistoryContent
                  clusterName={cluster.name}
                  query={query}
                  result={liveResult}
                  requestActive={requestActive}
                  displayedRange={displayedRange}
                />
              )}
            </LiveTokenHistoryContent>
          ) : (
            <HistoryContent
              clusterName={cluster.name}
              query={query}
              result={query.result!}
              requestActive={requestActive}
              displayedRange={displayedRange}
            />
          )
        ) : hasResult && query.result?.state === "unavailable" ? (
          <UnavailableContent query={query} requestActive={requestActive} hasCachedResult />
        ) : query.isInitialLoading ? (
          <div
            className="flex h-56 items-center justify-center rounded-md bg-zinc-50 text-sm text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400"
            aria-busy="true"
          >
            Loading persisted token history…
          </div>
        ) : (
          <UnavailableContent query={query} requestActive={requestActive} hasCachedResult={false} />
        )}
      </CardBody>
    </Card>
  );
});

function HistoryContent({
  clusterName,
  query,
  result,
  requestActive,
  displayedRange,
}: {
  clusterName: string;
  query: TokenHistoryQueryState;
  result: TokenHistoryResult;
  requestActive: boolean;
  displayedRange: TrendRange | null;
}) {
  if (result.state === "empty") {
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-2 rounded-md bg-zinc-50 px-4 text-center text-sm text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
        <p>No token throughput samples have been collected for this range.</p>
        <p>Collection will populate this chart when the cluster reports Tokens/s.</p>
        {requestActive && <LoadingRangeNote query={query} displayedRange={displayedRange} />}
        {query.error !== null && <p className="text-red-700 dark:text-red-300">{query.error}</p>}
        {query.isStale && (
          <p className="text-amber-700 dark:text-amber-300">
            This collecting state is stale while history refreshes.
          </p>
        )}
        {(query.error !== null || query.isStale) && (
          <Button type="button" size="sm" onClick={query.retry} disabled={requestActive}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  const summary = summarizeTokenHistory(result);
  const latestText = formatTokensPerSecond(summary.latest);
  const averageText = formatTokensPerSecond(summary.average);
  const minimumText = formatTokensPerSecond(summary.minimum);
  const maximumText = formatTokensPerSecond(summary.maximum);
  const chartLabel =
    `${clusterName} token throughput history, ${displayedRange ?? result.range}; ` +
    `Latest: ${latestText}; Average: ${averageText}; Min–max: ${minimumText} – ${maximumText}`;

  return (
    <div className="flex flex-col gap-3">
      <TokenHistoryChart result={result} ariaLabel={chartLabel} />
      <div className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
        <p>
          Latest: {formatTokensPerSecond(summary.latest)} · Average:{" "}
          {formatTokensPerSecond(summary.average)}
        </p>
        <p>
          Min–max: {formatTokensPerSecond(summary.minimum)} –{" "}
          {formatTokensPerSecond(summary.maximum)}
        </p>
        <p>
          Range: {displayedRange ?? result.range} · Coverage: {Math.round(result.coverage * 100)}% ·
          Freshness: {formatFreshness(summary.latestAtMs, query.isStale)}
        </p>
        {requestActive && <LoadingRangeNote query={query} displayedRange={displayedRange} />}
        {query.error !== null && <p className="text-red-700 dark:text-red-300">{query.error}</p>}
        {(query.error !== null || query.isStale) && (
          <Button type="button" size="sm" onClick={query.retry} disabled={requestActive}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

function UnavailableContent({
  query,
  requestActive,
  hasCachedResult,
}: {
  query: TokenHistoryQueryState;
  requestActive: boolean;
  hasCachedResult: boolean;
}) {
  return (
    <div className="flex min-h-32 flex-col items-start gap-3 text-sm text-zinc-600 dark:text-zinc-400">
      <p>
        {hasCachedResult
          ? "Token history is unavailable for the requested range. The previous result is retained when possible."
          : "Token history is unavailable for this cluster right now."}
      </p>
      {query.error !== null && <p className="text-red-700 dark:text-red-300">{query.error}</p>}
      <Button type="button" size="sm" onClick={query.retry} disabled={requestActive}>
        Retry
      </Button>
    </div>
  );
}

function LoadingRangeNote({
  query,
  displayedRange,
}: {
  query: TokenHistoryQueryState;
  displayedRange: TrendRange | null;
}) {
  if (!query.isRefreshing || displayedRange === null) return null;
  return (
    <p aria-live="polite" className="text-xs text-amber-700 dark:text-amber-300">
      Loading {query.requestedRange}; showing {displayedRange}
    </p>
  );
}

function formatTokensPerSecond(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} Tokens/s`;
}

function formatFreshness(atMs: number | null, stale: boolean): string {
  if (atMs === null) return "No samples yet";
  const timestamp = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(atMs));
  return `${timestamp}${stale ? " · stale" : ""}`;
}
