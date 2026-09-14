import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const xAxisProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("recharts", () => {
  const passthrough = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);

  return {
    CartesianGrid: () => null,
    Line: () => null,
    LineChart: passthrough,
    ResponsiveContainer: passthrough,
    Tooltip: () => null,
    XAxis: (props: Record<string, unknown>) => {
      xAxisProps.current = props;
      return null;
    },
    YAxis: () => null,
  };
});

import { TokenHistoryChart } from "@/app/components/dashboard/TokenHistoryChart";
import type { TokenHistoryResult } from "@/lib/tokenHistory";

const result: TokenHistoryResult = {
  cluster: "alpha",
  fingerprint: "fingerprint",
  latestObservationAtMs: 11_000,
  range: "15m",
  fromMs: 1_000,
  toMs: 11_000,
  resolutionMs: 5_000,
  state: "partial",
  coverage: 0.5,
  points: [
    { atMs: 1_000, tokensPerSecond: 0 },
    { atMs: 6_000, tokensPerSecond: null },
    { atMs: 11_000, tokensPerSecond: 12.5 },
  ],
};

it("renders an accessible fixed-height chart region", () => {
  const html = renderToStaticMarkup(
    createElement(TokenHistoryChart, {
      result,
      ariaLabel: "Token throughput history for alpha",
    }),
  );

  expect(html).toContain('class="h-56 w-full"');
  expect(html).toContain('role="img"');
  expect(html).toContain('aria-label="Token throughput history for alpha"');
});

it("pins the numeric axis to the requested epoch-time window", () => {
  const realisticResult: TokenHistoryResult = {
    ...result,
    fromMs: 1_700_000_000_000,
    toMs: 1_700_000_900_000,
    points: [
      { atMs: 1_700_000_000_000, tokensPerSecond: 0 },
      { atMs: 1_700_000_450_000, tokensPerSecond: null },
      { atMs: 1_700_000_900_000, tokensPerSecond: 12.5 },
    ],
  };

  renderToStaticMarkup(
    createElement(TokenHistoryChart, {
      result: realisticResult,
      ariaLabel: "Token throughput history for alpha",
    }),
  );

  expect(xAxisProps.current?.domain).toEqual([realisticResult.fromMs, realisticResult.toMs]);
});
