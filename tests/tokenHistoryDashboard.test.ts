import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { TokenHistoryResult } from "@/lib/tokenHistory";
import {
  TOKEN_HISTORY_RANGES,
  TOKEN_HISTORY_REFRESH_MS,
  formatTokensPerSecond,
  isFreshHistoryCache,
  summarizeTokenHistory,
  tokenHistoryCacheKey,
} from "@/app/components/dashboard/tokenHistoryData";
import {
  acquireTokenHistoryRequest,
  isFreshTokenHistoryCacheEntry,
  isTokenHistoryCacheable,
  shouldRetainUsableHistory,
} from "@/app/components/dashboard/useTokenHistory";

const result: TokenHistoryResult = {
  cluster: "alpha",
  fingerprint: "abc",
  latestObservationAtMs: 10_000,
  range: "15m",
  fromMs: 0,
  toMs: 15_000,
  resolutionMs: 5_000,
  state: "partial",
  coverage: 2 / 3,
  points: [
    { atMs: 0, tokensPerSecond: null },
    { atMs: 5_000, tokensPerSecond: 0 },
    { atMs: 10_000, tokensPerSecond: 20 },
  ],
};

describe("token history dashboard data", () => {
  it("supports exactly the five bounded history ranges", () => {
    expect(TOKEN_HISTORY_RANGES).toEqual(["5m", "15m", "1d", "7d", "30d"]);
  });

  it("keys cache entries by cluster and range", () => {
    expect(tokenHistoryCacheKey("alpha", "15m")).not.toBe(tokenHistoryCacheKey("beta", "15m"));
    expect(tokenHistoryCacheKey("alpha", "15m")).not.toBe(tokenHistoryCacheKey("alpha", "1d"));
  });

  it("keeps entries fresh through one minute and stale after the boundary", () => {
    expect(isFreshHistoryCache(100_000, 100_000 + TOKEN_HISTORY_REFRESH_MS)).toBe(true);
    expect(isFreshHistoryCache(100_000, 100_000 + TOKEN_HISTORY_REFRESH_MS + 1)).toBe(false);
  });

  it("ignores null readings while retaining zero in summary math", () => {
    expect(summarizeTokenHistory(result)).toEqual({
      latest: 20,
      minimum: 0,
      maximum: 20,
      average: 10,
      latestAtMs: 10_000,
    });
    expect(formatTokensPerSecond(0)).toBe("0.0 Tokens/s");
  });

  it("returns null statistics for an all-null result", () => {
    expect(
      summarizeTokenHistory({
        ...result,
        points: [
          { atMs: 0, tokensPerSecond: null },
          { atMs: 5_000, tokensPerSecond: null },
        ],
      }),
    ).toEqual({
      latest: null,
      minimum: null,
      maximum: null,
      average: null,
      latestAtMs: null,
    });
    expect(formatTokensPerSecond(null)).toBe("—");
  });

  it("does not treat unavailable responses as fresh cache data", () => {
    const unavailable: TokenHistoryResult = { ...result, state: "unavailable" };

    expect(isTokenHistoryCacheable(result)).toBe(true);
    expect(isTokenHistoryCacheable(unavailable)).toBe(false);
  });

  it("invalidates a fresh cached history result after a topology reset", () => {
    const cached = { result, fetchedAtMs: 100_000, topologyGeneration: 3 };

    expect(isFreshTokenHistoryCacheEntry(cached, 3, 100_001)).toBe(true);
    expect(isFreshTokenHistoryCacheEntry(cached, 4, 100_001)).toBe(false);
  });

  it("retains usable chart data when a background request is unavailable", () => {
    const unavailable: TokenHistoryResult = { ...result, state: "unavailable" };

    expect(shouldRetainUsableHistory(result, unavailable)).toBe(true);
    expect(shouldRetainUsableHistory(null, unavailable)).toBe(false);
    expect(shouldRetainUsableHistory(unavailable, unavailable)).toBe(false);
  });

  it("uses the typed token history RPC instead of a stream or direct cluster URL", () => {
    const source = readFileSync(
      new URL("../app/components/dashboard/useTokenHistory.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("rpc.tokenHistory.get");
    expect(source).not.toContain("tokenHistory.stream");
    expect(source).not.toMatch(/https?:\/\/[^"'`]*cluster/);
  });

  it("owns one reconnecting dashboard telemetry stream outside the history-card map", () => {
    const providerSource = readFileSync(
      new URL("../app/components/dashboard/DashboardTelemetryProvider.tsx", import.meta.url),
      "utf8",
    );
    const sectionSource = readFileSync(
      new URL("../app/components/dashboard/ClusterTokenHistorySection.tsx", import.meta.url),
      "utf8",
    );
    const cardSource = readFileSync(
      new URL("../app/components/dashboard/ClusterTokenHistoryCard.tsx", import.meta.url),
      "utf8",
    );

    expect(providerSource.match(/rpc\.telemetry\.stream\(/g)).toHaveLength(1);
    expect(providerSource).toContain("new AbortController()");
    expect(providerSource).toContain("waitForRetry");
    expect(providerSource).toContain("store.beginConnection()");
    expect(providerSource).toContain("setConnectionHealthy(false)");
    expect(providerSource).not.toContain("EventSource");
    expect(providerSource).not.toContain("tokenHistory.stream");
    expect(providerSource).not.toMatch(/https?:\/\/[^"'`]*cluster/);
    expect(cardSource).not.toContain("telemetry.stream");
    expect(sectionSource).not.toContain("TelemetryProvider");
  });

  it("keeps the client telemetry store on the portable token-history schema boundary", () => {
    const storeSource = readFileSync(
      new URL("../app/components/dashboard/tokenHistoryTelemetryStore.ts", import.meta.url),
      "utf8",
    );

    expect(storeSource).toContain("@/lib/tokenHistoryTelemetry");
    expect(storeSource).not.toContain("@/lib/dashboardTelemetry");
  });

  it("keeps a shared request alive until its final card releases it", async () => {
    const owner = new AbortController();
    const otherCard = new AbortController();
    let resolveRequest!: (value: TokenHistoryResult) => void;
    let sharedSignal!: AbortSignal;
    const requestFactory = vi.fn((signal: AbortSignal) => {
      sharedSignal = signal;
      const promise = new Promise<TokenHistoryResult>((resolve) => {
        resolveRequest = resolve;
        signal.addEventListener("abort", () => undefined, { once: true });
      });
      return promise;
    });
    const first = acquireTokenHistoryRequest("alpha\u000015m", owner, requestFactory);
    const second = acquireTokenHistoryRequest("alpha\u000015m", otherCard, () => {
      throw new Error("a deduplicated request must not create a second RPC call");
    });

    first.release();
    owner.abort();
    expect(sharedSignal.aborted).toBe(false);
    expect(requestFactory).toHaveBeenCalledTimes(1);

    resolveRequest(result);
    await expect(second.promise).resolves.toBe(result);
    second.release();
    expect(sharedSignal.aborted).toBe(false);

    const finalCard = new AbortController();
    let pendingSignal!: AbortSignal;
    const pending = acquireTokenHistoryRequest("alpha\u00001d", finalCard, (signal) => {
      pendingSignal = signal;
      return new Promise<TokenHistoryResult>(() => undefined);
    });
    pending.release();
    expect(pendingSignal.aborted).toBe(true);
  });
});
