# Capture (diagnostics)

Keep Capture off normally. In the plugin UI, enable **Capture (diagnostics)** just
before a diagnostic session. Its standard plugin toggle starts/stops recording;
**Max file size (MB)** defaults to 50. Advanced **Include all DAMAGE** defaults off.
Capture never enables itself. Saved profiles may restore an explicit enabled choice,
so disable it after the session before quitting.

Each enable creates one file lazily at the first record:
`<appDataDir()>/captures/capture-<timestamp>-<unique suffix>.jsonl` (normally
`%APPDATA%/RealmTool/captures`). The log prints the path on open and close.
Disable it and wait for “Capture stopped” before copying the file. Disable, plugin
cleanup and normal app stop queue a flush and close. Abrupt process termination or
power loss can lose queued data. Reaching the cap stops capture without splitting a
record; it does not rotate into another file. Re-enable for a fresh file.

Only MAPINFO map name, CREATESUCCESS own object ID, AOE geometry/damage/effect,
AOEACK time/position, DAMAGE IDs/damage/effects (local target by default), and own
HP/max HP/DEF/condition masks are recorded. AOE `effectDuration` and `originType`
are normalized to `duration` and `origType`. DEATH, RECONNECT and client ESCAPE
are empty event markers. Stats are snapshots of known allowlisted values, emitted
only on change; UPDATE establishes omitted condition masks as zero. Every line
has an opaque connection ID, direction, packet type, monotonic milliseconds and
ISO wall-clock time. AOE also has a capture-local sequence number.

No HELLO, login credentials, account/player names, chat, reconnect host/key/token,
or other objects' stats are written. Position and session timing are diagnostic
information; review the file before sharing. No packets are modified or injected.

Run with Node >=22.18:

```
node tools/capture-report.ts path/to/capture.jsonl
node tools/capture-report.ts path/to/capture.jsonl --window-ms 2000
```

The report uses FIFO one-to-one AOE/ACK correlation within 1500ms by default,
per connection. It reports each AOE, distance against radius, counts, ACK ratio
(raw ACK/AOE), latency p50/p95 and a tentative verdict. “Substantial” means at
least three examples and 20% of AOEs; “about zero” means at most 5%. The hits-only
verdict also requires at least three inside ACKs. Overlapping AOEs, late ACKs,
automatic escape suppression and recording boundaries can invalidate this
heuristic. Unacked events at capture end may not have had a full observation window.

Every 60 seconds and on disable the log summarizes counts. Near-unacked uses the
last ACK position **at AOE observation**, with radius+0.5 tolerance. Unknown
positions, pending AOEs and boundary-censored AOEs are separate counts. Map/lifecycle markers end matching
segments. These summaries are heuristics, not hit confirmation.

The Bleeding bit was not verified in the repository's safety/research sources.
The report therefore prints masks 29/95 and HP deltas between consecutive changed
stat records for manual DoT analysis. These samples can include projectile damage,
healing and transitions; they do not isolate DoT damage.

Known host limitation: Capture registers no observers until first enabled. After
disabling Capture, its observers stay registered until the proxy restarts. Keep
Capture disabled and restart the proxy to return to zero additional Capture
overhead. Fix requires
`src/plugins/host.ts` to filter observer registrations by `plugin.enabled` and
`!plugin.failed` in `interest()` and refresh interest on enable/disable changes.
NEWTICK/UPDATE already flow for the host’s unconditional identity tracking; Capture does not add that baseline cost. No transport changes are needed. The current plugin API has no unsubscribe method.
