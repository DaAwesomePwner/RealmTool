import sys
W = r'C:\Users\dap\Documents\GitHub\realmtool\.superpowers\sdd\2026-10-03-phase2-plugin-host'
ROOT = {'a': r'C:\Users\dap\Documents\GitHub\realmtool', 'b': r'C:\Users\dap\Documents\GitHub\realmtool-lane-b', 'c': r'C:\Users\dap\Documents\GitHub\realmtool-lane-c'}
SUMMARY = {
    '1': 'Make the routed HELLO observable (read-only) so plugins can read its access token.',
    '2': 'Plugin API types (src/plugins/api.ts) and the per-plugin SettingsStore with generic validation.',
    '3': 'Atomic, debounced, corruption-safe profile store under %APPDATA%\\RealmTool.',
    '4': "Local player identity tracker (owner object id from CREATESUCCESS, name from stat 31).",
    '5': 'The plugin host: contexts, client facades, verdict/observer/command/notification routing, interest, profiles.',
    '6': 'Port Chat Filter from realm-engine-client 88a66b2 unchanged in behavior, including its 62 tests.',
    '7': 'Server Switch plugin: /con, /goto, /ip through the proxy router, with the official server list.',
    '8': 'Wire the plugin host into the CLI, add config-path, document plugins.',
}
CONTEXT = {
    '1': 'Phase 1 is merged; src/transport/session.ts routeHello() posts `routed` then connects. The existing session tests and harness are in src/transport/__tests__/session.test.ts.',
    '2': 'New files only. src/util/log.ts exports `log`. src/protocol/Packet.ts exports the Packet type.',
    '3': 'New files only. src/util/log.ts exports `log` (setConsole, addSink for silencing/capturing).',
    '4': 'New files only. src/protocol/Packet.ts exports createPacket(id, name, direction).',
    '5': 'Tasks 1-4 are merged in your folder: src/plugins/api.ts, src/plugins/settings.ts, src/config/store.ts, src/plugins/identity.ts, plus the HELLO observe change. Phase 1 code: src/transport/host.ts (ProxyHost, HostEvents, PacketEvent), src/protocol/PacketFactory.ts (PacketSerializeError, createByName, serialize, createFromBytes).',
    '6': 'Tasks 1-5 are merged in your folder: src/plugins/api.ts, src/plugins/host.ts, src/testing/pluginHarness.ts (startHost, textData, FakeProxy), plugins/index.ts. Source: C:\\Users\\dap\\Documents\\GitHub\\realm-engine-client at 88a66b2.',
    '7': 'Tasks 1-5 are merged in your folder: src/plugins/api.ts, src/plugins/host.ts, src/testing/pluginHarness.ts (startHost, textData, FakeProxy), plugins/index.ts. The research report docs/research/05-phase2-port-details.md section 4 has the exact Realm Engine messages and the API details.',
    '8': 'Tasks 1-7 are merged in your folder.',
}

def write(task, lane):
    root = ROOT[lane]
    report = (W if lane == 'a' else root + r'\.superpowers\sdd') + f'\\task-{task}-report.md'
    text = f"""You are implementing Task {task} of RealmTool Phase 2: {SUMMARY[task]}

Work ONLY in: {root}  (this replaces the repo path in the contract)

1. Read and follow this contract first: {W}\\implementer-contract.md
2. Read this next. It is your requirements, with the exact values to use verbatim: {W}\\task-{task}-brief.md
3. Context: {CONTEXT[task]} Ignore the brief's commit step.
4. Write your report to: {report}
"""
    path = (W if lane == 'a' else root + r'\.superpowers\sdd') + f'\\task-{task}-dispatch.md'
    open(path, 'w', encoding='utf-8').write(text)
    print(path)

for arg in sys.argv[1:]:
    t, l = arg.split(':')
    write(t, l)
