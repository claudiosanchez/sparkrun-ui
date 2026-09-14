import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const dashboardRoot = resolve(process.cwd(), "app/components/dashboard");
const headerStatsPath = resolve(process.cwd(), "app/components/HeaderStats.tsx");

it("keeps overview and fleet cards free of direct monitor owners", () => {
  const overview = readFileSync(resolve(dashboardRoot, "ClusterOverviewCard.tsx"), "utf8");
  const fleetCard = readFileSync(resolve(dashboardRoot, "ReactorCard.tsx"), "utf8");

  expect(overview).not.toContain("rpc.monitor.stream");
  expect(fleetCard).not.toContain("useReactor(");
});

it("owns one same-origin dashboard stream and no per-cluster dashboard streams", () => {
  const provider = readFileSync(resolve(dashboardRoot, "DashboardTelemetryProvider.tsx"), "utf8");
  const hook = readFileSync(resolve(dashboardRoot, "useReactor.ts"), "utf8");
  const aggregate = readFileSync(resolve(dashboardRoot, "AggregateStats.tsx"), "utf8");
  const live = readFileSync(resolve(dashboardRoot, "DashboardLive.tsx"), "utf8");

  expect((provider.match(/rpc\.telemetry\.stream/g) ?? []).length).toBe(1);
  expect(live.match(/<DashboardTelemetryProvider/g)).toHaveLength(1);
  expect(hook).not.toContain("rpc.status.stream");
  expect(hook).not.toContain("rpc.monitor.stream");
  expect(hook).not.toContain("rpc.vllmMetrics.stream");
  expect(hook).not.toContain("rpc.services.health");
  expect(aggregate).not.toContain("rpc.monitor.stream");
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
