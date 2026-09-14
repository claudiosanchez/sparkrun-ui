import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  aggregateTokenHistory,
  isTrendRange,
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

type ClusterState = {
  rollingEntries: StoredObservation[];
  dailyEntriesByDay: Map<string, Map<string, StoredObservation>>;
  loaded: boolean;
  degraded: boolean;
};

export type TokenHistoryFileSystem = {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
};

let temporaryFileSequence = 0;

const nativeFileSystem: TokenHistoryFileSystem = {
  mkdir: async (path, options) => mkdir(path, options),
  readFile: async (path, encoding) => readFile(path, encoding),
  readdir: async (path) => readdir(path),
  rename: async (oldPath, newPath) => rename(oldPath, newPath),
  unlink: async (path) => unlink(path),
  writeFile: async (path, data, encoding) => writeFile(path, data, encoding),
};

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
  if (!observation || !Number.isSafeInteger(observation.atMs) || observation.atMs < 0) {
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
  if (
    observation.latestAtMs !== undefined &&
    (!Number.isSafeInteger(observation.latestAtMs) || observation.latestAtMs < observation.atMs)
  ) {
    throw new Error("Invalid observation timestamp");
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
  if (value.kind !== "sample" && value.kind !== "minute") return null;
  const source = isObject(value.observation) ? value.observation : value;
  if (
    typeof source.atMs !== "number" ||
    !Number.isSafeInteger(source.atMs) ||
    source.atMs < 0 ||
    source.cluster !== cluster ||
    typeof source.fingerprint !== "string" ||
    source.fingerprint.length === 0 ||
    (source.latestAtMs !== undefined &&
      (typeof source.latestAtMs !== "number" ||
        !Number.isSafeInteger(source.latestAtMs) ||
        source.latestAtMs < source.atMs)) ||
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
  if (
    value.kind === "minute" &&
    (source.atMs % MINUTE_MS !== 0 ||
      (source.latestAtMs !== undefined && source.latestAtMs >= source.atMs + MINUTE_MS))
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
    tier: value.kind,
  };
}

function likelyTruncated(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("{") &&
    !trimmed.endsWith("}") &&
    /"kind"\s*:\s*"(?:sample|minute)"/.test(trimmed)
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

async function removeIfPresent(fileSystem: TokenHistoryFileSystem, path: string): Promise<void> {
  try {
    await fileSystem.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeAtomically(
  fileSystem: TokenHistoryFileSystem,
  path: string,
  content: string,
): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${temporaryFileSequence++}`;
  try {
    await fileSystem.writeFile(temporaryPath, content, "utf8");
    await fileSystem.rename(temporaryPath, path);
  } catch (error) {
    await removeIfPresent(fileSystem, temporaryPath).catch(() => undefined);
    throw error;
  }
}

function minuteAtMs(atMs: number): number {
  return Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
}

function minuteKey(fingerprint: string, atMs: number): string {
  return `${fingerprint}\u0000${atMs}`;
}

function validWeight(entry: StoredObservation): number {
  if (entry.tokensPerSecond === null) return 0;
  return entry.weight ?? 1;
}

function mergeMinuteEntries(
  left: StoredObservation | undefined,
  right: StoredObservation,
  atMs: number,
): StoredObservation {
  const leftWeight = left ? validWeight(left) : 0;
  const rightWeight = validWeight(right);
  const totalWeight = leftWeight + rightWeight;
  const weightedSum =
    (left?.tokensPerSecond ?? 0) * leftWeight + (right.tokensPerSecond ?? 0) * rightWeight;
  const latestAtMs = Math.max(
    left?.latestAtMs ?? left?.atMs ?? atMs,
    right.latestAtMs ?? right.atMs,
  );
  return {
    atMs,
    cluster: right.cluster,
    fingerprint: right.fingerprint,
    tokensPerSecond: totalWeight > 0 ? weightedSum / totalWeight : null,
    ...(totalWeight > 0 ? { weight: totalWeight } : {}),
    latestAtMs,
    tier: "minute",
  };
}

function addDailyEntry(
  dailyEntriesByDay: Map<string, Map<string, StoredObservation>>,
  entry: StoredObservation,
): string {
  const atMs = minuteAtMs(entry.atMs);
  const day = utcDay(atMs);
  const entries = dailyEntriesByDay.get(day) ?? new Map<string, StoredObservation>();
  const key = minuteKey(entry.fingerprint, atMs);
  const normalized: StoredObservation = {
    ...entry,
    atMs,
    tier: "minute",
    latestAtMs: entry.latestAtMs ?? entry.atMs,
  };
  entries.set(key, mergeMinuteEntries(entries.get(key), normalized, atMs));
  dailyEntriesByDay.set(day, entries);
  return day;
}

function flattenDailyEntries(
  dailyEntriesByDay: Map<string, Map<string, StoredObservation>>,
): StoredObservation[] {
  const entries: StoredObservation[] = [];
  for (const dayEntries of dailyEntriesByDay.values()) entries.push(...dayEntries.values());
  return entries;
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
  fileSystem = nativeFileSystem,
}: {
  dataDir: string;
  now: () => number;
  fileSystem?: TokenHistoryFileSystem;
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
      state = {
        rollingEntries: [],
        dailyEntriesByDay: new Map(),
        loaded: false,
        degraded: false,
      };
      clusters.set(cluster, state);
    }

    const rollingEntries: StoredObservation[] = [];
    const dailyEntriesByDay = new Map<string, Map<string, StoredObservation>>();
    let degraded = false;
    try {
      await fileSystem.mkdir(dataDir, { recursive: true });
      const files = await fileSystem.readdir(dataDir);
      const rollingName = `rolling-${hashIdentifier(cluster)}.ndjson`;
      const prefix = dayPrefix(cluster);
      const matchingFiles = files
        .filter((file) => file === rollingName || isDayFile(file, prefix))
        .sort();

      for (const file of matchingFiles) {
        const content = await fileSystem.readFile(join(dataDir, file), "utf8");
        const parsed = parseNdjson(content, cluster);
        degraded ||= parsed.degraded;
        if (file === rollingName) {
          rollingEntries.push(...parsed.entries);
        } else {
          for (const entry of parsed.entries) addDailyEntry(dailyEntriesByDay, entry);
        }
      }

      const deduplicatedRolling = rollingEntries.filter((entry) => {
        const atMs = minuteAtMs(entry.atMs);
        const aggregate = dailyEntriesByDay
          .get(utcDay(atMs))
          ?.get(minuteKey(entry.fingerprint, atMs));
        if (!aggregate) return true;
        return (entry.latestAtMs ?? entry.atMs) > (aggregate.latestAtMs ?? aggregate.atMs);
      });

      state.rollingEntries = deduplicatedRolling;
      state.dailyEntriesByDay = dailyEntriesByDay;
      state.degraded = degraded;
      state.loaded = true;
      return state;
    } catch (error) {
      state.rollingEntries = [];
      state.dailyEntriesByDay.clear();
      state.degraded = false;
      state.loaded = false;
      throw error;
    }
  }

  function sameObservation(left: StoredObservation, right: StoredObservation): boolean {
    return (
      left.tier === right.tier &&
      left.atMs === right.atMs &&
      left.cluster === right.cluster &&
      left.fingerprint === right.fingerprint &&
      left.tokensPerSecond === right.tokensPerSecond &&
      left.weight === right.weight &&
      left.latestAtMs === right.latestAtMs
    );
  }

  function sameObservationList(left: StoredObservation[], right: StoredObservation[]): boolean {
    return (
      left.length === right.length &&
      left.every((entry, index) => sameObservation(entry, right[index]))
    );
  }

  async function persistCluster(
    cluster: string,
    state: ClusterState,
    nowMs: number,
    forceRollingWrite = false,
  ): Promise<void> {
    const retentionCutoff = nowMs - DAILY_RETENTION_MS;
    const rollingCutoff = nowMs - ROLLING_RETENTION_MS;
    const compactBeforeMs = minuteAtMs(rollingCutoff);
    const rollingEntries = state.rollingEntries.filter(
      (entry) => entry.atMs >= retentionCutoff && minuteAtMs(entry.atMs) >= compactBeforeMs,
    );
    const entriesToCompact = state.rollingEntries.filter(
      (entry) => entry.atMs >= retentionCutoff && minuteAtMs(entry.atMs) < compactBeforeMs,
    );
    const pendingDailyEntries = new Map(state.dailyEntriesByDay);
    const copiedDays = new Set<string>();
    const changedDays = new Set<string>();

    function mutableDay(day: string): Map<string, StoredObservation> {
      if (!copiedDays.has(day)) {
        pendingDailyEntries.set(day, new Map(state.dailyEntriesByDay.get(day)));
        copiedDays.add(day);
      }
      return pendingDailyEntries.get(day)!;
    }

    for (const entry of entriesToCompact) {
      const day = utcDay(minuteAtMs(entry.atMs));
      mutableDay(day);
      addDailyEntry(pendingDailyEntries, entry);
      changedDays.add(day);
    }

    const retentionDay = utcDay(retentionCutoff);
    for (const day of [...pendingDailyEntries.keys()]) {
      if (day < retentionDay) {
        pendingDailyEntries.delete(day);
        changedDays.add(day);
        continue;
      }
      if (day !== retentionDay) continue;
      const current = pendingDailyEntries.get(day);
      if (!current) continue;
      const retainedDay = new Map(
        [...current.entries()].filter(
          ([, entry]) => (entry.latestAtMs ?? entry.atMs) >= retentionCutoff,
        ),
      );
      if (retainedDay.size !== current.size) {
        if (retainedDay.size === 0) pendingDailyEntries.delete(day);
        else pendingDailyEntries.set(day, retainedDay);
        changedDays.add(day);
      }
    }

    await fileSystem.mkdir(dataDir, { recursive: true });
    for (const day of [...changedDays].sort()) {
      const entries = pendingDailyEntries.get(day);
      if (!entries || entries.size === 0) {
        await removeIfPresent(fileSystem, dayPath(dataDir, cluster, day));
        continue;
      }
      const content =
        [...entries.values()]
          .sort(
            (left, right) =>
              left.atMs - right.atMs || left.fingerprint.localeCompare(right.fingerprint),
          )
          .map(serializeObservation)
          .join("\n") + "\n";
      await writeAtomically(fileSystem, dayPath(dataDir, cluster, day), content);
    }

    const rollingFile = rollingPath(dataDir, cluster);
    if (forceRollingWrite || !sameObservationList(state.rollingEntries, rollingEntries)) {
      if (rollingEntries.length === 0) {
        await removeIfPresent(fileSystem, rollingFile);
      } else {
        const content = rollingEntries.map(serializeObservation).join("\n") + "\n";
        await writeAtomically(fileSystem, rollingFile, content);
      }
    }

    state.rollingEntries = rollingEntries;
    state.dailyEntriesByDay = pendingDailyEntries;
  }

  return {
    record(observation) {
      return enqueue(async () => {
        if (closed) throw new Error("Token history store is closed");
        validateObservation(observation);
        const nowMs = now();
        if (!Number.isFinite(nowMs)) throw new Error("Invalid token history clock");
        const state = await loadCluster(observation.cluster);
        state.rollingEntries.push({ ...observation, tier: "sample" });
        try {
          await persistCluster(observation.cluster, state, nowMs, true);
        } catch (error) {
          state.rollingEntries = [];
          state.dailyEntriesByDay.clear();
          state.degraded = false;
          state.loaded = false;
          throw error;
        }
      });
    },

    query(query: TokenHistoryQuery) {
      return enqueue(async () => {
        if (closed) throw new Error("Token history store is closed");
        validateIdentifier(query.cluster, "cluster");
        if (!isTrendRange(query.range)) {
          throw new Error("Invalid token history range");
        }
        const nowMs = query.nowMs ?? now();
        if (!Number.isFinite(nowMs))
          return unavailableResult(query.cluster, query.range, Date.now());

        try {
          const state = await loadCluster(query.cluster);
          await persistCluster(query.cluster, state, nowMs);
          const entries = [
            ...state.rollingEntries,
            ...flattenDailyEntries(state.dailyEntriesByDay),
          ];
          const result = aggregateTokenHistory(entries, {
            cluster: query.cluster,
            range: query.range,
            nowMs,
            degraded: state.degraded,
          });
          if (state.degraded && result.state === "empty")
            return { ...result, state: "unavailable" };
          return result;
        } catch {
          const state = clusters.get(query.cluster);
          if (state) {
            state.rollingEntries = [];
            state.dailyEntriesByDay.clear();
            state.degraded = false;
            state.loaded = false;
          }
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
