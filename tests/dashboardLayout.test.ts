import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DashboardLive } from "@/app/components/dashboard/DashboardLive";
import { ClusterOverviewSection } from "@/app/components/dashboard/ClusterOverviewSection";
import { ClusterStatusSchema } from "@/lib/schemas";
import { ReactorRings } from "@/app/components/dashboard/ReactorRings";
import type { ReactorState } from "@/lib/reactorState";

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

it("places token throughput history after the fleet for every saved cluster", () => {
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
  const overviewIndex = html.indexOf('aria-label="Saved cluster overview"');
  const fleetIndex = html.indexOf('aria-label="Saved cluster fleet"');
  const historyIndex = html.indexOf('aria-label="Token throughput history"');
  const workloadsIndex = html.indexOf(">Workloads</h2>");

  expect(overviewIndex).toBeGreaterThanOrEqual(0);
  expect(fleetIndex).toBeGreaterThan(overviewIndex);
  expect(historyIndex).toBeGreaterThan(fleetIndex);
  expect(workloadsIndex).toBeGreaterThan(historyIndex);
  const historyHtml = html.slice(historyIndex, workloadsIndex);
  for (const name of ["alpha", "beta", "gamma"]) expect(historyHtml).toContain(name);
  expect(historyHtml).toContain('class="grid grid-cols-1 gap-4 lg:grid-cols-2"');
});

it("renders the aggregate overview metric treatment for every saved cluster, including a third", () => {
  const clusters = ["alpha", "beta", "gamma"].map((name, index) => ({
    name,
    hosts: [`10.0.0.${index + 1}`],
    is_default: index === 0,
  }));
  const html = renderToStaticMarkup(createElement(ClusterOverviewSection, { clusters }));

  for (const name of ["alpha", "beta", "gamma"]) expect(html).toContain(`>${name}<`);
  for (const label of ["CPU", "GPU", "Memory", "Power", "Temps"]) {
    expect(html.match(new RegExp(`>${label}<`, "g")) ?? []).toHaveLength(3);
  }
});

it("stacks saved-cluster overview cards vertically at every viewport width", () => {
  const html = renderToStaticMarkup(
    createElement(ClusterOverviewSection, {
      clusters: [
        { name: "alpha", hosts: ["10.0.0.1"], is_default: true },
        { name: "beta", hosts: ["10.0.0.2"], is_default: false },
      ],
    }),
  );

  expect(html).toContain('class="grid grid-cols-1 gap-4"');
  expect(html).not.toContain("md:grid-cols-");
  expect(html).not.toContain("xl:grid-cols-");
});

it("renders three accessible rings and honest inference fields", () => {
  const html = renderToStaticMarkup(
    createElement(DashboardLive, {
      clusters: [{ name: "lab", hosts: ["127.0.0.1"], is_default: true }],
      initialStatuses: { lab: ClusterStatusSchema.parse({ host_count: 1 }) },
      recipeByCluster: new Map(),
    }),
  );
  for (const label of [
    "Total unified memory",
    "KV cache occupancy",
    "GPU compute utilization",
    "Tokens / sec",
    "Clients",
    "Sessions",
    "Running",
    "Queued",
  ]) {
    expect(html).toContain(label);
  }
  expect(html.match(/role="progressbar"/g) ?? []).toHaveLength(3);
  expect(html).toContain("Client and session counts are not collected");
});

it("preserves zero and renders unavailable KV without a numeric value", () => {
  const rings: ReactorState["rings"] = {
    memory: {
      label: "Total unified memory",
      percent: 0,
      detail: "0.0 / 128.0 GB",
      source: "sparkrun-monitor",
    },
    kv: {
      label: "KV cache occupancy",
      percent: null,
      detail: "Capacity not reported",
      source: "vllm-metrics",
      state: "unavailable",
    },
    gpu: {
      label: "GPU compute utilization",
      percent: 0,
      detail: "0.0%",
      source: "sparkrun-monitor",
    },
  };
  const inference: ReactorState["inference"] = {
    state: "live",
    stateText: "Tokens per second live",
    tokensPerSecond: 0,
    tokensPerSecondText: "0.0",
    runningText: "0",
    queuedText: "0",
    clientsText: "—",
    sessionsText: "—",
  };
  const html = renderToStaticMarkup(
    createElement(ReactorRings, { rings, inference, modelText: "qwen" }),
  );
  expect(html).toContain('aria-valuenow="0"');
  expect(html).toContain('aria-valuetext="Not reported"');
  expect(html).not.toContain('aria-valuenow="37.5"');
});

it("marks a numeric stale KV value in visible and accessible ring text", () => {
  const rings: ReactorState["rings"] = {
    memory: {
      label: "Total unified memory",
      percent: 50,
      detail: "64.0 / 128.0 GB",
      source: "sparkrun-monitor",
    },
    kv: {
      label: "KV cache occupancy",
      percent: 42,
      detail: "Capacity not reported",
      source: "vllm-metrics",
      state: "stale",
    },
    gpu: {
      label: "GPU compute utilization",
      percent: 70,
      detail: "Compute load",
      source: "sparkrun-monitor",
    },
  };
  const inference: ReactorState["inference"] = {
    state: "unavailable",
    stateText: "Tokens per second unavailable",
    tokensPerSecond: null,
    tokensPerSecondText: "—",
    runningText: "—",
    queuedText: "—",
    clientsText: "—",
    sessionsText: "—",
  };
  const html = renderToStaticMarkup(
    createElement(ReactorRings, { rings, inference, modelText: "qwen" }),
  );

  expect(html).toContain("42.0% · stale");
  expect(html).toContain('aria-valuetext="42.0% · stale"');
});
