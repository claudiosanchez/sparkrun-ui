# Twin Reactor Live Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the original three-ring Twin Reactor display with real Sparkrun host telemetry and server-collected vLLM metrics for every saved cluster.

**Architecture:** Keep the existing independent `sparkrun cluster monitor` stream for all-host unified-memory and GPU-compute rings. Add one shared server-side vLLM collector/cache per cluster; it resolves only the first saved host as the serving leader, polls that host's port `8000`, parses the four allowed Prometheus metrics, and computes tokens per second from per-series counter deltas. The existing per-cluster store publishes only the reactor that changed, so no poll or stream refreshes the whole Dashboard.

**Tech Stack:** Next.js 16, React 19, TypeScript, oRPC event streams, Zod, native `fetch`, Prometheus text exposition, Tailwind CSS, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-twin-reactor-dashboard-design.md`

## Global Constraints

- Discover every target through `sparkrun cluster list --json`; the browser may provide a cluster name but never a host, port, or URL.
- The browser must contact only Sparkrun UI's same-origin `/rpc` endpoint. Only the server may fetch `http://<saved-host>:8000/metrics`.
- Keep one status stream, one monitor stream, one vLLM stream, and one model-health poll per saved cluster. A failure in C032 must not replace or rerender C458 state, and vice versa.
- Poll host telemetry every 2 seconds, vLLM metrics every 2 seconds with a 3-second request timeout, and model health every 10 seconds.
- Preserve a numeric zero as a live value. Use `null` plus an explicit state for unavailable, warming, stale, or reset values.
- Compute tokens per second on the server as the sum of matched per-series deltas divided by elapsed seconds. Match series by the complete Prometheus label set and use server monotonic time.
- Treat a lower token counter as a reset. Emit `state: "reset"` and `value: null`; do not emit a negative rate or a synthetic zero. Use the new counter as the next baseline.
- The outer ring is total unified-memory use from the Sparkrun monitor sample. The middle ring is vLLM KV-cache occupancy. The inner ring is GPU compute utilization from the Sparkrun monitor sample.
- Do not substitute GPU video memory for KV cache. Do not infer or fabricate KV used bytes or capacity bytes.
- Do not fabricate client or session counts. Keep their original center positions as `—` and label them as not collected.
- Do not change, restart, or reconfigure any model server. A UI deployment must not run a model lifecycle command.
- Keep the existing aggregate overview, saved-cluster overview, workload section, and all non-Dashboard routes.
- Add no Prometheus parsing dependency. The collector needs only four exact metric names and can parse their numeric sample lines directly.
- For a multi-host cluster, collect vLLM metrics from only the first saved host. The serving API can expose the same engine metrics on more than one host, so polling and summing every host would double-count. Continue to aggregate Sparkrun monitor memory and GPU values across every configured host.
- Share one in-process collector and last-snapshot cache per cluster across RPC subscribers. A browser reconnect must not create a second poll loop or discard a valid counter baseline.
- Limit a metrics response to 1,000,000 bytes and reject redirects. A saved host must not redirect the server to another network target.
- Deploy only the exact merged commit from a clean worktree. Keep the deployed revision and the integration branch aligned.

---

## Verified source evidence

The 2026-09-13 read-only audit found the same four exact vLLM series on both live configured services: `vllm:num_requests_running`, `vllm:num_requests_waiting`, `vllm:kv_cache_usage_perc`, and `vllm:generation_tokens_total`. The serving API is cluster-level, so the collector uses the first saved host as the fixed leader endpoint. Worker hosts may duplicate the service counters or may not expose port `8000`; they are not additional vLLM aggregate members.

The existing Sparkrun monitor remains authoritative for hardware telemetry across every configured host. The implementation must keep its all-host memory ratio and GPU average separate from the leader-only vLLM service metrics.

## Data contract and aggregation rules

Use these exact public types in `lib/vllmMetrics.ts`:

```ts
export const VllmMetricStateSchema = z.enum([
  "live",
  "warming",
  "stale",
  "unavailable",
  "reset",
]);
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
  }),
});
export type VllmClusterSnapshot = z.infer<typeof VllmClusterSnapshotSchema>;
```

The parser recognizes only these exact metric families, with or without labels:

| Prometheus metric | Collected value | Cluster meaning |
| --- | --- | --- |
| `vllm:generation_tokens_total` | Keep each full-label series separate and sum only matched, valid deltas | One serving-engine output rate from the first saved host |
| `vllm:num_requests_running` | Sum all series on the leader endpoint | One serving-engine running-request count |
| `vllm:num_requests_waiting` | Sum all series on the leader endpoint | One serving-engine waiting-request count |
| `vllm:kv_cache_usage_perc` | Arithmetic mean of series, multiplied by 100 and clamped to 0–100 | One serving-engine KV occupancy from the leader endpoint |

The current vLLM value for `kv_cache_usage_perc` is an occupancy fraction. A sample of `0.42` therefore becomes `42`, not `0.42`, in the UI contract.

Counter handling is deliberately strict:

