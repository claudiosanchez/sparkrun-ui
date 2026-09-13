# Coxshire Local-Fork Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the committed local `codex/twin-reactor-dashboard` worktree to Coxshire and verify the real Dashboard.

**Architecture:** The local fork remains source of truth; no push or pull request is created. Back up Coxshire source, rsync the exact clean committed source, build standalone output on Coxshire, start its standalone server with the existing Sparkrun binary, then record revision and browser evidence.

**Tech Stack:** Git, SSH, rsync, Node 24, Corepack pnpm, Next.js standalone.

**Spec:** `docs/superpowers/specs/2026-09-13-twin-reactor-dashboard-design.md`

## Global Constraints

- Deploy only a clean committed local worktree; do not push or open a PR.
- Coxshire is `coxshire` at `100.78.146.12`; app root is `/Users/claudio/sparkrun-ui`; port is `5678`.
- Preserve `SPARKRUN_BIN=/Users/claudio/.local/bin/sparkrun`.
- Start `.next/standalone/server.js`, not `next start`.
- Do not change model lifecycle, SSH trust, hosts, or keys.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `docs/operations/coxshire-sparkrun-ui-deployment.md` | Human-run deployment and rollback runbook. |
| `docs/operations/deployments/YYYY-MM-DD-twin-reactor-dashboard.md` | Commit, backup path, checks, and live evidence. |

### Task 1: Write and commit the runbook

**Files:** Create `docs/operations/coxshire-sparkrun-ui-deployment.md`.

**Interfaces:** Consumes a clean local commit; produces a reversible remote deployment with recorded backup.

- [ ] **Step 1: Add preflight commands:** `git status --short`, `git rev-parse HEAD`, a read-only Coxshire check for the Sparkrun binary, and `pgrep -af '/Users/claudio/sparkrun-ui/.next/standalone/server.js'`. Stop on dirty source, SSH trust warning, missing executable, or ambiguous process identity.

- [ ] **Step 2: Specify a timestamped source backup under `/Users/claudio/sparkrun-ui-backups/` before rsync. Exclude `.git`, `.next`, `node_modules`, `.superpowers`, and secrets.**

- [ ] **Step 3: Specify the remote build.**

```bash
export PATH=/Users/claudio/.nvm/versions/node/v24.21.0/bin:/Users/claudio/.local/bin:$PATH
cd /Users/claudio/sparkrun-ui
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Copy `public` and `.next/static` into the standalone tree after build. Before replacing generated asset directories, print and verify the exact application root.

- [ ] **Step 4: Specify restart and rollback.** Start with `NODE_ENV=production PORT=5678 HOSTNAME=0.0.0.0 SPARKRUN_BIN=/Users/claudio/.local/bin/sparkrun /Users/claudio/.nvm/versions/node/v24.21.0/bin/node .next/standalone/server.js`. Keep a pid and log file in the verified app root. Rollback restores only the timestamped backup, rebuilds, and starts with the same environment.

- [ ] **Step 5: Commit as `docs: add Coxshire UI deployment runbook`.**

### Task 2: Deploy all committed product slices

**Files:** Create `docs/operations/deployments/YYYY-MM-DD-twin-reactor-dashboard.md`.

**Interfaces:** Consumes the overview, health, and SSH adoption outcomes; produces a live revision and deployment record.

- [ ] **Step 1: Run `pnpm test && pnpm typecheck && pnpm lint && pnpm build` from the clean worktree.**

- [ ] **Step 2: Execute the runbook using `git rev-parse HEAD`; do not deploy an unstaged or uncommitted file.**

- [ ] **Step 3: Verify Coxshire-local `curl -fsS http://127.0.0.1:5678/dashboard`, then browse `http://100.78.146.12:5678/dashboard`. Confirm retained aggregate C032, dynamic clusters, detailed fleet, workloads, and C458 health settling within five seconds.**

- [ ] **Step 4: Record target, local revision, backup path, time, test commands, C032/C458 results, browser URL, and rollback path; commit as `docs: record Coxshire dashboard deployment`.**
