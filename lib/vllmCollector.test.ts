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
vllm:kv_cache_usage_perc{model_name="qwen"} 0.25
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
      metrics: { runningRequests: { value: 1, state: "live" } },
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
    const monotonicNow = vi
      .fn<() => number>()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(3_000);
    const registry = createVllmCollectorRegistry({
      ...dependencies(fetch, wait),
      monotonicNow,
    });
    const first = vi.fn();
    const remove = registry.subscribe("c032", "host", first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    remove();

    const reconnect = vi.fn();
    const removeReconnect = registry.subscribe("c032", "host", reconnect);
    expect(reconnect).toHaveBeenCalledWith(first.mock.calls[0][0]);
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
