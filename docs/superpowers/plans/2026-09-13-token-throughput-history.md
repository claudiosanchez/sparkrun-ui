# Token Throughput History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every saved cluster an honest, durable Tokens/s history card for 15m, 1d, 7d, and 30d.

**Architecture:** A process-owned recorder receives validated vLLM snapshots from the existing server-side collector and persists nullable Tokens/s observations in an application-owned file store. A same-origin RPC returns bounded, timestamped series. The dashboard renders a separate, per-cluster card without changing the existing overview or Twin Reactor cards. The collector is deployed first so time-series data begins accumulating before the full UI ships.

**Tech Stack:** Next.js 16 standalone server, React 19, TypeScript, oRPC, Zod, Node filesystem APIs, Recharts, Vitest, Tailwind CSS.

**Spec:** docs/superpowers/specs/2026-09-13-token-throughput-history-design.md

## Global Constraints

- Render one Token/s history card for every saved cluster; never hardcode C032 or C458.
- Do not change, rename, replace, or reorder the existing aggregate Cluster overview, saved-cluster overview, or Twin Reactor fleet.
- All history collection stays server-side. The browser never chooses a host, URL, file path, or arbitrary collector target.
- A numeric zero Tokens/s sample is valid. Warming, reset, stale, unavailable, and missing readings are gaps.
- History collection runs with no open dashboard and creates no additional browser monitor stream.
- Store data in SPARKRUN_UI_DATA_DIR, never inside Sparkrun-owned cache files. One UI process owns one data directory in this release.
- Preserve the existing 2-second live stream cadence when a browser subscribes. Recorder-only cadence may be 5 seconds.
- The API returns no more than 360 timestamped points per cluster/range and represents elapsed gaps with null values.
- Every delivery slice uses the local fork: test, review, PR into claudio-fork/main, merge, deploy the merged commit to Coxshire, then verify live. Do not alter model services.

---

### Task 1: Define durable Tokens/s history and file storage

**Files:**
- Create: lib/tokenHistory.ts
- Create: lib/tokenHistoryFileStore.ts
- Create: lib/tokenHistory.test.ts
- Create: lib/tokenHistoryFileStore.test.ts

**Interfaces:**
- Produces `TrendRange = "15m" | "1d" | "7d" | "30d"`.
- Produces `TokenObservation`, `TokenHistoryPoint`, `TokenHistoryResult`, and `TokenHistoryStore`.
- Produces `createTokenHistoryFileStore({ dataDir, now })` with `record()`, `query()`, and `close()`.
- Produces `rangePolicy(range)`.

- [ ] **Step 1: Write a failing range and gap test**

```ts
it("keeps a zero sample and materializes a missing bucket as null", () => {
  const policy = rangePolicy("15m");
  const result = aggregateTokenHistory(
    [
      { atMs: 1_000, cluster: "c032", fingerprint: "a", tokensPerSecond: 0 },
      { atMs: 11_000, cluster: "c032", fingerprint: "a", tokensPerSecond: 20 },
    ],
    { range: "15m", nowMs: policy.bucketMs * 3 },
  );
  expect(result.points.map((point) => point.tokensPerSecond)).toContain(0);
  expect(result.points.map((point) => point.tokensPerSecond)).toContain(null);
});
```

- [ ] **Step 2: Run the test red**

Run: `pnpm vitest run lib/tokenHistory.test.ts`

Expected: FAIL because `./tokenHistory` does not exist.

- [ ] **Step 3: Implement the pure model and range policy**

