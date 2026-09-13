# Per-cluster SSH users on Coxshire

On 2026-09-13, the Coxshire Sparkrun UI account was checked before applying
the per-cluster SSH-user setting.

- Sparkrun version: `0.3.8`
- Active configuration root: `/Users/claudio/.config/sparkrun`
- C032 user: `spark-c032`
- C458 user: `spark-c458`
- C032 host: `100.65.40.24`
- C458 host: `100.83.161.109`
- Configuration command: `sparkrun cluster update c458 --user spark-c458`
- C458 backup: `/Users/claudio/sparkrun-ui-backups/per-cluster-ssh-20260913T175045/c458.yaml`

The existing SSH identity configuration was reused for both users. No key,
host address, DNS, Tailnet, known-hosts entry, or model service was changed.
The global/default behavior remains available to clusters without a saved
user override.

Read-only verification completed after the update:

- `sparkrun cluster show c032 --json` reports `spark-c032`.
- `sparkrun cluster show c458 --json` reports `spark-c458`.
- SSH connects to both saved hosts with their configured users.
- `sparkrun status --cluster c032 --json` reports one managed workload.
- `sparkrun status --cluster c458 --json` reports an idle host and zero managed workloads.
- One live JSON monitor sample was received from C458.

To roll back this setting, restore the C458 YAML backup and run the same
read-only `sparkrun cluster show c458 --json` check. Do not remove the file or
change the global SSH configuration without a separate authorization.
