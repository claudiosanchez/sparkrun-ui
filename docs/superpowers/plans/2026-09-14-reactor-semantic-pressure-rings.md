# Reactor Semantic-Pressure Rings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old memory/GPU Reactor rings with truthful per-cluster serving-pressure rings and semantic state colors while preserving the existing Dashboard control layout.

**Architecture:** The Dashboard server page loads an optional UI-local capacity-policy file and enriches the existing saved-cluster objects before they cross into the client. `deriveReactorState` turns vLLM readings plus that optional policy into typed semantic rings. `ReactorRings` keeps its existing three-ring SVG and definition-list layout, but derives ring color and accessible text from the semantic state instead of a fixed metric color.

**Tech Stack:** Next.js 16, React 19, TypeScript, Zod, Node filesystem APIs, Tailwind CSS, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-reactor-semantic-pressure-rings-design.md`

## Global Constraints

- Preserve the Reactor control topology: three continuous concentric arcs, center Tokens/sec, right-side legend, request facts, and hardware-details grid.
- Do not change Cluster overview, fleet ordering, routes, model services, SSH configuration, or telemetry collection cadence.
- Do not hard-code C032, C458, host names, safe concurrency, or queue budget.
- Do not infer a policy denominator from memory, GPU, KV capacity, or vLLM `max-num-seqs`.
- A missing or invalid target is neutral and explicit; it never yields a made-up percentage or a critical color.
- A stale numeric reading retains its arc length but is zinc and visibly/accessibly `Stale`.
- A value above 100% fills its arc to 100% but keeps its raw percentage in legend and `aria-valuetext`.
- Unified memory and GPU utilization remain supporting hardware facts and are not Reactor rings.
- Keep one Dashboard SSE connection and the existing per-cluster state-store ownership; do not add a browser polling loop.
- Deploy only the exact merged fork-main commit from a clean worktree. Do not assign live policy values without a verified operating-policy source.

---

## File structure

| File | Responsibility |
| --- | --- |
| `lib/reactorCapacityPolicy.ts` | Resolve the policy path, parse the UI-local JSON file, validate policies, and enrich saved clusters by name. |
| `lib/reactorCapacityPolicy.test.ts` | Prove path override, absent/invalid files, valid policies, and arbitrary-cluster enrichment. |
| `lib/schemas.ts` | Define the serializable optional `reactorCapacity` field on a Dashboard cluster. |
| `app/dashboard/page.tsx` | Load policies on the server and pass enriched saved clusters to the existing Dashboard tree. |
| `lib/reactorState.ts` | Derive KV, active-request, and queue rings with semantic status/tone values. |
| `lib/reactorState.test.ts` | Prove thresholds, missing targets, stale values, and preserving memory as a supporting metric. |
| `app/components/dashboard/ReactorRings.tsx` | Render the existing control with semantic colors, text statuses, and continuous accessible arcs. |
| `tests/dashboardLayout.test.ts` | Prove visual-content and accessibility contract in static markup. |
| `lib/reactorStateStore.test.ts` | Update a typed sample reactor to the new ring contract. |
| `README.md` | Document the policy file, override environment variable, and neutral missing-target behavior. |

### Task 1: Load explicit per-cluster capacity policy

**Files:**
- Create: `lib/reactorCapacityPolicy.ts`
- Create: `lib/reactorCapacityPolicy.test.ts`
- Modify: `lib/schemas.ts`
- Modify: `app/dashboard/page.tsx`
- Modify: `README.md`

**Interfaces:**
- Produces `ReactorCapacityPolicy` with `safeConcurrentRequests` and `queueBudget` positive integers.
- Produces `loadReactorCapacityPolicies(options?): Promise<Record<string, ReactorCapacityPolicy>>`.
- Produces `applyReactorCapacityPolicies(clusters, policies): ClusterEntry[]`.
- `ClusterEntry` gains optional `reactorCapacity?: ReactorCapacityPolicy`.

- [ ] **Step 1: Write the failing policy tests**

```ts
it("loads a named policy and enriches only that saved cluster", async () => {
  const readFile = async () => JSON.stringify({
    clusters: { c032: { safe_concurrent_requests: 4, queue_budget: 16 } },
  });
  const policies = await loadReactorCapacityPolicies({ readFile, path: "/policy.json" });
  expect(applyReactorCapacityPolicies([
    { name: "c032", hosts: ["a"], is_default: true },
    { name: "future", hosts: ["b"], is_default: false },
  ], policies)).toEqual([
    expect.objectContaining({ name: "c032", reactorCapacity: { safeConcurrentRequests: 4, queueBudget: 16 } }),
    expect.objectContaining({ name: "future", reactorCapacity: undefined }),
  ]);
});

