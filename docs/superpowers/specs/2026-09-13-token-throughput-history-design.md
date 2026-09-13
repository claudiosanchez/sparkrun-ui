# Token Throughput History Design

## Goal

Show one historical Tokens/s card for every saved Sparkrun cluster. Each card
can show the last 15 minutes, 1 day, 7 days, or 30 days without inventing
missing data.

## Scope

- The card plots only token throughput. It does not add CPU, GPU, memory, or
  temperature history controls.
- The dashboard keeps the existing aggregate Cluster overview, saved-cluster
  overview cards, and Twin Reactor cards unchanged.
- The History section sits after the Twin Reactor fleet and before Workloads.
- Cards derive from the saved cluster list. Adding a saved cluster adds a card
  without a UI code change.

## Data collection

The current browser-owned trend arrays are not a source of history. A
server-owned recorder collects vLLM metric snapshots while the Sparkrun UI
server is running, whether or not a browser has the dashboard open.

The recorder subscribes to the same saved-cluster, server-side vLLM collector
used by the live dashboard. It must not create browser-to-cluster requests or
let a caller supply a host or metrics URL. The collector keeps a 2-second live
poll cadence when a dashboard stream is connected and may use a 5-second
cadence when the history recorder is its only subscriber.

Each observation stores:

- server receipt time;
- saved cluster name;
- a stable fingerprint of the cluster's ordered host list;
- nullable Tokens/s and the reading state.

Only a `live` Tokens/s reading is recorded as a numeric sample. A warm-up,
counter reset, stale, unavailable, or missing reading produces a gap. A zero
Tokens/s reading is valid and must remain zero.

If a saved cluster's host fingerprint changes, its history starts a new
series. The UI explains that its saved target changed instead of joining data
from different hosts.

## Retention and storage

Use dependency-free files owned by Sparkrun UI, not Sparkrun's cache:

- `SPARKRUN_UI_DATA_DIR` selects the data root. The default is a
  `sparkrun-ui/telemetry` directory under the platform cache directory.
- One writer process owns each data root in this first release.
- Keep 5-second buckets for 20 minutes and one-minute buckets for 31 days.
- Store minute buckets in safe, per-cluster, UTC-day newline-delimited JSON
  segments. Replace the short rolling tier atomically.
- Ignore a truncated final record after an unexpected process stop. Other
  malformed records degrade coverage instead of failing the page.
- Docker deployments receive a dedicated mounted data directory so history
  survives container recreation.

The query service aggregates and bounds data server-side:

| Range | Source resolution | Maximum chart points |
| --- | --- | ---: |
| 15m | 5 seconds | 180 |
| 1d | 5 minutes | 288 |
| 7d | 30 minutes | 336 |
| 30d | 2 hours | 360 |

The service uses weighted sums and valid counts. It never averages averages.
It materializes missing time buckets with `null` Tokens/s so the chart shows a
gap rather than a false flat line.

## API

Add one read-only same-origin RPC procedure:

```ts
get({ cluster: string, range: "15m" | "1d" | "7d" | "30d" })
```

The procedure validates `cluster` against the saved cluster list. It returns
the range bounds, chart resolution, coverage, series identity, state, and
timestamped nullable points. It has no host, path, URL, or file arguments.

`state` is one of:

- `ready`: valid samples cover the requested period;
- `partial`: samples exist but a source outage, downtime, or target change
  left gaps;
- `empty`: no valid samples exist for the range yet;
- `unavailable`: the history store could not be read.

Recorder and storage failures do not interrupt current live metrics, status
streams, service health, or the dashboard page.

## Dashboard interaction

The new History section has one shared, keyboard-accessible range control:
`15m`, `1d`, `7d`, and `30d`. Selecting a range updates all cluster cards so
the same period remains comparable across clusters. The default is `15m`.

Each cluster card includes:

- cluster name and a concise history-state badge;
- a fixed-height Tokens/s line chart;
- a textual current/latest, range average, and min--max summary;
- a screen-reader summary naming the cluster, range, and values;
- a timestamped coverage or freshness note.

The chart uses null points as gaps, disables decorative animation, and does
not reload the page or re-open monitor streams. It preserves the last
successful chart while a range refresh runs. First load uses a chart-sized
loading state. Empty and unavailable states are explicit and do not show a
zero line.

On narrow screens, history cards stack in saved-cluster order. Wider screens
use a responsive grid. Range controls are native buttons with tab semantics,
visible selected state, focus rings, and text labels in addition to color.

## Delivery order

1. Deploy the recorder, durable store, and read-only RPC without a dashboard
   card. Verify it creates real per-cluster samples, survives one UI restart,
   and does not add browser streams.
2. Deploy a 15-minute Tokens/s card per saved cluster. Verify it shows the
   persisted series, gaps, zero, and startup collection state in the real
   dashboard.
3. Deploy the 1-day, 7-day, and 30-day range controls. Verify bounded query
   size, each range's labels, and retained history behavior.

Every slice follows the local-fork delivery path: tests, review, PR into
`claudio-fork/main`, merge, Coxshire deployment of the merged code, and live
browser verification. No model service lifecycle operation is part of this
work.

## Acceptance criteria

- A saved C032 and C458 each get an independent Tokens/s history card.
- A later third saved cluster receives a card automatically.
- 15m, 1d, 7d, and 30d range controls query bounded timestamped data.
- Missing readings, downtime, server restarts, and vLLM counter resets appear
  as gaps or an honest state, never fabricated values.
- A numeric zero remains visible as `0.0 Tokens/s`.
- History is still collected while the dashboard is closed and survives an UI
  process restart.
- Existing overview and Twin Reactor cards remain unchanged and dashboard
  responsiveness does not regress.
