import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenHistoryStore, TokenObservation } from "./tokenHistory";
import { createTokenHistoryRecorder, fingerprintHosts } from "./tokenHistoryRecorder";
import type { VllmClusterSnapshot } from "./vllmMetrics";

type Listener = (snapshot: VllmClusterSnapshot) => void;

type FakeRegistry = {
  subscriptions: Map<
    string,
    { hosts: string; listener: Listener; onStopped: () => void; pollIntervalMs?: number }
  >;
  subscribe: (
    cluster: string,
    leaderHost: string,
    listener: Listener,
    onStopped?: () => void,
    pollIntervalMs?: number,
  ) => () => void;
  stop: (cluster: string) => void;
  emit: (cluster: string, snapshot: VllmClusterSnapshot) => void;
};

function createFakeRegistry(): FakeRegistry {
  const subscriptions = new Map<
    string,
    { hosts: string; listener: Listener; onStopped: () => void; pollIntervalMs?: number }
  >();
  return {
    subscriptions,
    subscribe(cluster, leaderHost, listener, onStopped = () => {}, pollIntervalMs) {
      subscriptions.set(cluster, { hosts: leaderHost, listener, onStopped, pollIntervalMs });
      return () => {
        const current = subscriptions.get(cluster);
        if (current?.listener === listener) subscriptions.delete(cluster);
      };
    },
    stop(cluster) {
      const current = subscriptions.get(cluster);
      if (!current) return;
      current.onStopped();
      subscriptions.delete(cluster);
    },
    emit(cluster, snapshot) {
      subscriptions.get(cluster)?.listener(snapshot);
    },
  };
}

function snapshot(
  cluster: string,
  polledAtMs: number,
  value: number | null,
  state: VllmClusterSnapshot["metrics"]["tokensPerSecond"]["state"] = "live",
): VllmClusterSnapshot {
  const reading = {
    value,
    state,
    observedAtMs: polledAtMs,
  } as VllmClusterSnapshot["metrics"]["tokensPerSecond"];
  return {
    cluster,
    polledAtMs,
    sourceHost: "host-a",
    state: state === "stale" ? "stale" : "live",
    error: null,
    metrics: {
      tokensPerSecond: reading,
      runningRequests: { value: 0, state: "live", observedAtMs: polledAtMs },
      waitingRequests: { value: 0, state: "live", observedAtMs: polledAtMs },
      kvCachePercent: { value: 0, state: "live", observedAtMs: polledAtMs },
    },
  };
}

function storeSpy() {
  const observations: TokenObservation[] = [];
  const store: TokenHistoryStore = {
    record: vi.fn(async (observation: TokenObservation) => {
      observations.push(observation);
    }),
    query: vi.fn(),
    close: vi.fn(async () => {}),
  };
  return { store, observations };
}

