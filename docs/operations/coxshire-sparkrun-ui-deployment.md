# Coxshire Sparkrun UI deployment

This runbook deploys the local `codex/twin-reactor-dashboard` branch to the
Coxshire UI account. It does not push a branch or open a pull request.

## Target

- SSH host: `coxshire`
- Resolved host: `coxshire-media-server.tail758204.ts.net`
- Remote source root: `/Users/claudio/sparkrun-ui`
- Remote backup root: `/Users/claudio/sparkrun-ui-backups`
- Dashboard URL: `http://100.78.146.12:5678/dashboard`
- Sparkrun binary: `/Users/claudio/.local/bin/sparkrun`
- Node binary: `/Users/claudio/.nvm/versions/node/v24.21.0/bin/node`

## Preflight

From the clean local worktree, run:

```bash
git status --short
git rev-parse HEAD
```

Stop if the worktree is dirty. On Coxshire, verify the binary and the
application process without changing state:

```bash
ssh -o BatchMode=yes coxshire 'id -un; test -x /Users/claudio/.local/bin/sparkrun; /Users/claudio/.local/bin/sparkrun --version; pgrep -af "/Users/claudio/sparkrun-ui/.next/standalone/server.js" || true'
```

Stop if SSH reports a missing, changed, or mismatched host key, if the binary
is missing, or if the process identity is ambiguous.

## Backup and source sync

Choose a UTC timestamp and create a source backup before replacing files:

```bash
DEPLOY_UTC=$(date -u +%Y%m%dT%H%M%S)
ssh -o BatchMode=yes coxshire "mkdir -p /Users/claudio/sparkrun-ui-backups/twin-reactor-${DEPLOY_UTC} && rsync -a --exclude=.git --exclude=.next --exclude=node_modules --exclude=.superpowers /Users/claudio/sparkrun-ui/ /Users/claudio/sparkrun-ui-backups/twin-reactor-${DEPLOY_UTC}/"
```

Verify the exact source and destination roots before syncing the committed
worktree. Exclude `.git`, `.next`, `node_modules`, `.superpowers`, and secrets.
Sync only the application source from the local worktree:

```bash
rsync -a --delete \
  --exclude=.git --exclude=.next --exclude=node_modules --exclude=.superpowers \
  /Users/claudio/Projects/.worktrees/sparkrun-ui-twin-reactor/ \
  coxshire:/Users/claudio/sparkrun-ui/
```

## Build and start

Build on Coxshire with the pinned runtime:

```bash
ssh -o BatchMode=yes coxshire 'export PATH=/Users/claudio/.nvm/versions/node/v24.21.0/bin:/Users/claudio/.local/bin:$PATH; cd /Users/claudio/sparkrun-ui; corepack pnpm install --frozen-lockfile; corepack pnpm build; rm -rf /Users/claudio/sparkrun-ui/.next/standalone/public /Users/claudio/sparkrun-ui/.next/standalone/.next/static; cp -R /Users/claudio/sparkrun-ui/public /Users/claudio/sparkrun-ui/.next/standalone/public; mkdir -p /Users/claudio/sparkrun-ui/.next/standalone/.next; cp -R /Users/claudio/sparkrun-ui/.next/static /Users/claudio/sparkrun-ui/.next/standalone/.next/static'
```

Before starting, stop only the identified Sparkrun UI standalone process and
record its log and PID in the verified application root:

```bash
ssh -o BatchMode=yes coxshire 'cd /Users/claudio/sparkrun-ui; NODE_ENV=production PORT=5678 HOSTNAME=0.0.0.0 SPARKRUN_BIN=/Users/claudio/.local/bin/sparkrun /Users/claudio/.nvm/versions/node/v24.21.0/bin/node .next/standalone/server.js > sparkrun-ui.log 2>&1 & echo $! > sparkrun-ui.pid'
```

The application must run from `.next/standalone/server.js` with
`SPARKRUN_BIN` preserved. Do not use model lifecycle commands.

## Verify and rollback

Verify the remote endpoint and then the real browser URL:

```bash
ssh -o BatchMode=yes coxshire 'curl -fsS http://127.0.0.1:5678/dashboard >/dev/null'
```

Confirm the existing aggregate overview remains first, the saved-cluster
overview includes every configured cluster, the detailed fleet remains below
it, and workloads remain last. Wait at least five seconds and confirm each
model badge is `Model API ready` or `Model API unavailable`, never indefinitely
`Checking model API`.

To roll back, stop only the current standalone PID, restore the timestamped
source backup to `/Users/claudio/sparkrun-ui`, rebuild, and restart with the
same command and environment. Keep the backup until the restored dashboard is
verified.
