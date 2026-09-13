# Model Health Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure model-health badges settle as ready or unavailable, rather than remaining `Checking model API`.

**Architecture:** Bound saved-cluster discovery and `/v1/models` with the RPC abort signal and a three-second deadline. Add a four-second client deadline to each health poll. Telemetry remains independent.

**Tech Stack:** Next.js 16, TypeScript, oRPC, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-twin-reactor-dashboard-design.md`

## Global Constraints

- Only GET `/v1/models`; do not change model lifecycle or run inference.
- Resolve hosts only through `sparkrun cluster list --json`.
- Preserve the `ServiceHealth` `ready` and `unavailable` contract.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/rpc/procedures/services.ts` | Abort-aware bounded discovery and HTTP check. |
| `lib/rpc/procedures/services.test.ts` | Ready and failure/deadline tests. |
| `app/components/dashboard/useReactor.ts` | Four-second client deadline. |
| `lib/reactorState.test.ts` | Visible state labels. |

### Task 1: Bound the server procedure

**Files:** Modify `lib/rpc/procedures/services.ts`; test `lib/rpc/procedures/services.test.ts`.

**Interfaces:** `healthForCluster(cluster: string, signal?: AbortSignal): Promise<ServiceHealth>`.

- [ ] **Step 1: Write failing tests.** Assert that discovery receives `['cluster', 'list', '--json']` and `{ signal, timeoutMs: 3_000 }`; command rejection, timeout, non-OK, malformed/empty data, and fetch rejection return typed unavailable; a ready response keeps its saved host and first model.

- [ ] **Step 2: Run `pnpm vitest run lib/rpc/procedures/services.test.ts`.** Expected: FAIL because discovery is currently unbounded.

- [ ] **Step 3: Implement this signal helper and use it for both discovery and fetch.**

```ts
const HEALTH_TIMEOUT_MS = 3_000;
function healthSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
```

Call `runSparkrunJson` with `{ signal: bounded, timeoutMs: HEALTH_TIMEOUT_MS }`; call `fetch` with that signal; preserve the unavailable helper; and change the procedure handler to pass `signal` to `healthForCluster`.

- [ ] **Step 4: Run `pnpm vitest run lib/rpc/procedures/services.test.ts`; commit `lib/rpc/procedures/services.ts` and its test as `fix: bound model health checks`.**

### Task 2: Bound the client poll

**Files:** Modify `app/components/dashboard/useReactor.ts`; test `lib/reactorState.test.ts`.

**Interfaces:** Each `checkHealth` poll must settle within four seconds.

- [ ] **Step 1: Add tests that null service says checking, unavailable says `Model API unavailable`, and ready shows the model.**

- [ ] **Step 2: Change `checkHealth` to use:**

```ts
const healthSignal = AbortSignal.any([signal, AbortSignal.timeout(4_000)]);
const next = await rpc.services.health({ cluster: name }, { signal: healthSignal });
```

Keep its existing catch-to-unavailable path and ten-second interval.

- [ ] **Step 3: Run `pnpm test && pnpm typecheck && pnpm lint && pnpm build`; commit the hook and test as `fix: settle stalled model health state`.**

- [ ] **Step 4: After deployment, open the Coxshire Dashboard, wait five seconds, and confirm C458 is ready with the first `/v1/models` result or explicitly unavailable. It must not remain checking.**
