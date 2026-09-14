import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rangePolicy, type TokenHistoryResult, type TokenHistoryStore } from "@/lib/tokenHistory";
import type { ClusterEntry } from "@/lib/schemas";
import { get } from "./tokenHistory";

const query = vi.fn<TokenHistoryStore["query"]>();
const runtime = {
  store: {
    record: vi.fn(),
    query,
    close: vi.fn(),
  } as TokenHistoryStore,
  registry: {} as never,
  dependencies: {} as never,
  dataDir: "/tmp/sparkrun-ui-test",
  listSavedClusters: vi.fn<(_signal: AbortSignal) => Promise<ClusterEntry[]>>(),
};

vi.mock("@/lib/vllmCollectorRuntime", () => ({
  getProductionVllmCollectorRuntime: () => runtime,
}));

const client = createRouterClient({ get }, { context: {} });

function result(range: "5m" | "15m" | "1d" | "7d" | "30d"): TokenHistoryResult {
  const nowMs = 100_000;
  const policy = rangePolicy(range);
  return {
    cluster: "c032",
    fingerprint: "fingerprint",
    range,
    fromMs: nowMs - policy.durationMs,
    toMs: nowMs,
    resolutionMs: policy.bucketMs,
    state: "partial",
    coverage: 0.5,
    points: Array.from({ length: Math.ceil(policy.durationMs / policy.bucketMs) }, (_, index) => ({
      atMs: nowMs - policy.durationMs + index * policy.bucketMs,
      tokensPerSecond: null,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.listSavedClusters.mockResolvedValue([
    { name: "c032", hosts: ["host-a"], is_default: true },
    { name: "c458", hosts: ["host-b"], is_default: false },
  ]);
  query.mockResolvedValue(result("30d"));
});

describe("tokenHistory.get", () => {
  it("rejects an unknown cluster", async () => {
    await expect(client.get({ cluster: "not-saved", range: "1d" })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts only a saved cluster and range and returns bounded points", async () => {
    const response = await client.get({ cluster: "c032", range: "30d" });

    expect(response.points.length).toBeLessThanOrEqual(360);
    expect(query).toHaveBeenCalledWith({
      cluster: "c032",
      range: "30d",
      nowMs: expect.any(Number),
    });
  });

  it("accepts five minutes for a saved cluster and keeps the response bounded", async () => {
    query.mockResolvedValue(result("5m"));

    const response = await client.get({ cluster: "c032", range: "5m" });

    expect(response).toMatchObject({ cluster: "c032", range: "5m" });
    expect(response.points).toHaveLength(300);
    expect(response.points.length).toBeLessThanOrEqual(360);
    expect(query).toHaveBeenCalledWith({
      cluster: "c032",
      range: "5m",
      nowMs: expect.any(Number),
    });
  });

  it("does not accept a caller-supplied host, URL, or path", async () => {
    await expect(
      client.get({
        cluster: "c032",
        range: "15m",
        host: "http://attacker.example:8000/metrics",
      } as never),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("returns an unavailable result when the history store cannot be read", async () => {
    query.mockRejectedValue(new Error("disk unavailable"));

    const response = await client.get({ cluster: "c032", range: "15m" });

    expect(response).toMatchObject({ cluster: "c032", range: "15m", state: "unavailable" });
    expect(response.points).toHaveLength(180);
  });

  it("returns 300 unavailable five-minute points when the history store cannot be read", async () => {
    query.mockRejectedValue(new Error("disk unavailable"));

    const response = await client.get({ cluster: "c032", range: "5m" });

    expect(response).toMatchObject({ cluster: "c032", range: "5m", state: "unavailable" });
    expect(response.points).toHaveLength(300);
    expect(response.points.every((point) => point.tokensPerSecond === null)).toBe(true);
  });
});
