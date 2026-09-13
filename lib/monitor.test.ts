import { describe, expect, it } from "vitest";
import { MonitorTickSchema, monitorHostViews, numberMetric } from "./monitor";

describe("monitorHostViews", () => {
  it("keeps a valid C458 sample keyed by its reported host", () => {
    const tick = MonitorTickSchema.parse({
      timestamp: 1,
      hosts: [{ host: "100.83.161.109", error: null, sample: { gpu_util_pct: "0" } }],
    });
    expect(monitorHostViews(tick)["100.83.161.109"].sample?.gpu_util_pct).toBe("0");
  });

  it("keeps an empty GPU-memory value unavailable", () => {
    expect(numberMetric("")).toBeNull();
  });

  it("keeps the monitor host error instead of inventing metrics", () => {
    const tick = MonitorTickSchema.parse({
      timestamp: 1,
      hosts: [{ host: "100.83.161.109", error: "Permission denied", sample: null }],
    });
    expect(monitorHostViews(tick)["100.83.161.109"]).toMatchObject({
      error: "Permission denied",
      sample: null,
    });
  });
});