- Key every generation-token counter baseline by its complete label set. Sort parsed labels when building the key so label order alone cannot create a new series.
- Emit a live rate only when the current and prior samples have the same series keys, every current value is finite and nonnegative, every counter is at least its prior value, and elapsed time is positive.
- If any counter decreases, emit reset with `value: null` and replace the baseline with the current valid series map.
- If a series is new, emit warming with `value: null` and replace the baseline. If a prior series disappears or a target series is invalid, emit unavailable with `value: null` and clear the baseline so the next valid sample warms up.
- After a failed poll, retain the last valid displayed values as stale. Do not advance or clear the counter baseline solely because the network poll failed.
- An idle but healthy server yields live `0` for throughput, running requests, waiting requests, or KV occupancy when the endpoint reports zero.

All-host aggregation applies only to the Sparkrun monitor stream. Unified-memory use is `sum(mem_used_mb) / sum(mem_total_mb)` across all configured hosts. GPU compute is the arithmetic mean of `gpu_util_pct` across all configured hosts. If any configured host or required value is missing, that ring remains unavailable rather than showing a partial result.

## File structure

| File | Responsibility |
| --- | --- |
| `lib/vllmMetrics.ts` | Parse the four vLLM metric families, preserve full-label counter series, derive rates, and mark stale/unavailable/reset state. |
| `lib/vllmMetrics.test.ts` | Prove parser, zero, full-label counter, series-churn, and stale rules. |
| `lib/vllmCollector.ts` | Own the shared per-cluster poll loop, counter baseline, last snapshot, subscriber set, and cleanup. |
| `lib/vllmCollector.test.ts` | Prove collector sharing, cached replay, reconnect continuity, cancellation, and cross-cluster isolation. |
| `lib/rpc/procedures/vllmMetrics.ts` | Resolve the saved leader host and subscribe the RPC stream to the shared collector. |
| `lib/rpc/procedures/vllmMetrics.test.ts` | Prove saved-leader resolution, URL construction, timeout, and arbitrary-host rejection. |
| `lib/rpc/router.ts` | Register `vllmMetrics.stream`. |
| `lib/reactorState.ts` | Combine Sparkrun and vLLM snapshots into display-safe three-ring and center state. |
| `lib/reactorState.test.ts` | Prove value-state copy, strict aggregation display, and no invented measurements. |
| `app/components/dashboard/useReactor.ts` | Own one cluster's independent vLLM subscription beside its existing streams and health poll. |
| `lib/useReactor.test.ts` | Prove request timeout helpers and state behavior used by the hook. |
| `app/components/dashboard/ReactorRings.tsx` | Render the three concentric accessible rings and center measurements. |
| `app/components/dashboard/ReactorCard.tsx` | Place the ring assembly, side labels, model name, freshness, and explanatory text. |
| `tests/dashboardLayout.test.ts` | Verify all three ring labels and the honest center fields in server-rendered markup. |
| `tests/dashboardConnections.test.ts` | Prevent a second stream owner and direct browser-to-host metrics access. |
| `docs/operations/deployments/2026-09-13-twin-reactor-live-metrics.md` | Record the merged commit, backup, test evidence, browser evidence, and rollback revision. |

### Task 1: Parse vLLM metrics and derive honest values

**Files:**
- Create: `lib/vllmMetrics.ts`
- Create: `lib/vllmMetrics.test.ts`

**Interfaces:**
- Consumes: Prometheus text, monotonic collection time, wall-clock observation time, and an optional per-series counter baseline.
- Produces: `parseVllmMetrics(text: string): ParsedVllmMetrics`, `deriveTokenRate(previous: CounterBaseline | null, current: ReadonlyMap<string, number> | null, monotonicMs: number, observedAtMs: number): TokenRateResult`, and `staleClusterSnapshot(previous, polledAtMs, error)`.

- [ ] **Step 1: Write failing parser and rate tests**

Create fixtures inline so the test documents labels, duplicate series, zeros, and irrelevant metrics:

```ts
const metrics = `
# HELP vllm:generation_tokens_total Number of generation tokens
vllm:generation_tokens_total{model_name="qwen",engine="0"} 120
vllm:generation_tokens_total{model_name="qwen",engine="1"} 80
vllm:num_requests_running{model_name="qwen"} 0
vllm:num_requests_waiting{model_name="qwen"} 2
vllm:kv_cache_usage_perc{model_name="qwen",engine="0"} 0.40
vllm:kv_cache_usage_perc{model_name="qwen",engine="1"} 0.60
process_cpu_seconds_total 999
`;

it("parses only the allowed vLLM families and preserves zero", () => {
  const parsed = parseVllmMetrics(metrics);
  expect([...parsed.generationTokenSeries.values()]).toEqual([120, 80]);
  expect(parsed).toMatchObject({
    runningRequests: 0,
    waitingRequests: 2,
    kvCachePercent: 50,
  });
});

it("uses elapsed monotonic time for tokens per second", () => {
  const prior = { series: new Map([[`engine="0",model_name="qwen"`, 200]]), monotonicMs: 1_000 };
  const current = new Map([[`engine="0",model_name="qwen"`, 260]]);
  expect(deriveTokenRate(prior, current, 3_000, 50_000).reading).toEqual({
    value: 30,
    state: "live",
    observedAtMs: 50_000,
  });
});

it("reports an idle interval as live zero", () => {
  const prior = { series: new Map([["model_name=\"qwen\"", 200]]), monotonicMs: 1_000 };
  const current = new Map([["model_name=\"qwen\"", 200]]);
  expect(deriveTokenRate(prior, current, 3_000, 50_000).reading).toMatchObject({
    value: 0,
    state: "live",
  });
});

it("reports a counter reset without a negative or synthetic rate", () => {
  const prior = { series: new Map([["model_name=\"qwen\"", 200]]), monotonicMs: 1_000 };
  const current = new Map([["model_name=\"qwen\"", 5]]);
  const result = deriveTokenRate(prior, current, 3_000, 50_000);
  expect(result.reading).toEqual({ value: null, state: "reset", observedAtMs: 50_000 });
  expect(result.baseline).toEqual({ series: current, monotonicMs: 3_000 });
});
```

