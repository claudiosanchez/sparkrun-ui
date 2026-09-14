import { TREND_RANGES, type TokenHistoryResult, type TrendRange } from "@/lib/tokenHistory";

export const TOKEN_HISTORY_RANGES = TREND_RANGES;
export const TOKEN_HISTORY_REFRESH_MS = 60_000;

export type TokenHistorySummary = {
  latest: number | null;
  minimum: number | null;
  maximum: number | null;
  average: number | null;
  latestAtMs: number | null;
};

export function tokenHistoryCacheKey(cluster: string, range: TrendRange): string {
  return `${cluster}\u0000${range}`;
}

export function isFreshHistoryCache(fetchedAtMs: number, nowMs: number): boolean {
  return nowMs - fetchedAtMs <= TOKEN_HISTORY_REFRESH_MS;
}

export function summarizeTokenHistory(result: TokenHistoryResult): TokenHistorySummary {
  let latest: number | null = null;
  let latestAtMs: number | null = null;
  let minimum: number | null = null;
  let maximum: number | null = null;
  let sum = 0;
  let count = 0;

  for (const point of result.points) {
    if (point.tokensPerSecond === null) continue;
    if (!Number.isFinite(point.tokensPerSecond)) continue;

    if (latestAtMs === null || point.atMs >= latestAtMs) {
      latest = point.tokensPerSecond;
      latestAtMs = point.atMs;
    }
    minimum = minimum === null ? point.tokensPerSecond : Math.min(minimum, point.tokensPerSecond);
    maximum = maximum === null ? point.tokensPerSecond : Math.max(maximum, point.tokensPerSecond);
    sum += point.tokensPerSecond;
    count += 1;
  }

  return {
    latest,
    minimum,
    maximum,
    average: count === 0 ? null : sum / count,
    latestAtMs,
  };
}

export function formatTokensPerSecond(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} Tokens/s`;
}

export function formatTokenHistoryCoverage(coverage: number): string {
  return `${Math.round(coverage * 100)}% coverage`;
}

export function formatTimestamp(atMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(atMs));
}
