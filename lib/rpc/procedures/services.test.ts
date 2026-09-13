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
    expect(runSparkrunJson).toHaveBeenCalledWith(["cluster", "list", "--json"]);
    expect(fetch).toHaveBeenCalledWith("http://100.83.161.109:8000/v1/models", {
      signal: expect.any(AbortSignal),
    });
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
