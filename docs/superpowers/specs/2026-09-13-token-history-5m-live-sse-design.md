# Five-Minute Token History and Live SSE Design

## Goal

Add a `5m` Tokens/s history range to the existing per-saved-cluster history
cards.  While that range is selected, its chart must advance from real
one-second vLLM SSE snapshots, without polling the history API every second
and without re-rendering the dashboard shell, other clusters, or long-range
history cards.

The existing Cluster overview and Twin Reactor cards keep their names, roles,
and placement.

## Existing live path

The server-side `VllmCollectorRegistry` owns one collector per saved cluster.
It polls that cluster's vLLM `/metrics` endpoint at `POLL_INTERVAL_MS`, which
is currently one second.  `rpc.vllmMetrics.stream({ cluster })` subscribes to
that shared registry.  oRPC delivers the async stream through the existing
same-origin SSE route.

The durable token-history recorder is another subscriber to the same registry.
It records exactly one nullable observation per accepted snapshot at the same
one-second target cadence.  The recorder remains server-owned and continues
when no browser is open.

## Decisions

### A five-minute range uses one-second buckets

`TrendRange` gains `"5m"`.  Its policy is a five-minute window with a
one-second resolution: 300 bounded chart points.  The existing rolling store
retains raw samples for 20 minutes, so it already contains the required data.
The range validation, unavailable result, file-store validation, client range
control, and tests all use the same union; no caller supplies a host, URL, or
storage path.

`0` is a valid token rate.  A warm-up, reset, stale, unavailable, or missing
rate remains `null`, and the chart keeps it as a gap.

### Publish the recorder's normalized observation on the existing SSE feed

There is no raw EventSource and no per-card `tokenHistory.stream` endpoint.
The existing `rpc.telemetry.stream({})` is the one browser SSE connection for
the history section.  Extend its typed event union with:

```ts
{
  version: 1;
  revision: number;
  topic: "token-history";
  cluster: string;
  observedAtMs: number;
  payload: TokenObservation;
}
```

The recorder publishes the already-normalized `TokenObservation` to the
process-global telemetry broker as it queues the durable write.  It does not
wait for disk I/O and it does not create another collector or upstream poll.
The broker's current per-topic/per-cluster latest-event queue, cached replay,
revisions, validation, cancellation, and bounded memory behavior apply to
these events too.

Only a `live` rate is numeric.  Every warm-up, reset, stale, unavailable, or
missing rate is published as a `null` observation.  Thus the live chart shares
exactly the recorder's normalization and series fingerprint, and a reconnect
does not manufacture a value from a stale reading.

### Keep live state local to a five-minute card

The base five-minute chart still starts with the bounded
`rpc.tokenHistory.get({ cluster, range: "5m" })` response.  A
`TokenHistoryTelemetryProvider` owns one `rpc.telemetry.stream({})`
subscription and writes only `token-history` events into a cluster-keyed
external store.  A small child component is mounted only while a card displays
`5m`; it subscribes only to its own cluster's store key, retains at most the
current five-minute live overlay, and applies it to that card's chart result.

The overlay moves the chart window forward from the newest SSE event and
recalculates only its own coverage, state, summary, and points.  It never
writes to `DashboardLive`, the history query cache, the durable store, or the
global page state.  Longer ranges retain their bounded one-minute fetch
schedule and do not subscribe to the live overlay.

### Rendering and freshness behavior

- The selected `5m` card may re-render once per received observation for its
  own cluster.  Other cluster cards and non-history dashboard sections do not.
- The Recharts line remains non-animated and receives nullable points
  directly, so gaps remain gaps.
- If the initial history query is `empty` but live samples arrive, the local
  overlay can show the newly observed partial series immediately.  The durable
  query remains the source of history after its normal refresh.
- A reconnection, warm-up, counter reset, or unavailable snapshot is visible
  as a gap; it does not repeat a prior numeric value.
- The 5m data request stays bounded and does not move to a one-second timer.
  SSE is the one-second transport.

## Acceptance criteria

- `5m`, `15m`, `1d`, `7d`, and `30d` are available in the shared selector.
- A `5m` result contains 300 at-most-one-second points.
- Each selected 5m card advances from recorder-normalized observations sent on
  the existing same-origin telemetry SSE feed at the collector's one-second
  target cadence.
- A live C032 update causes no C458 history-card render or long-range-card
  subscription.
- An unavailable, stale, warm-up, or reset reading creates a gap instead of a
  fabricated zero or repeated value.
- History remains bounded, server validates saved clusters, and neither model
  services nor SSH configuration change.
