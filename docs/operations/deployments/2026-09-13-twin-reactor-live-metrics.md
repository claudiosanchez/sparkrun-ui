# Twin Reactor live metrics deployment record

## Release identity

This record is prepared for the owner to complete after the integration pull
request is merged and the merged revision is deployed. Do not replace these
placeholders with a pre-merge feature commit.

- PR URL: `<PR_URL_TO_BE_FILLED_AFTER_OPENING>`
- PR merge commit (`MERGED_REVISION`): `<40_CHARACTER_MERGE_COMMIT_TO_BE_FILLED_AFTER_MERGE>`
- Local branch: `codex/twin-reactor-dashboard`
- Remote integration ref: `claudio-fork/codex/twin-reactor-dashboard`
- Deployment status: `Pending root merge and deployment`

## Target and release evidence

- Source worktree: `/Users/claudio/Projects/.worktrees/sparkrun-ui-twin-reactor`
- Coxshire source root: `/Users/claudio/sparkrun-ui`
- Backup path: `<TIMESTAMPED_BACKUP_PATH_TO_BE_FILLED_AFTER_BACKUP>`
- Deployed revision file value: `<MERGED_REVISION_TO_BE_FILLED_AFTER_SYNC>`
- Standalone UI PID: `<PID_TO_BE_FILLED_AFTER_RESTART>`
- Deployment timestamp: `<UTC_TIMESTAMP_TO_BE_FILLED_AFTER_DEPLOYMENT>`
- Dashboard URL: `http://100.78.146.12:5678/dashboard`

The application deployment must use the exact PR merge commit. The deployed
application revision is not the later documentation commit.

## Pre-deployment checks

The implementation worktree passed the following checks on 2026-09-13:

```text
pnpm test       23 files, 133 tests passed
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

Complete these fields only after live verification of the deployed revision:

- C032 ring values and states: `<TO_BE_FILLED>`
- C458 ring values and states: `<TO_BE_FILLED>`
- Positive-to-zero tokens-per-second observation: `<TO_BE_FILLED>`
- Same-origin `/rpc` traffic confirmed with no direct port `8000` request: `<TO_BE_FILLED>`
- Desktop screenshot path: `<TO_BE_FILLED>`
- Mobile screenshot path: `<TO_BE_FILLED>`
- Aggregate overview, saved-cluster overview, workloads, `/monitor`, and `/chat`: `<TO_BE_FILLED>`

## Rollback

1. Stop only the recorded standalone UI PID.
2. Restore the timestamped backup at `<TIMESTAMPED_BACKUP_PATH>` to
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
