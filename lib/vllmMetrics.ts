import { z } from "zod";

export const VllmMetricStateSchema = z.enum(["live", "warming", "stale", "unavailable", "reset"]);
export type VllmMetricState = z.infer<typeof VllmMetricStateSchema>;

export const VllmReadingSchema = z.object({
  value: z.number().finite().nonnegative().nullable(),
  state: VllmMetricStateSchema,
  observedAtMs: z.number().int().nonnegative().nullable(),
});
export type VllmReading = z.infer<typeof VllmReadingSchema>;

export const VllmClusterSnapshotSchema = z.object({
  cluster: z.string(),
  polledAtMs: z.number().int().nonnegative(),
  sourceHost: z.string().nullable(),
  state: z.enum(["live", "stale", "unavailable"]),
  error: z.string().nullable(),
  metrics: z.object({
    tokensPerSecond: VllmReadingSchema,
    runningRequests: VllmReadingSchema,
    waitingRequests: VllmReadingSchema,
    kvCachePercent: VllmReadingSchema,
    kvCacheCapacityTokens: VllmReadingSchema.default({
      value: null,
      state: "unavailable",
      observedAtMs: null,
    }),
  }),
});
export type VllmClusterSnapshot = z.infer<typeof VllmClusterSnapshotSchema>;

