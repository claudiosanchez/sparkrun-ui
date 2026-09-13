import { describe, expect, it } from "vitest";
import { aggregateTokenHistory, rangePolicy } from "./tokenHistory";

describe("rangePolicy", () => {
  it("bounds each supported range to its server resolution", () => {
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
