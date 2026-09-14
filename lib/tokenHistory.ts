export type TrendRange = "5m" | "15m" | "1d" | "7d" | "30d";

export const TREND_RANGES = ["5m", "15m", "1d", "7d", "30d"] as const satisfies readonly TrendRange[];

export function isTrendRange(range: unknown): range is TrendRange {
  return typeof range === "string" && TREND_RANGES.includes(range as TrendRange);
}

export type TokenObservation = {
  atMs: number;
  cluster: string;
  fingerprint: string;
  tokensPerSecond: number | null;
  /** Number of equally-timed valid samples represented by this observation. */
  weight?: number;
  /** Latest source timestamp when this observation is a compacted bucket. */
  latestAtMs?: number;
};

export type TokenHistoryPoint = {
  atMs: number;
  tokensPerSecond: number | null;
};

export type TokenHistoryState = "ready" | "partial" | "empty" | "unavailable";

export type TokenHistoryResult = {
  cluster: string;
  fingerprint: string | null;
  range: TrendRange;
  fromMs: number;
  toMs: number;
  resolutionMs: number;
  state: TokenHistoryState;
  coverage: number;
  points: TokenHistoryPoint[];
};

export type TokenHistoryQuery = {
  cluster: string;
  range: TrendRange;
  nowMs?: number;
};

export type TokenHistoryStore = {
  record(observation: TokenObservation): Promise<void>;
  query(query: TokenHistoryQuery): Promise<TokenHistoryResult>;
  close(): Promise<void>;
};

export type TokenHistoryRangePolicy = {
  durationMs: number;
  bucketMs: number;
};

export function rangePolicy(range: TrendRange): TokenHistoryRangePolicy {
  if (range === "5m") return { durationMs: 5 * 60_000, bucketMs: 1_000 };
  if (range === "15m") return { durationMs: 15 * 60_000, bucketMs: 5_000 };
  if (range === "1d") return { durationMs: 24 * 60 * 60_000, bucketMs: 5 * 60_000 };
  if (range === "7d") return { durationMs: 7 * 24 * 60 * 60_000, bucketMs: 30 * 60_000 };
  return { durationMs: 30 * 24 * 60 * 60_000, bucketMs: 2 * 60 * 60_000 };
}

type AggregateOptions = {
  range: TrendRange;
  nowMs: number;
  cluster?: string;
  degraded?: boolean;
};

type Bucket = {
  weightedSum: number;
  validWeight: number;
};

/**
 * Aggregate observations into the bounded series used by the history API.
 *
 * Observations are equally weighted because each collector observation is one
 * sample. The sums and counts stay separate so a later storage tier can add
 * samples without averaging already-averaged values.
 */
export function aggregateTokenHistory(
  observations: TokenObservation[],
  options: AggregateOptions,
): TokenHistoryResult {
  const policy = rangePolicy(options.range);
  const fromMs = options.nowMs - policy.durationMs;
  const toMs = options.nowMs;
  const pointCount = Math.ceil(policy.durationMs / policy.bucketMs);
  const points = Array.from({ length: pointCount }, (_, index) => ({
    atMs: fromMs + index * policy.bucketMs,
    tokensPerSecond: null as number | null,
  }));

  const scoped = observations
    .map((observation, index) => ({ observation, index }))
    .filter(({ observation }) => {
      if (options.cluster !== undefined && observation.cluster !== options.cluster) return false;
      const seriesAtMs = observation.latestAtMs ?? observation.atMs;
      if (!Number.isFinite(observation.atMs) || !Number.isFinite(seriesAtMs)) return false;
      return seriesAtMs >= fromMs && seriesAtMs <= toMs;
    });

  const seriesTimestamp = (observation: TokenObservation): number =>
    observation.latestAtMs ?? observation.atMs;

  let newest: { observation: TokenObservation; index: number } | undefined;
  for (const candidate of scoped) {
    if (
      !newest ||
      seriesTimestamp(candidate.observation) > seriesTimestamp(newest.observation) ||
      (seriesTimestamp(candidate.observation) === seriesTimestamp(newest.observation) &&
        candidate.index > newest.index)
    ) {
      newest = candidate;
    }
  }

  const cluster = options.cluster ?? newest?.observation.cluster ?? "";
  const fingerprint = newest?.observation.fingerprint ?? null;
  const buckets: Bucket[] = Array.from({ length: pointCount }, () => ({
    weightedSum: 0,
    validWeight: 0,
  }));

  if (fingerprint !== null) {
    for (const { observation } of scoped) {
      if (observation.fingerprint !== fingerprint) continue;
      if (observation.tokensPerSecond === null || !Number.isFinite(observation.tokensPerSecond)) {
        continue;
      }

      const bucketAtMs = Math.max(observation.atMs, fromMs);
      const offset = bucketAtMs - fromMs;
      const index = Math.min(pointCount - 1, Math.floor(offset / policy.bucketMs));
      if (index < 0 || index >= pointCount) continue;
      const weight = observation.weight ?? 1;
      if (!Number.isFinite(weight) || weight <= 0) continue;
      buckets[index].weightedSum += observation.tokensPerSecond * weight;
      buckets[index].validWeight += weight;
    }
  }

  let covered = 0;
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.validWeight === 0) continue;
    points[index].tokensPerSecond = bucket.weightedSum / bucket.validWeight;
    covered += 1;
  }

  const coverage = pointCount === 0 ? 0 : covered / pointCount;
  let state: TokenHistoryState;
  if (options.degraded && covered > 0) {
    state = "partial";
  } else if (covered === 0) {
    state = "empty";
  } else if (covered === pointCount) {
    state = "ready";
  } else {
    state = "partial";
  }

  return {
    cluster,
    fingerprint,
    range: options.range,
    fromMs,
    toMs,
    resolutionMs: policy.bucketMs,
    state,
    coverage,
    points,
  };
}
