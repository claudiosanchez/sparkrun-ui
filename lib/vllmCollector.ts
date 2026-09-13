import {
  deriveTokenRate,
  parseVllmMetrics,
  staleClusterSnapshot,
  unavailableClusterSnapshot,
  type CounterBaseline,
  type VllmClusterSnapshot,
} from "./vllmMetrics";

export const POLL_INTERVAL_MS = 2_000;
export const FETCH_TIMEOUT_MS = 3_000;
export const IDLE_GRACE_MS = 10_000;
export const MAX_METRICS_BYTES = 1_000_000;

export type VllmCollectorDependencies = {
  fetch: typeof globalThis.fetch;
  monotonicNow: () => number;
  wallNow: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
};

type Listener = (snapshot: VllmClusterSnapshot) => void;

export type CollectorEntry = {
  cluster: string;
  leaderHost: string;
  subscribers: Set<Listener>;
  baseline: CounterBaseline | null;
  lastSnapshot: VllmClusterSnapshot | null;
  controller: AbortController;
  running: Promise<void>;
  idleCleanup: ReturnType<typeof setTimeout> | null;
};

type PollErrorKind =
  | "timeout"
  | "redirect rejected"
  | "response too large"
  | "invalid metrics"
  | "unreachable"
  | `HTTP ${number}`;

class PollError extends Error {
  constructor(readonly kind: PollErrorKind) {
    super(kind);
    this.name = "PollError";
  }
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) done();
  });
}

function formatLeaderHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

export function metricsUrlForHost(host: string): string {
  return `http://${formatLeaderHost(host)}:8000/metrics`;
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) throw new PollError("invalid metrics");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let cancelled = false;
  const cancelReader = async () => {
    if (cancelled) return;
    cancelled = true;
    try {
      await reader.cancel();
    } catch {}
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        try {
          text += decoder.decode();
        } catch {
          throw new PollError("invalid metrics");
        }
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_METRICS_BYTES) {
        await cancelReader();
        throw new PollError("response too large");
      }
      try {
        text += decoder.decode(value, { stream: true });
      } catch {
        throw new PollError("invalid metrics");
      }
    }
  } catch (error) {
    await cancelReader();
    throw error;
  } finally {
    reader.releaseLock();
  }
  return text;
}

export async function fetchVllmMetrics(
  leaderHost: string,
  collectorSignal: AbortSignal,
  fetcher: typeof globalThis.fetch,
): Promise<string> {
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = AbortSignal.any([collectorSignal, timeoutSignal]);
  let response: Response;
  try {
    response = await fetcher(metricsUrlForHost(leaderHost), {
      signal,
      redirect: "error",
    });
  } catch (error) {
    if (collectorSignal.aborted) throw error;
    if (signal.aborted && timeoutSignal.aborted) throw new PollError("timeout");
    if (error instanceof Error && /redirect/i.test(error.message)) {
      throw new PollError("redirect rejected");
    }
    throw new PollError("unreachable");
  }

  if (
    response.redirected ||
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new PollError("redirect rejected");
  }
  if (!response.ok) throw new PollError(`HTTP ${response.status}`);
  return readBoundedText(response);
}

function sanitizedError(error: unknown): PollErrorKind {
  if (error instanceof PollError) return error.kind;
  return "unreachable";
}

function reading(value: number | null, observedAtMs: number) {
  return value === null
    ? { value: null, state: "unavailable" as const, observedAtMs }
    : { value, state: "live" as const, observedAtMs };
}

