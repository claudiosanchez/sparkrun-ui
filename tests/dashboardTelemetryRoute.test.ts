import { afterEach, describe, expect, it } from "vitest";
import {
  getProductionDashboardTelemetryBroker,
  resetProductionDashboardTelemetryBroker,
} from "@/lib/dashboardTelemetry";
import { POST, withSseDeliveryHeaders } from "@/app/rpc/[[...rest]]/route";

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for SSE data")), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(() => {
  resetProductionDashboardTelemetryBroker();
});

describe("dashboard telemetry RPC route", () => {
  it("adds SSE delivery headers and keeps the original body, status, and status text", () => {
    const body = new ReadableStream<Uint8Array>();
    const source = new Response(body, {
      status: 202,
      statusText: "Streaming",
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });

    const response = withSseDeliveryHeaders(source);

    expect(response).not.toBe(source);
    expect(response.body).toBe(body);
    expect(response.status).toBe(202);
    expect(response.statusText).toBe("Streaming");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("leaves a normal response unchanged", () => {
    const source = Response.json({ ok: true }, { status: 201 });

    expect(withSseDeliveryHeaders(source)).toBe(source);
    expect(source.headers.get("x-accel-buffering")).toBeNull();
  });

  it("serves the typed oRPC stream as cancellable SSE", async () => {
    const broker = getProductionDashboardTelemetryBroker();
    const response = await POST(
      new Request("http://localhost/rpc/telemetry/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(broker.activeSubscriptionCount).toBe(1);

    const reader = response.body!.getReader();
    broker.publish({
      topic: "token-history",
      cluster: "c032",
      observedAtMs: 30_000,
      payload: {
        atMs: 30_000,
        cluster: "c032",
        fingerprint: "fingerprint-c032",
        tokensPerSecond: 12,
      },
    });
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes('"topic":"token-history"')) {
      const chunk = await readChunk(reader);
      expect(chunk.done).toBe(false);
      received += decoder.decode(chunk.value, { stream: true });
    }
    expect(received.startsWith(":")).toBe(true);

    await reader.cancel();
    expect(broker.activeSubscriptionCount).toBe(0);
  });

  it("does not add SSE headers to an unknown RPC response", async () => {
    const response = await POST(
      new Request("http://localhost/rpc/not-a-procedure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("x-accel-buffering")).toBeNull();
    expect(response.headers.get("cache-control")).not.toBe("no-cache, no-store, no-transform");
  });
});
