import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  aggregateTokenHistory,
  rangePolicy,
  type TokenHistoryQuery,
  type TokenHistoryResult,
  type TokenHistoryStore,
  type TokenObservation,
  type TrendRange,
} from "./tokenHistory";

const ROLLING_RETENTION_MS = 20 * 60_000;
const DAILY_RETENTION_MS = 31 * 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

type StoredObservation = TokenObservation & {
  tier: "sample" | "minute";
};

type MinuteAccumulator = {
  atMs: number;
  latestAtMs: number;
  cluster: string;
  fingerprint: string;
  weightedSum: number;
  validWeight: number;
};

type ClusterState = {
  entries: StoredObservation[];
  loaded: boolean;
  degraded: boolean;
};

let temporaryFileSequence = 0;

function hashIdentifier(identifier: string): string {
  return createHash("sha256").update(identifier).digest("hex");
}

function validateIdentifier(value: string, label: "cluster" | "fingerprint"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  if (value === "." || value === ".." || /[\\/\0\r\n]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function validateObservation(observation: TokenObservation): void {
  if (!observation || !Number.isFinite(observation.atMs)) {
    throw new Error("Invalid token observation");
  }
  validateIdentifier(observation.cluster, "cluster");
  validateIdentifier(observation.fingerprint, "fingerprint");
  if (
    observation.tokensPerSecond !== null &&
    (!Number.isFinite(observation.tokensPerSecond) || observation.tokensPerSecond < 0)
  ) {
    throw new Error("Invalid tokensPerSecond");
  }
  if (
    observation.weight !== undefined &&
    (!Number.isFinite(observation.weight) || observation.weight <= 0)
  ) {
    throw new Error("Invalid observation weight");
  }
}

function rollingPath(dataDir: string, cluster: string): string {
  return join(dataDir, `rolling-${hashIdentifier(cluster)}.ndjson`);
}

function dayPrefix(cluster: string): string {
  return `day-${hashIdentifier(cluster)}-`;
}

function dayPath(dataDir: string, cluster: string, day: string): string {
  return join(dataDir, `${dayPrefix(cluster)}${day}.ndjson`);
}

function isDayFile(file: string, prefix: string): boolean {
  if (!file.startsWith(prefix) || !file.endsWith(".ndjson")) return false;
  const day = file.slice(prefix.length, -".ndjson".length);
  return /^\d{4}-\d{2}-\d{2}$/.test(day);
}

function utcDay(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredValue(value: unknown, cluster: string): StoredObservation | null {
  if (!isObject(value)) return null;
  const source = isObject(value.observation) ? value.observation : value;
  if (
    typeof source.atMs !== "number" ||
    !Number.isFinite(source.atMs) ||
    source.cluster !== cluster ||
    typeof source.fingerprint !== "string" ||
    source.fingerprint.length === 0 ||
    (source.latestAtMs !== undefined &&
      (typeof source.latestAtMs !== "number" || !Number.isFinite(source.latestAtMs))) ||
    (source.tokensPerSecond !== null && typeof source.tokensPerSecond !== "number")
  ) {
    return null;
  }
  if (
    source.tokensPerSecond !== null &&
    (!Number.isFinite(source.tokensPerSecond) || source.tokensPerSecond < 0)
  ) {
    return null;
  }

  const weight = source.weight;
  if (
    weight !== undefined &&
    (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0)
  ) {
    return null;
  }

  return {
    atMs: source.atMs,
    cluster,
    fingerprint: source.fingerprint,
    tokensPerSecond: source.tokensPerSecond,
    ...(weight === undefined ? {} : { weight }),
    ...(source.latestAtMs === undefined ? {} : { latestAtMs: source.latestAtMs }),
    tier: value.kind === "minute" ? "minute" : "sample",
  };
}

function likelyTruncated(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return (
    (trimmed.startsWith("{") && !trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && !trimmed.endsWith("]"))
  );
}

function parseNdjson(
  content: string,
  cluster: string,
): { entries: StoredObservation[]; degraded: boolean } {
  const hasTrailingNewline = content.endsWith("\n") || content.endsWith("\r");
  const lines = content.split(/\r?\n/);
  if (hasTrailingNewline && lines[lines.length - 1] === "") lines.pop();

  const entries: StoredObservation[] = [];
  let degraded = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) continue;
    const isFinalLine = index === lines.length - 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (isFinalLine && !hasTrailingNewline && likelyTruncated(line)) continue;
      degraded = true;
      continue;
    }

    const parsed = parseStoredValue(value, cluster);
    if (parsed) entries.push(parsed);
    else degraded = true;
  }

  return { entries, degraded };
}

