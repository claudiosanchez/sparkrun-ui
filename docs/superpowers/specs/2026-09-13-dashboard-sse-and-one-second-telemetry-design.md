# Dashboard SSE and One-Second Telemetry Design

## Goal

Make the Sparkrun dashboard feel immediate without increasing work in direct
proportion to the number of open browser tabs. Tokens per second must be
collected once per second. The browser must receive live dashboard data through
one Server-Sent Events (SSE) connection and update only the widgets affected by
each event.

This work does not change model services, SSH configuration, saved clusters, or
the layout and meaning of the existing top-level **Cluster overview** card.

## What Exists Today

The UI already uses oRPC async streams. oRPC serializes those streams as
`text/event-stream`, so the protocol is SSE today. The problem is ownership:
the dashboard opens a status stream, a monitor stream, and a vLLM stream for
each cluster, plus another monitor stream for the aggregate card. Those streams
each own their own collection loop. `DashboardLive` also updates parent state
on every status event.

The vLLM registry is already process-global and shared with the persistent
Tokens/s recorder. It currently defaults to two seconds, and the recorder
requests five seconds when no browser is open.

## Decisions

### 1. The server owns collection

The Next.js server process on Coxshire owns all dashboard collection. Browsers
never choose polling intervals or open a collector directly.

The initial cadence policy is deliberately different by source:

| Source | Target cadence | Reason |
| --- | --- | --- |
| vLLM metrics and Tokens/s | 1 second | Drives the Twin Reactor's live inference display and durable history. |
| Host monitor | 2 seconds | Hardware changes more slowly and already has a two-second UI contract. |
| Cluster status | 3 seconds | Workload state does not need per-second polling. |
| Model health | 10 seconds | A readiness probe is comparatively expensive and changes rarely. |

Each collector has at most one request in flight. It schedules from a monotonic
start time, waits only for the remainder of its interval, and skips overdue
ticks rather than creating overlapping requests. The vLLM loop makes one
request per scheduled tick; it must not perform a hidden second immediate poll.

### 2. One typed SSE feed for the dashboard

Add `rpc.telemetry.stream({})`. It is an oRPC stream, which the existing route
delivers as SSE. A raw parallel `EventSource` endpoint is unnecessary and would
create a second transport to maintain.

The stream emits the latest complete state for one source at a time:

```ts
type DashboardTelemetryEvent =
  | { version: 1; revision: number; topic: "vllm"; cluster: string; observedAtMs: number; payload: VllmClusterSnapshot }
  | { version: 1; revision: number; topic: "monitor"; cluster: string; observedAtMs: number; payload: MonitorTick }
  | { version: 1; revision: number; topic: "overview-monitor"; observedAtMs: number; payload: MonitorTick }
  | { version: 1; revision: number; topic: "status"; cluster: string; observedAtMs: number; payload: ClusterStatus }
  | { version: 1; revision: number; topic: "service"; cluster: string; observedAtMs: number; payload: ServiceHealth };
```

`revision` is process-scoped. It helps the browser discard out-of-order
snapshots but does not promise replay across reconnects or server restarts.

The client sends no hosts, URLs, or intervals. The runtime resolves saved
clusters itself. It sends a cached snapshot immediately on connection, then
only newer events. A connection retains only the newest queued event for each
`cluster/topic` key, which prevents a background tab from accumulating an
unbounded queue.

The existing stream procedures remain as compatibility adapters for other
pages until they are migrated. The dashboard itself uses only the new stream.

### 3. Preserve card meaning and isolate rendering

`Cluster overview` keeps its current scope and label. Its current unscoped
monitor input is represented as the `overview-monitor` topic rather than being
silently changed to an all-cluster aggregate.

`DashboardTelemetryProvider` owns the one browser SSE connection and writes
events into an external store. The store preserves object identity for unchanged
topics and provides narrow subscriptions:

- an overview subscription for the top card;
- one subscription per cluster/topic for Twin Reactor and saved-cluster cards;
- a status-only subscription for workload counts, errors, and the workload list.

`DashboardLive` becomes structural: it does not keep a changing status map.
An update to C032 Tokens/s must not rerender C458, the workload list, or the
top card. A status event can update workload-related sections without rerendering
the entire dashboard.

### 4. SSE delivery rules

For an SSE response, the route sets:

```
Cache-Control: no-cache, no-store, no-transform
X-Accel-Buffering: no
```

The server keeps oRPC's cancellation behavior and keepalive comments. On
disconnect it removes the stream listener, aborts waits, and releases timers.
Source freshness remains separate from connection health: a keepalive never
makes stale measurements look live.

### 5. Navigation is a separate measured slice

Current dashboard navigations wait on `cluster list`, `recipes list`, and a
status request per cluster before the Server Component payload can finish.
The initial SSE work removes browser-stream duplication, but cannot by itself
remove that server-render waterfall. After the shared runtime exists, the page
will use its cached seed state and defer noncritical workload decoration so
navigation can render the dashboard shell promptly.

## Acceptance Criteria

- The durable Tokens/s recorder continues collecting at a one-second target
  cadence with no open browser tab.
- A dashboard tab opens one live SSE connection, not one per cluster/source.
- Two browser tabs still produce one upstream collector per source and cluster.
- C032 vLLM updates do not commit C458 UI components or workload-only sections.
- The existing cards, ordering, labels, and missing-data behavior remain intact.
- Slow or disconnected browsers cannot grow a server queue without bound.
- The live Coxshire release shows persisted sample start times approximately one
  second apart, with no overlapping upstream requests.
- Before/after measurements record dashboard navigation, first live sample,
  stream count, and React commit isolation. Target: first live sample within
  1.5 seconds, vLLM event p95 at or below 1.25 seconds, and a C032 update causes
  zero C458 commits.

## Non-Goals

- No model restart, model replacement, SSH change, or remote host reconfiguration.
- No raw second SSE stack alongside oRPC.
- No fabricated historical backfill.
- No renaming or replacement of `Cluster overview`.