Also test first-sample `warming`, missing family `unavailable`, `NaN`/`Inf` rejection, comments, timestamps after sample values, a zero-duration interval returning warming rather than dividing by zero, and equivalent label sets written in a different order producing the same canonical key.

- [ ] **Step 2: Run the tests and verify the red state**

Run: `pnpm vitest run lib/vllmMetrics.test.ts`

Expected: FAIL because `lib/vllmMetrics.ts` does not exist.

- [ ] **Step 3: Implement the exact-family parser and counter state**

Use this sample-line boundary; do not build a general Prometheus parser:

```ts
const allowed = new Set([
  "vllm:generation_tokens_total",
  "vllm:num_requests_running",
  "vllm:num_requests_waiting",
  "vllm:kv_cache_usage_perc",
]);
const sampleLine = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{[^}]*\})?\s+([^\s]+)(?:\s+\d+)?$/;
```

Trim each line, skip blank/comment lines, reject non-finite or negative samples, and collect values by exact family. Parse the label block into name/value pairs and create the generation counter key by sorting and joining every label pair. Preserve generation counters as `ReadonlyMap<string, number>`; do not collapse them before rate calculation. Sum request gauges. Average KV series, multiply by 100, then clamp to 0–100. Return `null` for a family with no valid samples.

Implement `deriveTokenRate` with a returned baseline so reset handling is explicit:

```ts
export type CounterBaseline = {
  series: ReadonlyMap<string, number>;
  monotonicMs: number;
};
export type TokenRateResult = {
  reading: VllmReading;
  baseline: CounterBaseline | null;
};
```

Never use `Date.now()` for elapsed time. Use it only for `observedAtMs` labels.

- [ ] **Step 4: Add strict series-churn and stale tests**

Test two unchanged label series with deltas of `60` and `0` over two seconds; expect a single live rate of `30`. Then test:

```ts
it("does not derive a rate across a changed series set", () => {
  const previous = baseline([["model=qwen,engine=0", 100]], 1_000);
  const current = new Map([
    ["model=qwen,engine=0", 120],
    ["model=qwen,engine=1", 5],
  ]);
  expect(deriveTokenRate(previous, current, 3_000, 60_000).reading).toMatchObject({
    value: null,
    state: "warming",
  });
});

it("retains values but marks them stale after a failed poll", () => {
  const stale = staleClusterSnapshot(liveSnapshot, 62_000, "HTTP 503");
  expect(stale.state).toBe("stale");
  expect(stale.metrics.tokensPerSecond).toMatchObject({ value: 30, state: "stale" });
  expect(stale.error).toBe("HTTP 503");
});
```

Also prove that a disappeared series and an invalid target sample produce unavailable/null and clear the baseline, while a decreased counter produces reset/null and adopts the current baseline.

- [ ] **Step 5: Run focused tests and commit the metric domain**

Run: `pnpm vitest run lib/vllmMetrics.test.ts`

Expected: PASS with live zero, warming, stale, unavailable, and reset represented separately.

```bash
git add lib/vllmMetrics.ts lib/vllmMetrics.test.ts
git commit -m "feat: define honest vLLM telemetry values"
```

### Task 2: Collect vLLM metrics on the server

**Files:**
- Create: `lib/vllmCollector.ts`
- Create: `lib/vllmCollector.test.ts`
- Create: `lib/rpc/procedures/vllmMetrics.ts`
- Create: `lib/rpc/procedures/vllmMetrics.test.ts`
- Modify: `lib/rpc/router.ts`

**Interfaces:**
- Consumes: `vllmMetrics.stream({ cluster: string })` with an oRPC abort signal. The server owns the fixed 2-second cadence.
- Produces: an `eventIterator(VllmClusterSnapshotSchema)`; no host or URL appears in the input.
- Uses: `createVllmCollectorRegistry(dependencies)`, `registry.subscribe(cluster, leaderHost, listener)`, and `streamClusterMetrics(input, signal, registry, listSavedClusters)` as exported test seams.

- [ ] **Step 1: Write failing saved-host and fetch tests**

Define injectable dependencies in the procedure module:

```ts
export type VllmCollectorDependencies = {
  fetch: typeof globalThis.fetch;
  listSavedClusters: (signal: AbortSignal) => Promise<ClusterEntry[]>;
  monotonicNow: () => number;
  wallNow: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
};
```

Test that `streamClusterMetrics` resolves `c458` to its first saved host, calls exactly `http://100.83.161.109:8000/metrics`, and emits no arbitrary URL supplied by a caller. The only input schema field must be `cluster`.

For a saved cluster with `hosts: ["leader.example", "worker.example"]`, assert only `http://leader.example:8000/metrics` is fetched. Assert the worker endpoint is never called and its values are never summed. Test a missing cluster and an empty saved-host list. Both must emit a snapshot with `sourceHost: null`, unavailable readings, and no fetch.

Test a non-OK response, rejected fetch, invalid text, redirect response, and oversized response. A failed first poll is unavailable. A failure after a valid poll retains the cached values as stale.

- [ ] **Step 2: Run the collector tests and verify the red state**

Run: `pnpm vitest run lib/rpc/procedures/vllmMetrics.test.ts`

Expected: FAIL because the collector procedure does not exist.

- [ ] **Step 3: Implement the bounded leader fetch**

Use `AbortSignal.any([collectorSignal, AbortSignal.timeout(3_000)])`. Call fetch with `{ signal, redirect: "error" }`. Set `MAX_METRICS_BYTES = 1_000_000`. Read `response.body` through a reader, count bytes before decoding, cancel and fail as `response too large` as soon as the cap is exceeded. Reject a missing body, non-OK status, redirect, invalid UTF-8, or invalid target metrics. Never include a response body or stack trace in the client error.

Build the URL only after saved-cluster resolution. Use the first entry from `ClusterEntry.hosts`; handle an IPv6 literal by wrapping it in brackets. Do not follow redirects because a saved endpoint must not redirect the server to an untrusted target.

- [ ] **Step 4: Implement one shared collector/cache per cluster**

`lib/vllmCollector.ts` owns a module-level production registry created through the injectable factory. Each registry entry contains:

```ts
type CollectorEntry = {
  cluster: string;
  leaderHost: string;
  subscribers: Set<(snapshot: VllmClusterSnapshot) => void>;
  baseline: CounterBaseline | null;
  lastSnapshot: VllmClusterSnapshot | null;
  controller: AbortController;
  running: Promise<void>;
  idleCleanup: ReturnType<typeof setTimeout> | null;
};
```

The key is the cluster name. If a later subscription resolves the same name to a different leader, stop and replace the old entry before subscribing. Start the sequential poll loop on the first subscriber. Replay `lastSnapshot` immediately to a reconnecting subscriber. When the last subscriber leaves, schedule abort and deletion after a fixed 10-second reconnect grace period. Cancel that cleanup if a subscriber returns. The short grace preserves cache and counter baselines across normal transport reconnects without leaving permanent background work.

One loop performs fetch, parse, rate derivation, cache update, and broadcast, then waits 2 seconds. Requests never overlap. On a valid response, update the per-series baseline and cached snapshot. On a failed response, leave the baseline unchanged and publish `staleClusterSnapshot(lastSnapshot, ...)`; if no valid snapshot exists, publish unavailable/null. Use only sanitized categories: `timeout`, `HTTP <status>`, `redirect rejected`, `response too large`, `invalid metrics`, or `unreachable`.

Use module constants `POLL_INTERVAL_MS = 2_000`, `FETCH_TIMEOUT_MS = 3_000`, `IDLE_GRACE_MS = 10_000`, and `MAX_METRICS_BYTES = 1_000_000`. The production wait and idle cleanup must clear their timers when the collector aborts.

- [ ] **Step 5: Prove sharing, cancellation, and independent clusters**

Subscribe two listeners to C032 and assert one fetch loop serves both. After one valid sample, unsubscribe both and reconnect within 10 seconds; assert the reconnect cancels cleanup, receives the cached snapshot, and the next sample derives from the existing baseline instead of warming again. Advance fake timers past 10 seconds with no subscriber and assert only the C032 controller aborts and registry entry disappears. Assert C032 and C458 have separate entries, baselines, fetch loops, and cleanup timers.

Register the route:

```ts
import * as vllmMetrics from "./procedures/vllmMetrics";

export const router = {
  // existing routes stay unchanged
  vllmMetrics: { stream: vllmMetrics.stream },
};
```

- [ ] **Step 6: Run focused tests and commit the server stream**

Run: `pnpm vitest run lib/vllmMetrics.test.ts lib/vllmCollector.test.ts lib/rpc/procedures/vllmMetrics.test.ts`

Expected: PASS; only the saved leader is fetched, responses are bounded, redirects are rejected, subscribers share one collector, and clusters remain isolated.

```bash
git add lib/vllmCollector.ts lib/vllmCollector.test.ts \
  lib/rpc/procedures/vllmMetrics.ts lib/rpc/procedures/vllmMetrics.test.ts lib/rpc/router.ts
git commit -m "feat: stream saved-cluster vLLM metrics"
```

### Task 3: Integrate vLLM state without broad Dashboard rerenders