it("returns no policy when the file is absent or a target is invalid", async () => {
  await expect(loadReactorCapacityPolicies({
    path: "/missing.json",
    readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  })).resolves.toEqual({});
  await expect(loadReactorCapacityPolicies({
    path: "/invalid.json",
    readFile: async () => JSON.stringify({ clusters: { c032: { safe_concurrent_requests: 0, queue_budget: 4 } } }),
  })).resolves.toEqual({});
});
```

Also assert an explicit `SPARKRUN_UI_REACTOR_CAPACITY_POLICY_PATH` wins over the platform default path.

- [ ] **Step 2: Run the focused test and verify the red state**

Run: `pnpm vitest run lib/reactorCapacityPolicy.test.ts`

Expected: FAIL because `lib/reactorCapacityPolicy.ts` does not exist.

- [ ] **Step 3: Implement the policy loader and cluster enrichment**

Create a strict external JSON schema:

```ts
const policyFileSchema = z.object({
  clusters: z.record(z.string(), z.object({
    safe_concurrent_requests: z.number().int().positive(),
    queue_budget: z.number().int().positive(),
  }).strict()),
}).strict();
```

Use `SPARKRUN_UI_REACTOR_CAPACITY_POLICY_PATH` when set. Otherwise use
`~/.config/sparkrun-ui/reactor-capacity.json` on Linux,
`~/Library/Application Support/sparkrun-ui/reactor-capacity.json` on macOS,
and `%APPDATA%/sparkrun-ui/reactor-capacity.json` on Windows. Return `{}` for
an absent or invalid file after a concise server warning. Transform only valid
snake_case file values into the camelCase policy attached to the matching
`ClusterEntry`. Do not add missing clusters or alter a cluster's name, host,
description, or default status.

In `app/dashboard/page.tsx`, load policies beside the existing initial data
fetch and pass `applyReactorCapacityPolicies(clusters, policies)` to
`DashboardLive`. Do not change the `clusters.list` RPC or the telemetry
runtime's saved-cluster discovery.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run lib/reactorCapacityPolicy.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Document and commit the policy source**

Add the exact file shape, default path, override variable, and `Target not
set` behavior to `README.md`. State plainly that safe concurrency and queue
budget are operating policy values, not model lifecycle settings.

```bash
git add lib/reactorCapacityPolicy.ts lib/reactorCapacityPolicy.test.ts lib/schemas.ts app/dashboard/page.tsx README.md
git commit -m "feat: load reactor capacity policy per cluster"
```

### Task 2: Derive semantic serving-pressure rings

**Files:**
- Modify: `lib/reactorState.ts`
- Modify: `lib/reactorState.test.ts`

**Interfaces:**
- Consumes optional `cluster.reactorCapacity` plus existing vLLM readings.
- Replaces `rings.memory`, `rings.kv`, and `rings.gpu` with `rings.kv`,
  `rings.active`, and `rings.queue`.
- Every ring has `{ label, percent, detail, status, tone, state, source }`.

- [ ] **Step 1: Write failing semantic-state tests**

```ts
it("derives serving-pressure rings from an explicit policy", () => {
  const state = deriveReactorState({
    cluster: { ...c032Entry, reactorCapacity: { safeConcurrentRequests: 4, queueBudget: 8 } },
    tick: c032Tick,
    vllm: snapshot({ kv: 78, running: 3, waiting: 2 }),
  });
  expect(state.rings).toMatchObject({
    kv: { percent: 78, status: "Watch", tone: "warning" },
    active: { percent: 75, detail: "3 / 4 safe requests", status: "Busy", tone: "warning" },
    queue: { percent: 25, detail: "2 / 8 queued-request budget", status: "Waiting", tone: "warning" },
  });
  expect("memory" in state.rings).toBe(false);
  expect("gpu" in state.rings).toBe(false);
  expect(state.metrics.memoryText).toBe("64.0 / 128.0 GB");
});

