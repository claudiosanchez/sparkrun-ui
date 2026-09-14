import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { TokenHistoryResult, TrendRange } from "@/lib/tokenHistory";

type QueryFixture = {
  requestedRange: TrendRange;
  displayedRange: TrendRange | null;
  result: TokenHistoryResult | null;
  isInitialLoading: boolean;
  isRefreshing: boolean;
  isStale: boolean;
  error: string | null;
  retry: () => void;
};

const mockState = vi.hoisted(() => ({ current: null as QueryFixture | null }));

vi.mock("@/app/components/dashboard/tokenHistoryData", () => ({
  summarizeTokenHistory: () => ({
    latest: 0,
    minimum: 0,
    maximum: 12.5,
    average: 6.25,
    latestAtMs: 11_000,
  }),
}));
vi.mock("@/app/components/dashboard/TokenHistoryChart", () => ({
  TokenHistoryChart: ({ ariaLabel }: { ariaLabel: string }) =>
    createElement("div", { role: "img", "aria-label": ariaLabel }),
}));
vi.mock("@/app/components/dashboard/LiveTokenHistoryContent", () => ({
  LiveTokenHistoryContent: ({ result }: { result: TokenHistoryResult }) =>
    createElement("div", { "data-live-range": result.range }, "live history"),
}));
vi.mock("@/app/components/dashboard/useTokenHistory", () => ({
  useTokenHistory: () => mockState.current,
}));

import { ClusterTokenHistoryCard } from "@/app/components/dashboard/ClusterTokenHistoryCard";

const cluster = { name: "alpha", hosts: ["10.0.0.1"], is_default: true };
const result: TokenHistoryResult = {
  cluster: "alpha",
  fingerprint: "fingerprint",
  range: "15m",
  fromMs: 1_000,
  toMs: 11_000,
  resolutionMs: 5_000,
  state: "ready",
  coverage: 1,
  points: [
    { atMs: 1_000, tokensPerSecond: 0 },
    { atMs: 6_000, tokensPerSecond: null },
    { atMs: 11_000, tokensPerSecond: 12.5 },
  ],
};

function renderCard(query: QueryFixture, range: TrendRange = "15m"): string {
  mockState.current = query;
  return renderToStaticMarkup(createElement(ClusterTokenHistoryCard, { cluster, range }));
}

function baseQuery(overrides: Partial<QueryFixture> = {}): QueryFixture {
  return {
    requestedRange: "15m",
    displayedRange: "15m",
    result,
    isInitialLoading: false,
    isRefreshing: false,
    isStale: false,
    error: null,
    retry: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockState.current = null;
});

it("renders the card heading, zero summary, and accessible chart", () => {
  const html = renderCard(baseQuery());

  expect(html).toContain(">alpha<");
  expect(html).toContain("0.0 Tokens/s");
  expect(html).toContain('role="img"');
  expect(html).toContain(
    'aria-label="alpha token throughput history, 15m; Latest: 0.0 Tokens/s; Average: 6.3 Tokens/s; Min–max: 0.0 Tokens/s – 12.5 Tokens/s"',
  );
  expect(html).toContain("Range: 15m");
});

it("retains the displayed chart range while a new range loads", () => {
  const html = renderCard(
    baseQuery({
      requestedRange: "1d",
      isRefreshing: true,
    }),
  );

  expect(html).toContain("Range: 15m");
  expect(html).toContain("Loading 1d; showing 15m");
});

it("renders history content after a successful client response", () => {
  const html = renderCard(baseQuery({ result }));

  expect(html).not.toContain("Loading persisted token history");
  expect(html).toContain("Latest: 0.0 Tokens/s");
  expect(html).toContain('role="img"');
});

it("mounts the live subscriber only for a usable displayed five-minute result", () => {
  const fiveMinuteResult = { ...result, range: "5m" as const, resolutionMs: 1_000 };

  const fiveMinuteHtml = renderCard(
    baseQuery({
      requestedRange: "5m",
      displayedRange: "5m",
      result: fiveMinuteResult,
    }),
    "5m",
  );
  const retainedLongRangeHtml = renderCard(
    baseQuery({
      requestedRange: "5m",
      displayedRange: "15m",
      result,
      isRefreshing: true,
    }),
    "5m",
  );

  expect(fiveMinuteHtml).toContain('data-live-range="5m"');
  expect(retainedLongRangeHtml).not.toContain("data-live-range");
  expect(retainedLongRangeHtml).toContain('role="img"');
});

it("renders an honest collecting message without a chart for empty history", () => {
  const html = renderCard(
    baseQuery({
      result: {
        ...result,
        state: "empty",
        coverage: 0,
        points: result.points.map((point) => ({ ...point, tokensPerSecond: null })),
      },
    }),
  );

  expect(html).toContain("Collecting history");
  expect(html).toContain("No token throughput samples have been collected for this range.");
  expect(html).not.toContain('role="img"');
});

it("keeps empty history recoverable when a background refresh is stale", () => {
  const html = renderCard(
    baseQuery({
      result: {
        ...result,
        state: "empty",
        coverage: 0,
        points: result.points.map((point) => ({ ...point, tokensPerSecond: null })),
      },
      isRefreshing: true,
      isStale: true,
      error: "Refresh failed",
    }),
  );

  expect(html).toContain("Collecting history");
  expect(html).toContain("Refresh failed");
  expect(html).toContain("This collecting state is stale while history refreshes.");
  expect(html).toContain(">Retry<");
  expect(html).toContain('disabled=""');
});

it("renders unavailable history with a retry button disabled during an active request", () => {
  const html = renderCard(
    baseQuery({
      result: { ...result, state: "unavailable", coverage: 0 },
      isRefreshing: true,
      error: "Temporary history failure",
    }),
  );

  expect(html).toContain("History unavailable");
  expect(html).toContain("Temporary history failure");
  expect(html).toContain(">Retry<");
  expect(html).toContain('disabled=""');
});

it("marks a retained chart stale and offers retry after a background failure", () => {
  const html = renderCard(
    baseQuery({
      isStale: true,
      error: "Refresh failed",
    }),
  );

  expect(html).toContain(">Stale<");
  expect(html).not.toContain("History unavailable");
  expect(html).toContain("Refresh failed");
  expect(html).toContain(">Retry<");
  expect(html).toContain('role="img"');
});
