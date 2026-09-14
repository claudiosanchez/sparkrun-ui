# Five-Minute Token History and Live SSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a five-minute Tokens/s range and make that selected chart advance from the existing one-second same-origin vLLM SSE events, without full-dashboard re-renders or an extra cluster poll.

**Architecture:** The server already has one shared per-cluster vLLM collector and durable recorder. Extend the bounded token-history range domain with `5m` at one-second resolution. Publish each recorder-normalized observation through the existing, currently unused `rpc.telemetry.stream` broker topic and let one history-section provider route it to a cluster-keyed external store. A selected 5m card consumes only its cluster's events. Do not create a per-card streaming endpoint or direct browser-to-cluster request. Keep long-range history on its existing bounded one-minute `tokenHistory.get` refresh path.

**Tech Stack:** Next.js, React 19, TypeScript, oRPC SSE streams, Recharts, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-token-history-5m-live-sse-design.md`

## Guardrails

- Start from the clean fork merge `fbb29132634c39b0f9123ad4936e12742cb69b37`; do not touch the dirty source checkout.
- Keep the existing `Cluster overview`, saved-cluster overview cards, Twin Reactor fleet, card order, and text unchanged.
- Do not hard-code C032, C458, a host, a saved-cluster count, an SSH user, a URL, or a server path.
- Treat `0` as a valid throughput. `null` stays a gap. Never infer a live value from a stale, warming, reset, or unavailable reading.
- Reuse the existing `rpc.telemetry.stream` oRPC/SSE transport; do not add an EventSource, `tokenHistory.stream`, a second collector subscription, or a one-second history-RPC timer.
- Keep live state below `DashboardLive`. A C032 SSE event must not update C458, Workloads, Cluster overview, or a non-5m history card.
- Work fork-only: push and PR only to `claudio-fork`; never push/open a PR to `origin`. Deploy only the merged fork commit.

## Task 1: Extend the bounded history contract with `5m`

**Files:**

- Modify: `lib/tokenHistory.ts`
- Modify: `lib/tokenHistoryFileStore.ts`
- Modify: `lib/rpc/procedures/tokenHistory.ts`
- Modify: `app/components/dashboard/tokenHistoryData.ts`
- Modify: `app/components/dashboard/ClusterTokenHistorySection.tsx`
- Modify: `lib/tokenHistory.test.ts`
- Modify: `lib/tokenHistoryFileStore.test.ts`
- Modify: `lib/rpc/procedures/tokenHistory.test.ts`
- Modify: `tests/tokenHistoryDashboard.test.ts`
- Modify: `tests/dashboardLayout.test.ts`

- [ ] **Step 1: Add focused failing tests before changing implementation.**

  Cover all public boundaries:

  - `rangePolicy("5m")` is `{ durationMs: 5 * 60_000, bucketMs: 1_000 }` and materializes exactly 300 points.
  - aggregation preserves a numeric zero, maps missing seconds to `null`, and has an honest partial coverage value.
  - the file store accepts/querys `5m` and has no range-specific failure.
  - the oRPC procedure accepts `5m`, validates the saved cluster, returns at most 360 points, and keeps host/URL rejection intact.
  - the selector's typed list is exactly `5m`, `15m`, `1d`, `7d`, `30d`; static dashboard markup contains five tabs and `5m` is the first/default selected label.

  Run:

  ```bash
  pnpm vitest run lib/tokenHistory.test.ts lib/tokenHistoryFileStore.test.ts lib/rpc/procedures/tokenHistory.test.ts tests/tokenHistoryDashboard.test.ts tests/dashboardLayout.test.ts
  ```

  Expected: failing tests demonstrate the missing `5m` contract before any production implementation changes.

- [ ] **Step 2: Implement `5m` end to end.**

  - Add `"5m"` to the `TrendRange` union and return its 300-point one-second policy before the 15m case.
  - Replace the file-store's duplicated literal range check with one source-compatible validation that includes `5m` without accepting arbitrary strings.
  - Add `5m` to `TrendRangeSchema`; the unavailable result must also have 300 null points.
  - Make `TOKEN_HISTORY_RANGES` start with `"5m"`, update tab-id/ref maps exhaustively, and set the section default to `"5m"`.
  - Preserve the same range type across domain, RPC, store, cache, and UI; do not duplicate a looser client union.

- [ ] **Step 3: Pass focused tests and commit the contract slice.**

  Run the command from Step 1 and `pnpm typecheck`. Commit only the coherent range-contract change:

  ```bash
  git add lib/tokenHistory.ts lib/tokenHistoryFileStore.ts lib/rpc/procedures/tokenHistory.ts \
    app/components/dashboard/tokenHistoryData.ts app/components/dashboard/ClusterTokenHistorySection.tsx \
    lib/tokenHistory.test.ts lib/tokenHistoryFileStore.test.ts lib/rpc/procedures/tokenHistory.test.ts \
    tests/tokenHistoryDashboard.test.ts tests/dashboardLayout.test.ts
  git commit -m "feat(dashboard): add five-minute token history range"
  ```

## Task 2: Publish normalized one-second history events through the existing SSE broker

**Files:**

- Modify: `lib/tokenHistory.ts` only if its observation schema needs a shared export
- Modify: `lib/dashboardTelemetry.ts`
- Modify: `lib/tokenHistoryRecorder.ts`
- Modify: `lib/rpc/router.ts` only if its public type needs wiring
- Modify: `lib/rpc/procedures/telemetry.ts` only if its output import needs wiring
- Modify: `instrumentation.ts`
- Modify: `lib/dashboardTelemetry.test.ts`
- Modify: `lib/tokenHistoryRecorder.test.ts`
- Modify: `lib/rpc/procedures/telemetry.test.ts`
- Modify: `tests/rpcRouteStream.test.ts` if the current route contract needs coverage

- [ ] **Step 1: Write failing typed-event and recorder-publication tests.**

  Cover all transport boundaries before changing implementation:

  - `DashboardTelemetryEventSchema` accepts a `token-history` event containing
    a finite timestamp, matching cluster, non-empty fingerprint, and nullable
    nonnegative Tokens/s; it rejects an arbitrary URL, non-finite number, and
    mismatched payload cluster.
  - The broker caches/replays the newest token-history event per cluster,
    coalesces queued updates, increments its revision, and removes listeners
    on abort just as it does for existing topics.
  - The recorder passes each deduplicated normalized observation—numeric zero,
    numeric live value, and null gap—to a supplied publisher exactly once,
    without waiting for a failing or delayed store write.
  - A caller of `rpc.telemetry.stream({})` gets the typed event as oRPC SSE;
    there is no input host, URL, interval, or cluster target.

  Run:

  ```bash
  pnpm vitest run lib/dashboardTelemetry.test.ts lib/tokenHistoryRecorder.test.ts lib/rpc/procedures/telemetry.test.ts
  ```

  Expected: failing tests because token-history is not yet a broker event and
  the recorder has no publisher dependency.

- [ ] **Step 2: Extend the broker's typed event contract.**

  Add a `token-history` variant to both the full and publishable dashboard
  telemetry unions. Its top-level `cluster` must equal `payload.cluster`; its
  `observedAtMs` must equal `payload.atMs`. Use a shared schema/type for
  `TokenObservation` rather than copy a broader shape. Include the topic in
  the broker's keyed cache behavior and preserve all existing topics.

- [ ] **Step 3: Publish from the process-owned recorder without adding a poll.**

  Extend `TokenHistoryRecorderDependencies` with an optional observation
  publisher. In the existing accepted-snapshot path, first build the single
  normalized `TokenObservation`, call that publisher safely, then queue the
  existing durable `store.record` write. The publisher must never block or
  interrupt recording; failed disk I/O must not suppress an event.

  In `startTokenHistoryRecorder`, provide a narrow adapter to
  `getProductionDashboardTelemetryBroker().publish({
  topic: "token-history", cluster, observedAtMs: atMs, payload: observation
  })`. Keep this dependency at the production composition boundary, so the
  recorder remains testable and does not depend directly on a global broker.
  The adapter cannot trigger a collector or alter collector cadence.

- [ ] **Step 4: Verify the server-side SSE event path and commit.**

  Verify the vLLM collector remains one-second (`POLL_INTERVAL_MS === 1_000`),
  the recorder remains a shared registry subscriber, and event publication
  cannot add a second upstream `/metrics` request. Run focused tests, then
  `pnpm lint` and `pnpm typecheck`. Commit:

  ```bash
  git add lib/tokenHistory.ts lib/dashboardTelemetry.ts lib/tokenHistoryRecorder.ts \
    instrumentation.ts lib/dashboardTelemetry.test.ts lib/tokenHistoryRecorder.test.ts \
    lib/rpc/procedures/telemetry.test.ts
  git commit -m "feat(telemetry): stream token history observations"
  ```

## Task 3: Render a 5m live overlay from one keyed SSE store

**Files:**

- Create: `app/components/dashboard/tokenHistoryTelemetryStore.ts`
- Create: `app/components/dashboard/TokenHistoryTelemetryProvider.tsx`
- Create: `app/components/dashboard/liveTokenHistory.ts`
- Create: `app/components/dashboard/LiveTokenHistoryContent.tsx`
- Modify: `app/components/dashboard/ClusterTokenHistorySection.tsx`
- Modify: `app/components/dashboard/ClusterTokenHistoryCard.tsx`
- Modify: `tests/liveTokenHistory.test.ts`
- Modify: `tests/tokenHistoryCard.test.ts`
- Modify: `tests/tokenHistoryDashboard.test.ts`

- [ ] **Step 1: Write failing pure-overlay and targeted-store tests.**

  Add test coverage for a pure function such as
  `applyLiveTokenHistory(result, observations): TokenHistoryResult`. It must:

  - leave non-`5m` results unchanged;
  - advance a 5m window to the newest observation timestamp and retain exactly
    300 one-second points;
  - use a numeric zero as data;
  - overwrite a same-bucket old value with `null` for a new gap;
  - preserve null gaps and recalculate coverage/state without calling missing
    data `ready`;
  - never mutate the input result or point array; and
  - bound the in-memory overlay to the current five-minute window.

  Test the store independently: a C032 publish calls only C032 listeners,
  preserves C458 snapshot identity, rejects malformed/unrelated telemetry
  events, and releases listeners. Test the provider's source for one
  `rpc.telemetry.stream({})` subscription, retry/backoff, no direct cluster
  URL, and no per-card stream.

  Run:

  ```bash
  pnpm vitest run tests/liveTokenHistory.test.ts tests/tokenHistoryCard.test.ts tests/tokenHistoryDashboard.test.ts
  ```

  Expected: failing tests because the keyed store, provider, and overlay do not
  exist yet.

- [ ] **Step 2: Implement a narrow client telemetry store and one provider.**

  `tokenHistoryTelemetryStore.ts` exports a small external store with:

  - `publish(event)` for validated `token-history` events;
  - `getSnapshot(cluster)` preserving exact identity until that cluster gets a
    new event;
  - `subscribe(cluster, listener)` with a no-op fallback;
  - a fingerprint-aware sequence limited to the five-minute, 300-observation
    live window per cluster, never an unbounded event log.

  `TokenHistoryTelemetryProvider` owns one abortable/reconnecting
  `rpc.telemetry.stream({})` loop. It ignores every non-token-history topic,
  routes each event into the store, clears/marks connection health on a
  reconnect without inventing observations, and releases its stream on
  unmount. Mount it once inside `ClusterTokenHistorySection`, outside the card
  map.

- [ ] **Step 3: Implement the live 5m overlay and targeted child.**

  Put pure range/overlay logic in `liveTokenHistory.ts`, including an
  observation reducer that handles series fingerprint changes by clearing the
  old overlay. It rebuilds from fetched base points plus current bounded
  observations with newest-wins timestamps, then recalculates coverage and
  state.

  `LiveTokenHistoryContent` is the only component that subscribes to a
  cluster-keyed telemetry store. It receives the static base query/result,
  folds in that cluster's bounded live observation sequence, and renders the
  existing chart and summary. Mount it only when the displayed range is `5m`
  and a usable base result exists. Keep the existing `HistoryContent` for every
  other range and retain all card loading/unavailable/retry behavior.

  A live event must not call `rpc.tokenHistory.get`; only the existing
  one-minute query refresh does so.

- [ ] **Step 4: Pass focused tests, lint/typecheck, and commit.**

  ```bash
  pnpm vitest run tests/liveTokenHistory.test.ts tests/tokenHistoryCard.test.ts tests/tokenHistoryDashboard.test.ts
  pnpm lint
  pnpm typecheck
  git add app/components/dashboard/tokenHistoryTelemetryStore.ts \
    app/components/dashboard/TokenHistoryTelemetryProvider.tsx \
    app/components/dashboard/liveTokenHistory.ts \
    app/components/dashboard/LiveTokenHistoryContent.tsx \
    app/components/dashboard/ClusterTokenHistorySection.tsx \
    app/components/dashboard/ClusterTokenHistoryCard.tsx \
    tests/liveTokenHistory.test.ts tests/tokenHistoryCard.test.ts tests/tokenHistoryDashboard.test.ts
  git commit -m "feat(dashboard): update five-minute history from SSE"
  ```

## Task 4: Integrate, review, release, and verify

**Files:**

- Create: `docs/operations/deployments/2026-09-13-token-history-5m-live-sse.md`
- Modify: only regression tests or deployment documentation if review exposes a concrete gap

- [ ] **Step 1: Run the full local verification suite.**

  ```bash
  pnpm vitest run
  pnpm lint
  pnpm typecheck
  pnpm build
  git diff --check
  ```

  Check the source diff for an accidental second event transport, direct
  browser-to-cluster URL, timer under 60 seconds for `tokenHistory.get`,
  hard-coded cluster name, or `DashboardLive` live-history state.

- [ ] **Step 2: Review through the fork-only pull-request path.**

  Push the branch only to `claudio-fork`, open a PR only against
  `claudio-fork/main`, run an independent review, address findings, merge the
  PR, and record the exact merge SHA. Never write to `origin`.

- [ ] **Step 3: Deploy the exact merged fork commit to Coxshire.**

  Before SSH, read the repository networking and SSH instructions. Preserve
  the deployed service's existing runtime environment, port, and data
  directory. Build and deploy the exact merged SHA, including matching
  standalone server and static assets. Do not alter model lifecycles, Docker,
  SSH configuration, saved clusters, or vLLM endpoints.

- [ ] **Step 4: Verify live behavior in the browser and record evidence.**

  On `/dashboard`:

  1. Refresh to obtain the current JavaScript bundle, choose `5m`, and confirm
     both saved-cluster cards appear with a 5m label.
  2. Confirm the server's `tokenHistory.get` response has `range: "5m"`,
     1,000-ms resolution, and no more than 300 points.
  3. Observe C032's live rate/chart change over consecutive one-second
     recorder-normalized telemetry SSE events, without a full-page loading
     state or a C458 card flash.
  4. Switch to 15m and confirm its chart remains bounded/RPC-backed and does
     not continue live-overlay updates.
  5. Verify C458’s unavailable/warm-up state remains an honest gap, not zero.

  Add a deployment note with fork PR URL, merge/deploy SHAs, endpoint status,
  selected ranges, and browser observations. Exclude credentials and raw
  secret-bearing logs.

## Review checklist

- **Data correctness:** 5m has 300 one-second slots; zero and null remain distinct; live rate state gates numeric overlay values.
- **Transport correctness:** existing `rpc.telemetry.stream`/oRPC SSE carries recorder-normalized events; history RPC remains bounded.
- **Performance:** a single provider plus local, keyed overlay state isolates C032 from C458 and avoids a DashboardLive render on each event.
- **Compatibility:** every existing range and card remains intact; readers get no host/URL control.
- **Release:** test, independent review, fork-only merge, exact-SHA deployment, and browser-visible verification occur before completion.
