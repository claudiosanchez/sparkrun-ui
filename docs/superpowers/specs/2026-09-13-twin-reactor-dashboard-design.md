# Dual-Cluster Twin-Reactor Dashboard Design

## Decision

Sparkrun UI will show every saved Sparkrun cluster on the Dashboard. Each
cluster gets its own live reactor card. The current Coxshire configuration
therefore shows C032 and C458 together. The Dashboard will not change the
default cluster.

This design keeps the existing Dashboard workload section. It adds a fleet
section above it that makes host telemetry and model API health visible even
when a model server was started outside Sparkrun.

## Current Evidence

On 2026-09-13, Coxshire reports two saved clusters:

| Cluster | Host | Default | Sparkrun status | Model API |
| --- | --- | --- | --- | --- |
| `c032` | `100.65.40.24` | Yes | One managed workload | Existing model service |
| `c458` | `100.83.161.109` | No | One idle host, no managed workload | Responds on port `8000` |

`sparkrun cluster monitor --cluster c458 --json` returns live samples with no
host error. C458 is not absent or failing. It is absent from the current
Dashboard because every Dashboard call omits `--cluster`, which makes
Sparkrun use C032, the default cluster.

The observed monitor command returns a `hosts` array. The current RPC schema
and Dashboard components expect a host-keyed object. The implementation must
normalize the actual command output before it reaches either screen.

## Goals

- Show C032 and C458 at the same time when both are saved clusters.
- Keep each cluster's data stream independent.
- Show CPU, GPU, unified memory, temperature, power, host reachability, and
  model API health for every cluster.
- Show direct model-service health when no Sparkrun-managed workload exists.
- Preserve the current workload cards and their controls.
- Preserve the selected refined twin-reactor visual language without copying
  its standalone HTML, JavaScript, or fixed synthetic data model.
- Keep the page usable on desktop, tablet, and phone.

## Non-Goals

- Do not change the Sparkrun default cluster.
- Do not start, stop, reconfigure, or otherwise manage C458's model server.
- Do not replace the existing `/monitor`, `/chat`, `/launch`, or `/logs`
  workflows in this change.
- Do not require all clusters to use the same serving runtime.
- Do not report unavailable GPU-memory fields as zero. GB10 samples may leave
  those fields empty.

## Architecture

### Saved cluster discovery

The existing `clusters.list` RPC procedure runs `sparkrun cluster list --json`.
The Dashboard server page will use it to discover saved clusters, then request
initial status for each name in parallel. It will not infer clusters from the
current default or hard-code `c032` and `c458`.

The Dashboard will still render when one initial status request fails. The
affected reactor starts in an unavailable state. Other reactors render their
own initial data.

### Per-cluster status and telemetry

`status.get` and `status.stream` will accept an optional `cluster` input.
When present, the procedures call `sparkrun cluster status --cluster <name>
--json`. The existing default-cluster behavior remains unchanged when the
input is omitted.

`monitor.stream` already accepts an optional cluster name. Its output contract
will be corrected to parse the CLI's real shape:

```ts
type MonitorTick = {
  timestamp: number;
  hosts: Array<{
    host: string;
    error: string | null;
    sample: Record<string, string> | null;
    workloads: unknown[];
    used_slots: number;
    free_slots: number;
  }>;
};
```

A small shared monitor-data module will turn that wire shape into a host-keyed
view model for React. Components will receive only valid samples. A host error
will remain visible as an error state rather than being coerced into zero
metrics.

Each reactor owns one status stream and one monitor stream. A stream failure
sets only that reactor to `reconnecting`; it does not reset another reactor's
last valid data.

### Model API health

Add a read-only RPC procedure that checks each saved cluster host at
`http://<saved-host>:8000/v1/models`. It must first resolve the requested
cluster through `clusters.list`; callers cannot supply an arbitrary host or
URL. The request uses a short abortable timeout.

The result contains the cluster name, host, health state, and first served
model name when available. It does not start an inference request and does
not expose model-server credentials. The reactor polls this check less often
than telemetry, every 10 seconds.

For C458 this check makes the direct service visible even though
`cluster status` correctly reports zero Sparkrun-managed workloads. A failed
API check reads `Model API unavailable`; it does not make the host telemetry
unavailable.

### Dashboard composition

Create a dashboard-specific fleet component with a focused reactor-card
component and a hook that owns the independent RPC subscriptions.

Each reactor card shows:

- Cluster name and configured host.
- Separate badges for telemetry freshness, model API health, and managed
  workload count.
- GPU utilization as the dominant value.
- CPU utilization, unified-memory use, GPU temperature, CPU temperature, and
  GPU power as supporting values.
