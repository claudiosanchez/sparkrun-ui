# Dual-Cluster Twin-Reactor Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every saved Sparkrun cluster as an independently live reactor on the Dashboard, including C458's direct model API health.

**Architecture:** The server discovers saved clusters and fetches initial status per cluster. Each client-side reactor card owns its own targeted status stream, monitor stream, and bounded model-API health poll. A shared monitor module validates Sparkrun's actual array-based monitor output and gives every screen one stable host view.

**Tech Stack:** Next.js 16, React 19, TypeScript, oRPC, Zod, Tailwind CSS, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-twin-reactor-dashboard-design.md`

## Global Constraints

- Discover saved clusters through `sparkrun cluster list --json`; never hard-code `c032` or `c458`.
- Do not change Sparkrun's default cluster.
- Resolve model API health only from a saved cluster's configured hosts at port `8000`.
- Keep C458 model lifecycle unchanged. This feature performs no inference request.
- Keep the existing workload controls, `/monitor`, `/chat`, `/launch`, and `/logs` workflows.
- Keep the work local and backed up to `claudio-fork/codex/twin-reactor-dashboard`. Do not open or merge a pull request.
- Do not deploy to Coxshire without a separate explicit user instruction.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/monitor.ts` | Parse real CLI monitor ticks, produce display-safe host views, and preserve host errors. |
| `lib/monitor.test.ts` | Test monitor parsing, missing GPU-memory fields, and host-error handling. |
| `lib/rpc/procedures/monitor.ts` | Stream the typed monitor wire contract. |
| `lib/rpc/procedures/status.ts` | Fetch and stream default or named-cluster status. |
| `lib/rpc/procedures/status.test.ts` | Prove target arguments for default and named-cluster status reads. |
| `lib/rpc/procedures/services.ts` | Resolve a saved cluster and check its model API with a bounded request. |
| `lib/rpc/procedures/services.test.ts` | Test ready, empty, failed, timed-out, and unknown-cluster model API checks. |
| `lib/rpc/router.ts` | Register `services.health`. |
| `app/dashboard/page.tsx` | Build the initial per-cluster Dashboard snapshot. |
| `lib/reactorState.ts` | Derive card labels and measurements from typed status, monitor, and API results. |
| `lib/reactorState.test.ts` | Test independent reactor states without a browser-only test environment. |
| `app/components/dashboard/useReactor.ts` | Subscribe and poll one cluster without coupling peer reactors. |
| `app/components/dashboard/ReactorCard.tsx` | Render one accessible live reactor. |
| `app/components/dashboard/TwinReactorFleet.tsx` | Lay out one or more reactor cards and the two-reactor divider. |
| `app/components/dashboard/DashboardLive.tsx` | Render the fleet first and retain combined workload cards below it. |
| `app/components/HeaderStats.tsx` | Read normalized monitor hosts for the global header. |
| `app/components/monitor/MonitorLive.tsx` | Read normalized monitor hosts without changing the monitor screen layout. |
| `lib/__fixtures__/monitor-stream.ndjson` | Store the observed array-shaped monitor contract. |

## Task 1: Normalize the real monitor stream

**Files:**
- Create: `lib/monitor.ts`
- Test: `lib/monitor.test.ts`
- Modify: `lib/rpc/procedures/monitor.ts`
- Modify: `lib/schemas.test.ts`
- Modify: `lib/__fixtures__/monitor-stream.ndjson`

**Interfaces:**
- Consumes: one JSON line from `sparkrun cluster monitor --json`.
- Produces: `MonitorTick`, `MonitorHost`, `monitorHostViews(tick)`, and `numberMetric(value)` from `lib/monitor.ts`.

- [ ] **Step 1: Write the failing monitor-contract tests**

