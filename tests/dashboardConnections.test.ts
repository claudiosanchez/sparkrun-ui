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
