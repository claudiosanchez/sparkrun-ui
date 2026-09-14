# Dashboard SSE and One-Second Telemetry Implementation Plan

## Context

This plan implements the approved design in
`docs/superpowers/specs/2026-09-13-dashboard-sse-and-one-second-telemetry-design.md`.
The user asked for one-second Tokens/s collection, an SSE API to the UI, and a
snappy dashboard. Release early: collection is useful before the visual stream
conversion, and each release must be a merged fork commit verified on Coxshire.

## Global Constraints

- Work only in the local `claudio-fork` repository. Do not push or open a PR
  against upstream `origin`.
- Do not modify Docker, model services, SSH configuration, saved-cluster
  configuration, or existing card labels/order.
- Preserve the server-owned, process-global vLLM registry. Do not make browser
  clients poll a host directly or choose source cadence.
- Use oRPC's SSE transport. Do not add an independent raw SSE stack.
- New public stream input must not accept a host, URL, or arbitrary interval.
- Every queue must be bounded and every subscription must clean up on abort.
- Use test-first development. Record the failing test before each production
  behavior change.
- After each release slice: run relevant tests, commit, PR to `claudio-fork/main`,
  merge, deploy only the merged SHA to Coxshire, and verify live behavior.

## Baseline

- Full baseline suite: 174 tests passing.
- Dashboard hard refresh (five samples): median TTFB 779 ms; median total 784 ms.
- Dashboard React Server Component navigation (five samples): median first byte
  5 ms; median completion 763 ms.
- Current dashboard opens seven long-lived browser streams for two clusters.
- The live vLLM registry defaults to two seconds; the durable recorder requests
  five seconds when the dashboard is not open.

## Task 1: One-Second Server-Owned vLLM Cadence

**Description:** Make durable vLLM collection target one second independent of
browser activity. Repair the collector loop so each scheduled tick performs one
metrics fetch, has only one request in flight, and schedules from monotonic
time.

**Acceptance criteria:**

- [x] Recorder subscription requests 1,000 ms.
- [x] vLLM registry defaults to 1,000 ms and does not downgrade when a browser
  disconnects.
- [x] One scheduled tick performs exactly one fetch; slow fetches never overlap.
- [x] A changed requested interval wakes the loop safely and recalculates the
  next deadline.
- [x] Existing stale/unavailable/zero Tokens/s behavior remains intact.

**Likely files:**

- `lib/vllmCollector.ts`
- `lib/vllmCollector.test.ts`
- `lib/tokenHistoryRecorder.ts`
- `lib/tokenHistoryRecorder.test.ts`

**Verification:** Focused collector and recorder tests, then full test suite,
typecheck, lint, production build. Deploy this slice immediately and compare
multiple persisted Coxshire sample timestamps.

**Dependencies:** None. Released in PR #5 as merged commit
`5b3ebb503443df653bc55836a3086d8d73c84c2c`; live C032/C458 samples measured
1,000–1,002 ms apart.

## Task 2: SSE Contract, Bounded Queue, and Route Headers

**Description:** Create the typed dashboard event contract, a per-connection
latest-value queue, and the strict `rpc.telemetry.stream({})` procedure. This
foundation has no collector ownership yet; it makes the transport safe and
testable before a runtime publishes real events.

**Acceptance criteria:**

- [x] Zod validates a discriminated event union with process-scoped revisions.
- [x] Input is strict empty object; host, URL, and interval fields are rejected.
- [x] A queue retains at most one pending event per source key, not one global
  event and not an unbounded array.
- [x] Abort, iterator return, and close remove listeners and resolve blocked
  consumers exactly once.
- [x] SSE responses add no-cache and anti-buffering headers without teeing or
  consuming the response body.

**Likely files:**

- `lib/dashboardTelemetry.ts` (new) and test
- `lib/rpc/procedures/telemetry.ts` (new) and test
- `lib/rpc/router.ts`
- `app/rpc/[[...rest]]/route.ts` and route-stream test

**Verification:** Queue/abort/strict-input tests; direct route SSE header and
cancellation test; full suite/typecheck/lint/build. Merge, deploy, and smoke
test the contract slice before adding a live publisher.

**Dependencies:** Task 1.

## Task 3: Process-Global vLLM Publisher for the SSE Feed

**Description:** Start one process-owned publisher from instrumentation. It
reuses the existing 1 Hz vLLM registry, reconciles saved clusters, caches the
latest vLLM event, and fans it out to `telemetry.stream` clients.

**Acceptance criteria:**

- [ ] Startup is idempotent and no browser connection starts another collector.
- [ ] Two logical clients share one source subscription and receive cached-first
  and later events.
- [ ] Discovery failure retains the last known subscriptions; removed or changed
  clusters clean up their source and cached event.
- [ ] Existing vLLM stream procedure remains available for non-dashboard users.

**Likely files:**

- `lib/dashboardTelemetryRuntime.ts` (new) and test
- `instrumentation.ts`
- `lib/rpc/procedures/telemetry.ts`
- runtime integration test

**Verification:** Fan-out, cache, reconciliation, start/stop, and source-count
tests; full suite/typecheck/lint/build. Merge and deploy the server SSE slice.

**Dependencies:** Task 2.

## Task 4: Dashboard SSE Store and VLLM Provider

**Description:** Add one dashboard-owned browser connection to the new SSE feed
and publish vLLM events into a narrow external store. This is the client-side
foundation; existing monitor/status streams remain temporarily compatible.

**Acceptance criteria:**

- [ ] A dashboard tab opens exactly one telemetry SSE connection.
- [ ] The store preserves unchanged cluster snapshots and supports cluster/topic
  subscriptions.