**Files:**
- Modify: `lib/reactorState.ts`
- Modify: `lib/reactorState.test.ts`
- Modify: `app/components/dashboard/useReactor.ts`
- Modify: `lib/useReactor.test.ts`
- Modify: `lib/reactorStateStore.test.ts`

**Interfaces:**
- Consumes: `VllmClusterSnapshot | null` and `vllmReconnecting: boolean` in `deriveReactorState`.
- Produces: `rings.memory`, `rings.kv`, `rings.gpu`, plus `inference.tokensPerSecond`, `runningRequests`, `waitingRequests`, `clients`, and `sessions` on `ReactorState`.
- Preserves: `ReactorStateProvider` remains the single owner per cluster, and `createReactorStateStore.publish(name, next)` notifies only listeners for that cluster.

- [ ] **Step 1: Write failing reactor-state tests**

Add a live vLLM snapshot and assert the exact UI state:

```ts
const vllm = VllmClusterSnapshotSchema.parse({
  cluster: "c032",
  polledAtMs: 50_000,
  sourceHost: "100.65.40.24",
  state: "live",
  error: null,
  metrics: {
    tokensPerSecond: { value: 42.6, state: "live", observedAtMs: 50_000 },
    runningRequests: { value: 1, state: "live", observedAtMs: 50_000 },
    waitingRequests: { value: 0, state: "live", observedAtMs: 50_000 },
    kvCachePercent: { value: 37.5, state: "live", observedAtMs: 50_000 },
  },
});

it("maps the original three rings to real sources", () => {
  const state = deriveReactorState({ cluster: c032Entry, tick: c032Tick, vllm });
  expect(state.rings).toMatchObject({
    memory: { percent: 50, source: "sparkrun-monitor" },
    kv: { percent: 37.5, source: "vllm-metrics" },
    gpu: { percent: 70, source: "sparkrun-monitor" },
  });
  expect(state.inference).toMatchObject({
    tokensPerSecondText: "42.6",
    runningText: "1",
    queuedText: "0",
    clientsText: "—",
    sessionsText: "—",
  });
});
```

Add separate cases for a live zero, warming, stale, unavailable, and reset token rate. A reset must render `—` with `Counter reset · calculating rate`; stale must retain the number and include `stale`; unavailable and warming must render `—`, not `0`.

Assert that missing KV renders an empty middle ring with `KV cache occupancy unavailable`. Assert that GPU-memory data cannot populate the KV ring. Assert that no input can make clients or sessions numeric.

- [ ] **Step 2: Run reactor-state tests and verify the red state**

Run: `pnpm vitest run lib/reactorState.test.ts`

Expected: FAIL because `deriveReactorState` does not yet accept vLLM state or expose three rings.

- [ ] **Step 3: Extend `deriveReactorState` with typed ring and center state**

Add these fields without parsing display strings:

```ts
rings: {
  memory: { label: "Total unified memory", percent: number | null, detail: string, source: "sparkrun-monitor" },
  kv: { label: "KV cache occupancy", percent: number | null, detail: "Capacity not reported", source: "vllm-metrics", state: VllmMetricState },
  gpu: { label: "GPU compute utilization", percent: number | null, detail: "Compute load", source: "sparkrun-monitor" },
},
inference: {
  state: VllmMetricState,
  stateText: string,
  tokensPerSecond: number | null,
  tokensPerSecondText: string,
  runningText: string,
  queuedText: string,
  clientsText: "—",
  sessionsText: "—",
},
```

Derive unified-memory percent from the raw summed `mem_used_mb / mem_total_mb`. Do not recover it by parsing `memoryText`. Clamp ring percentages only at the render boundary, not in the domain calculation.

- [ ] **Step 4: Add the independent vLLM subscription to `useReactor`**

Add state:

```ts
const [vllm, setVllm] = useState<VllmClusterSnapshot | null>(null);
const [vllmReconnecting, setVllmReconnecting] = useState(false);
```

Open it through the existing generic `subscribe` loop:

```ts
void subscribe(
  () => rpc.vllmMetrics.stream({ cluster: name }, { signal }),
  setVllm,
  setVllmReconnecting,
);
```

Pass both fields to `deriveReactorState`. Keep the existing owner `AbortController`; cleanup aborts all three streams for that card but no other card. Do not add a subscription to `ReactorCard`, `ReactorRings`, `ClusterOverviewCard`, or `TwinReactorFleet`.

Do not add a short client deadline to the long-lived stream. The server bounds each poll at 3 seconds, and the existing owner abort signal closes the stream when that reactor source unmounts.

- [ ] **Step 5: Verify store isolation and commit integration**

Add a `reactorStateStore` assertion that publishing a new C032 throughput value calls only the C032 listener. Run:

`pnpm vitest run lib/reactorState.test.ts lib/reactorStateStore.test.ts lib/useReactor.test.ts tests/dashboardConnections.test.ts`

Expected: PASS; the new data flows through the existing per-cluster owner and store.

```bash
git add lib/reactorState.ts lib/reactorState.test.ts lib/reactorStateStore.test.ts \
  app/components/dashboard/useReactor.ts lib/useReactor.test.ts
git commit -m "feat: join vLLM metrics into reactor state"
```