```ts
export type TrendRange = "15m" | "1d" | "7d" | "30d";
export type TokenObservation = {
  atMs: number;
  cluster: string;
  fingerprint: string;
  tokensPerSecond: number | null;
};
export type TokenHistoryPoint = { atMs: number; tokensPerSecond: number | null };
export type TokenHistoryResult = {
  cluster: string;
  fingerprint: string | null;
  range: TrendRange;
  fromMs: number;
  toMs: number;
  resolutionMs: number;
  state: "ready" | "partial" | "empty" | "unavailable";
  coverage: number;
  points: TokenHistoryPoint[];
};
export function rangePolicy(range: TrendRange) {
  if (range === "15m") return { durationMs: 15 * 60_000, bucketMs: 5_000 };
  if (range === "1d") return { durationMs: 24 * 60 * 60_000, bucketMs: 5 * 60_000 };
  if (range === "7d") return { durationMs: 7 * 24 * 60 * 60_000, bucketMs: 30 * 60_000 };
  return { durationMs: 30 * 24 * 60 * 60_000, bucketMs: 2 * 60 * 60_000 };
}
```

Use weighted sums and valid counts. Query only the newest host-fingerprint series inside the requested range. Emit an explicit null point for every time bucket with no numeric sample.

- [ ] **Step 4: Write a failing restart-recovery test**

```ts
it("retains observations across a store restart", async () => {
  const first = createTokenHistoryFileStore({ dataDir: tempDir, now: () => 60_000 });
  await first.record({ atMs: 10_000, cluster: "c032", fingerprint: "host-a", tokensPerSecond: 7 });
  await first.close();

  const second = createTokenHistoryFileStore({ dataDir: tempDir, now: () => 60_000 });
  const result = await second.query({ cluster: "c032", range: "15m", nowMs: 60_000 });
  expect(result.points.some((point) => point.tokensPerSecond === 7)).toBe(true);
});
```

- [ ] **Step 5: Run the test red**

Run: `pnpm vitest run lib/tokenHistoryFileStore.test.ts`

Expected: FAIL because `./tokenHistoryFileStore` does not exist.

- [ ] **Step 6: Implement the file store**

```ts
export function createTokenHistoryFileStore({
  dataDir,
  now,
}: {
  dataDir: string;
  now: () => number;
}): TokenHistoryStore {
  // Serialize writes in this process. Keep a five-second rolling tier for
  // 20 minutes, and compact minute buckets into safe UTC-day NDJSON segments.
}
```

Use safe hashes for filenames. Retain 5-second samples for 20 minutes and minute aggregates for 31 days. Replace the short rolling tier with temp-file-plus-rename. Ignore only a truncated final NDJSON line; surface other malformed records as degraded coverage. Add tests for null gaps, zero, retention, malformed final line, unsafe filename rejection, and a changed fingerprint.

- [ ] **Step 7: Run focused storage tests green**

