import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DashboardLive } from "@/app/components/dashboard/DashboardLive";
import { ClusterStatusSchema } from "@/lib/schemas";

it("keeps the existing overview above the added reactor fleet and workload section", () => {
  const html = renderToStaticMarkup(
    createElement(DashboardLive, {
      clusters: [{ name: "lab", hosts: ["127.0.0.1"], is_default: true }],
      initialStatuses: { lab: ClusterStatusSchema.parse({ host_count: 1 }) },
      recipeByCluster: new Map(),
    }),
  );
  expect(html).toContain("Cluster overview");
  expect(html).toContain('aria-label="Saved cluster fleet"');
  expect(html).toContain("GPU utilization");
  expect(html).toContain(">Workloads</h2>");
  expect(html.indexOf("Cluster overview")).toBeLessThan(
    html.indexOf('aria-label="Saved cluster fleet"'),
  );
  expect(html.indexOf('aria-label="Saved cluster fleet"')).toBeLessThan(
    html.indexOf(">Workloads</h2>"),
  );
});

it("renders every saved cluster in a separate overview section", () => {
  const clusters = ["alpha", "beta", "gamma"].map((name, index) => ({
    name,
    hosts: [`10.0.0.${index + 1}`],
    is_default: index === 0,
  }));
  const html = renderToStaticMarkup(
    createElement(DashboardLive, {
      clusters,
      initialStatuses: Object.fromEntries(
        clusters.map((cluster) => [cluster.name, ClusterStatusSchema.parse({ host_count: 1 })]),
      ),
      recipeByCluster: new Map(),
    }),
  );

  expect(html).toContain('aria-label="Saved cluster overview"');
  for (const name of ["alpha", "beta", "gamma"]) expect(html).toContain(name);
  expect(html.indexOf("Cluster overview")).toBeLessThan(
    html.indexOf('aria-label="Saved cluster overview"'),
  );
  expect(html.indexOf('aria-label="Saved cluster overview"')).toBeLessThan(
    html.indexOf('aria-label="Saved cluster fleet"'),
  );
  expect(html.indexOf('aria-label="Saved cluster fleet"')).toBeLessThan(
    html.indexOf(">Workloads</h2>"),
  );
});
