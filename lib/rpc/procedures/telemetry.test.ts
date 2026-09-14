import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  getProductionDashboardTelemetryBroker,
  resetProductionDashboardTelemetryBroker,
} from "@/lib/dashboardTelemetry";
import { stream } from "./telemetry";

const client = createRouterClient({ stream }, { context: {} });

afterEach(() => {
  resetProductionDashboardTelemetryBroker();
});

describe("telemetry.stream", () => {
  it.each([
    { host: "c032.local" },
    { url: "http://c032.local:8000/metrics" },
    { intervalMs: 1_000 },
    { cluster: "c032" },
  ])("rejects client-owned source configuration: %o", async (input) => {
    await expect(client.stream(input as never)).rejects.toThrow();
    expect(getProductionDashboardTelemetryBroker().activeSubscriptionCount).toBe(0);
  });

  it("streams typed broker events for the strict empty input", async () => {
    const broker = getProductionDashboardTelemetryBroker();
    const iterator = await client.stream({});
    const event = broker.publish({
      topic: "token-history",
      cluster: "c032",
      observedAtMs: 20_000,
      payload: {
        atMs: 20_000,
        cluster: "c032",
        fingerprint: "fingerprint-c032",
        tokensPerSecond: 12,
      },
    });

    await expect(iterator.next()).resolves.toEqual({ value: event, done: false });
    await iterator.return?.();
  });

  it("aborts a blocked stream and removes its broker listener", async () => {
    const broker = getProductionDashboardTelemetryBroker();
    const controller = new AbortController();
    const iterator = await client.stream({}, { signal: controller.signal });
    const pending = iterator.next();

    expect(broker.activeSubscriptionCount).toBe(1);
    controller.abort();

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(broker.activeSubscriptionCount).toBe(0);
    await iterator.return?.();
  });
});