async function pollEntry(
  entry: CollectorEntry,
  dependencies: VllmCollectorDependencies,
): Promise<void> {
  const polledAtMs = Math.max(0, Math.trunc(dependencies.wallNow()));
  let text: string;
  try {
    text = await fetchVllmMetrics(entry.leaderHost, entry.controller.signal, dependencies.fetch);
  } catch (error) {
    if (entry.controller.signal.aborted) return;
    const message = sanitizedError(error);
    const next = entry.lastSnapshot
      ? staleClusterSnapshot(entry.lastSnapshot, polledAtMs, message)
      : unavailableClusterSnapshot(entry.cluster, polledAtMs, entry.leaderHost, message);
    entry.lastSnapshot = next;
    broadcast(entry, next);
    return;
  }

  if (entry.controller.signal.aborted) return;
  let parsed;
  try {
    parsed = parseVllmMetrics(text);
    if (
      parsed.generationTokenSeries === null &&
      parsed.runningRequests === null &&
      parsed.waitingRequests === null &&
      parsed.kvCachePercent === null
    ) {
      throw new PollError("invalid metrics");
    }
  } catch (error) {
    if (entry.controller.signal.aborted) return;
    const message = sanitizedError(error);
    const next = entry.lastSnapshot
      ? staleClusterSnapshot(entry.lastSnapshot, polledAtMs, message)
      : unavailableClusterSnapshot(entry.cluster, polledAtMs, entry.leaderHost, message);
    entry.lastSnapshot = next;
    broadcast(entry, next);
    return;
  }

  const observedAtMs = polledAtMs;
  const rate = deriveTokenRate(
    entry.baseline,
    parsed.generationTokenSeries,
    dependencies.monotonicNow(),
    observedAtMs,
  );
  entry.baseline = rate.baseline;
  const next: VllmClusterSnapshot = {
    cluster: entry.cluster,
    polledAtMs,
    sourceHost: entry.leaderHost,
    state: "live",
    error: null,
    metrics: {
      tokensPerSecond: rate.reading,
      runningRequests: reading(parsed.runningRequests, observedAtMs),
      waitingRequests: reading(parsed.waitingRequests, observedAtMs),
      kvCachePercent: reading(parsed.kvCachePercent, observedAtMs),
    },
  };
  entry.lastSnapshot = next;
  broadcast(entry, next);
}

function broadcast(entry: CollectorEntry, snapshot: VllmClusterSnapshot): void {
  for (const subscriber of entry.subscribers) {
    try {
      subscriber(snapshot);
    } catch {
      // A subscriber cannot interrupt collection for the other subscribers.
    }
  }
}

async function runEntry(
  entry: CollectorEntry,
  dependencies: VllmCollectorDependencies,
): Promise<void> {
  while (!entry.controller.signal.aborted) {
    await pollEntry(entry, dependencies);
    if (entry.controller.signal.aborted) return;
    await dependencies.wait(POLL_INTERVAL_MS, entry.controller.signal);
  }
}

export function createVllmCollectorRegistry(dependencies: Partial<VllmCollectorDependencies> = {}) {
  const resolved: VllmCollectorDependencies = {
    fetch: dependencies.fetch ?? globalThis.fetch.bind(globalThis),
    monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
    wallNow: dependencies.wallNow ?? (() => Date.now()),
    wait: dependencies.wait ?? defaultWait,
  };
  const entries = new Map<string, CollectorEntry>();

  function stopEntry(entry: CollectorEntry) {
    if (entry.idleCleanup) {
      clearTimeout(entry.idleCleanup);
      entry.idleCleanup = null;
    }
    entry.controller.abort();
    if (entries.get(entry.cluster) === entry) entries.delete(entry.cluster);
  }

  function scheduleIdleCleanup(entry: CollectorEntry) {
    if (entry.idleCleanup) return;
    entry.idleCleanup = setTimeout(() => {
      entry.idleCleanup = null;
      if (entry.subscribers.size === 0) stopEntry(entry);
    }, IDLE_GRACE_MS);
  }

  function subscribe(cluster: string, leaderHost: string, listener: Listener): () => void {
    const existing = entries.get(cluster);
    if (existing && existing.leaderHost !== leaderHost) stopEntry(existing);
    let entry = entries.get(cluster);
    if (!entry) {
      entry = {
        cluster,
        leaderHost,
        subscribers: new Set(),
        baseline: null,
        lastSnapshot: null,
        controller: new AbortController(),
        running: Promise.resolve(),
        idleCleanup: null,
      };
      entries.set(cluster, entry);
      entry.running = runEntry(entry, resolved).catch(() => undefined);
    } else if (entry.idleCleanup) {
      clearTimeout(entry.idleCleanup);
      entry.idleCleanup = null;
    }
    entry.subscribers.add(listener);
    if (entry.lastSnapshot) listener(entry.lastSnapshot);
    return () => {
      if (!entry || !entry.subscribers.delete(listener)) return;
      if (entry.subscribers.size === 0) scheduleIdleCleanup(entry);
    };
  }

  return {
    subscribe,
    getEntry: (cluster: string) => entries.get(cluster),
    stopAll: () => {
      for (const entry of [...entries.values()]) stopEntry(entry);
    },
    get size() {
      return entries.size;
    },
  };
}

export type VllmCollectorRegistry = ReturnType<typeof createVllmCollectorRegistry>;
