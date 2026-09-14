# Token Throughput History Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an honest, responsive Tokens/s history section to the dashboard. It shows one card for every saved cluster and a shared 15m, 1d, 7d, or 30d period selector, without changing the existing Cluster Overview or Twin Reactor cards.

**Architecture:** The server-side recorder, durable history store, and bounded same-origin `tokenHistory.get` RPC already exist. Add an isolated, memoized client-side History section after the Twin Reactor fleet. Each card uses a small hook to request only its cluster and selected range, keeps the last useful result during a refresh, and redraws only that card. Live telemetry remains a separate concern; the history cards do not open a stream.

**Tech Stack:** Next.js, React, TypeScript, oRPC, Recharts, Tailwind CSS, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-token-throughput-history-design.md`

## Global Constraints

- The already-merged history foundation is the source of truth: `lib/tokenHistory.ts`, `lib/tokenHistoryFileStore.ts`, `lib/tokenHistoryRecorder.ts`, and `lib/rpc/procedures/tokenHistory.ts`. Do not change the recorder, store, RPC contract, collector cadence, model services, SSH settings, or saved-cluster configuration for this UI feature.
- The collector and recorder already sample at one second. The browser history cards may refresh their bounded RPC result no more often than once per minute.
- Use only `rpc.tokenHistory.get({ cluster, range }, { signal })`, which is same-origin and validates the saved cluster server-side. Do not call a cluster host, construct a metrics URL, or use `rpc.monitor.stream`, `rpc.vllmMetrics.stream`, or `rpc.telemetry.stream` in the history feature.
- Treat the data as throughput, not a cumulative token count. The user-visible card title and units must say `Tokens/s` or `Token throughput`.
- Render from the supplied `clusters` array only. Do not special-case or hard-code C032, C458, host names, or a number of cards. A third saved cluster must render a third history card on the next dashboard render.
- Preserve all existing dashboard cards, labels, and order. Insert the new section after `TwinReactorFleet` and before status errors and Workloads. Do not rename or replace `Cluster overview`.
- A numeric `0` is valid data. `null` means a missing reading and must remain a chart gap; never coerce it to zero or connect the line across it.
- First load uses a chart-sized loading state. Empty and unavailable states are explicit; neither may draw a fabricated zero line. During a range change or failed background refresh, retain the last successful chart and say which range is currently displayed.
- Keep history rendering independent of `ReactorStateProvider` and the live status state. `DashboardLive` updates must not re-render the history chart subtree when only live status changes.
- The implementation is fork-only: work on a local branch and, when ready, use a pull request into `claudio-fork/main` only. Never push or open a pull request against `origin`/upstream. Deploy only the merged fork commit, then verify the dashboard in a browser.

---

## Task 1: Define the UI data contract and bounded client refresh

**Files:**

- Create: `app/components/dashboard/tokenHistoryData.ts`
- Create: `app/components/dashboard/useTokenHistory.ts`
- Create: `tests/tokenHistoryDashboard.test.ts`

This slice creates no visible dashboard card. It gives the later card a typed, testable way to summarize nullable points and obtain a bounded history result without causing page-wide state updates.

- [ ] **Step 1: Write the failing pure-data tests.**

  In `tests/tokenHistoryDashboard.test.ts`, import the planned pure helpers and construct a `TokenHistoryResult` with `null`, `0`, and positive points. Cover these cases:

  - the supported ranges are exactly `15m`, `1d`, `7d`, and `30d`;
  - the cache key differs for either a different cluster or a different range;
  - a cache entry is fresh through 60,000 ms and stale after that boundary;
  - summary math ignores `null` but preserves `0` as a real latest/minimum/average value;
  - an all-null result has no latest, average, minimum, or maximum value;
  - the source for the hook calls `rpc.tokenHistory.get` and does not contain a history stream call or a direct `http` cluster URL.

  Example fixture and assertions:

  ```ts
  const result: TokenHistoryResult = {
    cluster: "alpha",
    fingerprint: "abc",
    range: "15m",
    fromMs: 0,
    toMs: 15_000,
    resolutionMs: 5_000,
    state: "partial",
    coverage: 2 / 3,
    points: [
      { atMs: 0, tokensPerSecond: null },
      { atMs: 5_000, tokensPerSecond: 0 },
      { atMs: 10_000, tokensPerSecond: 20 },
    ],
  };

  expect(summarizeTokenHistory(result)).toMatchObject({
    latest: 20,
    minimum: 0,
    maximum: 20,
    average: 10,
    latestAtMs: 10_000,
  });
  ```

  Run: `pnpm vitest run tests/tokenHistoryDashboard.test.ts`

  Expected: FAIL because the helper module does not exist yet.

- [ ] **Step 2: Implement the pure history presentation helpers.**

  In `app/components/dashboard/tokenHistoryData.ts`, import `TokenHistoryResult` and `TrendRange` from `@/lib/tokenHistory`; do not duplicate their unions or schemas. Export:

  ```ts
  export const TOKEN_HISTORY_RANGES = ["15m", "1d", "7d", "30d"] as const;
  export const TOKEN_HISTORY_REFRESH_MS = 60_000;

  export function tokenHistoryCacheKey(cluster: string, range: TrendRange): string {
    return `${cluster}\u0000${range}`;
  }

  export function isFreshHistoryCache(fetchedAtMs: number, nowMs: number): boolean {
    return nowMs - fetchedAtMs <= TOKEN_HISTORY_REFRESH_MS;
  }
  ```

  Add `summarizeTokenHistory(result)` and formatting helpers. Iterate points with an explicit `point.tokensPerSecond !== null` check, retain the latest non-null timestamp, and return `null` statistics when there are no valid points. Format a valid zero as `0.0 Tokens/s`; do not use truthiness checks for metrics.

- [ ] **Step 3: Implement the isolated request hook.**

  In `app/components/dashboard/useTokenHistory.ts`, add a client hook with this public shape:

  ```ts
  export type TokenHistoryQueryState = {
    requestedRange: TrendRange;
    displayedRange: TrendRange | null;
    result: TokenHistoryResult | null;
    isInitialLoading: boolean;
    isRefreshing: boolean;
    isStale: boolean;
    error: string | null;
    retry: () => void;
  };

  export function useTokenHistory(
    cluster: string,
    range: TrendRange,
  ): TokenHistoryQueryState;
  ```

  Use a module-local `Map<string, { result: TokenHistoryResult; fetchedAtMs: number }>` and a second in-flight promise map keyed with `tokenHistoryCacheKey(cluster, range)`. The hook must:

  1. show a fresh cached result immediately;
  2. request a stale or missing value with `rpc.tokenHistory.get({ cluster, range }, { signal })`;
  3. use one `AbortController` per mounted card/range request and abort it on unmount or range change;
  4. ignore an aborted or superseded response rather than displaying it as an error;
  5. use `setTimeout` or an interval to refresh the currently selected range at `TOKEN_HISTORY_REFRESH_MS`, never faster;
  6. preserve the last successful result while a new range is loading, exposing its range as `displayedRange`;
  7. preserve a last successful result after a background failure, set `isStale`, and expose a retry action; and
  8. make retry disabled by the card while an identical request is already in flight.

  Do not put this state in `DashboardLive`, `ReactorStateProvider`, or a global page store. A shared cache is allowed; shared React state is not.

- [ ] **Step 4: Make the tests pass and run the focused checks.**

  Run: `pnpm vitest run tests/tokenHistoryDashboard.test.ts`

  Run: `pnpm typecheck`

  Expected: tests pass, TypeScript resolves the existing `rpc.tokenHistory.get` contract, and the helper does not turn missing readings into zero.

- [ ] **Step 5: Commit the non-visual slice.**

  ```bash
  git add app/components/dashboard/tokenHistoryData.ts \
    app/components/dashboard/useTokenHistory.ts \
    tests/tokenHistoryDashboard.test.ts
  git commit -m "feat(dashboard): add token history client data hook"
  ```

  Do not deploy this slice by itself: it has no user-visible dashboard result.

## Task 2: Deliver the 15-minute card for every saved cluster

**Files:**

- Create: `app/components/dashboard/ClusterTokenHistorySection.tsx`
- Create: `app/components/dashboard/ClusterTokenHistoryCard.tsx`
- Create: `app/components/dashboard/TokenHistoryChart.tsx`
- Modify: `app/components/dashboard/DashboardLive.tsx`
- Modify: `tests/dashboardLayout.test.ts`
- Modify: `tests/tokenHistoryDashboard.test.ts`

This is the first user-visible deployment. It proves persisted 15-minute data, zero, gaps, startup collection, and per-cluster rendering before the longer-range controls are added.

- [ ] **Step 1: Extend the layout test before changing the dashboard.**

  In `tests/dashboardLayout.test.ts`, render `DashboardLive` with `alpha`, `beta`, and `gamma`. Add assertions that:

  - the existing `Cluster overview` and saved-cluster overview still render first;
  - the existing `Saved cluster fleet` still renders before the new section;
  - the new `Token throughput history` section is before `Workloads`;
  - all three supplied cluster names occur in the history section; and
  - the history grid is `grid grid-cols-1 gap-4 lg:grid-cols-2` (one column on a narrow screen, responsive grid on a wider screen).

  Keep the existing tests for the overview cards unchanged. This prevents a history-card change from silently replacing or renaming them.

  Run: `pnpm vitest run tests/dashboardLayout.test.ts tests/tokenHistoryDashboard.test.ts`

  Expected: FAIL because the history section does not exist.

- [ ] **Step 2: Build a memoized 15-minute section and cards.**

  In `ClusterTokenHistorySection.tsx`:

  - accept `{ clusters: ClusterEntry[] }`;
  - export `memo(ClusterTokenHistorySection)` so unchanged `clusters` props bypass re-render when live status updates change `DashboardLive`;
  - render a section headed `Token throughput history` with an accessible description that the data is persisted Tokens/s history;
  - map `clusters` in received order to `ClusterTokenHistoryCard`, passing `range="15m"`; and
  - use `className="grid grid-cols-1 gap-4 lg:grid-cols-2"` for the cards.

  In `ClusterTokenHistoryCard.tsx`, export a memoized card which calls `useTokenHistory(cluster.name, range)` and uses `Card`, `CardHeader`, `CardTitle`, `CardBody`, and `Badge`. Do not consume `ReactorStateContext`.

  Render these honest states:

  | Condition | Card content |
  | --- | --- |
  | No result and initial request in flight | a fixed `h-56` loading region with `aria-busy="true"` |
  | `ready` | green `Ready` badge and a chart |
  | `partial` | amber `Partial history` badge and a chart with gaps |
  | `empty` | neutral `Collecting history` badge and a chart-sized explanation, no plotted zero line |
  | `unavailable` or first-request error | red `History unavailable` badge, an explanation, and a Retry button |
  | Cached chart while changing range or retrying | retain the chart and state `Loading 1d; showing 15m` (using the actual requested/displayed ranges) |

  Give every successful card a textual latest, average, min--max, coverage, and freshness line. Show `0.0 Tokens/s` when the underlying value is zero. Use the existing result's `coverage` and latest non-null point timestamp; never claim that an all-null series has a latest value.

- [ ] **Step 3: Build the chart as a passive visual of the RPC result.**

  In `TokenHistoryChart.tsx`, use the existing Recharts pattern from `app/components/benchmarks/BenchmarkCharts.tsx`:

  ```tsx
  <div className="h-56 w-full" role="img" aria-label={summary}>
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={result.points} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="atMs" tickFormatter={formatTimestamp} />
        <YAxis tickFormatter={(value) => `${value} tok/s`} width={56} />
        <Tooltip labelFormatter={formatTimestamp} formatter={formatTokensPerSecond} />
        <Line
          type="linear"
          dataKey="tokensPerSecond"
          connectNulls={false}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  </div>
  ```

  Use a `Date`/`Intl.DateTimeFormat` formatter that receives the epoch-millisecond point time. Do not transform `null` points before passing them to Recharts. Keep the chart free of effects, timers, or RPC calls.

- [ ] **Step 4: Insert the section without coupling it to live dashboard state.**

  In `app/components/dashboard/DashboardLive.tsx`, add exactly one structural insertion:

  ```tsx
  <TwinReactorFleet clusters={clusters} />

  <ClusterTokenHistorySection clusters={clusters} />

  {errors.length > 0 && (
  ```

  Import the section normally. Do not add a server-side history fetch to `app/dashboard/page.tsx`; that would delay initial navigation and make all cards wait together.

- [ ] **Step 5: Finish and verify the first visual slice.**

  Add static-render tests for card heading, zero text, empty/unavailable messages, retry, and chart `role="img"` label through a small presentational fixture or pure helper. Then run:

  ```bash
  pnpm vitest run tests/dashboardLayout.test.ts tests/tokenHistoryDashboard.test.ts
  pnpm lint
  pnpm typecheck
  pnpm build
  ```

  In a real browser against a server with data, verify C032 and C458 each have a separate 15m card; verify a third temporary saved-cluster fixture produces a third card in tests; verify an interrupted sequence shows a gap; and verify zero is visible instead of absent.

- [ ] **Step 6: Merge and deploy the first visual slice.**

  ```bash
  git add app/components/dashboard/ClusterTokenHistorySection.tsx \
    app/components/dashboard/ClusterTokenHistoryCard.tsx \
    app/components/dashboard/TokenHistoryChart.tsx \
    app/components/dashboard/DashboardLive.tsx \
    tests/dashboardLayout.test.ts \
    tests/tokenHistoryDashboard.test.ts
  git commit -m "feat(dashboard): show per-cluster token throughput history"
  ```

  Open a pull request from the feature branch to `claudio-fork/main`, review it, merge it, deploy that exact merged fork commit to Coxshire, and browser-verify `/dashboard`. Record the merged SHA, deployed SHA, endpoint response, and visible cards in the deployment note. Do not use the upstream remote.

## Task 3: Add shared range controls and resilient range transitions

**Files:**

- Modify: `app/components/dashboard/ClusterTokenHistorySection.tsx`
- Modify: `app/components/dashboard/ClusterTokenHistoryCard.tsx`
- Modify: `app/components/dashboard/useTokenHistory.ts`
- Modify: `tests/dashboardLayout.test.ts`
- Modify: `tests/tokenHistoryDashboard.test.ts`

This slice makes the same period comparable across every card without turning a range selection into a page navigation or a new live telemetry subscription.

- [ ] **Step 1: Add failing range-control and cache tests.**

  Extend `tests/tokenHistoryDashboard.test.ts` to assert:

  - the section has one `role="tablist"` labelled `Token throughput range`;
  - it exposes four native buttons with `role="tab"`, text `15m`, `1d`, `7d`, and `30d`, with `15m` selected initially;
  - changing range passes the same selected `TrendRange` to every supplied cluster card;
  - a saved response is keyed by both cluster and range, so a cached `alpha/15m` result is not presented as `alpha/1d` or `beta/15m`;
  - a range change keeps the prior chart visible while the requested range loads; and
  - parent live-status updates cannot trigger `rpc.tokenHistory.get` or re-render a memoized history section when `clusters` has the same identity.

  For behavior that cannot run in the Node-only test environment, test the pure cache and static markup here and reserve keyboard/focus behavior for browser verification below.

  Run: `pnpm vitest run tests/dashboardLayout.test.ts tests/tokenHistoryDashboard.test.ts`

  Expected: FAIL because the 15m section has no selectable range control.

- [ ] **Step 2: Implement one shared, keyboard-accessible selector.**

  In `ClusterTokenHistorySection.tsx`, own `const [range, setRange] = useState<TrendRange>("15m")`. Render one selector above the grid:

  ```tsx
  <div role="tablist" aria-label="Token throughput range">
    {TOKEN_HISTORY_RANGES.map((item) => (
      <button
        key={item}
        id={`token-history-tab-${item}`}
        type="button"
        role="tab"
        aria-selected={range === item}
        aria-controls="token-history-cards"
        onClick={() => setRange(item)}
      >
        {item}
      </button>
    ))}
  </div>
  ```

  Give the card grid `id="token-history-cards"`, `role="tabpanel"`, and `aria-labelledby` pointing to the selected tab. Implement ArrowLeft, ArrowRight, Home, and End keyboard handling. Move focus to the newly selected tab, wrap arrows at either end, keep the selected state visible by text and focus ring, and do not rely on color alone.

- [ ] **Step 3: Preserve honest range and refresh behavior.**

  Update `ClusterTokenHistoryCard.tsx` to distinguish `requestedRange` from `displayedRange`.

  - When a selected range is already cached, display it immediately and allow the background revalidation to run.
  - When it is not cached, retain the last successful chart rather than blanking the card. Its summary, x-axis meaning, and freshness text must describe `displayedRange`, while adjacent loading text names `requestedRange`.
  - When a background request fails, leave the old data visible, mark it stale, provide Retry, and do not restart the entire dashboard or card grid.
  - Keep each active card's timer at the one-minute floor established in Slice 1. Cancel its timer and request on unmount/range change.

  The selected range will cause one bounded request per displayed saved cluster. It must not create an EventSource, polling loop for live status, or global refresh.

- [ ] **Step 4: Verify responsiveness and accessibility.**

  Run:

  ```bash
  pnpm vitest run tests/dashboardLayout.test.ts tests/tokenHistoryDashboard.test.ts
  pnpm lint
  pnpm typecheck
  pnpm build
  ```

  Browser verification on `/dashboard`:

  1. Use Tab, ArrowLeft/ArrowRight, Home, and End across the range selector; selected text, `aria-selected`, and focus must stay aligned.
  2. Select every range and confirm each visible saved-cluster card requests and labels the same range.
  3. Change from a cached 15m range to an uncached longer range: the 15m chart remains visible with an explicit transition message until the longer result arrives.
  4. Confirm all chart responses contain no more than 360 points, preserve gaps, and preserve a valid zero.
  5. While the live dashboard status updates, confirm navigation and history cards remain responsive and the history section does not flash or redraw as a whole.

- [ ] **Step 5: Merge and deploy the range slice.**

  ```bash
  git add app/components/dashboard/ClusterTokenHistorySection.tsx \
    app/components/dashboard/ClusterTokenHistoryCard.tsx \
    app/components/dashboard/useTokenHistory.ts \
    tests/dashboardLayout.test.ts \
    tests/tokenHistoryDashboard.test.ts
  git commit -m "feat(dashboard): add token history range controls"
  ```

  Open and merge a fork-only pull request to `claudio-fork/main`, deploy the exact merged SHA to Coxshire, then verify all four controls and per-cluster cards in the live browser. Do not change model lifecycle or cluster connectivity as part of deployment.

## Task 4: Final release checks and regression guardrails

**Files:**

- Modify if needed: `tests/dashboardLayout.test.ts`
- Modify if needed: `tests/tokenHistoryDashboard.test.ts`
- Create: `docs/operations/deployments/2026-09-13-token-throughput-history-ui.md`

- [ ] **Step 1: Rebase only against the fork's merged main branch.**

  Before final integration, fetch `claudio-fork/main`, rebase the history branch onto it, and resolve any `DashboardLive.tsx` overlap by preserving one instance each of Cluster Overview, Twin Reactor Fleet, History, errors, and Workloads in that order. Do not overwrite concurrent live-telemetry work.

- [ ] **Step 2: Run the full required verification suite.**

  ```bash
  pnpm vitest run
  pnpm lint
  pnpm typecheck
  pnpm build
  ```

  Confirm the test suite includes a three-cluster input case and that no test asserts a C032/C458-specific card count.

- [ ] **Step 3: Conduct a browser acceptance pass.**

  Verify each item visibly, rather than relying only on terminal output:

  - existing `Cluster overview` and Twin Reactor treatment are unchanged;
  - one history card renders per saved cluster in saved-cluster order;
  - narrow view stacks cards and wide view uses the responsive grid;
  - all range controls work from mouse and keyboard;
  - loading, empty, partial, unavailable, stale, gap, and zero-value states are understandable;
  - history refreshes independently on its one-minute schedule without a full page reload; and
  - switching dashboard tabs remains responsive while the history feature is present.

- [ ] **Step 4: Document the deployed evidence.**

  Create the deployment note with the fork PR URL, merge SHA, deployed SHA, deployment time, dashboard URL, visible saved-cluster names, ranges exercised, and browser observations. Do not record credentials or sensitive command output.

## Plan Review

- **Spec coverage:** The plan implements a card per saved cluster, all four ranges, bounded same-origin queries, null gaps, visible zero, cached transitions, accessible controls, and the required dashboard placement.
- **Performance coverage:** History state lives below `DashboardLive`, cards and section are memoized, RPC calls are bounded and cached by cluster/range, and history has its own one-minute refresh floor rather than a page-wide refresh.
- **Out-of-scope protection:** The plan does not alter collection, storage, RPC schemas, saved clusters, SSH, model services, or existing overview/Twin Reactor cards.
- **Delivery coverage:** The first visual 15m slice is separately merged, deployed, and browser-verified before range controls; all publication remains in `claudio-fork/main`, never upstream.