```ts
import { describe, expect, it } from "vitest";
import { MonitorTickSchema, monitorHostViews, numberMetric } from "./monitor";

describe("monitorHostViews", () => {
  it("keeps a valid C458 sample keyed by its reported host", () => {
    const tick = MonitorTickSchema.parse({
      timestamp: 1,
      hosts: [{ host: "100.83.161.109", error: null, sample: { gpu_util_pct: "0" } }],
    });
    expect(monitorHostViews(tick)["100.83.161.109"].sample?.gpu_util_pct).toBe("0");
  });

  it("keeps an empty GPU-memory value unavailable", () => {
    expect(numberMetric("")).toBeNull();
  });

  it("keeps the monitor host error instead of inventing metrics", () => {
    const tick = MonitorTickSchema.parse({
      timestamp: 1,
      hosts: [{ host: "100.83.161.109", error: "Permission denied", sample: null }],
    });
    expect(monitorHostViews(tick)["100.83.161.109"]).toMatchObject({
      error: "Permission denied",
      sample: null,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run lib/monitor.test.ts`

Expected: FAIL because `./monitor` does not exist.

- [ ] **Step 3: Implement the monitor contract and normalizer**

```ts
export const MonitorSampleSchema = z.object({}).catchall(z.string());
export const MonitorHostSchema = z.object({
  host: z.string(),
  error: z.unknown().nullable().default(null),
  sample: MonitorSampleSchema.nullable().default(null),
  workloads: z.array(z.unknown()).default([]),
  used_slots: z.number().default(0),
  free_slots: z.number().default(0),
}).loose();
export const MonitorTickSchema = z.object({ timestamp: z.number(), hosts: z.array(MonitorHostSchema) });

export function monitorHostViews(tick: MonitorTick): Record<string, MonitorHost> {
  return Object.fromEntries(tick.hosts.map((entry) => [entry.host, entry]));
}

export function numberMetric(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}
```

Import `MonitorTickSchema` into the RPC procedure and use it as the stream output schema. Replace the fixture's object-shaped `hosts` value with C032 and C458 array entries captured from the CLI. Update `lib/schemas.test.ts` to validate a whole `MonitorTickSchema` per line instead of iterating `Object.values(obj.hosts)`.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm vitest run lib/monitor.test.ts lib/schemas.test.ts`

Expected: PASS; the real array fixture parses and missing GPU-memory values remain unavailable.

- [ ] **Step 5: Commit the contract slice**

```bash
git add lib/monitor.ts lib/monitor.test.ts lib/rpc/procedures/monitor.ts \
  lib/schemas.test.ts lib/__fixtures__/monitor-stream.ndjson
git commit -m "fix: normalize Sparkrun monitor ticks"
```

## Task 2: Target status per cluster and expose bounded model API health

**Files:**
- Create: `lib/rpc/procedures/status.test.ts`
- Create: `lib/rpc/procedures/services.ts`
- Create: `lib/rpc/procedures/services.test.ts`
- Modify: `lib/rpc/procedures/status.ts`
- Modify: `lib/rpc/router.ts`

**Interfaces:**
- Consumes: `{ cluster?: string }` for `status.get` and `status.stream`; `{ cluster: string }` for `services.health`.
- Produces: a `ClusterStatus` for a selected saved cluster and `{ cluster, host, state, model? }` for model API health, where `state` is `ready` or `unavailable`.

- [ ] **Step 1: Write the failing status-target tests**

Mock `@/lib/sparkrun` in `status.test.ts`, call the exported `fetchStatus` helper, and assert exact arguments:

```ts
expect(runSparkrunJson).toHaveBeenCalledWith(["cluster", "status", "--json"]);
expect(runSparkrunJson).toHaveBeenCalledWith([
  "cluster", "status", "--cluster", "c458", "--json",
]);
```

Write health tests that mock `runSparkrunJson` with a saved `c458` host and mock `fetch`:

```ts
expect(await healthForCluster("c458")).toEqual({
  cluster: "c458", host: "100.83.161.109", state: "ready", model: "qwen",
});
expect(await healthForCluster("missing")).toEqual({
  cluster: "missing", host: null, state: "unavailable", model: null,
});
```