Run: `pnpm vitest run lib/tokenHistory.test.ts lib/tokenHistoryFileStore.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the foundation**

```bash
git add lib/tokenHistory.ts lib/tokenHistoryFileStore.ts lib/tokenHistory.test.ts lib/tokenHistoryFileStore.test.ts
git commit -m "feat: add durable token history store"
```

### Task 2: Start the server-owned recorder and expose a safe query

**Files:**
- Create: lib/tokenHistoryRecorder.ts
- Create: lib/tokenHistoryRecorder.test.ts
- Create: lib/vllmCollectorRuntime.ts
- Create: lib/vllmCollectorRuntime.test.ts
- Create: lib/rpc/procedures/tokenHistory.ts
- Create: lib/rpc/procedures/tokenHistory.test.ts
- Create: instrumentation.ts
- Modify: lib/vllmCollector.ts
- Modify: lib/rpc/procedures/vllmMetrics.ts
- Modify: lib/rpc/router.ts
- Modify: docker-compose.yml
- Modify: README.md

**Interfaces:**
- Consumes Task 1's `TokenHistoryStore` and `TrendRange`.
- Produces `startTokenHistoryRecorder(): () => void`.
- Produces `rpc.tokenHistory.get({ cluster, range })`.
- Extends `VllmCollectorRegistry.subscribe()` with optional `pollIntervalMs`.
- Produces `getProductionVllmCollectorRuntime()` backed by `globalThis`, so
  instrumentation and the live RPC stream use exactly one collector registry.

- [x] **Step 1: Write a failing recorder isolation test**

```ts
it("records live zero and positive Tokens/s without a browser subscriber", async () => {
  const recorder = createTokenHistoryRecorder({ clusters, registry, store, now });
  await recorder.start();
  registry.emit("c032", liveSnapshot("c032", 0));
  registry.emit("c032", liveSnapshot("c032", 12));
  expect(await store.query({ cluster: "c032", range: "15m", nowMs: now() }))
    .toMatchObject({ state: "ready" });
});
```

- [x] **Step 2: Run the recorder test red**

Run: `pnpm vitest run lib/tokenHistoryRecorder.test.ts`

Expected: FAIL because the recorder module does not exist.

- [x] **Step 3: Implement recorder ownership and cadence**

```ts
export function startTokenHistoryRecorder(): () => void {
  if (globalThis.__sparkrunTokenHistoryStop) return globalThis.__sparkrunTokenHistoryStop;
  const stop = createTokenHistoryRecorder(productionDependencies).start();
  globalThis.__sparkrunTokenHistoryStop = stop;
  return stop;
}
```

Move the saved-cluster loader and production registry from the RPC procedure
into `lib/vllmCollectorRuntime.ts`. Keep the runtime on `globalThis` so Next's
separately compiled instrumentation and route entries share one registry.
Create one hidden server subscriber per saved cluster and refresh the
saved-cluster list without leaking prior subscriptions. A temporary discovery
failure retains the last known subscriptions. Compare the full normalized,
ordered host list before replacing a subscription, not only the leader. Record
only `snapshot.metrics.tokensPerSecond.state === "live"`; write all other
states as null observations. De-duplicate an immediate cached snapshot after
a target replacement. A dashboard subscriber uses 2 seconds; recorder-only
uses 5 seconds. Any asynchronous store rejection is caught inside the
listener, so it cannot produce an unhandled rejection or stop collection.

- [x] **Step 4: Start the recorder once using instrumentation**

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTokenHistoryRecorder } = await import("./lib/tokenHistoryRecorder");
    startTokenHistoryRecorder();
  }
}
```

The hook must not throw or stop the UI server when storage is unavailable.

- [x] **Step 5: Write failing RPC validation tests**

```ts
it("rejects an unknown cluster", async () => {
  await expect(client.tokenHistory.get({ cluster: "not-saved", range: "1d" })).rejects.toThrow();
});
it("returns no more than 360 points for 30 days", async () => {
  const result = await client.tokenHistory.get({ cluster: "c032", range: "30d" });
  expect(result.points.length).toBeLessThanOrEqual(360);
});
```

- [x] **Step 6: Run RPC tests red**

Run: `pnpm vitest run lib/rpc/procedures/tokenHistory.test.ts`

Expected: FAIL because the procedure is not registered.

- [x] **Step 7: Implement and register the read-only RPC**

```ts
export const get = os
  .input(z.object({ cluster: z.string().min(1), range: z.enum(["15m", "1d", "7d", "30d"]) }))
  .output(TokenHistoryResultSchema)
  .handler(async ({ input }) => {
    const cluster = await requireSavedCluster(input.cluster);
    return productionTokenHistory.query({ cluster: cluster.name, range: input.range, nowMs: Date.now() });
  });
```

Validate only saved cluster names. Return the `unavailable` result state for history-store reads that fail. Do not accept a host, URL, or file path.

- [x] **Step 8: Add configuration**

Document `SPARKRUN_UI_DATA_DIR` in README. Mount a dedicated application data directory in docker-compose, separate from `~/.cache/sparkrun`. State that collection begins after deployment and has one writer per data directory.

- [x] **Step 9: Run focused collection tests green**

Run: `pnpm vitest run lib/tokenHistory.test.ts lib/tokenHistoryFileStore.test.ts lib/tokenHistoryRecorder.test.ts lib/rpc/procedures/tokenHistory.test.ts lib/vllmCollector.test.ts lib/rpc/procedures/vllmMetrics.test.ts`

Expected: PASS.

- [ ] **Step 10: Commit, review, merge, and deploy the collection slice**

