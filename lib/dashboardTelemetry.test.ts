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
      kvCacheCapacityTokens: { value: 1_000, state: "live" as const, observedAtMs },
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

function tokenHistoryEvent(cluster: string, atMs: number, tokensPerSecond: number | null) {
  return {
    topic: "token-history" as const,
    cluster,
    observedAtMs: atMs,
    payload: {
      atMs,
      cluster,
      fingerprint: `fingerprint-${cluster}`,
      tokensPerSecond,
    },
  };
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
      {
        ...common,
        topic: "token-history-reset",
        cluster: "c032",
        payload: { reason: "topology-change" },
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

  it.each([0, 12.5, null])("accepts a normalized token-history value of %s", (value) => {
    const event = {
      version: 1 as const,
      revision: 1,
      ...tokenHistoryEvent("c032", 10_000, value),
    };

    expect(DashboardTelemetryEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    ["an arbitrary URL", { url: "http://c032.local:8000/metrics" }],
    ["a non-finite observation", { payload: { tokensPerSecond: Number.POSITIVE_INFINITY } }],
    ["a mismatched cluster", { payload: { cluster: "c458" } }],
    ["a mismatched timestamp", { payload: { atMs: 9_999 } }],
    ["an empty fingerprint", { payload: { fingerprint: "" } }],
    ["a negative token rate", { payload: { tokensPerSecond: -1 } }],
  ])("rejects token-history events containing %s", (_name, override) => {
    const base = {
      version: 1 as const,
      revision: 1,
      ...tokenHistoryEvent("c032", 10_000, 12),
    };
    const event = {
      ...base,
      ...override,
      payload: { ...base.payload, ...("payload" in override ? override.payload : {}) },
    };

    expect(() => DashboardTelemetryEventSchema.parse(event)).toThrow();
  });
});

describe("dashboard telemetry broker", () => {
  it("delivers a transient topology transition without caching it for reconnects", async () => {
    const broker = createDashboardTelemetryBroker();
    const active = broker.subscribe();
    const reset = broker.publishTransient({
      topic: "token-history-reset",
      cluster: "c032",
      observedAtMs: 10_000,
      payload: { reason: "topology-change" },
    });

    await expect(active.next()).resolves.toEqual({ value: reset, done: false });

    const replay = broker.subscribe();
    expect(replay.pendingEventCount).toBe(0);

    await active.return();
    await replay.return();
  });

  it("evicts a stale cluster cache entry without dropping other cluster snapshots", async () => {
    const broker = createDashboardTelemetryBroker();
    const c032 = publishVllm(broker, "c032", 10);
    const c458 = publishVllm(broker, "c458", 20);

    (
      broker as typeof broker & {
        evict: (key: { topic: "vllm"; cluster: string }) => void;
      }
    ).evict({ topic: "vllm", cluster: "c032" });

    const subscription = broker.subscribe();
    await expect(subscription.next()).resolves.toEqual({ value: c458, done: false });

    let nextReadSettled = false;
    const nextRead = subscription.next().then((result) => {
      nextReadSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(nextReadSettled).toBe(false);

    await subscription.return();
    await expect(nextRead).resolves.toEqual({ value: undefined, done: true });
    expect(c032.revision).toBe(1);
  });

  it("replays and coalesces the newest token-history event per cluster", async () => {
    const broker = createDashboardTelemetryBroker();
    const queued = broker.subscribe();
    broker.publish(tokenHistoryEvent("c032", 10_000, 0));
    const latestC032 = broker.publish(tokenHistoryEvent("c032", 11_000, 8));
    const latestC458 = broker.publish(tokenHistoryEvent("c458", 11_000, null));

    expect(latestC032.revision).toBe(2);
    expect(latestC458.revision).toBe(3);
    expect(queued.pendingEventCount).toBe(2);
    await expect(queued.next()).resolves.toEqual({ value: latestC032, done: false });
    await expect(queued.next()).resolves.toEqual({ value: latestC458, done: false });

    const controller = new AbortController();
    const replay = broker.subscribe(controller.signal);
    await expect(replay.next()).resolves.toEqual({ value: latestC032, done: false });
    await expect(replay.next()).resolves.toEqual({ value: latestC458, done: false });
    expect(broker.activeSubscriptionCount).toBe(2);
    controller.abort();
    expect(broker.activeSubscriptionCount).toBe(1);

    await queued.return();
  });

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

  it("replaces a cached source with its latest live value without moving other keys", async () => {
    const broker = createDashboardTelemetryBroker();
    publishVllm(broker, "c032", 10);
    const c458 = publishVllm(broker, "c458", 40);
    const controller = new AbortController();
    const subscription = broker.subscribe(controller.signal);
    publishVllm(broker, "c032", 20);
    const latestLive = publishVllm(broker, "c032", 30);

    expect(subscription.pendingEventCount).toBe(2);
    await expect(subscription.next()).resolves.toEqual({ value: latestLive, done: false });
    await expect(subscription.next()).resolves.toEqual({ value: c458, done: false });
    expect(subscription.pendingEventCount).toBe(0);

    let thirdReadSettled = false;
    const thirdRead = subscription.next().then((result) => {
      thirdReadSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(thirdReadSettled).toBe(false);
    controller.abort();
    await expect(thirdRead).resolves.toEqual({ value: undefined, done: true });
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

  it("deeply isolates nested status data from publishers and other subscribers", async () => {
    const broker = createDashboardTelemetryBroker();
    const nested = { value: 1 };
    broker.publish({
      topic: "status",
      cluster: "c032",
      observedAtMs: 10_000,
      payload: {
        groups: { reactor: nested },
        solo_entries: [],
        idle_hosts: [],
        pending_ops: [],
        errors: {},
        total_containers: 0,
        host_count: 1,
      },
    });
    nested.value = 99;

    const firstSubscription = broker.subscribe();
    const secondSubscription = broker.subscribe();
    const first = await firstSubscription.next();
    const second = await secondSubscription.next();
    if (!first.done && first.value.topic === "status" && first.value.payload) {
      (first.value.payload.groups.reactor as { value: number }).value = 777;
    }

    expect(second.value).toMatchObject({
      topic: "status",
      payload: { groups: { reactor: { value: 1 } } },
    });
    await firstSubscription.return();
    await secondSubscription.return();
  });

  it("deeply isolates nested monitor workload data", async () => {
    const broker = createDashboardTelemetryBroker();
    const nested = { value: 1 };
    broker.publish({
      topic: "monitor",
      cluster: "c032",
      observedAtMs: 10_000,
      payload: {
        timestamp: 10_000,
        hosts: [
          {
            host: "c032.local",
            error: null,
            sample: null,
            workloads: [{ details: nested }],
            used_slots: 0,
            free_slots: 1,
          },
        ],
      },
    });
    nested.value = 99;

    const subscription = broker.subscribe();
    const event = await subscription.next();

    expect(event.value).toMatchObject({
      topic: "monitor",
      payload: { hosts: [{ workloads: [{ details: { value: 1 } }] }] },
    });
    await subscription.return();
  });

  it.each([
    [
      "cyclic data",
      () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
    ],
    ["bigint data", () => ({ value: BigInt(1) })],
    ["undefined data", () => ({ value: undefined })],
    ["a Map", () => new Map([["value", 1]])],
    ["a custom toJSON object", () => new Date(0)],
    [
      "a sparse array",
      () => {
        const value: unknown[] = [];
        value.length = 1;
        return value;
      },
    ],
  ])("rejects non-serializable status payloads containing %s", (_name, createValue) => {
    const broker = createDashboardTelemetryBroker();

    expect(() =>
      broker.publish({
        topic: "status",
        cluster: "c032",
        observedAtMs: 10_000,
        payload: {
          groups: { reactor: createValue() },
          solo_entries: [],
          idle_hosts: [],
          pending_ops: [],
          errors: {},
          total_containers: 0,
          host_count: 1,
        },
      }),
    ).toThrow(/wire-safe/i);
  });

  it("does not consume a revision when a non-serializable event is rejected", () => {
    const broker = createDashboardTelemetryBroker();
    const first = publishVllm(broker, "c032", 10);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() =>
      broker.publish({
        topic: "status",
        cluster: "c032",
        observedAtMs: 10_000,
        payload: {
          groups: { reactor: cyclic },
          solo_entries: [],
          idle_hosts: [],
          pending_ops: [],
          errors: {},
          total_containers: 0,
          host_count: 1,
        },
      }),
    ).toThrow(/wire-safe/i);
    const second = publishVllm(broker, "c032", 20);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
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