Include an empty `data` array, non-OK response, rejected fetch, and aborted timeout case.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run lib/rpc/procedures/status.test.ts lib/rpc/procedures/services.test.ts`

Expected: FAIL because named status targeting and `services.ts` do not exist.

- [ ] **Step 3: Implement named status and health checks**

```ts
const StatusInputSchema = z.object({ cluster: z.string().min(1).optional() }).optional();

export async function fetchStatus(cluster?: string): Promise<ClusterStatus> {
  const args = ["cluster", "status"];
  if (cluster) args.push("--cluster", cluster);
  args.push("--json");
  return ClusterStatusSchema.parse(await runSparkrunJson<unknown>(args));
}
```

In `services.ts`, first read `sparkrun cluster list --json`, locate the exact
cluster name, then fetch `http://${host}:8000/v1/models` with
`AbortSignal.timeout(3_000)`. Return a typed unavailable result for every
failure. Do not accept a host or URL from the RPC caller. Register the
procedure as `router.services.health`.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm vitest run lib/rpc/procedures/status.test.ts lib/rpc/procedures/services.test.ts`

Expected: PASS; C458 gets `--cluster c458`, while the default call stays unchanged and health failures remain contained.

- [ ] **Step 5: Commit the status and health slice**

```bash
git add lib/rpc/procedures/status.ts lib/rpc/procedures/status.test.ts \
  lib/rpc/procedures/services.ts lib/rpc/procedures/services.test.ts lib/rpc/router.ts
git commit -m "feat: add per-cluster reactor health"
```

## Task 3: Build the independent twin-reactor Dashboard

**Files:**
- Create: `lib/reactorState.ts`
- Create: `lib/reactorState.test.ts`
- Create: `app/components/dashboard/useReactor.ts`
- Create: `app/components/dashboard/ReactorCard.tsx`
- Create: `app/components/dashboard/TwinReactorFleet.tsx`
- Modify: `app/dashboard/page.tsx`
- Modify: `app/components/dashboard/DashboardLive.tsx`

**Interfaces:**
- Consumes: `ClusterEntry`, optional initial `ClusterStatus`, `MonitorTick`, and `services.health` result for one cluster.
- Produces: `ReactorState` with `telemetryState`, `serviceState`, `managedWorkloadCount`, metrics, and safe display strings.

- [ ] **Step 1: Write failing pure reactor-state tests**

```ts
it("keeps C032 live when C458 model health is unavailable", () => {
  const c032 = deriveReactorState({ cluster: c032Entry, tick: c032Tick, service: ready });
  const c458 = deriveReactorState({ cluster: c458Entry, tick: c458Tick, service: unavailable });
  expect(c032.telemetryState).toBe("live");
  expect(c458.serviceState).toBe("unavailable");
  expect(c458.metrics.gpuMemoryText).toBe("—");
});

