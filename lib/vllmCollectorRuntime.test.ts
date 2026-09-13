import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSparkrunJson } from "./sparkrun";
import {
  getProductionVllmCollectorRuntime,
  resetProductionVllmCollectorRuntime,
} from "./vllmCollectorRuntime";

vi.mock("./sparkrun", () => ({ runSparkrunJson: vi.fn() }));

afterEach(() => {
  resetProductionVllmCollectorRuntime();
});

beforeEach(() => {
  vi.mocked(runSparkrunJson).mockReset();
});

describe("production vLLM collector runtime", () => {
  it("uses one process-global registry and store", () => {
    const first = getProductionVllmCollectorRuntime();
    const second = getProductionVllmCollectorRuntime();

    expect(second).toBe(first);
    expect(second.registry).toBe(first.registry);
    expect(second.store).toBe(first.store);
  });

  it("uses an application data directory separate from Sparkrun cache by default", () => {
    const runtime = getProductionVllmCollectorRuntime();

    expect(runtime.dataDir).not.toContain(".cache/sparkrun/");
    expect(runtime.dataDir).toContain("sparkrun-ui");
    expect(runtime.dataDir).toContain("telemetry");
  });

  it("normalizes both current and legacy saved-cluster default fields", async () => {
    vi.mocked(runSparkrunJson).mockResolvedValue([
      { name: "legacy", hosts: ["host-a"], default: true },
      { name: "current", hosts: ["host-b"], is_default: true },
    ]);

    const clusters = await getProductionVllmCollectorRuntime().listSavedClusters(
      new AbortController().signal,
    );

    expect(clusters).toEqual([
      { name: "legacy", hosts: ["host-a"], is_default: true },
      { name: "current", hosts: ["host-b"], is_default: true },
    ]);
    expect(runSparkrunJson).toHaveBeenCalledWith(["cluster", "list", "--json"], {
      signal: expect.any(AbortSignal),
      timeoutMs: 3_000,
    });
  });
});
