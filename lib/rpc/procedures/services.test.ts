import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healthForCluster } from "./services";
import { runSparkrunJson } from "@/lib/sparkrun";

vi.mock("@/lib/sparkrun", () => ({
  runSparkrunJson: vi.fn(),
}));

describe("healthForCluster", () => {
  const savedC458 = [{ name: "c458", hosts: ["100.83.161.109"] }];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.mocked(runSparkrunJson).mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it("returns health for a cluster with a valid host", async () => {
    vi.mocked(runSparkrunJson).mockResolvedValue(savedC458);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ model: "qwen" }] }),
    } as Response);

    const result = await healthForCluster("c458");

    expect(result).toEqual({
      cluster: "c458",
      host: "100.83.161.109",
      state: "ready",
      model: "qwen",
    });
    const discoveryCall = vi.mocked(runSparkrunJson).mock.calls[0];
    expect(discoveryCall[0]).toEqual(["cluster", "list", "--json"]);
    expect(discoveryCall[1]).toEqual({ signal: expect.any(AbortSignal), timeoutMs: 3_000 });
    const discoverySignal = (discoveryCall[1] as { signal: AbortSignal }).signal;
    expect(fetch).toHaveBeenCalledWith("http://100.83.161.109:8000/v1/models", {
      signal: discoverySignal,
    });
  });

  it("combines the caller abort signal with the health deadline", async () => {
    const caller = new AbortController();
    vi.mocked(runSparkrunJson).mockResolvedValue(savedC458);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "qwen" }] }),
    } as Response);

    await healthForCluster("c458", caller.signal);

    const discoveryOptions = vi.mocked(runSparkrunJson).mock.calls[0][1] as {
      signal: AbortSignal;
      timeoutMs: number;
    };
    expect(discoveryOptions.timeoutMs).toBe(3_000);
    expect(discoveryOptions.signal).not.toBe(caller.signal);
    expect(discoveryOptions.signal.aborted).toBe(false);
  });

  it("returns unavailable when cluster not found", async () => {
    vi.mocked(runSparkrunJson).mockResolvedValue([]);

    const result = await healthForCluster("missing");

    expect(result).toEqual({
      cluster: "missing",
      host: null,
      state: "unavailable",
      model: null,
    });
  });

  it("returns unavailable when saved-cluster discovery returns malformed data", async () => {
    vi.mocked(runSparkrunJson).mockResolvedValue({ clusters: savedC458 });

    const result = await healthForCluster("c458");

    expect(result).toEqual({
      cluster: "c458",
      host: null,
      state: "unavailable",
      model: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns unavailable when saved-cluster discovery rejects", async () => {
    vi.mocked(runSparkrunJson).mockRejectedValue(new Error("timed out"));

    const result = await healthForCluster("c458");

    expect(result).toEqual({
      cluster: "c458",
      host: null,
      state: "unavailable",
      model: null,
    });
  });

  it("returns unavailable for empty data array", async () => {
    vi.mocked(runSparkrunJson).mockResolvedValue(savedC458);
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as Response);

    const result = await healthForCluster("c458");

    expect(result).toEqual({
      cluster: "c458",
      host: "100.83.161.109",
      state: "unavailable",
      model: null,
    });
  });

  it("returns unavailable for non-OK response", async () => {
    vi.mocked(runSparkrunJson).mockResolvedValue(savedC458);
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);

    const result = await healthForCluster("c458");

    expect(result).toEqual({
      cluster: "c458",
      host: "100.83.161.109",
      state: "unavailable",
      model: null,
    });
  });

  it("returns unavailable for fetch rejection", async () => {
    vi.mocked(runSparkrunJson).mockResolvedValue(savedC458);
    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

    const result = await healthForCluster("c458");

    expect(result).toEqual({
      cluster: "c458",
      host: "100.83.161.109",
      state: "unavailable",
      model: null,
    });
  });

  it("returns unavailable for abort timeout", async () => {
    vi.mocked(runSparkrunJson).mockResolvedValue(savedC458);
    vi.mocked(fetch).mockRejectedValue(new DOMException("Timed out", "AbortError"));

    const result = await healthForCluster("c458");

    expect(result).toEqual({
      cluster: "c458",
      host: "100.83.161.109",
      state: "unavailable",
      model: null,
    });
  });
});
