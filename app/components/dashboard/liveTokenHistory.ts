import { rangePolicy, type TokenHistoryResult, type TokenObservation } from "@/lib/tokenHistory";

const LIVE_RANGE = "5m";
const LIVE_POINT_LIMIT = 300;

function observationSourceAtMs(observation: TokenObservation): number {
  return observation.latestAtMs ?? observation.atMs;
}

export function reduceLiveTokenObservations(
  previous: readonly TokenObservation[],
  observation: TokenObservation,
): readonly TokenObservation[] {
  const currentFingerprint = previous.at(-1)?.fingerprint;
  if (currentFingerprint !== undefined && currentFingerprint !== observation.fingerprint) {
    const newestObservation = previous.at(-1);
    if (
      newestObservation !== undefined &&
      observationSourceAtMs(observation) < observationSourceAtMs(newestObservation)
    ) {
      return previous;
    }
    return [observation];
  }

  const byTimestamp = new Map<number, TokenObservation>();
  for (const item of previous) byTimestamp.set(item.atMs, item);
  byTimestamp.set(observation.atMs, observation);

  const ordered = [...byTimestamp.values()].sort(
    (left, right) => observationSourceAtMs(left) - observationSourceAtMs(right),
  );
  const newestAtMs = observationSourceAtMs(ordered.at(-1) ?? observation);
  const fromExclusive = newestAtMs - rangePolicy(LIVE_RANGE).durationMs;
  return ordered
    .filter((item) => observationSourceAtMs(item) > fromExclusive)
    .slice(-LIVE_POINT_LIMIT);
}

export function applyLiveTokenHistory(
  result: TokenHistoryResult,
  inputObservations: readonly TokenObservation[],
): TokenHistoryResult {
  if (result.range !== LIVE_RANGE) return result;

  const observations = inputObservations
    .filter((observation) => observation.cluster === result.cluster)
    .reduce<readonly TokenObservation[]>(reduceLiveTokenObservations, []);
  if (observations.length === 0) return result;

  const newest = observations.at(-1);
  if (newest === undefined) return result;

  const policy = rangePolicy(LIVE_RANGE);
  const newestLiveSourceAtMs = observationSourceAtMs(newest);
  if (
    result.fingerprint !== null &&
    newest.fingerprint !== result.fingerprint &&
    result.latestObservationAtMs !== null &&
    newestLiveSourceAtMs < result.latestObservationAtMs
  ) {
    return result;
  }
  const newestBucketEndMs =
    Math.floor(newest.atMs / policy.bucketMs) * policy.bucketMs + policy.bucketMs;
  const toMs = newest.atMs < result.toMs ? result.toMs : Math.max(result.toMs, newestBucketEndMs);
  const fromMs = toMs - policy.durationMs;
  const liveFingerprint = newest.fingerprint;
  const points = Array.from({ length: LIVE_POINT_LIMIT }, (_, index) => ({
    atMs: fromMs + index * policy.bucketMs,
    tokensPerSecond: null as number | null,
  }));
  const newestByBucket = new Map<
    number,
    { atMs: number; order: number; tokensPerSecond: number | null }
  >();
  let order = 0;

  const addToBucket = (atMs: number, tokensPerSecond: number | null) => {
    if (!Number.isFinite(atMs) || atMs < fromMs || atMs > toMs) return;
    const offset = Math.max(atMs, fromMs) - fromMs;
    const index = Math.min(LIVE_POINT_LIMIT - 1, Math.floor(offset / policy.bucketMs));
    const current = newestByBucket.get(index);
    const candidate = { atMs, order, tokensPerSecond };
    order += 1;
    if (
      current === undefined ||
      candidate.atMs > current.atMs ||
      (candidate.atMs === current.atMs && candidate.order > current.order)
    ) {
      newestByBucket.set(index, candidate);
    }
  };

  if (result.fingerprint === liveFingerprint) {
    for (const point of result.points) {
      addToBucket(
        point.atMs,
        point.tokensPerSecond !== null && Number.isFinite(point.tokensPerSecond)
          ? point.tokensPerSecond
          : null,
      );
    }
  }
  for (const observation of observations) {
    if (observation.fingerprint !== liveFingerprint) continue;
    addToBucket(observation.atMs, observation.tokensPerSecond);
  }

  let covered = 0;
  for (const [index, candidate] of newestByBucket) {
    points[index].tokensPerSecond = candidate.tokensPerSecond;
    if (candidate.tokensPerSecond !== null) covered += 1;
  }

  const coverage = covered / LIVE_POINT_LIMIT;
  return {
    ...result,
    fingerprint: liveFingerprint,
    latestObservationAtMs:
      result.fingerprint === liveFingerprint && result.latestObservationAtMs !== null
        ? Math.max(result.latestObservationAtMs, newestLiveSourceAtMs)
        : newestLiveSourceAtMs,
    fromMs,
    toMs,
    resolutionMs: policy.bucketMs,
    state: covered === 0 ? "empty" : covered === LIVE_POINT_LIMIT ? "ready" : "partial",
    coverage,
    points,
  };
}
