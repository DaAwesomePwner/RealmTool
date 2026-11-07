# Capture (diagnostics)

Keep Capture off normally. In the plugin UI, enable **Capture (diagnostics)** just
before a diagnostic session. Its standard plugin toggle starts/stops recording;
**Max file size (MB)** defaults to 50. Advanced **Include all DAMAGE** defaults off.
Capture never enables itself: startup and profile restore ignore saved enabled=true.
Enable it explicitly again after each proxy start or profile change.

Each enable creates one file lazily at the first record:
`<appDataDir()>/captures/capture-<timestamp>-<unique suffix>.jsonl` (normally
`%APPDATA%/RealmTool/captures`). The log prints the path on open and close.
Disable it and wait for “Capture stopped” before copying the file. Disable, plugin
cleanup and normal app stop queue a flush and close. Abrupt process termination or
power loss can lose queued data. Reaching the cap stops capture without splitting a
record; it does not rotate into another file. Re-enable for a fresh file.

Only MAPINFO map name, CREATESUCCESS own object ID, AOE geometry/damage/effect,
AOEACK time/position, DAMAGE IDs/damage/effects (local target by default), and own
HP/max HP/DEF/condition masks and own-object position (x, y) are recorded.
Own position comes only from NEWTICK/UPDATE, with at least 0.1 tile movement
since the last emitted position and at least 100ms between samples. Position-only
records are possible; no other objects’ positions or MOVE packets are captured. AOE `effectDuration` and `originType`
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

The report compares two one-to-one AOE/ACK heuristics within 1500ms by default:
spatial-first matches the oldest pending AoE containing the ACK position within
radius+0.5, falling back to FIFO if none contains it; FIFO always matches the
oldest pending AoE. Both pairings report each AOE, ACK distance against the actual
radius, counts, latency p50/p95 and tentative verdicts. Per-client and overall
verdicts combine evidence across reconnects without matching across connections.
The ACK ratio is raw ACK/AOE. Invalid or truncated JSONL lines are skipped and
counted, preserving readable records from an interrupted capture.

Unacked-inside/outside uses the nearest prior recorded own position (or ACK
position), evaluated against radius+0.5 **at AOE observation**, never a later
position. Unknown positions are counted separately. Position samples can be
stale; these are hypotheses, not proof of hits. “Substantial” means at least three
examples and 20% of AOEs; “about zero” means at most 5%. Hits-only requires
substantial unacked-outside, about zero unacked-inside and acked-outside, and at
least three inside ACKs. Every-AoE requires substantial outside ACKs and about
zero unacked. The spatial heuristic favors inside matches, which is why the FIFO
comparison is retained. Overlapping AoEs, late ACKs, automatic escape suppression
and recording boundaries can invalidate either model. Unacked events at capture
or segment end may not have had a full observation window.

Every 60 seconds the log summarizes clients active during that period. Disable
summarizes retained clients; disconnect summarizes and prunes that connection.
Summary matching uses spatial-first. Near-unacked uses the same prior position
and radius+0.5 tolerance as the report. Unknown positions, pending AOEs and
boundary-censored AOEs are separate counts. Map/lifecycle markers end matching
segments. File errors include their error code; an old capture's failure cannot
stop a newer capture.

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