### Task 4: Restore the original three-ring reactor UI

**Files:**
- Create: `app/components/dashboard/ReactorRings.tsx`
- Modify: `app/components/dashboard/ReactorCard.tsx`
- Modify: `tests/dashboardLayout.test.ts`
- Modify: `tests/dashboardConnections.test.ts`

**Interfaces:**
- Consumes: `ReactorState["rings"]`, `ReactorState["inference"]`, and model text.
- Produces: three nested progress rings, three matching side measurements, and the original center hierarchy with honest unavailable labels.

- [ ] **Step 1: Write failing static-render tests**

Update the Dashboard layout test to require all original ring labels and center fields:

```ts
for (const label of [
  "Total unified memory",
  "KV cache occupancy",
  "GPU compute utilization",
  "Tokens / sec",
  "Clients",
  "Sessions",
  "Running",
  "Queued",
]) {
  expect(html).toContain(label);
}
expect(html.match(/role="progressbar"/g) ?? []).toHaveLength(3);
expect(html).toContain("Client and session counts are not collected");
```

Render a standalone `ReactorRings` with live zero values and assert `aria-valuenow="0"`. Render unavailable KV and assert `aria-valuetext="Not reported"` with no numeric KV value.

In `tests/dashboardConnections.test.ts`, assert only `useReactor.ts` contains `rpc.vllmMetrics.stream`, and assert it contains no string matching `http://` plus `:8000/metrics`. This guards against browser-side host polling.

- [ ] **Step 2: Run layout and connection tests and verify the red state**

Run: `pnpm vitest run tests/dashboardLayout.test.ts tests/dashboardConnections.test.ts`

Expected: FAIL because the current card renders only one GPU ring.

- [ ] **Step 3: Implement the reusable ring renderer**

Render outer, middle, and inner SVG circles with separate radii and stroke widths. Every ring uses `pathLength="100"` and `strokeDasharray={`${clamped} 100`}`. When a percentage is null, use `strokeDasharray="0 100"`, omit `aria-valuenow`, and set `aria-valuetext="Not reported"`.

Use the original order and labels:

```ts
const ordered = [rings.memory, rings.kv, rings.gpu];
```

Use distinct but restrained colors that remain visible in both themes: emerald for unified memory, cyan for KV cache, and sky for GPU compute. Do not copy the standalone widget stylesheet. Add `motion-reduce:transition-none` to ring transitions.

The center shows the served model, `Tokens / sec`, the rate, then a two-by-two definition list for Clients, Sessions, Running, and Queued. Clients and Sessions always show `—`. Add a nearby sentence: `Client and session counts are not collected.`

- [ ] **Step 4: Replace the single GPU ring in `ReactorCard`**

Keep cluster identity, default badge, telemetry/model-health badges, and freshness text. Replace the existing 44-by-44 SVG with `ReactorRings`. Place side measurements beside the rings on wide cards and above them in reading order on narrow cards. For KV detail, show `Capacity not reported`; never reuse `gpuMemoryText`.

When inference is warming or reset, show the state text under tokens per second. When it is stale, keep the last numeric value and mark it stale. Add `aria-live="polite"` to the inference state text, not to each animated SVG.

- [ ] **Step 5: Run focused tests and commit the visual slice**

Run: `pnpm vitest run tests/dashboardLayout.test.ts tests/dashboardConnections.test.ts lib/reactorState.test.ts`

Expected: PASS; static markup contains three accessible rings and no invented center or KV values.

```bash
git add app/components/dashboard/ReactorRings.tsx app/components/dashboard/ReactorCard.tsx \
  tests/dashboardLayout.test.ts tests/dashboardConnections.test.ts
git commit -m "feat: restore Twin Reactor metric rings"
```

### Task 5: Validate the complete slice

**Files:**
- Modify only if a test exposes a defect in files from Tasks 1–4.

**Interfaces:**
- Consumes: the complete feature branch.
- Produces: a clean, production-buildable commit with no direct browser metrics access.

- [ ] **Step 1: Run all automated gates**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:ci
pnpm build
```

Expected: all commands exit zero. If formatting fails, run `pnpm format`, inspect the changed paths, and commit only feature files with `style: format Twin Reactor metrics`.

- [ ] **Step 2: Review the feature diff for forbidden substitutions and URLs**

```bash
rg -n "gpuMemory|gpu_mem|client.*[0-9]|session.*[0-9]|:8000/metrics" \
  app/components/dashboard lib tests
git diff --check
git status --short
```

Expected: `:8000/metrics` appears only in server procedure/tests; no KV derivation reads GPU-memory fields; clients and sessions have no numeric fallback; the worktree is clean.

- [ ] **Step 3: Review counter and aggregation behavior from tests**

Run:

```bash
pnpm vitest run lib/vllmMetrics.test.ts lib/vllmCollector.test.ts \
  lib/rpc/procedures/vllmMetrics.test.ts \
  lib/reactorState.test.ts lib/reactorStateStore.test.ts tests/dashboardConnections.test.ts
