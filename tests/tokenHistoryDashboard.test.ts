import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TokenHistoryResult } from "@/lib/tokenHistory";
import {
  TOKEN_HISTORY_RANGES,
  TOKEN_HISTORY_REFRESH_MS,
  formatTokensPerSecond,
  isFreshHistoryCache,
  summarizeTokenHistory,
  tokenHistoryCacheKey,
} from "@/app/components/dashboard/tokenHistoryData";

const result: TokenHistoryResult = {
  cluster: "alpha",
  fingerprint: "abc",
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
  it("supports exactly the four bounded history ranges", () => {
    expect(TOKEN_HISTORY_RANGES).toEqual(["15m", "1d", "7d", "30d"]);
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

  it("uses the typed token history RPC instead of a stream or direct cluster URL", () => {
    const source = readFileSync(
      new URL("../app/components/dashboard/useTokenHistory.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("rpc.tokenHistory.get");
    expect(source).not.toContain("tokenHistory.stream");
    expect(source).not.toMatch(/https?:\/\/[^"'`]*cluster/);
  });
});
