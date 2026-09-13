# Twin Reactor performance deployment

## Deployment

- Date: 2026-09-13
- Deployed revision: `aef69fa39bf8826a1383eb39b51643fa75afb1a0`
- Local branch: `codex/twin-reactor-dashboard`
- Source worktree: `/Users/claudio/Projects/.worktrees/sparkrun-ui-twin-reactor`
- Target: Coxshire, `/Users/claudio/sparkrun-ui`
- Dashboard: `http://100.78.146.12:5678/dashboard`
- Server: standalone Next.js on port `5678`, PID `33457`
- Source backup: `/Users/claudio/sparkrun-ui-backups/twin-reactor-20260913T183234/`

No branch was pushed and no pull request was opened.

## Verification

- Coxshire production build completed successfully.
- Coxshire-local `GET /dashboard` returned HTTP 200.
- Tailnet `GET /dashboard` returned HTTP 200.
- A fresh browser session showed the retained aggregate overview, saved C032 and
  C458 cluster summaries, detailed fleet, and workloads in that order.
- After six seconds, both C032 and C458 reported live telemetry in the saved
  overview and detailed fleet.

The separate model-health badges settled to `Model API unavailable`; this
deployment did not change that known service-health follow-up.

## Rollback

Restore `/Users/claudio/sparkrun-ui-backups/twin-reactor-20260913T183234/` to
`/Users/claudio/sparkrun-ui`, rebuild with Node 24 and frozen pnpm dependencies,
then restart the standalone server with the same `SPARKRUN_BIN`, `PORT`, and
`HOSTNAME` values. Verify the local endpoint and the browser dashboard before
removing the backup.
