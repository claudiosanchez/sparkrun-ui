# Per-Cluster SSH User Adoption Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use `spark-c032` for C032 and `spark-c458` for C458 with the existing key and global fallback.

**Architecture:** This is configuration adoption, not a Sparkrun source change. Installed Sparkrun 0.3.8 already has optional `ClusterDefinition.user`, writes it as YAML `user:`, supports `cluster update --user`, and assigns it over global `config.yaml` `ssh.user`.

**Tech Stack:** Sparkrun 0.3.8, YAML, SSH.

**Spec:** `docs/superpowers/specs/2026-09-13-twin-reactor-dashboard-design.md`

## Global Constraints

- Reuse the existing authorized key; never create, rotate, copy, or expose keys.
- Leave global `ssh.user: spark-c032` as the C032 fallback.
- Set only C458 `user: spark-c458`.
- Do not edit installed site-packages, change models, addresses, DNS, Tailnet, or known-hosts.

---

## Discovery Result

- `/Users/claudio/.local/bin/sparkrun` runs 0.3.8.
- Saved clusters read and write `user:` and `cluster update` exposes `--user`.
- A saved user overrides global `config.ssh_user`; an absent one preserves the global user, key, and options.
- C032 and C458 currently have no `user:`; global config has `ssh.user: spark-c032`.

No Sparkrun source repository is needed for this slice.

### Task 1: Baseline and configure C458

**Files:** Modify the Coxshire UI account's resolved `~/.config/sparkrun/clusters/c458.yaml`; add a dated operational note under `docs/operations/`.

**Interfaces:** `sparkrun cluster update c458 --user spark-c458` writes `user: spark-c458`.

- [ ] **Step 1: Run `sparkrun --version`, `sparkrun cluster show c032 --json`, and `sparkrun cluster show c458 --json`. On Coxshire, first confirm the UI account, `SPARKRUN_BIN`, and config root. Stop if it uses a different root.**

- [ ] **Step 2: Resolve exact SSH user and identity settings.**

```bash
ssh -G spark-c032@100.65.40.24 | rg '^(user|identityfile) '
ssh -G spark-c458@100.83.161.109 | rg '^(user|identityfile) '
```

Stop on a host-key warning or mismatch.

- [ ] **Step 3: Back up only C458 YAML, then run `sparkrun cluster update c458 --user spark-c458` and `sparkrun cluster show c458 --json`. Expected: C458 JSON has `"user": "spark-c458"`; C032 remains without `user:` and inherits global C032.**

- [ ] **Step 4: Run read-only targeted C032 and C458 status checks plus one C458 monitor NDJSON line. Do not change containers or model services.**

- [ ] **Step 5: Verify the Dashboard reports separate C032 and C458 telemetry; commit only its no-secret operational note as `docs: record per-cluster SSH user setup`.**
