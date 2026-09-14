import { describe, expect, it, vi } from "vitest";
import type { DashboardTelemetryEvent } from "@/lib/dashboardTelemetry";
import type { TokenHistoryResult, TokenObservation } from "@/lib/tokenHistory";
import {
  applyLiveTokenHistory,
  reduceLiveTokenObservations,
} from "@/app/components/dashboard/liveTokenHistory";
import { createTokenHistoryTelemetryStore } from "@/app/components/dashboard/tokenHistoryTelemetryStore";

function historyResult(overrides: Partial<TokenHistoryResult> = {}): TokenHistoryResult {
  return {
    cluster: "C032",
    fingerprint: "series-a",
    range: "5m",
    fromMs: 0,
    toMs: 300_000,
    resolutionMs: 1_000,
    state: "partial",
    coverage: 2 / 300,
    points: Array.from({ length: 300 }, (_, index) => ({
      atMs: index * 1_000,
      tokensPerSecond: index === 0 ? 8 : index === 299 ? 12 : null,
    })),
    ...overrides,
  };
}

function observation(
  atMs: number,
  tokensPerSecond: number | null,
  overrides: Partial<TokenObservation> = {},
): TokenObservation {
  return {
    atMs,
    cluster: "C032",
    fingerprint: "series-a",
    tokensPerSecond,
    ...overrides,
  };
}

function telemetryEvent(
  cluster: string,
  atMs: number,
  value: number | null,
  fingerprint = `series-${cluster}`,
): DashboardTelemetryEvent {
  return {
    version: 1,
    revision: atMs,
    topic: "token-history",
    cluster,
    observedAtMs: atMs,
    payload: {
      atMs,
      cluster,
      fingerprint,
      tokensPerSecond: value,
    },
  };
}

describe("applyLiveTokenHistory", () => {
  it("returns a non-five-minute result unchanged", () => {
    const base = historyResult({ range: "15m", resolutionMs: 5_000 });

    expect(applyLiveTokenHistory(base, [observation(301_000, 20)])).toBe(base);
  });

  it("advances to the newest observation and keeps exactly 300 one-second points", () => {
    const base = historyResult();
    const next = applyLiveTokenHistory(base, [observation(300_500, 18), observation(301_000, 0)]);

    expect(next).not.toBe(base);
    expect(next.fromMs).toBe(1_000);
    expect(next.toMs).toBe(301_000);
    expect(next.resolutionMs).toBe(1_000);
    expect(next.points).toHaveLength(300);
    expect(next.points[0]).toEqual({ atMs: 1_000, tokensPerSecond: null });
    expect(next.points[299]).toEqual({ atMs: 300_000, tokensPerSecond: 0 });
    expect(next.state).toBe("partial");
    expect(next.coverage).toBe(2 / 300);
  });

  it("does not move a fetched window backward for an older replayed observation", () => {
    const base = historyResult();

    const next = applyLiveTokenHistory(base, [observation(299_500, 16)]);

    expect(next.fromMs).toBe(0);
    expect(next.toMs).toBe(300_000);
    expect(next.points[299]).toEqual({ atMs: 299_000, tokensPerSecond: 16 });
  });

  it("lets a newer null observation replace an old value in the same bucket", () => {
    const emptyBase = historyResult({
      state: "empty",
      coverage: 0,
      points: Array.from({ length: 300 }, (_, index) => ({
        atMs: index * 1_000,
        tokensPerSecond: null,
      })),
    });
    const next = applyLiveTokenHistory(emptyBase, [
      observation(300_500, 25),
      observation(300_900, null),
    ]);

    expect(next.points[299].tokensPerSecond).toBeNull();
    expect(next.state).toBe("empty");
    expect(next.coverage).toBe(0);
  });

  it("clears base and overlay values when the live series fingerprint changes", () => {
    const oldOverlay = [observation(299_000, 30)];
    const reduced = reduceLiveTokenObservations(
      oldOverlay,
      observation(300_000, null, { fingerprint: "series-b" }),
    );
    const next = applyLiveTokenHistory(historyResult(), reduced);

    expect(reduced).toEqual([observation(300_000, null, { fingerprint: "series-b" })]);
    expect(next.fingerprint).toBe("series-b");
    expect(next.points.every((point) => point.tokensPerSecond === null)).toBe(true);
    expect(next.coverage).toBe(0);
    expect(next.state).toBe("empty");
  });

  it("does not mutate the fetched result or its points", () => {
    const base = historyResult();
    const originalPoints = base.points.map((point) => ({ ...point }));

    const next = applyLiveTokenHistory(base, [observation(301_000, 0)]);

    expect(base).toEqual(historyResult());
    expect(base.points).toEqual(originalPoints);
    expect(next.points).not.toBe(base.points);
  });
});