```bash
git add instrumentation.ts lib/tokenHistoryRecorder.ts lib/tokenHistoryRecorder.test.ts lib/vllmCollectorRuntime.ts lib/vllmCollectorRuntime.test.ts lib/rpc/procedures/tokenHistory.ts lib/rpc/procedures/tokenHistory.test.ts lib/vllmCollector.ts lib/rpc/procedures/vllmMetrics.ts lib/rpc/router.ts docker-compose.yml README.md docs/superpowers/plans/2026-09-13-token-throughput-history.md
git commit -m "feat: record token throughput history"
```

Open and merge a PR into `claudio-fork/main`. Deploy only the merged revision to Coxshire. Verify the process starts, /dashboard returns 200, current telemetry remains live, C032/C458 sample files appear, and samples survive one UI restart. Record deployed revision and rollback copy.

### Task 3: Show per-cluster 15-minute Tokens/s cards

**Files:**
- Create: app/components/dashboard/ClusterTokenHistorySection.tsx
- Create: app/components/dashboard/ClusterTokenHistoryCard.tsx
- Create: app/components/dashboard/TokenHistoryChart.tsx
- Modify: app/components/dashboard/DashboardLive.tsx
- Modify: tests/dashboardLayout.test.ts
- Modify: tests/dashboardConnections.test.ts

**Interfaces:**
- Consumes `rpc.tokenHistory.get({ cluster, range })`.
- Produces `ClusterTokenHistorySection({ clusters })` with `range="15m"`.
- Produces `ClusterTokenHistoryCard({ cluster, range })`.

- [ ] **Step 1: Write a failing placement test**

```ts
expect(html).toContain('aria-label="Token throughput history"');
expect(html.indexOf('aria-label="Saved cluster fleet"')).toBeLessThan(
  html.indexOf('aria-label="Token throughput history"'),
);
expect(html.indexOf('aria-label="Token throughput history"')).toBeLessThan(
  html.indexOf(">Workloads</h2>"),
);
```

- [ ] **Step 2: Run the layout test red**

Run: `pnpm vitest run tests/dashboardLayout.test.ts`

Expected: FAIL because no Token throughput history section exists.

- [ ] **Step 3: Implement the section and cards**

```tsx
export function ClusterTokenHistorySection({ clusters }: { clusters: ClusterEntry[] }) {
  return (
    <section aria-label="Token throughput history" className="flex flex-col gap-4">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Token throughput history</h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {clusters.map((cluster) => (
          <ClusterTokenHistoryCard key={cluster.name} cluster={cluster} range="15m" />
        ))}
      </div>
    </section>
  );
}
```

Insert after `TwinReactorFleet` and before errors/Workloads. Each card makes a same-origin one-shot history request. It must not use `rpc.monitor.stream`, `rpc.vllmMetrics.stream`, or a cluster host URL.

- [ ] **Step 4: Implement the chart and state handling**

```tsx
<Line
  type="linear"
  dataKey="tokensPerSecond"
  connectNulls={false}
  isAnimationActive={false}
  dot={false}
/>
```

Use a fixed-height responsive Recharts chart, timestamped x-axis, Tokens/s y-axis, chart aria label, and textual latest/average/min--max summary. Use an `aria-busy` chart-sized loading state. Render `No Token/s samples for this range yet.` for empty data. Retain the last successful chart and mark it stale after refresh failure.

- [ ] **Step 5: Write connection and empty-state tests**

```ts
expect(source).toContain("rpc.tokenHistory.get");
expect(source).not.toContain("rpc.monitor.stream");
expect(source).not.toContain("rpc.vllmMetrics.stream");
expect(html).toContain("No Token/s samples for this range yet.");
```

- [ ] **Step 6: Run focused UI tests green**

