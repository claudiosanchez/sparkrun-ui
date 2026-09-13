import { createRouterClient } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterStatusSchema } from "@/lib/schemas";
import { runSparkrunJson, streamSparkrunLines } from "@/lib/sparkrun";
import { health } from "./workloads";
import { stream as logs } from "./logs";
import { stream as chat } from "./chat";

vi.mock("@/lib/sparkrun", () => ({
  runSparkrun: vi.fn(),
  runSparkrunJson: vi.fn(),
  streamSparkrunLines: vi.fn(),
}));

const client = createRouterClient({ health, logs, chat }, { context: {} });
const workload = {
  cluster_id: "secondary_workload",
  host: "100.83.161.109",
  meta: { port: 8000, hosts: ["100.83.161.109"], overrides: {} },
};
const populated = ClusterStatusSchema.parse({
  solo_entries: [workload],
  total_containers: 1,
  host_count: 1,
});
const empty = ClusterStatusSchema.parse({});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runSparkrunJson).mockImplementation(async (args) =>
    args.includes("--cluster") && args.includes("c458") ? populated : empty,
  );
  vi.mocked(streamSparkrunLines).mockImplementation(async function* () {
    yield "Model ready";
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/health")) return new Response("OK");
      if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "secondary-model" }] });
      return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n');
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe.each([
  { label: "a workload present only in a non-default saved cluster", cluster: "c458" },
  { label: "the existing default-cluster flow", cluster: undefined },
])("workload controls for $label", ({ cluster }) => {
  beforeEach(() => {
    if (!cluster) vi.mocked(runSparkrunJson).mockResolvedValue(populated);
  });

  it("probes the selected workload's health", async () => {
    const result = await client.health({ clusterId: workload.cluster_id, cluster });
    expect(result).toEqual({ ready: true, state: "ready" });
    expect(fetch).toHaveBeenCalledWith("http://100.83.161.109:8000/health", {
      signal: expect.any(AbortSignal),
    });
    expect(runSparkrunJson).toHaveBeenCalledWith(
      cluster
        ? ["cluster", "status", "--cluster", "c458", "--json"]
        : ["cluster", "status", "--json"],
    );
  });

  it("attaches logs using the selected workload's hosts", async () => {
    const events = [];
    for await (const event of await client.logs({ clusterId: workload.cluster_id, cluster }))
      events.push(event);
    expect(events.map((event) => event.line)).toEqual([
      "[meta] attaching to secondary_workload on 100.83.161.109 (tail=200)",
      "Model ready",
    ]);
    expect(streamSparkrunLines).toHaveBeenCalledWith(
      ["logs", "secondary_workload", "--hosts", "100.83.161.109", "--tail", "200"],
      expect.objectContaining({ includeStderr: true }),
    );
  });

  it("streams chat from the selected workload's model endpoint", async () => {
    const tokens = [];
    for await (const token of await client.chat({
      clusterId: workload.cluster_id,
      cluster,
      messages: [{ role: "user", content: "Hi" }],
    }))
      tokens.push(token);
    expect(tokens).toEqual(["Hello"]);
    expect(fetch).toHaveBeenCalledWith(
      "http://100.83.161.109:8000/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "secondary-model",
          messages: [{ role: "user", content: "Hi" }],
          stream: true,
          max_tokens: 2048,
        }),
      }),
    );
  });
});

it("does not probe a non-default workload through an unrelated saved cluster", async () => {
  expect(await client.health({ clusterId: workload.cluster_id, cluster: "other" })).toMatchObject({
    ready: false,
    state: "not_found",
  });
  expect(fetch).not.toHaveBeenCalled();
});