it("labels a direct service with zero managed workloads", () => {
  expect(deriveReactorState({ cluster: c458Entry, status: emptyStatus }).managedWorkloadText)
    .toBe("0 managed workloads");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run lib/reactorState.test.ts`

Expected: FAIL because `reactorState.ts` does not exist.

- [ ] **Step 3: Implement state derivation and subscriptions**

`lib/reactorState.ts` must use `numberMetric` and return `—` for missing numbers.
`useReactor.ts` must create a separate `AbortController` for each reactor,
stream `rpc.status.stream({ cluster, intervalMs: 3000 })`, stream
`rpc.monitor.stream({ cluster, intervalSec: 2 })`, and call
`rpc.services.health({ cluster })` immediately and every 10 seconds. Its
cleanup aborts only that card's requests and clears only that card's timer.

`DashboardPage` must call `serverClient.clusters.list()`, then use
`Promise.all` with per-cluster `.catch(() => null)` for initial status. It
must build recipe labels from the flattened non-null status entries.

`TwinReactorFleet` renders saved clusters in list order. It uses a two-column
stage and visible divider only when exactly two entries exist; otherwise it
uses the responsive grid. `ReactorCard` exposes status in text as well as
color, uses `aria-live="polite"` for freshness, and keeps the workload cards
below the fleet stage. It reuses the existing Card and Badge primitives rather
than the standalone widget's CSS or markup.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `pnpm vitest run lib/reactorState.test.ts`

Expected: PASS; the C458 API failure does not change the C032 reactor state.

- [ ] **Step 5: Commit the dashboard slice**

```bash
git add app/dashboard/page.tsx lib/reactorState.ts lib/reactorState.test.ts \
  app/components/dashboard/useReactor.ts \
  app/components/dashboard/ReactorCard.tsx app/components/dashboard/TwinReactorFleet.tsx \
  app/components/dashboard/DashboardLive.tsx
git commit -m "feat: show saved clusters as twin reactors"
```

## Task 4: Update existing monitor consumers for the stable contract

**Files:**
- Modify: `app/components/HeaderStats.tsx`
- Modify: `app/components/monitor/MonitorLive.tsx`
- Test: `lib/monitor.test.ts`

**Interfaces:**
- Consumes: `MonitorTick` and `monitorHostViews` from `lib/monitor.ts`.
- Produces: the current header and monitor-page displays with no object-shaped monitor assumption.

- [ ] **Step 1: Extend the failing monitor tests for both consumers' input**

```ts
it("returns both host samples from one array tick", () => {
  const views = monitorHostViews(twoHostTick);
  expect(Object.keys(views)).toEqual(["100.65.40.24", "100.83.161.109"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run lib/monitor.test.ts`

Expected: FAIL until the two-host fixture and normalizer support the real array input.

- [ ] **Step 3: Replace local casts with the shared normalizer**

In `HeaderStats.tsx`, calculate averages from
`Object.values(monitorHostViews(tick)).flatMap((host) => host.sample ? [host.sample] : [])`.
In `MonitorLive.tsx`, derive display hosts from the same function and show a
small existing-style Card message when a host has `error` and no sample.
Do not change either route's navigation or existing `HostCard` meter layout.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm vitest run lib/monitor.test.ts`

Expected: PASS; the two-host tick remains addressable by both host IPs.

- [ ] **Step 5: Commit the compatibility slice**

```bash
git add app/components/HeaderStats.tsx app/components/monitor/MonitorLive.tsx lib/monitor.test.ts
git commit -m "fix: share normalized monitor data across screens"
```

## Task 5: Verify the local build and prepare a deployment decision

**Files:**
- Modify only if a verification finding requires a minimal fix: files named by that finding.

**Interfaces:**
- Consumes: the completed local branch and local dependency installation.
- Produces: a verified local build and a concise request for explicit Coxshire deployment approval.

- [ ] **Step 1: Run the complete automated suite**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`

Expected: all commands pass with no TypeScript, lint, or production-build errors.

- [ ] **Step 2: Inspect the local Dashboard in a browser**

Run: `pnpm dev`

Open: `http://127.0.0.1:5678/dashboard`

Expected: the fleet stage is responsive and remains readable at desktop and phone widths. Local telemetry may be unavailable because this workstation does not own Coxshire's Sparkrun configuration; that state must be labelled, not synthesized.

- [ ] **Step 3: Check the final diff and commit only a verification fix**

```bash
git status --short
git diff --check
git log --oneline origin/main..HEAD
```

Expected: the design and plan commits, the four planned implementation commits, and an optional minimal verification-fix commit are present.

- [ ] **Step 4: Back up the completed local branch to the fork**

```bash
git push claudio-fork codex/twin-reactor-dashboard
```

Expected: the fork has the local branch; no pull request is opened.

- [ ] **Step 5: Request separate deployment direction**

Report the local verification results. Ask whether to deploy the named fork
branch to Coxshire. Do not restart Coxshire, alter `SPARKRUN_BIN`, or change
either model service until the user explicitly directs that deployment.
