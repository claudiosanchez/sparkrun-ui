import { describe, expect, it } from "vitest";
import { aggregateTokenHistory, rangePolicy } from "./tokenHistory";

describe("rangePolicy", () => {
  it("bounds each supported range to its server resolution", () => {
    expect(rangePolicy("5m")).toEqual({ durationMs: 5 * 60_000, bucketMs: 1_000 });
    expect(rangePolicy("15m")).toEqual({ durationMs: 15 * 60_000, bucketMs: 5_000 });
    expect(rangePolicy("1d")).toEqual({ durationMs: 24 * 60 * 60_000, bucketMs: 5 * 60_000 });
    expect(rangePolicy("7d")).toEqual({ durationMs: 7 * 24 * 60 * 60_000, bucketMs: 30 * 60_000 });
    expect(rangePolicy("30d")).toEqual({
      durationMs: 30 * 24 * 60 * 60_000,
      bucketMs: 2 * 60 * 60_000,
    });
  });
});

describe("aggregateTokenHistory", () => {
  it("retains the newest source timestamp instead of its chart bucket timestamp", () => {
    const result = aggregateTokenHistory(
      [
        {
          atMs: 399_000,
          latestAtMs: 399_900,
          cluster: "c032",
          fingerprint: "new",
          tokensPerSecond: 25,
          weight: 2,
        },
      ],
      { cluster: "c032", range: "5m", nowMs: 400_000 },
    );

    expect(result).toMatchObject({
      fingerprint: "new",
      latestObservationAtMs: 399_900,
    });
    expect(result.points[299]).toEqual({ atMs: 399_000, tokensPerSecond: 25 });
  });

  it("uses null when an empty result has no source observation", () => {
    const result = aggregateTokenHistory([], {
      cluster: "c032",
      range: "5m",
      nowMs: 400_000,
    });

    expect(result).toMatchObject({
      fingerprint: null,
      latestObservationAtMs: null,
      state: "empty",
    });
  });

  it("materializes five minutes of seconds with zero, null gaps, and partial coverage", () => {
    const policy = rangePolicy("5m");
    const result = aggregateTokenHistory(
      [{ atMs: 1_000, cluster: "c032", fingerprint: "a", tokensPerSecond: 0 }],
      { range: "5m", nowMs: 300_000 },
    );

    expect(result.points).toHaveLength(300);
    expect(result.points[1].tokensPerSecond).toBe(0);
    expect(result.points[2].tokensPerSecond).toBeNull();
    expect(result.coverage).toBe(1 / 300);
    expect(result.state).toBe("partial");
  });

  it("keeps a zero sample and materializes a missing bucket as null", () => {
    const policy = rangePolicy("15m");
    const result = aggregateTokenHistory(
      [
        { atMs: 1_000, cluster: "c032", fingerprint: "a", tokensPerSecond: 0 },
        { atMs: 11_000, cluster: "c032", fingerprint: "a", tokensPerSecond: 20 },
      ],
      { range: "15m", nowMs: policy.bucketMs * 3 },
    );
    expect(result.points.map((point) => point.tokensPerSecond)).toContain(0);
    expect(result.points.map((point) => point.tokensPerSecond)).toContain(null);
  });

  it("uses valid samples to calculate a bucket average", () => {
    const policy = rangePolicy("15m");
    const result = aggregateTokenHistory(
      [
        { atMs: 10_000, cluster: "c032", fingerprint: "a", tokensPerSecond: 10 },
        { atMs: 11_000, cluster: "c032", fingerprint: "a", tokensPerSecond: 20 },
      ],
      { range: "15m", nowMs: policy.bucketMs * 3 },
    );

    expect(result.points.map((point) => point.tokensPerSecond)).toContain(15);
    expect(result.coverage).toBeGreaterThan(0);
    expect(result.state).toBe("partial");
  });

  it("returns only the newest cluster fingerprint series", () => {
    const result = aggregateTokenHistory(
      [
        { atMs: 1_000, cluster: "c032", fingerprint: "host-a", tokensPerSecond: 7 },
        { atMs: 2_000, cluster: "c032", fingerprint: "host-b", tokensPerSecond: 11 },
        { atMs: 3_000, cluster: "c032", fingerprint: "host-a", tokensPerSecond: 13 },
      ],
      { range: "15m", nowMs: 60_000 },
    );

    expect(result.fingerprint).toBe("host-a");
    expect(result.points.map((point) => point.tokensPerSecond)).toContain(10);
    expect(result.points.map((point) => point.tokensPerSecond)).not.toContain(11);
  });
});
