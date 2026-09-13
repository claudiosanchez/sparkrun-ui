import { describe, expect, it } from "vitest";
import { MonitorTickSchema, monitorHostViews, numberMetric } from "./monitor";

const twoHostTick = MonitorTickSchema.parse({
  timestamp: 1,
  hosts: [
    { host: "100.65.40.24", error: null, sample: { gpu_util_pct: "50", gpu_temp_c: "60" } },
    { host: "100.83.161.109", error: null, sample: { gpu_util_pct: "80", gpu_temp_c: "70" } },
  ],
});

describe("monitorHostViews", () => {
  it("keeps a valid C458 sample keyed by its reported host", () => {
    const tick = MonitorTickSchema.parse({
      timestamp: 1,
      hosts: [{ host: "100.83.161.109", error: null, sample: { gpu_util_pct: "0" } }],
    });
    expect(monitorHostViews(tick)["100.83.161.109"].sample?.gpu_util_pct).toBe("0");
  });

  it("returns both host samples from one array tick", () => {
    const views = monitorHostViews(twoHostTick);
    expect(Object.keys(views)).toEqual(["100.65.40.24", "100.83.161.109"]);
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
