import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import { rangePolicy, type TokenHistoryResult, type TrendRange } from "@/lib/tokenHistory";
import { getProductionVllmCollectorRuntime } from "@/lib/vllmCollectorRuntime";

const TrendRangeSchema = z.enum(["15m", "1d", "7d", "30d"]);
const TokenHistoryPointSchema = z.object({
  atMs: z.number().int().finite(),
  tokensPerSecond: z.number().finite().nonnegative().nullable(),
});

export const TokenHistoryResultSchema = z.object({
  cluster: z.string(),
  fingerprint: z.string().nullable(),
  range: TrendRangeSchema,
  fromMs: z.number().finite(),
  toMs: z.number().finite(),
  resolutionMs: z.number().int().positive(),
  state: z.enum(["ready", "partial", "empty", "unavailable"]),
  coverage: z.number().finite().min(0).max(1),
  points: z.array(TokenHistoryPointSchema).max(360),
});

const TokenHistoryInputSchema = z
  .object({
    cluster: z.string().min(1),
    range: TrendRangeSchema,
  })
  .strict();

function unavailableResult(cluster: string, range: TrendRange, nowMs: number): TokenHistoryResult {
  const policy = rangePolicy(range);
  const fromMs = nowMs - policy.durationMs;
  return {
    cluster,
    fingerprint: null,
    range,
    fromMs,
    toMs: nowMs,
    resolutionMs: policy.bucketMs,
    state: "unavailable",
    coverage: 0,
    points: Array.from({ length: Math.ceil(policy.durationMs / policy.bucketMs) }, (_, index) => ({
      atMs: fromMs + index * policy.bucketMs,
      tokensPerSecond: null,
    })),
  };
}

export async function requireSavedCluster(clusterName: string, signal?: AbortSignal) {
  const runtime = getProductionVllmCollectorRuntime();
  const loadClusters = runtime.listSavedClusters ?? runtime.dependencies.listSavedClusters;
  const savedClusters = await loadClusters(signal ?? new AbortController().signal);
  const cluster = savedClusters.find((entry) => entry.name === clusterName);
  if (!cluster) {
    throw new ORPCError("NOT_FOUND", { message: `Saved cluster not found: ${clusterName}` });
  }
  return cluster;
}

export const get = os
  .input(TokenHistoryInputSchema)
  .output(TokenHistoryResultSchema)
  .handler(async ({ input, signal }) => {
    const runtime = getProductionVllmCollectorRuntime();
    const savedCluster = await requireSavedCluster(input.cluster, signal);

    const nowMs = Date.now();
    try {
      return await runtime.store.query({ cluster: savedCluster.name, range: input.range, nowMs });
    } catch {
      return unavailableResult(input.cluster, input.range, nowMs);
    }
  });