```

Expected: tests explicitly pass for live zero, first-sample warming, endpoint unavailable, retained stale value, counter reset, new/missing/invalid label series, shared collection, leader-only collection, and per-cluster listener isolation.

### Task 6: Merge only the metrics slice

**Files:**
- No product files.

**Interfaces:**
- Consumes: a clean `codex/twin-reactor-live-metrics` branch based on the current deployed Twin Reactor line.
- Produces: one reviewed merge commit on `claudio-fork/codex/twin-reactor-dashboard` whose PR diff contains only this plan and Tasks 1–4.

- [ ] **Step 1: Preserve the exact deployed baseline before feature work**

The local Twin Reactor worktree is currently ahead of its tracking branch with prior deployed work. Do not open this feature directly against fork `main`; that would mix the live-metrics slice with historical Dashboard commits. Before coding, record the clean baseline and fast-forward the existing remote integration branch without force:

```bash
git status --short
git rev-parse HEAD
git fetch claudio-fork
git merge-base --is-ancestor claudio-fork/codex/twin-reactor-dashboard HEAD
git push claudio-fork HEAD:codex/twin-reactor-dashboard
git switch -c codex/twin-reactor-live-metrics
```

Expected: status is empty; the ancestry check exits zero; the push is a fast-forward. Stop on a non-fast-forward result. Do not rebase, force-push, or absorb a remote commit without review.

- [ ] **Step 2: Verify the PR delta before opening it**

After implementation and all gates:

```bash
git fetch claudio-fork
git log --oneline claudio-fork/codex/twin-reactor-dashboard..HEAD
git diff --stat claudio-fork/codex/twin-reactor-dashboard...HEAD
git diff --name-only claudio-fork/codex/twin-reactor-dashboard...HEAD
```

Expected paths are the plan, the vLLM metric domain/procedure/tests, router, reactor state/hook/tests, ring/card files, and Dashboard tests listed above. Any older deployment or unrelated product file means the base is wrong; stop and fix the branch relationship before opening the pull request.

- [ ] **Step 3: Push, open, and merge the focused PR**

```bash
git push -u claudio-fork codex/twin-reactor-live-metrics
gh pr create --repo claudiosanchez/sparkrun-ui \
  --base codex/twin-reactor-dashboard \
  --head codex/twin-reactor-live-metrics \
  --title "feat: add live metrics to Twin Reactor" \
  --body "Adds server-side saved-host vLLM collection, honest counter-rate states, strict multi-host aggregation, and the original three-ring reactor UI."
gh pr checks --repo claudiosanchez/sparkrun-ui --watch
gh pr merge --repo claudiosanchez/sparkrun-ui --merge --delete-branch=false
```

Use the PR number returned by `gh pr create` for both later commands if the installed CLI requires an explicit number. Do not merge while a required check is failing.

- [ ] **Step 4: Check out and verify the exact merged revision**

```bash
git fetch claudio-fork
git switch codex/twin-reactor-dashboard
git merge --ff-only claudio-fork/codex/twin-reactor-dashboard
git status --short
git rev-parse HEAD
gh pr view --repo claudiosanchez/sparkrun-ui --json state,mergeCommit,baseRefName,headRefName
```

Expected: PR state is `MERGED`; base is `codex/twin-reactor-dashboard`; local HEAD equals `mergeCommit.oid`; status is empty. Save that full 40-character object ID as `MERGED_REVISION` for deployment.

This integration-branch PR is the safe release unit. Promoting the accumulated Dashboard line into fork `main` requires a separate PR whose full historical diff is reviewed explicitly.

### Task 7: Deploy the merged commit and verify the real Dashboard

**Files:**
- Create: `docs/operations/deployments/2026-09-13-twin-reactor-live-metrics.md`

**Interfaces:**
- Consumes: the exact `MERGED_REVISION`, the existing Coxshire standalone deployment runbook, and a clean integration branch.
- Produces: a reversible Coxshire deployment and user-visible proof for C032 and C458.

- [ ] **Step 1: Run deployment preflight**

Read `docs/operations/coxshire-sparkrun-ui-deployment.md` and `/Users/claudio/.codex/ssh.md`. Then verify:

```bash
git status --short
git rev-parse HEAD
git rev-parse claudio-fork/codex/twin-reactor-dashboard
ssh -G coxshire | sed -n 's/^\(hostname\|user\|identityfile\) /\1 /p'
ssh -o BatchMode=yes coxshire \
  'id -un; test -x /Users/claudio/.local/bin/sparkrun; /Users/claudio/.local/bin/sparkrun --version; pgrep -af "/Users/claudio/sparkrun-ui/.next/standalone/server.js" || true'
