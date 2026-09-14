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

- [ ] Recorder subscription requests 1,000 ms.
- [ ] vLLM registry defaults to 1,000 ms and does not downgrade when a browser
  disconnects.
- [ ] One scheduled tick performs exactly one fetch; slow fetches never overlap.
- [ ] A changed requested interval wakes the loop safely and recalculates the
  next deadline.
- [ ] Existing stale/unavailable/zero Tokens/s behavior remains intact.

**Likely files:**

- `lib/vllmCollector.ts`
- `lib/vllmCollector.test.ts`
- `lib/tokenHistoryRecorder.ts`
- `lib/tokenHistoryRecorder.test.ts`

**Verification:** Focused collector and recorder tests, then full test suite,
typecheck, lint, production build. Deploy this slice immediately and compare
multiple persisted Coxshire sample timestamps.

**Dependencies:** None.

## Task 2: Shared Dashboard Telemetry Runtime and Typed SSE Contract

**Description:** Add a server-owned runtime for the dashboard's vLLM, monitor,
status, service-health, and top-card monitor sources. Expose its cached,
multiplexed updates as `rpc.telemetry.stream({})` over oRPC SSE.

**Acceptance criteria:**

- [ ] Runtime starts once from `instrumentation.ts` and reconciles saved clusters.
- [ ] Source cadences are 1s vLLM, 2s monitor, 3s status, and 10s service health.
- [ ] The stream uses a Zod discriminated event union and validates no client
  host, URL, or cadence.
- [ ] Cached latest state arrives first; slow consumers have a bounded
  latest-value queue; abort releases every listener and timer.
- [ ] Existing stream procedures remain available as compatibility adapters.
- [ ] SSE responses have anti-buffering and no-cache headers.

**Likely files:**

- `instrumentation.ts`
- `lib/dashboardTelemetry.ts` (new)
- `lib/dashboardTelemetryRuntime.ts` (new)
- `lib/rpc/procedures/telemetry.ts` (new)
- `lib/rpc/router.ts`
- `app/rpc/[[...rest]]/route.ts`
- `lib/rpc/procedures/{status,monitor,services,vllmMetrics}.ts`
- focused unit and route-stream tests

**Verification:** Runtime fan-out/cancellation/queue tests; route content type
and headers; two logical client streams share one source; full suite/typecheck/
lint/build. Merge and deploy this server slice before wiring the dashboard.

**Dependencies:** Task 1.

## Task 3: One Dashboard SSE Client and Selective Store Updates

**Description:** Replace dashboard-owned per-cluster stream loops with one
provider consuming `rpc.telemetry.stream({})`. Publish events to a narrow
external store so only subscribers to the changed topic rerender.

**Acceptance criteria:**

- [ ] A dashboard browser tab opens one SSE connection.
- [ ] `DashboardLive` no longer maintains a status map or re-renders on every
  status event.
- [ ] Top overview uses only `overview-monitor`; workload/error sections use
  status-only subscriptions.
- [ ] A C032 vLLM event causes no C458 component or workload-section commit.
- [ ] Existing cards, order, and labels remain unchanged.

**Likely files:**

- `app/components/dashboard/DashboardTelemetryProvider.tsx` (new)
- `app/components/dashboard/dashboardTelemetryStore.ts` (new)
- `app/components/dashboard/ReactorStateContext.tsx`
- `app/components/dashboard/useReactor.ts`
- `app/components/dashboard/DashboardLive.tsx`
- `app/components/dashboard/{AggregateStats,ReactorCard,ClusterOverviewCard}.tsx`
- dashboard connection/render tests

**Verification:** Store selector tests, one-client network contract test, React
render-isolation tests, full suite/typecheck/lint/build, browser network and
visual verification. Merge, deploy, then confirm one live stream and selective
updates on Coxshire.

**Dependencies:** Task 2.

## Task 4: Remove the Dashboard Server-Render Waterfall and Measure

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

**Dependencies:** Task 3.

## Checkpoints and Releases

1. **After Task 1:** release the one-second collector. Verify persisted data on
   Coxshire before proceeding.
2. **After Task 2:** release the server SSE contract. Verify response headers,
   event cadence, reconnect, and source fan-out.
3. **After Task 3:** release the dashboard conversion. Verify one browser SSE
   connection and render isolation.
4. **After Task 4:** compare performance with the recorded baseline. Retain only
   changes that beat noise and meet the acceptance criteria.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| One-second polling overloads a host | One shared collector, one in-flight request, source-specific cadence, live cadence verification. |
| Slow tab consumes memory | Coalesce by cluster/topic and bound each subscriber queue. |
| SSE proxy buffers messages | Explicit response headers and deployed first-event/heartbeat tests. |
| A new runtime causes duplicate CLI work | Runtime-level fan-out tests with two clients and compatibility adapters. |
| Faster data still rerenders too much UI | Topic-scoped external-store subscriptions and React commit isolation tests. |
| Faster transport leaves slow navigation | Address Server Component waterfall separately in Task 4 and measure it. |
