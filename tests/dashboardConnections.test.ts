import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const dashboardRoot = resolve(process.cwd(), "app/components/dashboard");

it("keeps one per-cluster monitor owner for the overview and fleet", () => {
  const overview = readFileSync(resolve(dashboardRoot, "ClusterOverviewCard.tsx"), "utf8");
  const fleetCard = readFileSync(resolve(dashboardRoot, "ReactorCard.tsx"), "utf8");

  expect(overview).not.toContain("rpc.monitor.stream");
  expect(fleetCard).not.toContain("useReactor(");
});

it("owns one same-origin vLLM stream through the per-cluster reactor hook", () => {
  const hook = readFileSync(resolve(dashboardRoot, "useReactor.ts"), "utf8");

  expect((hook.match(/rpc\.vllmMetrics\.stream/g) ?? []).length).toBe(1);
  expect(hook).not.toMatch(/https?:\/\/[^"'`]*:8000\/metrics/);
  expect(hook).not.toContain("gpuMemory");
});
