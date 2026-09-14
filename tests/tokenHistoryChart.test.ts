import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TokenHistoryChart } from "@/app/components/dashboard/TokenHistoryChart";
import type { TokenHistoryResult } from "@/lib/tokenHistory";

const result: TokenHistoryResult = {
  cluster: "alpha",
  fingerprint: "fingerprint",
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
      clusterName: "alpha",
      result,
      ariaLabel: "Token throughput history for alpha",
    }),
  );

  expect(html).toContain('class="h-56 w-full"');
  expect(html).toContain('role="img"');
  expect(html).toContain('aria-label="Token throughput history for alpha"');
});
