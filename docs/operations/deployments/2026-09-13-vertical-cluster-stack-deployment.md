# Vertical saved-cluster stack deployment

## Deployment

- Date: 2026-09-13
- Deployed revision: `b69e827487160a36c1617c7d5d303e0942976378`
- Local branch: `codex/twin-reactor-dashboard`
- Source worktree: `/Users/claudio/Projects/.worktrees/sparkrun-ui-twin-reactor`
- Target: Coxshire, `/Users/claudio/sparkrun-ui`
- Dashboard: `http://100.78.146.12:5678/dashboard`
- Server: standalone Next.js on port `5678`, PID `61813`
- Source backup: `/Users/claudio/sparkrun-ui-backups/twin-reactor-20260913T193609/`

No branch was pushed and no pull request was opened.

## Verification

- Coxshire production build completed successfully.
- Coxshire-local and Tailnet `GET /dashboard` returned HTTP 200.
- The saved-cluster overview uses a single-column layout at every viewport
  width, while the detailed Twin Reactor Fleet remains unchanged.
- A fresh browser session showed live telemetry and ready model APIs for both
  C032 and C458.

## Rollback

Restore `/Users/claudio/sparkrun-ui-backups/twin-reactor-20260913T193609/` to
`/Users/claudio/sparkrun-ui`, rebuild with Node 24 and frozen pnpm dependencies,
then restart the standalone server with the same `SPARKRUN_BIN`, `PORT`, and
`HOSTNAME` values. Verify the local endpoint and the browser dashboard before
removing the backup.
