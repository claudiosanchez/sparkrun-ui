# Reactor Semantic-Pressure Rings Design

## Decision

Keep the existing Reactor control intact: three continuous, concentric rings;
the Tokens/sec center readout; the right-side three-line legend; the request
facts; and the hardware-details grid below it.

Replace the old rings with these live serving-pressure measures:

1. KV cache occupancy.
2. Active-request capacity: running requests divided by an explicit
   per-cluster safe-concurrency policy.
3. Queue pressure: waiting requests divided by an explicit per-cluster queue
   budget.

Unified memory and GPU utilization leave the rings. They stay in the existing
hardware-details grid. The top Cluster overview, fleet layout, and all other
Dashboard controls remain unchanged.

## Capacity-policy source

The UI must not infer a safe denominator from host memory, GPU use, KV tokens,
or vLLM's hard `--max-num-seqs` ceiling. Those measurements describe different
limits. Each saved cluster may instead have an optional UI-local policy in
`~/.config/sparkrun-ui/reactor-capacity.json`, or a path supplied through
`SPARKRUN_UI_REACTOR_CAPACITY_POLICY_PATH`.

The file uses this exact shape:

```json
{
  "clusters": {
    "c032": {
      "safe_concurrent_requests": 4,
      "queue_budget": 16
    }
  }
}
```

The numbers are operating policy, not model configuration. The UI must not
create values for a cluster that is not listed. A missing target renders the
matching ring as a neutral track with `Target not set` rather than a fabricated
percentage. A future saved cluster is still rendered dynamically; it simply
needs its own policy before the two target-based rings become live.

## Semantic color rules

Color describes the meaning of a value, not the identity of a metric. The ring
arc and the matching legend dot always use the same color. The visible and
accessible reading includes a text status, so color is not the only signal.

| Ring | Healthy / informative | Watch | Pressure | Critical |
| --- | --- | --- | --- | --- |
| KV cache occupancy | 0–69%: emerald `Headroom` | 70–84%: amber `Watch` | 85–94%: orange `Tight` | ≥95%: rose `Critical` |
| Active-request capacity | 0%: zinc `Idle`; 1–69%: sky `Serving` | 70–84%: amber `Busy` | 85–100%: orange `At capacity` | >100%: rose `Over capacity` |
| Queue pressure | 0%: emerald `Clear` | >0–49%: amber `Waiting` | 50–99%: orange `Backed up` | ≥100%: rose `Queue limit reached` |

For stale data, retain a numeric arc but desaturate it to zinc and label it
`Stale`. For warming, reset, unavailable telemetry, an invalid policy, or a
missing target, render a neutral track and an explicit text state. Never use a
critical color for missing data.

## Interaction and accessibility rules

- Every arc stays one continuous stroke from 0° to the clamped 0–100% visual
  range. A measured value above 100% displays its full arc but retains its raw
  percentage in visible and accessible text.
- Tokens/sec stays neutral because it has no universal 0–100% ceiling.
- Preserve the existing desktop ring-left, legend-right layout and the
  existing mobile reading order.
- Preserve the `Running` and `Queued` raw counts below the control.
- Do not add a meter, card, new header, model name, or Cluster overview change.

## Verification

- Test policy-file loading, an absent file, invalid values, and name-based
  application to arbitrary saved clusters.
- Test every semantic state, zero, missing policy, stale value, and an
  over-capacity value.
- Test the server-rendered control has the new labels, three progress bars,
  continuous ring markup, semantic accessible text, no unified-memory ring,
  and a retained Unified memory hardware detail.
- After merge and deployment, verify C032's actual card in a browser. Do not
  invent C032 or C458 policy values during deployment.
