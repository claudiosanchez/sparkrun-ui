# Dynamic Cluster Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain the default-cluster aggregate card and add a compact overview card for every saved cluster.

**Architecture:** `AggregateStats` remains unchanged and streams the default cluster. `ClusterOverviewSection` receives the existing saved `clusters` array and maps it to named-stream `ClusterOverviewCard` instances. The detailed fleet remains below this new collection.

**Tech Stack:** Next.js 16, React 19, TypeScript, oRPC, Zod, Tailwind CSS, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-twin-reactor-dashboard-design.md`

## Global Constraints

- Keep `AggregateStats` first and do not pass it a `cluster` prop.
- Never branch on a cluster name, host address, or expected count.
- A failing card says `Telemetry unavailable` and cannot block a peer card.
- Keep `TwinReactorFleet` below the new section and workloads below the fleet.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `app/components/dashboard/ClusterOverviewCard.tsx` | Compact live telemetry for one saved cluster. |
| `app/components/dashboard/ClusterOverviewSection.tsx` | Dynamic grid and empty state. |
| `app/components/dashboard/DashboardLive.tsx` | Required section order. |
| `tests/dashboardLayout.test.ts` | Third-cluster and order proof. |

### Task 1: Add the dynamic cards

**Files:** Create `app/components/dashboard/ClusterOverviewCard.tsx`; create `app/components/dashboard/ClusterOverviewSection.tsx`; test `tests/dashboardLayout.test.ts`.

**Interfaces:** Consumes `ClusterEntry` and `rpc.monitor.stream({ cluster: cluster.name, intervalSec: 2 })`. Produces `<ClusterOverviewSection clusters={clusters} />`.

- [ ] **Step 1: Write the failing three-cluster layout test.**

```ts
const clusters = ["alpha", "beta", "gamma"].map((name, index) => ({ name, hosts: [`10.0.0.${index + 1}`], is_default: index === 0 }));
expect(html).toContain('aria-label="Saved cluster overview"');
for (const name of ["alpha", "beta", "gamma"]) expect(html).toContain(name);
```

Also assert: `Cluster overview` before `Saved cluster overview` before `Saved cluster fleet` before `Workloads`.

- [ ] **Step 2: Run `pnpm vitest run tests/dashboardLayout.test.ts`.**

Expected: FAIL because the collection does not exist.

- [ ] **Step 3: Implement the section.**

```tsx
export function ClusterOverviewSection({ clusters }: { clusters: ClusterEntry[] }) {
  return <section aria-label="Saved cluster overview"><h2>Clusters</h2><div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{clusters.map((cluster) => <ClusterOverviewCard key={cluster.name} cluster={cluster} />)}</div></section>;
}
```

`ClusterOverviewCard` uses `MonitorTick`, `monitorHostViews`, and `numberMetric`, reads only `cluster.hosts`, and displays CPU, GPU, memory, temperature, power, and host count. It aborts its named stream on cleanup. Missing or bad data uses em dashes and `Telemetry unavailable`; a disconnected stream retains valid values only with `Reconnecting`.

- [ ] **Step 4: Run `pnpm vitest run tests/dashboardLayout.test.ts && pnpm typecheck`, then commit.**

```bash
git add app/components/dashboard/ClusterOverviewCard.tsx app/components/dashboard/ClusterOverviewSection.tsx tests/dashboardLayout.test.ts
git commit -m "feat: add dynamic cluster overview cards"
```

### Task 2: Integrate without changing the aggregate

**Files:** Modify `app/components/dashboard/DashboardLive.tsx`; modify `tests/dashboardLayout.test.ts`; test `lib/reactorState.test.ts`.

**Interfaces:** Produces this exact order:

```tsx
<AggregateStats />
<ClusterOverviewSection clusters={clusters} />
<TwinReactorFleet clusters={clusters} initialStatuses={initialStatuses} onStatus={updateStatus} />
```

- [ ] **Step 1: Add a `future-spark` arbitrary-name state test, with a valid monitor tick, and expect `telemetryState` to equal `live`.**

- [ ] **Step 2: Insert the section, run `pnpm test && pnpm typecheck && pnpm lint && pnpm build`, and confirm all pass.**

- [ ] **Step 3: Check `/dashboard` at desktop and phone widths. Confirm aggregate first, one compact card per saved cluster, fleet below, and workloads last.**

- [ ] **Step 4: Commit.**

```bash
git add app/components/dashboard/DashboardLive.tsx lib/reactorState.test.ts tests/dashboardLayout.test.ts
git commit -m "feat: show saved clusters in dashboard overview"
```
