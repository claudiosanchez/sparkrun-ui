# Twin Reactor live metrics deployment record

## Release identity

The feature and its live-connection follow-up were merged before deployment.
The dashboard was deployed from the final merge commit, not from an unmerged
feature branch.

- Feature PR: https://github.com/claudiosanchez/sparkrun-ui/pull/1
- Feature merge commit: `ffae5bf1e0b74c37f08bb8294a7d8e9a4df1aeee`
- Connection-capacity follow-up PR: https://github.com/claudiosanchez/sparkrun-ui/pull/2
- Deployed merge commit (`MERGED_REVISION`): `c35cd6068e346d295466d62476636607630e991a`
- Local branch: `codex/twin-reactor-dashboard`
- Remote integration ref: `claudio-fork/codex/twin-reactor-dashboard`
- Deployment status: `Deployed and browser-verified`

## Target and release evidence

- Source worktree: `/Users/claudio/Projects/.worktrees/sparkrun-ui-twin-reactor`
- Coxshire source root: `/Users/claudio/sparkrun-ui`
- Backup path: `/Users/claudio/sparkrun-ui-backups/twin-reactor-20260913T205018Z`
- Earlier feature-release backup: `/Users/claudio/sparkrun-ui-backups/twin-reactor-20260913T204120Z`
- Deployed revision: `c35cd6068e346d295466d62476636607630e991a`
- Standalone UI PID: `98255`
- Deployment verification timestamp: `2026-09-13T20:53:01Z`
- Dashboard URL: `http://100.78.146.12:5678/dashboard`

The Coxshire source directory has no Git checkout. Before each deployment,
the exact merge tree was archived locally, synced, and verified by matching
SHA-1 values for the changed source files. The application deployment uses the
exact merge commit; this later documentation commit is not application code.

## Pre-deployment checks

The implementation worktree passed the following checks on 2026-09-13:

```text
pnpm test       23 files, 138 tests passed
pnpm typecheck  passed
pnpm lint       passed
pnpm build      passed
```

`pnpm format:ci` reports existing formatting differences in
`app/components/HeaderStats.tsx`, `lib/monitor.ts`,
`lib/rpc/procedures/monitor.ts`, `lib/schemas.ts`, and
`lib/useReactor.test.ts`. The Twin Reactor feature files are formatted.

Focused feature checks passed:

```text
pnpm vitest run lib/vllmMetrics.test.ts lib/vllmCollector.test.ts \
  lib/rpc/procedures/vllmMetrics.test.ts lib/reactorState.test.ts \
  lib/reactorStateStore.test.ts lib/useReactor.test.ts \
  tests/dashboardConnections.test.ts tests/dashboardLayout.test.ts
```

## Post-deployment browser evidence

Fresh browser verification of `c35cd6068e346d295466d62476636607630e991a` found:

- C032: `Telemetry live`; outer unified-memory ring `76.1%`, middle KV-cache
  ring `0.0%`, inner GPU-compute ring `0.0%`, Tokens/s `0.0`, Running `0`,
  Queued `0`.
- C458: `Telemetry live`; outer unified-memory ring `92.8%`, middle KV-cache
  ring `0.0%`, inner GPU-compute ring `0.0%`, Tokens/s `0.0`, Running `0`,
  Queued `0`.
- Both vLLM sources were idle during verification, so the live zero rate was
  observed but a positive-to-zero transition was not fabricated.
- The browser contacts only same-origin `/rpc`; the source-level connection
  regression test confirms there is no browser request to a host `:8000`
  metrics endpoint.
- The aggregate overview, saved-cluster overview, detailed Twin Reactor cards,
  and workloads were visible in the browser. Tailnet HTTP checks returned 200
  for `/dashboard`, `/monitor`, and `/chat`.
- C458's separate model-health badge was `Model API unavailable` during this
  check. It does not affect the live vLLM telemetry stream; no model server was
  changed as part of this deployment.

## Rollback

1. Stop only the recorded standalone UI PID.
2. Restore `/Users/claudio/sparkrun-ui-backups/twin-reactor-20260913T205018Z` to
   `/Users/claudio/sparkrun-ui`.
3. Rebuild the standalone output with Node
   `/Users/claudio/.nvm/versions/node/v24.21.0/bin/node`, frozen pnpm
   dependencies, and the same `SPARKRUN_BIN` value.
4. Restart `/Users/claudio/sparkrun-ui/.next/standalone/server.js` on port
   `5678` with `HOSTNAME=0.0.0.0`.
5. Verify the Coxshire-local endpoint and the browser Dashboard before
   removing the backup.

Do not stop, start, or reconfigure either model server during deployment or
rollback.