const GENERATION_TOKENS = "vllm:generation_tokens_total";
const RUNNING_REQUESTS = "vllm:num_requests_running";
const WAITING_REQUESTS = "vllm:num_requests_waiting";
const KV_CACHE = "vllm:kv_cache_usage_perc";
const CACHE_CONFIG = "vllm:cache_config_info";
const allowed = new Set([GENERATION_TOKENS, RUNNING_REQUESTS, WAITING_REQUESTS, KV_CACHE]);
const sampleLine = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s+\d+)?$/;
const familyAtLineStart = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{|\s|$)/;
const labelPair = /^([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"$/;

export type ParsedVllmMetrics = {
  generationTokenSeries: ReadonlyMap<string, number> | null;
  runningRequests: number | null;
  waitingRequests: number | null;
  kvCachePercent: number | null;
  kvCacheCapacityTokens: number | null;
  invalidFamilies: ReadonlySet<string>;
  hasValidSamples: boolean;
};

function parseLabels(raw: string | undefined): Array<[string, string]> | null {
  if (raw === undefined || raw.trim() === "") return [];

  const pairs: string[] = [];
  let start = 0;
  let escaped = false;
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      pairs.push(raw.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  pairs.push(raw.slice(start).trim());

  const parsed: Array<[string, string]> = [];
  const names = new Set<string>();
  for (const pair of pairs) {
    const match = pair.match(labelPair);
    if (!match || names.has(match[1])) return null;
    names.add(match[1]);
    parsed.push([match[1], match[2]]);
  }
  parsed.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return parsed;
}

function canonicalLabels(raw: string | undefined): string | null {
  const parsed = parseLabels(raw);
  if (parsed === null) return null;
  if (parsed.length === 0) return "";
  parsed.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return parsed.map(([name, value]) => `${name}="${value}"`).join(",");
}

function labelValue(labels: Array<[string, string]> | null, name: string): string | null {
  return labels?.find(([label]) => label === name)?.[1] ?? null;
}

export function parseVllmMetrics(text: string): ParsedVllmMetrics {
  const samples = new Map<string, Array<{ key: string; value: number }>>();
  const kvCacheCapacities = new Map<string, number>();
  const kvCacheEngines = new Set<string>();
  let cacheConfigIsAmbiguous = false;
  const invalidFamilies = new Set<string>();
  let hasValidSamples = false;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const family = trimmed.match(familyAtLineStart)?.[1];
    const match = trimmed.match(sampleLine);
    if (match) {
      const genericValue = Number(match[3]);
      if (Number.isFinite(genericValue) && genericValue >= 0) hasValidSamples = true;
    }
    if (family === CACHE_CONFIG) {
      if (!match || match[1] !== family) {
        cacheConfigIsAmbiguous = true;
        continue;
      }
      const labels = parseLabels(match[2]);
      const engine = labelValue(labels, "engine");
      const rawCapacity = labelValue(labels, "kv_cache_size_tokens");
      const capacity = rawCapacity === null ? Number.NaN : Number(rawCapacity);
      if (engine === null || !Number.isSafeInteger(capacity) || capacity < 0) {
        cacheConfigIsAmbiguous = true;
        continue;
      }
      const previousCapacity = kvCacheCapacities.get(engine);
      if (previousCapacity !== undefined && previousCapacity !== capacity) {
        cacheConfigIsAmbiguous = true;
        continue;
      }
      kvCacheCapacities.set(engine, capacity);
      continue;
    }
    if (!family || !allowed.has(family)) continue;
    if (!match || match[1] !== family) {
      invalidFamilies.add(family);
      continue;
    }
    const key = canonicalLabels(match[2]);
    const value = Number(match[3]);
    if (
      key === null ||
      !Number.isFinite(value) ||
      value < 0 ||
      (family === KV_CACHE && value > 1)
    ) {
      invalidFamilies.add(family);
      continue;
    }
    const familySamples = samples.get(family) ?? [];
    familySamples.push({ key, value });
    samples.set(family, familySamples);
    if (family === KV_CACHE) {
      const engine = labelValue(parseLabels(match[2]), "engine");
      if (engine !== null) kvCacheEngines.add(engine);
    }
  }

  function familyValues(family: string): Array<{ key: string; value: number }> | null {
    if (invalidFamilies.has(family)) return null;
    return samples.get(family) ?? null;
  }

  const tokenSamples = familyValues(GENERATION_TOKENS);
  const generationTokenSeries = tokenSamples
    ? new Map(tokenSamples.map(({ key, value }) => [key, value]))
    : null;
  const runningSamples = familyValues(RUNNING_REQUESTS);
  const waitingSamples = familyValues(WAITING_REQUESTS);
  const kvSamples = familyValues(KV_CACHE);
  // vLLM reports this capacity per engine. It does not define a cluster-wide
  // total, so only show the value when the metrics describe one engine.
  const capacityEntry = [...kvCacheCapacities.entries()][0];
  const kvCacheCapacityTokens =
    !cacheConfigIsAmbiguous &&
    kvCacheCapacities.size === 1 &&
    kvCacheEngines.size <= 1 &&
    capacityEntry !== undefined &&
    (kvCacheEngines.size === 0 || kvCacheEngines.has(capacityEntry[0]))
      ? capacityEntry[1]
      : null;

  return {
    generationTokenSeries,
    runningRequests:
      runningSamples === null
        ? null
        : runningSamples.reduce((total, sample) => total + sample.value, 0),
    waitingRequests:
      waitingSamples === null
        ? null
        : waitingSamples.reduce((total, sample) => total + sample.value, 0),
    kvCachePercent:
      kvSamples === null
        ? null
        : Math.max(
            0,
            Math.min(
              100,
              (kvSamples.reduce((total, sample) => total + sample.value, 0) / kvSamples.length) *
                100,
            ),
          ),
    kvCacheCapacityTokens,
    invalidFamilies,
    hasValidSamples,
  };
}

export type CounterBaseline = {
  series: ReadonlyMap<string, number>;
  monotonicMs: number;
};

export type TokenRateResult = {
  reading: VllmReading;
  baseline: CounterBaseline | null;
};

function nullReading(state: VllmMetricState, observedAtMs: number): VllmReading {
  return { value: null, state, observedAtMs };
}

export function deriveTokenRate(
  previous: CounterBaseline | null,
  current: ReadonlyMap<string, number> | null,
  monotonicMs: number,
  observedAtMs: number,
): TokenRateResult {
  if (current === null || current.size === 0) {
    return { reading: nullReading("unavailable", observedAtMs), baseline: null };
  }

  const nextBaseline = { series: new Map(current), monotonicMs };
  if (previous === null) {
    return { reading: nullReading("warming", observedAtMs), baseline: nextBaseline };
  }

  const previousKeys = new Set(previous.series.keys());
  const currentKeys = new Set(current.keys());
  let hasMissingSeries = false;
  let hasNewSeries = false;
  for (const key of previousKeys) {
    if (!currentKeys.has(key)) hasMissingSeries = true;
  }
  for (const key of currentKeys) {
    if (!previousKeys.has(key)) hasNewSeries = true;
  }
  if (hasMissingSeries) {
    return { reading: nullReading("unavailable", observedAtMs), baseline: null };
  }
  if (hasNewSeries) {
    return { reading: nullReading("warming", observedAtMs), baseline: nextBaseline };
  }

  const elapsedMs = monotonicMs - previous.monotonicMs;
  if (elapsedMs <= 0) {
    return { reading: nullReading("warming", observedAtMs), baseline: nextBaseline };
  }

  let delta = 0;
  for (const [key, value] of current) {
    if (!Number.isFinite(value) || value < 0) {
      return { reading: nullReading("unavailable", observedAtMs), baseline: null };
    }
    const prior = previous.series.get(key);
    if (prior === undefined || !Number.isFinite(prior) || prior < 0) {
      return { reading: nullReading("unavailable", observedAtMs), baseline: null };
    }
    if (value < prior) {
      return { reading: nullReading("reset", observedAtMs), baseline: nextBaseline };
    }
    delta += value - prior;
  }

  return {
    reading: { value: delta / (elapsedMs / 1000), state: "live", observedAtMs },
    baseline: nextBaseline,
  };
}

function unavailableReading(): VllmReading {
  return { value: null, state: "unavailable", observedAtMs: null };
}

export function unavailableClusterSnapshot(
  cluster: string,
  polledAtMs: number,
  sourceHost: string | null,
  error: string | null,
): VllmClusterSnapshot {
  return {
    cluster,
    polledAtMs,
    sourceHost,
    state: "unavailable",
    error,
    metrics: {
      tokensPerSecond: unavailableReading(),
      runningRequests: unavailableReading(),
      waitingRequests: unavailableReading(),
      kvCachePercent: unavailableReading(),
      kvCacheCapacityTokens: unavailableReading(),
    },
  };
}

export function staleClusterSnapshot(
  previous: VllmClusterSnapshot,
  polledAtMs: number,
  error: string,
): VllmClusterSnapshot {
  const stale = (reading: VllmReading): VllmReading => ({ ...reading, state: "stale" });
  return {
    ...previous,
    polledAtMs,
    state: "stale",
    error,
    metrics: {
      tokensPerSecond: stale(previous.metrics.tokensPerSecond),
      runningRequests: stale(previous.metrics.runningRequests),
      waitingRequests: stale(previous.metrics.waitingRequests),
      kvCachePercent: stale(previous.metrics.kvCachePercent),
      kvCacheCapacityTokens: stale(previous.metrics.kvCacheCapacityTokens),
    },
  };
}