describe("reduceLiveTokenObservations", () => {
  it("rejects an older observation from a stale fingerprint series", () => {
    const current = [observation(300_000, 20, { fingerprint: "series-b" })];

    const reduced = reduceLiveTokenObservations(
      current,
      observation(250_000, 10, { fingerprint: "series-a" }),
    );

    expect(reduced).toBe(current);
    expect(reduced).toEqual([observation(300_000, 20, { fingerprint: "series-b" })]);
  });

  it("accepts a newer observation when the fingerprint series changes", () => {
    const current = [observation(250_000, 10, { fingerprint: "series-a" })];

    const reduced = reduceLiveTokenObservations(
      current,
      observation(300_000, null, { fingerprint: "series-b" }),
    );

    expect(reduced).toEqual([observation(300_000, null, { fingerprint: "series-b" })]);
  });

  it("bounds one cluster to the newest five-minute, 300-observation sequence", () => {
    let observations: readonly TokenObservation[] = [];
    for (let atMs = 1_000; atMs <= 305_000; atMs += 1_000) {
      observations = reduceLiveTokenObservations(observations, observation(atMs, atMs));
    }

    expect(observations).toHaveLength(300);
    expect(observations[0].atMs).toBe(6_000);
    expect(observations[299].atMs).toBe(305_000);
  });
});

describe("token history telemetry store", () => {
  it("keeps cluster snapshots and listeners stable across connection-health transitions", () => {
    const store = createTokenHistoryTelemetryStore();
    const c032Listener = vi.fn();
    const c458Listener = vi.fn();
    store.subscribe("C032", c032Listener);
    store.subscribe("C458", c458Listener);
    const c032Before = store.getSnapshot("C032");
    const c458Before = store.getSnapshot("C458");

    store.setConnectionHealthy(true);
    expect(store.connectionHealthy).toBe(true);
    store.setConnectionHealthy(false);

    expect(store.connectionHealthy).toBe(false);
    expect(store.getSnapshot("C032")).toBe(c032Before);
    expect(store.getSnapshot("C458")).toBe(c458Before);
    expect(c032Listener).not.toHaveBeenCalled();
    expect(c458Listener).not.toHaveBeenCalled();
  });

  it("notifies only the published cluster and preserves untouched snapshot identity", () => {
    const store = createTokenHistoryTelemetryStore();
    const c032Listener = vi.fn();
    const c458Listener = vi.fn();
    const releaseC032 = store.subscribe("C032", c032Listener);
    store.subscribe("C458", c458Listener);
    const c032Before = store.getSnapshot("C032");
    const c458Before = store.getSnapshot("C458");

    expect(store.publish(telemetryEvent("C032", 1_000, 0))).toBe(true);

    expect(c032Listener).toHaveBeenCalledTimes(1);
    expect(c458Listener).not.toHaveBeenCalled();
    expect(store.getSnapshot("C032")).not.toBe(c032Before);
    expect(store.getSnapshot("C458")).toBe(c458Before);
    expect(store.getSnapshot("C032").observations).toEqual([
      telemetryEvent("C032", 1_000, 0).payload,
    ]);

    releaseC032();
    expect(store.publish(telemetryEvent("C032", 2_000, null))).toBe(true);
    expect(c032Listener).toHaveBeenCalledTimes(1);
  });

  it("rejects unrelated and malformed events without changing a snapshot", () => {
    const store = createTokenHistoryTelemetryStore();
    const before = store.getSnapshot("C032");
    const listener = vi.fn();
    store.subscribe("C032", listener);

    expect(
      store.publish({
        version: 1,
        revision: 1,
        topic: "overview-monitor",
        observedAtMs: 1_000,
        payload: {},
      }),
    ).toBe(false);
    expect(
      store.publish({
        ...telemetryEvent("C032", 1_000, 10),
        observedAtMs: 999,
      }),
    ).toBe(false);

    expect(store.getSnapshot("C032")).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("resets a cluster sequence on a fingerprint change", () => {
    const store = createTokenHistoryTelemetryStore();
    store.publish(telemetryEvent("C032", 1_000, 10, "series-a"));
    store.publish(telemetryEvent("C032", 2_000, 20, "series-a"));
    store.publish(telemetryEvent("C032", 3_000, null, "series-b"));

    expect(store.getSnapshot("C032").observations).toEqual([
      telemetryEvent("C032", 3_000, null, "series-b").payload,
    ]);
  });
});
