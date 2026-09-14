import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVllmCollectorRegistry,
  fetchVllmMetrics,
  type VllmCollectorDependencies,
} from "./vllmCollector";

const body = `
vllm:generation_tokens_total{model_name="qwen"} 100
vllm:num_requests_running{model_name="qwen"} 1
vllm:num_requests_waiting{model_name="qwen"} 0
vllm:kv_cache_usage_perc{engine="0",model_name="qwen"} 0.25
vllm:cache_config_info{engine="0",kv_cache_size_tokens="1000"} 1
`;

function response(text: string, status = 200): Response {
  return new Response(text, { status });
}

function dependencies(
  fetch: typeof globalThis.fetch,
  wait?: VllmCollectorDependencies["wait"],
): VllmCollectorDependencies {
  return {
    fetch,
    monotonicNow: vi.fn(() => 1_000),
    wallNow: vi.fn(() => 50_000),
    wait:
      wait ??
      vi.fn(
        (_ms: number, signal: AbortSignal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
      ),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createVllmCollectorRegistry", () => {
  it("defaults server-owned collection to one second", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body));
    const wait = vi.fn(
      (_ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    );
    const registry = createVllmCollectorRegistry({ ...dependencies(fetch), wait });
    const remove = registry.subscribe("c032", "host", vi.fn());

    await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(1_000, expect.any(AbortSignal)));
    expect(registry.getEntry("c032")?.pollIntervalMs).toBe(1_000);

    remove();
    expect(registry.getEntry("c032")?.pollIntervalMs).toBe(1_000);
    registry.stopAll();
  });

  it("schedules the next single fetch from the prior fetch start time", async () => {
    let now = 0;
    let releaseWait: (() => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (now === 0) now = 400;
      return response(body);
    });
    const wait = vi.fn(
      (_ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          releaseWait = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const registry = createVllmCollectorRegistry({
      ...dependencies(fetch, wait),
      monotonicNow: () => now,
    });
    const remove = registry.subscribe("c032", "host", vi.fn());

    await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(600, expect.any(AbortSignal)));
    expect(fetch).toHaveBeenCalledTimes(1);

    now = 1_000;
    releaseWait!();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledTimes(2);

    remove();
    registry.stopAll();
  });

  it("skips an overdue wait without overlapping slow fetches", async () => {
    let now = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise<Response>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          releases.push(() => {
            inFlight -= 1;
            resolve(response(body));
          });
        }),
    );
    const wait = vi.fn((ms: number, signal: AbortSignal) => {
      if (ms === 0) return Promise.resolve();
      return new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const registry = createVllmCollectorRegistry({
      ...dependencies(fetch, wait),
      monotonicNow: () => now,
    });
    const remove = registry.subscribe("c032", "host", vi.fn());

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    now = 1_500;
    releases[0]();

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(wait).toHaveBeenCalledWith(0, expect.any(AbortSignal));
    expect(maxInFlight).toBe(1);

    releases[1]();
    remove();
    registry.stopAll();
  });

  it("recalculates the same monotonic deadline when a requested interval changes", async () => {
    let now = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      now = 100;
      return response(body);
    });
    const wait = vi.fn(
      (_ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    );
    const registry = createVllmCollectorRegistry({
      ...dependencies(fetch, wait),
      monotonicNow: () => now,
    });
    const removeRecorder = registry.subscribe("c032", "host", vi.fn(), undefined, 2_000);

    await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(1_900, expect.any(AbortSignal)));

    const removeFastSubscriber = registry.subscribe("c032", "host", vi.fn(), undefined, 1_000);
    await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(900, expect.any(AbortSignal)));
    expect(fetch).toHaveBeenCalledTimes(1);

    now = 200;
    removeFastSubscriber();
    await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(1_800, expect.any(AbortSignal)));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(registry.getEntry("c032")?.pollIntervalMs).toBe(2_000);

    removeRecorder();
    registry.stopAll();
  });

  it("extends the deadline when an interval change races timer completion", async () => {
    let now = 0;
    let fetchCalls = 0;
    let releaseTimer: (() => void) | undefined;
    const waits: number[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      fetchCalls += 1;
      return response(body);
    });
    const wait = (ms: number, signal: AbortSignal) => {
      waits.push(ms);
      return new Promise<void>((resolve) => {
        if (waits.length === 1) releaseTimer = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const registry = createVllmCollectorRegistry({
      ...dependencies(fetch, wait),
      monotonicNow: () => now,
    });
    const removeSlowSubscriber = registry.subscribe("c032", "host", vi.fn(), undefined, 2_000);
    const removeFastSubscriber = registry.subscribe("c032", "host", vi.fn(), undefined, 1_000);

    await vi.waitFor(() => expect(waits).toEqual([1_000]));
    now = 1_000;
    releaseTimer!();
    queueMicrotask(removeFastSubscriber);

    await vi.waitFor(() => expect(waits).toHaveLength(2));
    expect(waits).toEqual([1_000, 1_000]);
    expect(fetchCalls).toBe(1);
    expect(registry.getEntry("c032")?.pollIntervalMs).toBe(2_000);

    removeSlowSubscriber();
    registry.stopAll();
  });

  it("shares one poll loop and one response across subscribers to a cluster", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body));
    const registry = createVllmCollectorRegistry(dependencies(fetch));
    const first = vi.fn();
    const second = vi.fn();

    const removeFirst = registry.subscribe("c032", "100.65.40.24", first);
    const removeSecond = registry.subscribe("c032", "100.65.40.24", second);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(first.mock.calls[0][0]);
    expect(first.mock.calls[0][0]).toMatchObject({
      cluster: "c032",
      sourceHost: "100.65.40.24",
      state: "live",
      metrics: {
        runningRequests: { value: 1, state: "live" },
        kvCacheCapacityTokens: { value: 1_000, state: "live" },
      },
    });

    removeFirst();
    removeSecond();
    registry.stopAll();
  });

  it("replays a cached snapshot and keeps its counter baseline across reconnect", async () => {
    let releaseWait: (() => void) | undefined;
    const wait = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseWait = resolve;
        }),
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(body))
      .mockResolvedValueOnce(response(body.replace(" 100", " 160")));
    let monotonicMs = 1_000;
    const registry = createVllmCollectorRegistry({
      ...dependencies(fetch, wait),
      monotonicNow: () => monotonicMs,
    });
    const first = vi.fn();
    const remove = registry.subscribe("c032", "host", first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    remove();

    const reconnect = vi.fn();
    const removeReconnect = registry.subscribe("c032", "host", reconnect);
    expect(reconnect).toHaveBeenCalledWith(first.mock.calls[0][0]);
    monotonicMs = 3_000;
    releaseWait!();
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(2));
    expect(reconnect.mock.calls[1][0].metrics.tokensPerSecond).toMatchObject({
      value: 30,
      state: "live",
    });

    removeReconnect();
    registry.stopAll();
  });

  it("cleans up only an idle cluster after the reconnect grace period", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body));
    const registry = createVllmCollectorRegistry(dependencies(fetch));
    const listener = vi.fn();
    const remove = registry.subscribe("c032", "host", listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    remove();
    expect(registry.getEntry("c032")).toBeDefined();

    vi.advanceTimersByTime(9_999);
    expect(registry.getEntry("c032")).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(registry.getEntry("c032")).toBeUndefined();
    expect(registry.getEntry("c458")).toBeUndefined();
  });

  it("keeps counters, fetch loops, and cleanup ownership separate per cluster", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(body))
      .mockResolvedValueOnce(response(body.replace(" 100", "200")));
    const registry = createVllmCollectorRegistry(dependencies(fetch));
    const c032 = vi.fn();
    const c458 = vi.fn();
    const remove032 = registry.subscribe("c032", "c032-host", c032);
    const remove458 = registry.subscribe("c458", "c458-host", c458);
    await vi.waitFor(() => {
      expect(c032).toHaveBeenCalledTimes(1);
      expect(c458).toHaveBeenCalledTimes(1);
    });

    expect(registry.getEntry("c032")?.leaderHost).toBe("c032-host");
    expect(registry.getEntry("c458")?.leaderHost).toBe("c458-host");
    expect(fetch).toHaveBeenCalledTimes(2);
    remove032();
    expect(registry.getEntry("c458")).toBeDefined();
    expect(registry.getEntry("c032")).toBeDefined();
    remove458();
    registry.stopAll();
  });

  it("notifies a replaced stream owner when a saved leader changes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body));
    const registry = createVllmCollectorRegistry(dependencies(fetch));
    const firstStopped = vi.fn();
    const removeFirst = registry.subscribe("c032", "old-host", vi.fn(), firstStopped);
    const removeSecond = registry.subscribe("c032", "new-host", vi.fn());

    expect(firstStopped).toHaveBeenCalledTimes(1);
    expect(registry.getEntry("c032")?.leaderHost).toBe("new-host");
    removeFirst();
    removeSecond();
    registry.stopAll();
  });

  it("clears the token baseline for an invalid generation family before recovery", async () => {
    let releaseWait: (() => void) | undefined;
    const wait = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseWait = resolve;
        }),
    );
    const invalidGeneration = 'vllm:generation_tokens_total{model_name="qwen"} NaN\n';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(body))
      .mockResolvedValueOnce(response(invalidGeneration))
      .mockResolvedValueOnce(response(body.replace(" 100", " 160")));
    let monotonicMs = 1_000;
    const registry = createVllmCollectorRegistry({
      ...dependencies(fetch, wait),
      monotonicNow: () => monotonicMs,
    });
    const listener = vi.fn();
    const remove = registry.subscribe("c032", "host", listener);

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener.mock.calls[0][0].metrics.tokensPerSecond).toMatchObject({
      value: null,
      state: "warming",
    });

    monotonicMs = 3_000;
    releaseWait!();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(listener.mock.calls[1][0].metrics.tokensPerSecond).toMatchObject({
      value: null,
      state: "unavailable",
    });

    monotonicMs = 5_000;
    releaseWait!();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(3));
    expect(listener.mock.calls[2][0].metrics.tokensPerSecond).toMatchObject({
      value: null,
      state: "warming",
    });

    remove();
    registry.stopAll();
  });

  it("rejects a body without valid Prometheus samples or a recognized target family", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response("not prometheus\n"));
    const registry = createVllmCollectorRegistry(dependencies(fetch));
    const listener = vi.fn();
    const remove = registry.subscribe("c032", "host", listener);

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener.mock.calls[0][0]).toMatchObject({
      state: "unavailable",
      error: "invalid metrics",
      metrics: {
        tokensPerSecond: { value: null, state: "unavailable" },
      },
    });

    remove();
    registry.stopAll();
  });
});

describe("fetchVllmMetrics", () => {
  it("cancels a response reader when UTF-8 decoding fails", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array([0xff]) }),
      cancel,
      releaseLock: vi.fn(),
    };
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      redirected: false,
      type: "basic",
      body: { getReader: () => reader },
    } as unknown as Response);

    await expect(fetchVllmMetrics("host", new AbortController().signal, fetcher)).rejects.toThrow(
      "invalid metrics",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes a fetch rejection caused by redirect blocking", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("redirect"));

    await expect(fetchVllmMetrics("host", new AbortController().signal, fetcher)).rejects.toThrow(
      "redirect rejected",
    );
  });
});
