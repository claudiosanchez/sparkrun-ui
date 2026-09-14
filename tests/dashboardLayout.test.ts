import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DashboardLive } from "@/app/components/dashboard/DashboardLive";
import { ClusterOverviewSection } from "@/app/components/dashboard/ClusterOverviewSection";
import { ClusterStatusSchema } from "@/lib/schemas";
import { ReactorRings } from "@/app/components/dashboard/ReactorRings";
import type { ReactorState } from "@/lib/reactorState";

function semanticRings(overrides: Partial<ReactorState["rings"]> = {}): ReactorState["rings"] {
  return {
    kv: {
      label: "KV cache occupancy",
      percent: 37.5,
      status: "Headroom",
      tone: "success",
      state: "live",
      detail: "3.17M cache-token capacity",
      source: "vllm-metrics",
    },
    active: {
      label: "Active request capacity",
      percent: 25,
      status: "Serving",
      tone: "info",
      state: "live",
      detail: "1 / 4 safe requests",
      source: "vllm-metrics",
    },
    queue: {
      label: "Queue pressure",
      percent: 0,
      status: "Clear",
      tone: "success",
      state: "live",
      detail: "0 / 8 queued-request budget",
      source: "vllm-metrics",
    },
    ...overrides,
  };
}

const inference: ReactorState["inference"] = {
  state: "live",
  stateText: "Tokens per second live",
  tokensPerSecond: 42.6,
  tokensPerSecondText: "42.6",
  runningText: "1",
  queuedText: "0",
  clientsText: "—",
  sessionsText: "—",
};

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
  expect(html).toContain("Unified memory");
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
  expect(historyHtml).toContain('role="tablist" aria-label="Token throughput range"');
  expect(historyHtml.match(/role="tab"/g) ?? []).toHaveLength(5);
  for (const range of ["5m", "15m", "1d", "7d", "30d"]) {
    expect(historyHtml).toContain(`>${range}`);
  }
  expect(historyHtml).toContain('id="token-history-tab-5m"');
  expect(historyHtml).toMatch(/id="token-history-tab-5m"[^>]*aria-selected="true"[^>]*>5m/);
  expect(historyHtml).toContain('aria-selected="true"');
  expect(historyHtml).toContain('role="tabpanel"');
  expect(historyHtml).toContain('aria-labelledby="token-history-tab-5m"');
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

it("renders semantic pressure rings without a memory or GPU ring", () => {
  const html = renderToStaticMarkup(
    createElement(ReactorRings, {
      rings: semanticRings({
        kv: {
          label: "KV cache occupancy",
          percent: 78,
          status: "Watch",
          tone: "warning",
          state: "live",
          detail: "3.17M cache-token capacity",
          source: "vllm-metrics",
        },
      }),
      inference,
    }),
  );
  for (const label of ["KV cache occupancy", "Active request capacity", "Queue pressure"]) {
    expect(html).toContain(label);
  }
  expect(html).not.toContain("Total unified memory");
  expect(html).not.toContain("GPU compute utilization");
  expect(html.match(/role="progressbar"/g) ?? []).toHaveLength(3);
  expect(html).toContain('aria-valuetext="78.0% · Watch"');
  expect(html).toContain('stroke-dasharray="78 100"');
});

it("renders a target-not-set ring without an aria value", () => {
  const html = renderToStaticMarkup(
    createElement(ReactorRings, {
      rings: semanticRings({
        active: {
          label: "Active request capacity",
          percent: null,
          status: "Target not set",
          tone: "neutral",
          state: "unavailable",
          detail: "Safe request target not set",
          source: "vllm-metrics",
        },
      }),
      inference,
    }),
  );
  expect(html).toContain("Target not set");
  expect(html).toContain('aria-valuetext="Target not set"');
  const activeRing = html.match(/<circle[^>]*aria-label="Active request capacity"[^>]*>/)?.[0];
  expect(activeRing).toBeDefined();
  expect(activeRing).not.toContain("aria-valuenow");
});

it("retains an over-capacity percentage in legend and accessible text", () => {
  const html = renderToStaticMarkup(
    createElement(ReactorRings, {
      rings: semanticRings({
        active: {
          label: "Active request capacity",
          percent: 125,
          status: "Over capacity",
          tone: "critical",
          state: "live",
          detail: "5 / 4 safe requests",
          source: "vllm-metrics",
        },
      }),
      inference,
    }),
  );
  expect(html).toContain("125.0% · Over capacity");
  expect(html).toContain('aria-valuetext="125.0% · Over capacity"');
  expect(html).toContain('aria-valuenow="100"');
  expect(html).toContain('stroke-dasharray="100 100"');
});

it("marks a numeric stale ring in visible and accessible text", () => {
  const html = renderToStaticMarkup(
    createElement(ReactorRings, {
      rings: semanticRings({
        kv: {
          label: "KV cache occupancy",
          percent: 42,
          status: "Stale",
          tone: "neutral",
          state: "stale",
          detail: "Capacity not reported",
          source: "vllm-metrics",
        },
      }),
      inference,
    }),
  );
  expect(html).toContain("42.0% · Stale");
  expect(html).toContain('aria-valuetext="42.0% · Stale"');
  expect(html).toContain("bg-zinc-500");
});

it("keeps a supplied model name out of the reactor center readout", () => {
  const props = {
    rings: semanticRings(),
    inference,
    modelText: "model-name-that-must-not-appear",
  } as unknown as ComponentProps<typeof ReactorRings>;
  const html = renderToStaticMarkup(createElement(ReactorRings, props));

  expect(html).not.toContain("model-name-that-must-not-appear");
  expect(html).toContain(">42.6<");
  expect(html).toContain("Tokens / sec");
});

it("keeps the existing request facts below the rings", () => {
  const html = renderToStaticMarkup(
    createElement(ReactorRings, { rings: semanticRings(), inference }),
  );
  for (const label of ["Clients", "Sessions", "Running", "Queued"]) {
    expect(html).toContain(label);
  }
  expect(html).toContain("Client and session counts are not collected");
});