Run: `pnpm vitest run tests/dashboardLayout.test.ts tests/dashboardConnections.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit, review, merge, and deploy the 15-minute slice**

```bash
git add app/components/dashboard/ClusterTokenHistorySection.tsx app/components/dashboard/ClusterTokenHistoryCard.tsx app/components/dashboard/TokenHistoryChart.tsx app/components/dashboard/DashboardLive.tsx tests/dashboardLayout.test.ts tests/dashboardConnections.test.ts
git commit -m "feat: show token throughput history"
```

Open and merge a PR into `claudio-fork/main`, deploy the merged revision, and use the Coxshire dashboard to verify separate C032/C458 15-minute cards, visible zero/gaps, keyboard navigation, and unchanged existing cards.

### Task 4: Add 1-day, 7-day, and 30-day range controls

**Files:**
- Modify: app/components/dashboard/ClusterTokenHistorySection.tsx
- Modify: app/components/dashboard/ClusterTokenHistoryCard.tsx
- Modify: app/components/dashboard/TokenHistoryChart.tsx
- Modify: tests/dashboardLayout.test.ts
- Modify: tests/dashboardConnections.test.ts
- Create: docs/operations/deployments/2026-09-13-token-throughput-history.md

**Interfaces:**
- Consumes Task 1's `TrendRange` and Task 2's history response.
- Produces one shared `role="tablist"` range control for every card.

- [ ] **Step 1: Write a failing range-control test**

```ts
for (const range of ["15m", "1d", "7d", "30d"]) {
  expect(html).toContain(`>\${range}<`);
}
expect(html).toContain('role="tablist"');
```

- [ ] **Step 2: Run the layout test red**

Run: `pnpm vitest run tests/dashboardLayout.test.ts`

Expected: FAIL because only 15m exists.

- [ ] **Step 3: Implement shared range controls and cache**

```tsx
const ranges: TrendRange[] = ["15m", "1d", "7d", "30d"];
<div role="tablist" aria-label="Token throughput range">
  {ranges.map((value) => (
    <button
      key={value}
      type="button"
      role="tab"
      aria-selected={range === value}
      onClick={() => setRange(value)}
    >
      {value}
    </button>
  ))}
</div>
```

Cache successful responses by `cluster + range`. Keep the prior chart while a new range loads. Refetch no more than once per minute per rendered card. Range selection must not remount dashboard live telemetry.

- [ ] **Step 4: Write bounded range-query regression tests**

```ts
for (const range of ["15m", "1d", "7d", "30d"] as const) {
  const result = await history.query({ cluster: "c032", range, nowMs });
  expect(result.points.length).toBeLessThanOrEqual(360);
}
```

- [ ] **Step 5: Run focused history and UI tests green**

Run: `pnpm vitest run lib/tokenHistory.test.ts lib/tokenHistoryFileStore.test.ts lib/rpc/procedures/tokenHistory.test.ts tests/dashboardLayout.test.ts tests/dashboardConnections.test.ts`

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`

Expected: every command exits 0. Report pre-existing formatter-only failures separately if they occur.

- [ ] **Step 7: Commit, review, merge, deploy, and record the release**

```bash
git add app/components/dashboard/ClusterTokenHistorySection.tsx app/components/dashboard/ClusterTokenHistoryCard.tsx app/components/dashboard/TokenHistoryChart.tsx tests/dashboardLayout.test.ts tests/dashboardConnections.test.ts docs/operations/deployments/2026-09-13-token-throughput-history.md
git commit -m "feat: add token history range controls"
```

Open and merge a PR into `claudio-fork/main`. Create a rollback copy, deploy the merged revision to Coxshire, and verify /dashboard returns 200. In a real browser select every range, verify independent C032/C458 cards, verify honest collecting/partial states for unaccrued ranges, and verify existing overview and Twin Reactor cards remain present. Record commit, backup path, data directory, sample count, browser evidence, and known limitations.

## Plan review

- Spec coverage: Tasks 1--2 provide durable collection, retention, startup, and safe queries. Task 3 provides an early visible 15m card. Task 4 adds the requested remaining ranges, complete verification, and the release record.
- Placeholder scan: zero, gaps, retention, safe inputs, deployment, and verification all have explicit behavior.
- Type consistency: TrendRange, TokenHistoryStore, TokenHistoryResult, and rpc.tokenHistory.get are defined before later tasks use them.
