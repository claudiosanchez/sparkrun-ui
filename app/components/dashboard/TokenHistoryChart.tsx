"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TokenHistoryResult } from "@/lib/tokenHistory";

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

function formatTimestamp(value: unknown): string {
  const timestamp =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "—" : timestampFormatter.format(date);
}

function formatTokensPerSecond(value: unknown): string {
  if (typeof value === "number") return `${value.toFixed(1)} tok/s`;
  return typeof value === "string" ? `${value} tok/s` : "—";
}

export function TokenHistoryChart({
  result,
  ariaLabel,
}: {
  clusterName: string;
  result: TokenHistoryResult;
  ariaLabel: string;
}) {
  return (
    <div className="h-56 w-full" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={result.points} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis type="number" dataKey="atMs" tickFormatter={formatTimestamp} />
          <YAxis tickFormatter={(value) => `${value} tok/s`} width={56} />
          <Tooltip labelFormatter={formatTimestamp} formatter={formatTokensPerSecond} />
          <Line
            type="linear"
            dataKey="tokensPerSecond"
            connectNulls={false}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