const waitUntilStopped = (_ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTokenHistoryRecorder", () => {
  it("requests one-second collection without a browser subscriber", async () => {
    const registry = createFakeRegistry();
    const { store } = storeSpy();
    const recorder = createTokenHistoryRecorder({
      clusters: async () => [{ name: "c032", hosts: ["host-a"], is_default: true }],
      registry: registry as never,
      store,
      now: () => 100_000,
      wait: waitUntilStopped,
    });

    await recorder.start();

    expect(registry.subscriptions.get("c032")?.pollIntervalMs).toBe(1_000);
    await recorder.stop();
  });

  it("records live zero and positive Tokens/s without a browser subscriber", async () => {
    const registry = createFakeRegistry();
    const { store, observations } = storeSpy();
    const recorder = createTokenHistoryRecorder({
      clusters: async () => [{ name: "c032", hosts: ["host-a"], is_default: true }],
      registry: registry as never,
      store,
      now: () => 100_000,
      wait: waitUntilStopped,
    });

    await recorder.start();
    registry.emit("c032", snapshot("c032", 100_000, 0));
    registry.emit("c032", snapshot("c032", 105_000, 12));
    registry.emit("c032", snapshot("c032", 110_000, 99, "stale"));
    await recorder.stop();

    expect(observations).toEqual([
      {
        atMs: 100_000,
        cluster: "c032",
        fingerprint: fingerprintHosts(["host-a"]),
        tokensPerSecond: 0,
      },
      {
        atMs: 105_000,
        cluster: "c032",
        fingerprint: fingerprintHosts(["host-a"]),
        tokensPerSecond: 12,
      },
      {
        atMs: 110_000,
        cluster: "c032",
        fingerprint: fingerprintHosts(["host-a"]),
        tokensPerSecond: null,
      },
    ]);
  });

  it("publishes each deduplicated normalized observation before its durable write", async () => {
    const registry = createFakeRegistry();
    const calls: Array<{ kind: "publish" | "record"; observation: TokenObservation }> = [];
    let releaseWrite: (() => void) | undefined;
    const delayedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const store: TokenHistoryStore = {
      record: vi.fn((observation: TokenObservation) => {
        calls.push({ kind: "record", observation });
        return delayedWrite;
      }),
      query: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const publishObservation = vi.fn((observation: TokenObservation) => {
      calls.push({ kind: "publish", observation });
    });
    const recorder = createTokenHistoryRecorder({
      clusters: async () => [{ name: "c032", hosts: ["host-a"], is_default: true }],
      registry: registry as never,
      store,
      now: () => 100_000,
      wait: waitUntilStopped,
      publishObservation,
    });

    await recorder.start();
    registry.emit("c032", snapshot("c032", 100_000, 0));
    registry.emit("c032", snapshot("c032", 100_000, 99));
    registry.emit("c032", snapshot("c032", 101_000, 12));
    registry.emit("c032", snapshot("c032", 102_000, 99, "stale"));

    expect(calls.map(({ kind }) => kind)).toEqual([
      "publish",
      "record",
      "publish",
      "record",
      "publish",
      "record",
    ]);
    expect(
      calls.filter(({ kind }) => kind === "publish").map(({ observation }) => observation),
    ).toEqual([
      {
        atMs: 100_000,
        cluster: "c032",
        fingerprint: fingerprintHosts(["host-a"]),
        tokensPerSecond: 0,
      },
      {
        atMs: 101_000,
        cluster: "c032",
        fingerprint: fingerprintHosts(["host-a"]),
        tokensPerSecond: 12,
      },
      {
        atMs: 102_000,
        cluster: "c032",
        fingerprint: fingerprintHosts(["host-a"]),
        tokensPerSecond: null,
      },
    ]);
    expect(calls[0].observation).toBe(calls[1].observation);
    expect(calls[2].observation).toBe(calls[3].observation);
    expect(calls[4].observation).toBe(calls[5].observation);

    releaseWrite?.();
    await recorder.stop();
  });

  it("contains publisher failures without suppressing durable writes", async () => {
    const registry = createFakeRegistry();
    const { store } = storeSpy();
    const publishObservation = vi
      .fn<(observation: TokenObservation) => void | Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error("publisher unavailable");
      })
      .mockRejectedValueOnce(new Error("publisher disconnected"));
    const recorder = createTokenHistoryRecorder({
      clusters: async () => [{ name: "c032", hosts: ["host-a"], is_default: true }],
      registry: registry as never,
      store,
      now: () => 100_000,
      wait: waitUntilStopped,
      publishObservation,
    });

    await recorder.start();
    registry.emit("c032", snapshot("c032", 100_000, 1));
    registry.emit("c032", snapshot("c032", 101_000, 2));
    await recorder.stop();

    expect(publishObservation).toHaveBeenCalledTimes(2);
    expect(store.record).toHaveBeenCalledTimes(2);
  });

  it("retains subscriptions after a temporary discovery failure", async () => {
    const registry = createFakeRegistry();
    const { store } = storeSpy();
    let calls = 0;
    const recorder = createTokenHistoryRecorder({
      clusters: async () => {
        calls += 1;
        if (calls === 2) throw new Error("temporary discovery failure");
        return [{ name: "c032", hosts: ["host-a", "worker-a"], is_default: true }];
      },
      registry: registry as never,
      store,
      now: () => 100_000,
      wait: waitUntilStopped,
    });

    await recorder.start();
    const subscription = registry.subscriptions.get("c032");
    expect(subscription?.hosts).toBe("host-a");
    await recorder.reconcile();
    expect(registry.subscriptions.get("c032")).toBe(subscription);
    await recorder.stop();
  });

  it("replaces a subscription when only a secondary host changes", async () => {
    const registry = createFakeRegistry();
    const { store } = storeSpy();
    let hosts = ["host-a", "worker-a"];
    const recorder = createTokenHistoryRecorder({
      clusters: async () => [{ name: "c032", hosts, is_default: true }],
      registry: registry as never,
      store,
      now: () => 100_000,
      wait: waitUntilStopped,
    });

    await recorder.start();
    const previous = registry.subscriptions.get("c032");
    hosts = ["host-a", "worker-b"];
    await recorder.reconcile();

    expect(registry.subscriptions.get("c032")).not.toBe(previous);
    await recorder.stop();
  });

  it("does not persist an immediate cached snapshot from the prior target", async () => {
    const subscriptions = new Map<string, { listener: Listener; onStopped: () => void }>();
    let hosts = ["host-a"];
    const registry = {
      subscribe: vi.fn(
        (cluster: string, _leaderHost: string, listener: Listener, onStopped = () => {}) => {
          subscriptions.set(cluster, { listener, onStopped });
          if (hosts[0] === "host-b") listener(snapshot(cluster, 100_000, 7));
          return () => subscriptions.delete(cluster);
        },
      ),
      stop: vi.fn((cluster: string) => {
        const existing = subscriptions.get(cluster);
        existing?.onStopped();
        subscriptions.delete(cluster);
      }),
    };
    const { store, observations } = storeSpy();
    const recorder = createTokenHistoryRecorder({
      clusters: async () => [{ name: "c032", hosts, is_default: true }],
      registry: registry as never,
      store,
      now: () => 100_000,
      wait: waitUntilStopped,
    });

    await recorder.start();
    subscriptions.get("c032")?.listener(snapshot("c032", 100_000, 5));
    hosts = ["host-b"];
    await recorder.reconcile();
    subscriptions.get("c032")?.listener(snapshot("c032", 105_000, 9));
    await recorder.stop();

    expect(observations.map(({ atMs, tokensPerSecond }) => ({ atMs, tokensPerSecond }))).toEqual([
      { atMs: 100_000, tokensPerSecond: 5 },
      { atMs: 105_000, tokensPerSecond: 9 },
    ]);
  });

  it("does not stop a runtime collector that replaced the recorder's old leader first", async () => {
    let hosts = ["host-a"];
    type Entry = {
      leaderHost: string;
      subscribers: Set<Listener>;
      onStopped: Map<Listener, () => void>;
    };
    let entry: Entry | undefined;
    const stop = vi.fn(() => {
      entry = undefined;
    });
    const registry = {
      subscribe: vi.fn(
        (cluster: string, leaderHost: string, listener: Listener, onStopped = () => {}) => {
          if (!entry || entry.leaderHost !== leaderHost) {
            entry = { leaderHost, subscribers: new Set(), onStopped: new Map() };
          }
          const subscribedEntry = entry;
          subscribedEntry.subscribers.add(listener);
          subscribedEntry.onStopped.set(listener, onStopped);
          return () => {
            subscribedEntry.subscribers.delete(listener);
            subscribedEntry.onStopped.delete(listener);
          };
        },
      ),
      getEntry: vi.fn(() => entry),
      stop,
    };
    const { store } = storeSpy();
    const recorder = createTokenHistoryRecorder({
      clusters: async () => [{ name: "c032", hosts, is_default: true }],
      registry: registry as never,
      store,
      now: () => 100_000,
      wait: waitUntilStopped,
    });

    await recorder.start();
    const oldEntry = entry!;
    for (const stopped of oldEntry.onStopped.values()) stopped();
    const runtimeListener = vi.fn();
    entry = {
      leaderHost: "host-b",
      subscribers: new Set([runtimeListener]),
      onStopped: new Map([[runtimeListener, () => {}]]),
    };
    hosts = ["host-b"];

    await recorder.reconcile();

    expect(stop).not.toHaveBeenCalled();
    expect(entry?.leaderHost).toBe("host-b");
    expect(entry?.subscribers).toContain(runtimeListener);

    await recorder.stop();
  });

  it("contains asynchronous store failures and continues collecting", async () => {
    const registry = createFakeRegistry();
    const published: TokenObservation[] = [];
    const record = vi
      .fn<NonNullable<TokenHistoryStore["record"]>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const store: TokenHistoryStore = { record, query: vi.fn(), close: vi.fn(async () => {}) };
    const recorder = createTokenHistoryRecorder({
      clusters: async () => [{ name: "c032", hosts: ["host-a"], is_default: true }],
      registry: registry as never,
      store,
      now: () => 100_000,
      wait: waitUntilStopped,
      publishObservation: (observation) => {
        published.push(observation);
      },
    });

    await recorder.start();
    registry.emit("c032", snapshot("c032", 100_000, 1));
    registry.emit("c032", snapshot("c032", 105_000, 2));
    await recorder.stop();

    expect(record).toHaveBeenCalledTimes(2);
    expect(published.map(({ tokensPerSecond }) => tokensPerSecond)).toEqual([1, 2]);
  });
});
