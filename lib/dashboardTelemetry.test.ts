import { describe, expect, it } from "vitest";
import {
  DashboardTelemetryEventSchema,
  createDashboardTelemetryBroker,
} from "./dashboardTelemetry";

function vllmPayload(cluster: string, tokensPerSecond: number) {
  const observedAtMs = 10_000;
  return {
    cluster,
    polledAtMs: observedAtMs,
    sourceHost: `${cluster}.local`,
    state: "live" as const,
    error: null,
    metrics: {
      tokensPerSecond: { value: tokensPerSecond, state: "live" as const, observedAtMs },
      runningRequests: { value: 1, state: "live" as const, observedAtMs },
      waitingRequests: { value: 0, state: "live" as const, observedAtMs },
      kvCachePercent: { value: 25, state: "live" as const, observedAtMs },
    },
  };
}

function publishVllm(
  broker: ReturnType<typeof createDashboardTelemetryBroker>,
  cluster: string,
  tokensPerSecond: number,
) {
  return broker.publish({
    topic: "vllm",
    cluster,
    observedAtMs: 10_000,
    payload: vllmPayload(cluster, tokensPerSecond),
  });
}

describe("DashboardTelemetryEventSchema", () => {
  it("validates every v1 dashboard topic and requires clusters only on cluster topics", () => {
    const common = { version: 1 as const, revision: 1, observedAtMs: 10_000 };
    const monitor = { timestamp: 10_000, hosts: [] };
    const status = {
      groups: {},
      solo_entries: [],
      idle_hosts: [],
      pending_ops: [],
      errors: {},
      total_containers: 0,
      host_count: 0,
    };

    const events = [
      { ...common, topic: "vllm", cluster: "c032", payload: vllmPayload("c032", 12) },
      { ...common, topic: "monitor", cluster: "c032", payload: monitor },
      { ...common, topic: "overview-monitor", payload: monitor },
      { ...common, topic: "status", cluster: "c032", payload: status },
      {
        ...common,
        topic: "service",
        cluster: "c032",
        payload: { cluster: "c032", host: "c032.local", state: "ready", model: "model-a" },
      },
    ];

    for (const event of events) {
      expect(DashboardTelemetryEventSchema.parse(event)).toEqual(event);
    }
    expect(() =>
      DashboardTelemetryEventSchema.parse({
        ...common,
        topic: "status",
        payload: status,
      }),
    ).toThrow();
    expect(() =>
      DashboardTelemetryEventSchema.parse({
        ...common,
        topic: "overview-monitor",
        cluster: "c032",
        payload: monitor,
      }),
    ).toThrow();
  });
});

describe("dashboard telemetry broker", () => {
  it("coalesces only the latest pending event for the same topic and cluster", async () => {
    const broker = createDashboardTelemetryBroker();
    const subscription = broker.subscribe();

    publishVllm(broker, "c032", 10);
    const latest = publishVllm(broker, "c032", 20);

    await expect(subscription.next()).resolves.toEqual({ value: latest, done: false });
    await subscription.return();
  });

  it("keeps pending events for distinct clusters instead of using one global slot", async () => {
    const broker = createDashboardTelemetryBroker();
    const subscription = broker.subscribe();

    const c032 = publishVllm(broker, "c032", 10);
    const c458 = publishVllm(broker, "c458", 20);

    await expect(subscription.next()).resolves.toEqual({ value: c032, done: false });
    await expect(subscription.next()).resolves.toEqual({ value: c458, done: false });
    await subscription.return();
  });

  it("delivers cached events before later live events", async () => {
    const broker = createDashboardTelemetryBroker();
    const c032 = publishVllm(broker, "c032", 10);
    const c458 = publishVllm(broker, "c458", 20);
    const subscription = broker.subscribe();
    const overview = broker.publish({
      topic: "overview-monitor",
      observedAtMs: 10_001,
      payload: { timestamp: 10_001, hosts: [] },
    });

    await expect(subscription.next()).resolves.toEqual({ value: c032, done: false });
    await expect(subscription.next()).resolves.toEqual({ value: c458, done: false });
    await expect(subscription.next()).resolves.toEqual({ value: overview, done: false });
    await subscription.return();
  });

  it("does not let a same-key live event replace the cached first event", async () => {
    const broker = createDashboardTelemetryBroker();
    const cached = publishVllm(broker, "c032", 10);
    const subscription = broker.subscribe();
    const live = publishVllm(broker, "c032", 20);

    await expect(subscription.next()).resolves.toEqual({ value: cached, done: false });
    await expect(subscription.next()).resolves.toEqual({ value: live, done: false });
    await subscription.return();
  });

  it("assigns increasing process-local revisions and does not leak payload mutations", async () => {
    const broker = createDashboardTelemetryBroker();
    const input = {
      topic: "vllm" as const,
      cluster: "c032",
      observedAtMs: 10_000,
      payload: vllmPayload("c032", 10),
    };
    const first = broker.publish(input);
    input.payload.metrics.tokensPerSecond.value = 999;

    const firstSubscription = broker.subscribe();
    const firstRead = await firstSubscription.next();
    if (!firstRead.done && firstRead.value.topic === "vllm") {
      firstRead.value.payload.metrics.tokensPerSecond.value = 777;
    }
    const secondSubscription = broker.subscribe();
    const secondRead = await secondSubscription.next();
    const second = publishVllm(broker, "c032", 20);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(secondRead.value).toMatchObject({
      revision: 1,
      payload: { metrics: { tokensPerSecond: { value: 10 } } },
    });
    await firstSubscription.return();
    await secondSubscription.return();
  });

  it("closes idempotently, unblocks a waiting read, and removes the listener", async () => {
    const broker = createDashboardTelemetryBroker();
    const subscription = broker.subscribe();
    const pending = subscription.next();

    expect(broker.activeSubscriptionCount).toBe(1);
    subscription.close();
    subscription.close();

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    await expect(subscription.next()).resolves.toEqual({ value: undefined, done: true });
    expect(broker.activeSubscriptionCount).toBe(0);
  });

  it("aborts a waiting read and cleans up the broker subscription", async () => {
    const broker = createDashboardTelemetryBroker();
    const controller = new AbortController();
    const subscription = broker.subscribe(controller.signal);
    const pending = subscription.next();

    controller.abort();

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(broker.activeSubscriptionCount).toBe(0);
    await expect(subscription.return()).resolves.toEqual({ value: undefined, done: true });
  });
});