function serializeObservation(entry: StoredObservation): string {
  return JSON.stringify({
    kind: entry.tier,
    atMs: entry.atMs,
    cluster: entry.cluster,
    fingerprint: entry.fingerprint,
    tokensPerSecond: entry.tokensPerSecond,
    ...(entry.weight === undefined ? {} : { weight: entry.weight }),
    ...(entry.latestAtMs === undefined ? {} : { latestAtMs: entry.latestAtMs }),
  });
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${temporaryFileSequence++}`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await removeIfPresent(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function minuteAggregates(entries: StoredObservation[]): StoredObservation[] {
  const aggregates = new Map<string, MinuteAccumulator>();
  for (const entry of entries) {
    const atMs = Math.floor(entry.atMs / MINUTE_MS) * MINUTE_MS;
    const key = `${entry.fingerprint}\u0000${atMs}`;
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        atMs,
        latestAtMs: entry.latestAtMs ?? entry.atMs,
        cluster: entry.cluster,
        fingerprint: entry.fingerprint,
        weightedSum: 0,
        validWeight: 0,
      };
      aggregates.set(key, aggregate);
    }
    aggregate.latestAtMs = Math.max(aggregate.latestAtMs, entry.latestAtMs ?? entry.atMs);
    if (entry.tokensPerSecond !== null) {
      const weight = entry.weight ?? 1;
      aggregate.weightedSum += entry.tokensPerSecond * weight;
      aggregate.validWeight += weight;
    }
  }

  return [...aggregates.values()]
    .sort((a, b) => a.atMs - b.atMs || a.fingerprint.localeCompare(b.fingerprint))
    .map((aggregate) => ({
      atMs: aggregate.atMs,
      cluster: aggregate.cluster,
      fingerprint: aggregate.fingerprint,
      tokensPerSecond:
        aggregate.validWeight > 0 ? aggregate.weightedSum / aggregate.validWeight : null,
      ...(aggregate.validWeight > 0 ? { weight: aggregate.validWeight } : {}),
      latestAtMs: aggregate.latestAtMs,
      tier: "minute" as const,
    }));
}

function unavailableResult(cluster: string, range: TrendRange, nowMs: number): TokenHistoryResult {
  const policy = rangePolicy(range);
  const fromMs = nowMs - policy.durationMs;
  const points = Array.from(
    { length: Math.ceil(policy.durationMs / policy.bucketMs) },
    (_, index) => ({
      atMs: fromMs + index * policy.bucketMs,
      tokensPerSecond: null,
    }),
  );
  return {
    cluster,
    fingerprint: null,
    range,
    fromMs,
    toMs: nowMs,
    resolutionMs: policy.bucketMs,
    state: "unavailable",
    coverage: 0,
    points,
  };
}

export function createTokenHistoryFileStore({
  dataDir,
  now,
}: {
  dataDir: string;
  now: () => number;
}): TokenHistoryStore {
  const clusters = new Map<string, ClusterState>();
  let queue = Promise.resolve();
  let closed = false;

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function loadCluster(cluster: string): Promise<ClusterState> {
    let state = clusters.get(cluster);
    if (state?.loaded) return state;
    if (!state) {
      state = { entries: [], loaded: false, degraded: false };
      clusters.set(cluster, state);
    }

    await mkdir(dataDir, { recursive: true });
    const files = await readdir(dataDir);
    const rollingName = `rolling-${hashIdentifier(cluster)}.ndjson`;
    const prefix = dayPrefix(cluster);
    const matchingFiles = files
      .filter((file) => file === rollingName || isDayFile(file, prefix))
      .sort();

    for (const file of matchingFiles) {
      const content = await readFile(join(dataDir, file), "utf8");
      const parsed = parseNdjson(content, cluster);
      state.entries.push(...parsed.entries);
      state.degraded ||= parsed.degraded;
    }
    state.loaded = true;
    return state;
  }

  async function persistCluster(
    cluster: string,
    state: ClusterState,
    nowMs: number,
  ): Promise<void> {
    const retentionCutoff = nowMs - DAILY_RETENTION_MS;
    const rollingCutoff = nowMs - ROLLING_RETENTION_MS;
    const retained = state.entries.filter((entry) => entry.atMs >= retentionCutoff);
    const rollingEntries = retained.filter((entry) => entry.atMs >= rollingCutoff);
    const dailyEntries = minuteAggregates(retained.filter((entry) => entry.atMs < rollingCutoff));
    state.entries = [...rollingEntries, ...dailyEntries];

    const rollingFile = rollingPath(dataDir, cluster);
    if (rollingEntries.length === 0) {
      await removeIfPresent(rollingFile);
    } else {
      const content = rollingEntries.map(serializeObservation).join("\n") + "\n";
      await writeAtomically(rollingFile, content);
    }

    await mkdir(dataDir, { recursive: true });
    const files = await readdir(dataDir);
    const prefix = dayPrefix(cluster);
    const byDay = new Map<string, StoredObservation[]>();
    for (const entry of dailyEntries) {
      const day = utcDay(entry.atMs);
      const dayEntries = byDay.get(day) ?? [];
      dayEntries.push(entry);
      byDay.set(day, dayEntries);
    }

    const existingDayFiles = files.filter((file) => isDayFile(file, prefix));
    for (const file of existingDayFiles) {
      const day = file.slice(prefix.length, -".ndjson".length);
      if (!byDay.has(day)) await removeIfPresent(join(dataDir, file));
    }
    for (const [day, entries] of byDay) {
      const content = entries.map(serializeObservation).join("\n") + "\n";
      await writeAtomically(dayPath(dataDir, cluster, day), content);
    }
  }

  return {
    record(observation) {
      return enqueue(async () => {
        if (closed) throw new Error("Token history store is closed");
        validateObservation(observation);
        const state = await loadCluster(observation.cluster);
        state.entries.push({ ...observation, tier: "sample" });
        const nowMs = now();
        if (!Number.isFinite(nowMs)) throw new Error("Invalid token history clock");
        await persistCluster(observation.cluster, state, nowMs);
      });
    },

    query(query: TokenHistoryQuery) {
      return enqueue(async () => {
        if (closed) throw new Error("Token history store is closed");
        validateIdentifier(query.cluster, "cluster");
        if (!["15m", "1d", "7d", "30d"].includes(query.range)) {
          throw new Error("Invalid token history range");
        }
        const nowMs = query.nowMs ?? now();
        if (!Number.isFinite(nowMs))
          return unavailableResult(query.cluster, query.range, Date.now());

        try {
          const state = await loadCluster(query.cluster);
          return aggregateTokenHistory(state.entries, {
            cluster: query.cluster,
            range: query.range,
            nowMs,
            degraded: state.degraded,
          });
        } catch {
          return unavailableResult(query.cluster, query.range, nowMs);
        }
      });
    },

    close() {
      return enqueue(async () => {
        closed = true;
      });
    },
  };
}