it("uses a neutral target-not-set state instead of fabricating pressure", () => {
  const state = deriveReactorState({ cluster: c032Entry, vllm });
  expect(state.rings.active).toMatchObject({ percent: null, status: "Target not set", tone: "neutral" });
  expect(state.rings.queue).toMatchObject({ percent: null, status: "Target not set", tone: "neutral" });
});
```

Also test KV `Headroom`, `Tight`, and `Critical`; active `Idle`, `Serving`,
`At capacity`, and `Over capacity`; queue `Clear`, `Backed up`, and `Queue
limit reached`; a stale numeric reading becoming zinc `Stale`; and an active
value above target retaining the raw percentage while visual geometry can be
clamped later.

- [ ] **Step 2: Run the focused test and verify the red state**

Run: `pnpm vitest run lib/reactorState.test.ts`

Expected: FAIL because the current state still exposes memory and GPU rings.

- [ ] **Step 3: Implement the smallest typed semantic mapper**

Keep `metrics.memoryText` and `metrics.gpuText` unchanged. Add a pure helper
for each capacity ratio that returns the raw percentage, status text, and one
of `"success" | "info" | "warning" | "pressure" | "critical" | "neutral"`.
Use the thresholds in the Spec verbatim. Readings in stale state retain their
raw ratio but use `status: "Stale"` and `tone: "neutral"`. A missing target,
missing numeric reading, warming reading, reset reading, or unavailable
reading has `percent: null` and a neutral explicit status.

Do not change collection, polling, SSE, or the current `Running` and `Queued`
text fields.

- [ ] **Step 4: Run focused tests and commit the state contract**

Run: `pnpm vitest run lib/reactorState.test.ts`

Expected: PASS.

```bash
git add lib/reactorState.ts lib/reactorState.test.ts
git commit -m "feat: derive semantic reactor pressure rings"
```

### Task 3: Render the existing control with semantic states

**Files:**
- Modify: `app/components/dashboard/ReactorRings.tsx`
- Modify: `tests/dashboardLayout.test.ts`
- Modify: `lib/reactorStateStore.test.ts`

**Interfaces:**
- Consumes the Task 2 `ReactorState["rings"]` contract.
- Renders exactly three continuous progress rings: `kv`, `active`, `queue`.
- Keeps the existing center Tokens/sec readout, request facts, and card-owned
  Unified memory hardware detail.

- [ ] **Step 1: Write failing control-markup tests**

```ts
it("renders semantic pressure rings without a memory or GPU ring", () => {
  const html = renderToStaticMarkup(createElement(ReactorRings, {
    rings: semanticRings({ kv: { percent: 78, status: "Watch", tone: "warning" } }),
    inference,
  }));
  for (const label of ["KV cache occupancy", "Active request capacity", "Queue pressure"]) {
    expect(html).toContain(label);
  }
  expect(html).not.toContain("Total unified memory");
  expect(html).not.toContain("GPU compute utilization");
  expect(html.match(/role="progressbar"/g) ?? []).toHaveLength(3);
  expect(html).toContain('aria-valuetext="78.0% · Watch"');
  expect(html).toContain('stroke-dasharray="78 100"');
});
```

Add tests for `Target not set` with no `aria-valuenow`, a raw 125% legend and
accessible text with a clamped `aria-valuenow="100"`, and a stale numeric
ring whose visible/accessible status is `Stale`.

- [ ] **Step 2: Run the focused test and verify the red state**

Run: `pnpm vitest run tests/dashboardLayout.test.ts lib/reactorStateStore.test.ts`

Expected: FAIL because the current renderer still expects memory/KV/GPU rings.

- [ ] **Step 3: Implement the visual mapping without changing layout**

Keep the current `svg`, radii, `pathLength="100"`, `strokeDasharray`, center
readout, flex topology, request facts, and reduced-motion behavior. Replace
the fixed `ringOrder` with `kv`, `active`, and `queue`. Map tones to existing
Tailwind semantics: emerald success, sky info, amber warning, orange pressure,
rose critical, and zinc neutral. Keep the matching legend dot and arc color
in sync. Put `${rawPercent.toFixed(1)}% · ${status}` in visible and accessible
text when numeric; put only the explicit status when no numeric percentage
exists. Keep geometry and `aria-valuenow` clamped to 0–100.

Remove the old GPU-only screen-reader sentence. Do not add a meter, nested
card, model label, or a second Unified memory presentation.

- [ ] **Step 4: Run focused tests, full test suite, and static checks**

Run: `pnpm vitest run tests/dashboardLayout.test.ts lib/reactorStateStore.test.ts && pnpm test && pnpm typecheck && pnpm lint && pnpm format:ci`

Expected: all tests pass. Report any pre-existing lint warning separately;
do not suppress it in this feature.

- [ ] **Step 5: Commit the UI change**

```bash
git add app/components/dashboard/ReactorRings.tsx tests/dashboardLayout.test.ts lib/reactorStateStore.test.ts
git commit -m "feat: color reactor rings by serving pressure"
```

## Final verification and release

1. Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:ci`, and `pnpm build` from the clean feature worktree.
2. Review the full branch diff against this Spec. Confirm the old memory/GPU rings are gone, Unified memory remains in the hardware grid, all new target-based rings stay neutral without policy, and no model or SSE code changed.
3. Push only to `claudio-fork`, open a fork PR against `claudio-fork/main`, merge it, and deploy the exact resulting fork-main merge commit to Coxshire.
4. On Coxshire, preserve `SPARKRUN_BIN`, do not change a model process, and do not invent a `reactor-capacity.json` policy. Verify the Dashboard in a browser: existing layout remains, C032/C458 still render, memory is a hardware detail, and the two target-based rings visibly say `Target not set` until an operator configures their policy.
