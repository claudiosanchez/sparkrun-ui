import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

const successfulResponse = {
  json: {
    cluster: "c032",
    fingerprint: "fingerprint",
    latestObservationAtMs: 11_000,
    range: "15m",
    fromMs: 1_000,
    toMs: 11_000,
    resolutionMs: 5_000,
    state: "ready",
    coverage: 1,
    points: [{ atMs: 1_000, tokensPerSecond: 12.5 }],
  },
  meta: [],
  maps: [],
};

beforeEach(() => {
  vi.resetModules();
});

it("pins token history to the server-supported POST transport", async () => {
  const source = readFileSync(new URL("../lib/rpc/client.ts", import.meta.url), "utf8");
  expect(source).toContain('method: "POST"');

  const requests: Request[] = [];
  vi.stubGlobal("window", { location: { origin: "http://dashboard.example" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request);
      return new Response(JSON.stringify(successfulResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  const { rpc } = await import("@/lib/rpc/client");
  await rpc.tokenHistory.get({ cluster: "c032", range: "15m" });

  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe("POST");
  expect(new URL(requests[0].url).pathname).toBe("/rpc/tokenHistory/get");
  await expect(requests[0].json()).resolves.toEqual({
    json: { cluster: "c032", range: "15m" },
  });
});
