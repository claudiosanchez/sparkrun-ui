import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const dashboardRoot = resolve(process.cwd(), "app/components/dashboard");
const headerStatsPath = resolve(process.cwd(), "app/components/HeaderStats.tsx");

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

it("gates the redundant header monitor stream off on the dashboard route", () => {
  const headerStats = readFileSync(headerStatsPath, "utf8");

  expect(headerStats).toContain('import { usePathname } from "next/navigation";');
  expect(headerStats).toContain("const pathname = usePathname();");
  expect(headerStats).toContain('if (pathname === "/dashboard") return;');
  expect(headerStats).toContain('if (pathname === "/dashboard") return null;');
  expect(headerStats).toContain("}, [pathname]);");
  expect(headerStats).toContain("rpc.monitor.stream");
});
