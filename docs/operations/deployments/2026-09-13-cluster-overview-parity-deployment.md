# Saved-cluster overview parity deployment

## Deployment

- Date: 2026-09-13
- Deployed revision: `052f5746d2ecb2a49047f6d55a8a3057ce7284e4`
- Local branch: `codex/twin-reactor-dashboard`
- Source worktree: `/Users/claudio/Projects/.worktrees/sparkrun-ui-twin-reactor`
- Target: Coxshire, `/Users/claudio/sparkrun-ui`
- Dashboard: `http://100.78.146.12:5678/dashboard`
- Server: standalone Next.js on port `5678`, PID `59106`
- Source backup: `/Users/claudio/sparkrun-ui-backups/twin-reactor-20260913T193037/`

No branch was pushed and no pull request was opened.

## Verification

- Coxshire production build completed successfully.
- Coxshire-local and Tailnet `GET /dashboard` returned HTTP 200.
- A fresh browser session showed the existing aggregate Cluster overview first.
- Each saved-cluster overview card showed CPU, GPU, memory, power, and combined
  temperature values with live telemetry and trend graphics.
- C032 and C458 both reported live telemetry in the detailed fleet.
- C032 and C458 both settled to `Model API ready` with their served-model names.

## Rollback

Restore `/Users/claudio/sparkrun-ui-backups/twin-reactor-20260913T193037/` to
`/Users/claudio/sparkrun-ui`, rebuild with Node 24 and frozen pnpm dependencies,
then restart the standalone server with the same `SPARKRUN_BIN`, `PORT`, and
`HOSTNAME` values. Verify the local endpoint and the browser dashboard before
removing the backup.