- [ ] A C032 vLLM event does not notify C458 subscribers.
- [ ] Reconnect preserves the last known value until the next event.

**Likely files:**

- `app/components/dashboard/DashboardTelemetryProvider.tsx` (new)
- `app/components/dashboard/dashboardTelemetryStore.ts` (new) and test
- `app/components/dashboard/ReactorStateContext.tsx`
- dashboard connection test

**Verification:** Store selector and connection lifecycle tests; full suite/
typecheck/lint/build.

**Dependencies:** Task 3.

## Task 5: Migrate Twin Reactor vLLM Updates and Isolate Cards

**Description:** Remove the dashboard's per-cluster vLLM streams and consume
the shared SSE store in the Twin Reactor path. Keep monitor, status, service,
card order, labels, and missing-data behavior unchanged.

**Acceptance criteria:**

- [ ] The dashboard has no `rpc.vllmMetrics.stream` call per reactor card.
- [ ] C032 Tokens/s refreshes from the shared 1 Hz feed without rerendering the
  C458 card, workload list, or top overview.
- [ ] Existing cards, layout, labels, and accessibility output remain intact.

**Likely files:**

- `app/components/dashboard/useReactor.ts`
- `app/components/dashboard/{ReactorCard,ReactorRings,ClusterOverviewCard}.tsx`
- dashboard layout/connection/render tests

**Verification:** React render-isolation tests, browser network check for one
telemetry stream, full suite/typecheck/lint/build. Merge, deploy, and verify
live Twin Reactor Tokens/s updates.

**Dependencies:** Task 4.

## Task 6: Shared Monitor Publisher and Top-Card Migration

**Description:** Move dashboard monitor ownership to the server runtime at its
two-second cadence. Preserve the existing unscoped top-card source as the
`overview-monitor` topic and remove its duplicate browser monitor process.

**Acceptance criteria:**

- [ ] Top `Cluster overview` retains its current label and source scope.
- [ ] Dashboard monitor work is shared across browser tabs and no duplicate
  aggregate monitor stream remains.
- [ ] Hardware updates affect only relevant overview/reactor widgets.

**Likely files:**

- `lib/dashboardTelemetryRuntime.ts` and test
- `app/components/dashboard/AggregateStats.tsx`
- dashboard store/provider files
- monitor compatibility adapter test

**Verification:** Source fan-out/cadence tests, aggregate source-scope test,
browser stream count, full suite/typecheck/lint/build, merged deployment.

**Dependencies:** Task 5.

## Task 7: Shared Status and Service Publisher; Workload Ownership

**Description:** Move status and service-health collection into the server
runtime and split dashboard workload/error ownership away from `DashboardLive`
parent state.

**Acceptance criteria:**

- [ ] Status runs at three seconds and service health at ten seconds on the
  server, not once per mounted card.
- [ ] `DashboardLive` is structural and no longer updates a status map on each
  event.
- [ ] Workload, error, and service sections update only on their relevant topic.

**Likely files:**

- `lib/dashboardTelemetryRuntime.ts` and test
- `lib/rpc/procedures/{status,services}.ts`
- `app/components/dashboard/DashboardLive.tsx`
- workload/error section components and tests

**Verification:** Source-count, selector, cleanup, and layout tests; full
suite/typecheck/lint/build; browser update isolation; merged deployment.

**Dependencies:** Task 6.

## Task 8: Remove the Dashboard Server-Render Waterfall and Measure

**Description:** Use the shared server cache to seed the dashboard and defer
noncritical workload decoration. This reduces navigation latency without
changing the visible cards or their meaning.

**Acceptance criteria:**

- [ ] Dashboard navigation does not wait for one status command per cluster.
- [ ] Missing startup cache is rendered honestly and filled by SSE.
- [ ] Before/after timing data exists for at least 20 hard refreshes and 20
  client navigations under the same conditions.
- [ ] First live telemetry is within 1.5 seconds; vLLM event p95 is at or below
  1.25 seconds; C032 updates cause zero C458 commits.

**Likely files:**

- `app/dashboard/page.tsx`
- dashboard data/seeding modules
- dashboard performance and browser verification tests

**Verification:** Full suite/typecheck/lint/build; repeatable timing script;
browser performance trace; merged deployment and live endpoint verification.

**Dependencies:** Task 7.

## Checkpoints and Releases

1. **After Task 1:** release the one-second collector. Verify persisted data on
   Coxshire before proceeding.
2. **After Task 2:** release the contract slice. Verify normal RPC responses
   remain unchanged and SSE headers are present without consuming the body.
3. **After Task 3:** release the live server SSE feed. Verify response headers,
   event cadence, reconnect, and source fan-out.
4. **After Task 5:** release the live Twin Reactor SSE conversion. Verify one
   browser telemetry stream and C032/C458 render isolation.
5. **After Task 7:** release the full dashboard collection consolidation.
6. **After Task 8:** compare performance with the recorded baseline. Retain only
   changes that beat noise and meet the acceptance criteria.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| One-second polling overloads a host | One shared collector, one in-flight request, source-specific cadence, live cadence verification. |
| Slow tab consumes memory | Coalesce by cluster/topic and bound each subscriber queue. |
| SSE proxy buffers messages | Explicit response headers and deployed first-event/heartbeat tests. |
| A new runtime causes duplicate CLI work | Runtime-level fan-out tests with two clients and compatibility adapters. |
| Faster data still rerenders too much UI | Topic-scoped external-store subscriptions and React commit isolation tests. |
| Faster transport leaves slow navigation | Address Server Component waterfall separately in Task 8 and measure it. |
