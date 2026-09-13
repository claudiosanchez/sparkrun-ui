import { describe, expect, it, vi } from "vitest";
import { createVllmCollectorRegistry } from "@/lib/vllmCollector";
import { streamClusterMetrics, type VllmCollectorDependencies } from "./vllmMetrics";

const text = `
vllm:generation_tokens_total{engine="0"} 10
vllm:num_requests_running 1
vllm:num_requests_waiting 2
vllm:kv_cache_usage_perc 0.42
`;

function response(body: string, status = 200): Response {
  return new Response(body, { status });
}

function deps(fetch: typeof globalThis.fetch): VllmCollectorDependencies {
  return {
    fetch,
    listSavedClusters: async () => [],
    monotonicNow: () => 1_000,
    wallNow: () => 10_000,
    wait: (_ms, signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  };
}

async function firstSnapshot(
  cluster: string,
  savedClusters: VllmCollectorDependencies["listSavedClusters"],
  fetch: typeof globalThis.fetch,
) {
  const registry = createVllmCollectorRegistry(deps(fetch));
  const controller = new AbortController();
  const iterator = streamClusterMetrics({ cluster }, controller.signal, registry, savedClusters);
  const next = await iterator.next();
  controller.abort();
  await iterator.return?.(undefined);
  registry.stopAll();
  return next.value;
}

describe("streamClusterMetrics", () => {
  it("resolves the first saved host and never accepts an arbitrary caller URL", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(text));
    const snapshot = await firstSnapshot(
      "c458",
      async () => [
        { name: "c458", hosts: ["100.83.161.109", "worker.example"], is_default: false },
      ],
      fetch,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("http://100.83.161.109:8000/metrics", {
      signal: expect.any(AbortSignal),
      redirect: "error",
    });
    expect(fetch).not.toHaveBeenCalledWith("http://worker.example:8000/metrics", expect.anything());
    expect(snapshot).toMatchObject({
      cluster: "c458",
      sourceHost: "100.83.161.109",
      metrics: {
        runningRequests: { value: 1 },
        waitingRequests: { value: 2 },
        kvCachePercent: { value: 42 },
      },
    });
  });

  it("returns unavailable without fetching for an unknown or empty saved cluster", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const missing = await firstSnapshot("missing", async () => [], fetch);
    const empty = await firstSnapshot(
      "empty",
      async () => [{ name: "empty", hosts: [], is_default: false }],
      fetch,
    );

    expect(missing).toMatchObject({ sourceHost: null, state: "unavailable" });
    expect(empty).toMatchObject({ sourceHost: null, state: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a bracketed URL for a saved IPv6 leader", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(text));
    await firstSnapshot(
      "v6",
      async () => [{ name: "v6", hosts: ["2001:db8::1"], is_default: false }],
      fetch,
    );
    expect(fetch.mock.calls[0][0]).toBe("http://[2001:db8::1]:8000/metrics");
  });

  it.each([
    ["HTTP 503", response("no", 503)],
    ["redirect rejected", new Response("", { status: 302, headers: { location: "http://bad" } })],
    ["invalid metrics", response("not prometheus")],
  ])("sanitizes a %s failure", async (error, result) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(result);
    const snapshot = await firstSnapshot(
      "c032",
      async () => [{ name: "c032", hosts: ["host"], is_default: false }],
      fetch,
    );
    expect(snapshot).toMatchObject({ state: "unavailable", error, sourceHost: "host" });
  });

  it("rejects an oversized metrics response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(`vllm:num_requests_running ${"1".repeat(1_000_001)}`));
    const snapshot = await firstSnapshot(
      "c032",
      async () => [{ name: "c032", hosts: ["host"], is_default: false }],
      fetch,
    );
    expect(snapshot).toMatchObject({ state: "unavailable", error: "response too large" });
  });
});
