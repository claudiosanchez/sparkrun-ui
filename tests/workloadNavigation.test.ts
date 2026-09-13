import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkloadCard } from "@/app/components/dashboard/WorkloadCard";

const workload = {
  cluster_id: "secondary_workload",
  host: "100.83.161.109",
  meta: { port: 8000, model: "secondary-model", overrides: {} },
};

describe("workload navigation", () => {
  it("keeps a non-default saved cluster in the Chat and Logs links", () => {
    const html = renderToStaticMarkup(createElement(WorkloadCard, { workload, cluster: "c458" }));
    expect(html).toContain('href="/chat?clusterId=secondary_workload&amp;cluster=c458"');
    expect(html).toContain('href="/logs/secondary_workload?cluster=c458"');
  });

  it("preserves links with no explicit saved cluster", () => {
    const html = renderToStaticMarkup(createElement(WorkloadCard, { workload }));
    expect(html).toContain('href="/chat?clusterId=secondary_workload"');
    expect(html).toContain('href="/logs/secondary_workload"');
  });
});
