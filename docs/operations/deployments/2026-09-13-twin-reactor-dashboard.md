# Twin-reactor dashboard deployment

## Deployment

- Date: 2026-09-13
- Deployed revision: `f5faef60a74e46c6f792dff367ac9957a28effff`
- Local branch: `codex/twin-reactor-dashboard`
- Source worktree: `/Users/claudio/Projects/.worktrees/sparkrun-ui-twin-reactor`
- Target: Coxshire, `/Users/claudio/sparkrun-ui`
- Dashboard: `http://100.78.146.12:5678/dashboard`
- Server: standalone Next.js on port `5678`, PID `13042`
- Sparkrun binary: `/Users/claudio/.local/bin/sparkrun`
- Source backup: `/Users/claudio/sparkrun-ui-backups/twin-reactor-20260913T175320/`

The source was clean and committed before deployment. The local fork was
used as the source of truth. No branch was pushed and no pull request was
opened.

## Verification

The following local checks passed before deployment:

```text
pnpm test       17 files, 91 tests passed
pnpm typecheck  passed
pnpm lint       passed
pnpm build      passed
```

Coxshire-local verification returned HTTP 200 for
`http://127.0.0.1:5678/dashboard`. The rendered HTML contains the existing
`Cluster overview`, `Saved cluster overview`, `Saved cluster fleet`, and
`Workloads` sections, plus both saved cluster names.

The real browser dashboard at
`http://100.78.146.12:5678/dashboard` showed:

- The existing aggregate Cluster overview remained first.
- The new Saved cluster overview rendered C032 and C458 from saved configuration.
- Both compact overview cards reached `Telemetry live` with live measurements.
- The Saved cluster fleet remained below the new overview.
- Workloads remained last, with the managed C032 workload visible.
- Model health badges settled to `Model API unavailable` within five seconds;
  they did not remain at `Checking model API`.

The direct C458 model endpoint also returned HTTP 200 from Coxshire:
`http://100.83.161.109:8000/v1/models`. The detailed fleet badge did not show
the served model during this browser observation, so model-health behavior
needs a follow-up browser investigation even though the bounded RPC procedure
returns C458 as ready when called directly.

## Rollback

The source backup is at
`/Users/claudio/sparkrun-ui-backups/twin-reactor-20260913T175320/`. To roll
back, stop only the recorded standalone PID, restore that backup to the app
root, rebuild with Node 24 and frozen pnpm dependencies, and restart with the
same `SPARKRUN_BIN`, `PORT`, and `HOSTNAME` values. Verify the local endpoint
and browser page before removing the backup.