- The served model name when the API answers.
- A concise explanation when telemetry, service health, or a metric is
  unavailable.

The visual treatment adapts the selected refined twin-reactor reference:
two balanced reactor panels, restrained cyan/emerald health signals,
monospaced measurements, circular utilization treatment, and a central
divider when exactly two clusters are present. It uses Sparkrun UI's existing
`Card`, `Badge`, Tailwind tokens, dark-mode behavior, and accessible text.
It does not embed the reference widget's standalone stylesheet or synthetic
provider.

At wide widths the two reactors form one stage. At narrower widths they remain
two equal cards. On phones they stack in saved-cluster order and retain the
same reading order. If more or fewer than two clusters are saved, the same
component uses a responsive grid without the twin-only divider.

The existing aggregate overview is replaced by the fleet stage. The workload
section stays below it. Its summary combines per-cluster status so workloads
from a non-default saved cluster remain visible.

## Data Flow

```text
sparkrun cluster list --json
             |
             +--> Dashboard server page: saved cluster names and initial status
             |
             +--> one ReactorCard per cluster
                    |
                    +--> status.stream({ cluster })
                    +--> monitor.stream({ cluster, intervalSec: 2 })
                    +--> services.health({ cluster }) every 10 seconds
                    |
                    +--> normalized metrics and independent health badges
```

## Error and Freshness Rules

| Condition | Reactor result |
| --- | --- |
| Valid monitor sample | `Telemetry live` and current measurements |
| Monitor host error or malformed sample | `Telemetry unavailable`; retain no fabricated values |
| Monitor stream disconnects after a valid sample | `Reconnecting`; retain the last valid values with a stale label |
| Model API responds with a model list | `Model API ready` and first model name |
| Model API times out or rejects the request | `Model API unavailable`; telemetry stays independent |
| No Sparkrun workload | Show `0 managed workloads`; do not call the host idle or failed |
| Empty GPU-memory fields | Show `—`, not `0 GB` or `0%` |

## Files and Responsibilities

| File | Responsibility |
| --- | --- |
| `lib/rpc/procedures/status.ts` | Add optional cluster targeting to status reads and streams. |
| `lib/rpc/procedures/monitor.ts` | Validate the real monitor stream and expose its stable contract. |
| `lib/monitor.ts` | Normalize monitor samples and derive display-safe metric values. |
| `lib/rpc/procedures/services.ts` | Resolve a saved cluster and perform the bounded model API health check. |
| `lib/rpc/router.ts` | Register the model-service health procedure. |
| `app/dashboard/page.tsx` | Discover clusters and load initial per-cluster status without a single-cluster assumption. |
| `app/components/dashboard/TwinReactorFleet.tsx` | Coordinate the reactor cards and their responsive stage. |
| `app/components/dashboard/ReactorCard.tsx` | Render one cluster's live state and accessible status. |
| `app/components/dashboard/useReactor.ts` | Subscribe to a single cluster's status and telemetry, and poll service health. |
| `app/components/dashboard/DashboardLive.tsx` | Place the fleet stage and retain the combined workload section. |
| `app/components/HeaderStats.tsx` | Consume normalized monitor data so the global header remains live. |
| `app/components/monitor/MonitorLive.tsx` | Consume normalized monitor data without changing the monitor page's layout. |
| `lib/__fixtures__/monitor-stream.ndjson` and focused tests | Capture the observed monitor array shape and prevent a return to the incompatible object assumption. |

## Test Strategy

- Add a fixture containing C032 and C458 monitor ticks in the actual
  array-based CLI shape.
- Add a failing schema and normalization test for valid samples, host errors,
  empty GPU-memory values, and two independent clusters.
- Add status-procedure tests that prove the selected cluster produces
  `--cluster <name>` and omission retains default behavior.
- Add model-service health tests for a ready response, empty model list,
  timeout, unreachable service, and rejection of a cluster that is not in the
  saved-cluster list.
- Add pure reactor-state tests for two reactors, an unavailable C458 API with
  live C032 telemetry, and the no-managed-workload state. The current Vitest
  setup is a Node environment, so browser rendering is verified in the final
  real-browser check rather than by adding a second test environment.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` in the isolated worktree.
- After merge and deployment, verify Coxshire's Dashboard in a real browser:
  C032 and C458 both render, C458 shows live telemetry and its direct model
  API, and a temporary loss of one stream leaves the other reactor visible.

## Deployment Constraints

- Build and deploy only the merged `main` commit.
- Run the production server with the project-supported standalone entry point,
  not `next start` against an `output: standalone` build.
- Preserve the working `SPARKRUN_BIN` path in Coxshire's service environment.
- Do not change C032 or C458 model lifecycle while deploying this UI change.