```

Expected: local HEAD, remote integration ref, and `MERGED_REVISION` are identical; source is clean; Coxshire host identity matches the documented target; one identifiable UI process is present. Stop for an SSH host-key warning, missing binary, ambiguous process, or revision mismatch.

- [ ] **Step 2: Back up and sync only the merged source**

Follow the existing runbook. Create a timestamped backup under `/Users/claudio/sparkrun-ui-backups/`, record the path, then rsync the clean worktree to `/Users/claudio/sparkrun-ui` with `.git`, `.next`, `node_modules`, `.superpowers`, and secrets excluded. Verify both source roots before any `--delete` sync.

- [ ] **Step 3: Build and restart the standalone UI only**

Build with the pinned Node 24 runtime and `corepack pnpm install --frozen-lockfile && corepack pnpm build`. Populate `.next/standalone/public` and `.next/standalone/.next/static` as the runbook specifies. Stop only the verified prior UI PID, then start:

```bash
NODE_ENV=production PORT=5678 HOSTNAME=0.0.0.0 \
SPARKRUN_BIN=/Users/claudio/.local/bin/sparkrun \
/Users/claudio/.nvm/versions/node/v24.21.0/bin/node .next/standalone/server.js
```

Do not run Sparkrun start/stop commands or touch either vLLM process.

- [ ] **Step 4: Verify HTTP and browser behavior**

First verify Coxshire-local and Tailnet HTTP 200:

```bash
ssh -o BatchMode=yes coxshire 'curl -fsS http://127.0.0.1:5678/dashboard >/dev/null'
curl -fsS http://100.78.146.12:5678/dashboard >/dev/null
```

Then use the browser-testing-with-devtools skill against `http://100.78.146.12:5678/dashboard`:

- At 1440 × 900, confirm C032 and C458 each show three concentric rings in the order unified memory, KV cache, GPU compute.
- Wait at least two vLLM intervals. Confirm idle zero appears as `0` or `0.0`, while unavailable values appear as `—` with a reason.
- Confirm Running and Queued show live counts. Confirm Clients and Sessions remain `—` and the not-collected explanation is visible.
- Use the existing same-origin Chat UI for one short generation. Confirm the matching reactor's tokens-per-second value becomes positive during output and later returns to a live zero. Do not call a host model endpoint from the browser.
- Inspect browser network requests. Confirm they target the UI origin `/rpc`; no request goes from the browser to `100.65.40.24:8000`, `100.83.161.109:8000`, or any saved-host metrics URL.
- At 390 × 844, confirm ring labels, center values, and both reactor cards remain readable without horizontal overflow.
- Confirm the aggregate overview, saved-cluster overview, workloads, `/monitor`, and `/chat` still load.

Capture one desktop screenshot and one mobile screenshot. Do not save a browser trace because it can retain cookies or request data.

- [ ] **Step 5: Prove the deployed code equals the merge commit**

Add a deployed revision file during source sync or compare a deterministic archive hash. The preferred release record is to write the already verified commit ID to `/Users/claudio/sparkrun-ui/DEPLOYED_REVISION` after sync, then read it back:

```bash
ssh -o BatchMode=yes coxshire 'tr -d "\n" < /Users/claudio/sparkrun-ui/DEPLOYED_REVISION'
```

Expected: the value exactly equals `MERGED_REVISION`. Also record the new UI PID and verify it runs from `/Users/claudio/sparkrun-ui/.next/standalone/server.js`.

- [ ] **Step 6: Record deployment and rollback evidence**

Create `docs/operations/deployments/2026-09-13-twin-reactor-live-metrics.md` with:

- PR URL and merge commit.
- Local branch and remote integration ref.
- Coxshire source root, backup path, deployed revision file value, PID, and timestamp.
- Results of tests, typecheck, lint, formatting, and production build.
- C032 and C458 ring values and states observed after two intervals.
- Positive-to-zero tokens-per-second observation from the same-origin Chat check.
- Confirmation that browser network traffic never contacted port `8000` directly.
- Desktop and mobile screenshot paths.
- Rollback steps: stop only the recorded UI PID, restore the timestamped backup to `/Users/claudio/sparkrun-ui`, rebuild standalone output with the same Node and `SPARKRUN_BIN`, restart, and verify both HTTP and browser Dashboard behavior.

Commit the deployment record after live verification:

```bash
git add docs/operations/deployments/2026-09-13-twin-reactor-live-metrics.md
git commit -m "docs: record Twin Reactor metrics deployment"
```

Push this documentation commit to the integration branch. Do not describe it as the deployed application revision; the application deployment remains pinned to `MERGED_REVISION` recorded inside the document.

## Final self-review checklist

- [ ] Every displayed number has one named source or is `—`.
- [ ] Zero, warming, stale, unavailable, and counter reset have separate tests and labels.
- [ ] The browser never receives or constructs a saved-host metrics URL.
- [ ] KV occupancy comes only from `vllm:kv_cache_usage_perc`.
- [ ] KV bytes, client counts, and session counts remain unavailable because no source provides them.
- [ ] Multi-host hardware aggregation uses every monitor host, while vLLM collection uses only the first saved leader host and never duplicates service totals.
- [ ] Metrics redirects and responses above 1,000,000 bytes are rejected.
- [ ] Generation-token baselines use full canonical label sets; reset, new, missing, and invalid series never produce a rate.
- [ ] Each cluster owns and publishes its own subscriptions.
- [ ] The PR diff contains only the live-metrics slice relative to the updated integration branch.
- [ ] The deployed application commit exactly equals the PR merge commit.
