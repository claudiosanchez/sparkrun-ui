import { describe, expect, it } from "vitest";
import {
  deriveTokenRate,
  parseVllmMetrics,
  staleClusterSnapshot,
  type CounterBaseline,
} from "./vllmMetrics";

const metrics = `
# HELP vllm:generation_tokens_total Number of generation tokens
vllm:generation_tokens_total{model_name="qwen",engine="0"} 120
vllm:generation_tokens_total{model_name="qwen",engine="1"} 80
vllm:num_requests_running{model_name="qwen"} 0
vllm:num_requests_waiting{model_name="qwen"} 2 123456
vllm:kv_cache_usage_perc{model_name="qwen",engine="0"} 0.40
vllm:kv_cache_usage_perc{model_name="qwen",engine="1"} 0.60
process_cpu_seconds_total 999
`;

const baseline = (series: Array<[string, number]>, monotonicMs = 1_000): CounterBaseline => ({
  series: new Map(series),
  monotonicMs,
});

describe("parseVllmMetrics", () => {
  it("parses only the allowed vLLM families and preserves zero", () => {
    const parsed = parseVllmMetrics(metrics);

    expect([...parsed.generationTokenSeries!.values()]).toEqual([120, 80]);
    expect(parsed).toMatchObject({
      runningRequests: 0,
      waitingRequests: 2,
      kvCachePercent: 50,
    });
  });

  it("canonicalizes equivalent label sets and skips comments and blank lines", () => {
    const parsed = parseVllmMetrics(`
      # a comment
      vllm:generation_tokens_total{engine="0",model_name="qwen"} 12
      vllm:generation_tokens_total{model_name="qwen",engine="0"} 12
    `);

    expect([...parsed.generationTokenSeries!.keys()]).toEqual(['engine="0",model_name="qwen"']);
    expect(parsed.generationTokenSeries!.get('engine="0",model_name="qwen"')).toBe(12);
  });

  it("rejects non-finite and negative target samples as unavailable families", () => {
    const parsed = parseVllmMetrics(`
      vllm:generation_tokens_total NaN
      vllm:num_requests_running +Inf
      vllm:num_requests_waiting -1
      vllm:kv_cache_usage_perc Infinity
    `);

    expect(parsed.generationTokenSeries).toBeNull();
    expect(parsed.runningRequests).toBeNull();
    expect(parsed.waitingRequests).toBeNull();
    expect(parsed.kvCachePercent).toBeNull();
    expect(parsed.invalidFamilies).toEqual(
      new Set([
        "vllm:generation_tokens_total",
        "vllm:num_requests_running",
        "vllm:num_requests_waiting",
        "vllm:kv_cache_usage_perc",
      ]),
    );
  });

  it("returns null for a family with no valid samples", () => {
    expect(parseVllmMetrics("vllm:num_requests_running 0\n").waitingRequests).toBeNull();
    expect(parseVllmMetrics("vllm:num_requests_running 0\n").kvCachePercent).toBeNull();
    expect(parseVllmMetrics("vllm:num_requests_running 0\n").generationTokenSeries).toBeNull();
  });
});

describe("deriveTokenRate", () => {
  it("uses elapsed monotonic time for tokens per second", () => {
    const prior = baseline([[`engine="0",model_name="qwen"`, 200]]);
    const current = new Map([[`engine="0",model_name="qwen"`, 260]]);

    expect(deriveTokenRate(prior, current, 3_000, 50_000).reading).toEqual({
      value: 30,
      state: "live",
      observedAtMs: 50_000,
    });
  });

  it("sums unchanged full-label series and reports an idle interval as live zero", () => {
    const prior = baseline([
      ['engine="0",model_name="qwen"', 200],
      ['engine="1",model_name="qwen"', 80],
    ]);
    const current = new Map([
      ['engine="0",model_name="qwen"', 260],
      ['engine="1",model_name="qwen"', 80],
    ]);
    expect(deriveTokenRate(prior, current, 3_000, 50_000).reading.value).toBe(30);

    const idle = new Map([['model_name="qwen"', 200]]);
    expect(
      deriveTokenRate(baseline([['model_name="qwen"', 200]]), idle, 3_000, 50_000).reading,
    ).toMatchObject({
      value: 0,
      state: "live",
    });
  });

  it("warms on the first sample and on a new series", () => {
    const current = new Map([["model=qwen,engine=0", 120]]);
    expect(deriveTokenRate(null, current, 3_000, 50_000).reading).toMatchObject({
      value: null,
      state: "warming",
    });

    const changed = new Map([
      ["model=qwen,engine=0", 120],
      ["model=qwen,engine=1", 5],
    ]);
    expect(
      deriveTokenRate(baseline([["model=qwen,engine=0", 100]]), changed, 3_000, 60_000).reading,
    ).toMatchObject({
      value: null,
      state: "warming",
    });
  });

  it("does not derive a rate across a disappeared series or invalid current map", () => {
    const previous = baseline([
      ["model=qwen,engine=0", 100],
      ["model=qwen,engine=1", 20],
    ]);
    const disappeared = new Map([["model=qwen,engine=0", 120]]);
    expect(deriveTokenRate(previous, disappeared, 3_000, 60_000)).toMatchObject({
      reading: { value: null, state: "unavailable" },
      baseline: null,
    });
    expect(deriveTokenRate(previous, null, 3_000, 60_000)).toMatchObject({
      reading: { value: null, state: "unavailable" },
      baseline: null,
    });
  });

  it("reports a counter reset without a negative or synthetic rate", () => {
    const prior = baseline([['model_name="qwen"', 200]]);
    const current = new Map([['model_name="qwen"', 5]]);
    const result = deriveTokenRate(prior, current, 3_000, 50_000);

    expect(result.reading).toEqual({ value: null, state: "reset", observedAtMs: 50_000 });
    expect(result.baseline).toEqual({ series: current, monotonicMs: 3_000 });
  });

  it("warms instead of dividing by zero for a nonpositive elapsed interval", () => {
    const current = new Map([['model_name="qwen"', 220]]);
    expect(
      deriveTokenRate(baseline([['model_name="qwen"', 200]]), current, 1_000, 50_000).reading,
    ).toMatchObject({
      value: null,
      state: "warming",
    });
  });
});

describe("staleClusterSnapshot", () => {
  it("retains values but marks them stale after a failed poll", () => {
    const liveSnapshot = {
      cluster: "c032",
      polledAtMs: 60_000,
      sourceHost: "100.65.40.24",
      state: "live" as const,
      error: null,
      metrics: {
        tokensPerSecond: { value: 30, state: "live" as const, observedAtMs: 60_000 },
        runningRequests: { value: 1, state: "live" as const, observedAtMs: 60_000 },
        waitingRequests: { value: 0, state: "live" as const, observedAtMs: 60_000 },
        kvCachePercent: { value: 50, state: "live" as const, observedAtMs: 60_000 },
      },
    };
    const stale = staleClusterSnapshot(liveSnapshot, 62_000, "HTTP 503");

    expect(stale.state).toBe("stale");
    expect(stale.metrics.tokensPerSecond).toMatchObject({ value: 30, state: "stale" });
    expect(stale.metrics.waitingRequests).toMatchObject({ value: 0, state: "stale" });
    expect(stale.error).toBe("HTTP 503");
  });
});
