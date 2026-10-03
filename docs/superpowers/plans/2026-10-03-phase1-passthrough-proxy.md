# RealmTool Phase 1 — Pass-through Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm start` installs a tiny helper DLL into the Exalt folder, launches the game, and proxies all game traffic through a worker-thread transport. HELLO/RECONNECT routing works, so normal play, realm changes and dungeons function exactly as without RealmTool. No plugins yet; the plugin seams (interest-gated verdicts, worker modules) are built and tested.

**Architecture:** One Node process. The main thread runs `ProxyHost`, which owns a `worker_threads` network worker. The worker owns every socket, the four RC4 streams, framing, per-direction ordering, HELLO/RECONNECT routing (`Router`) and the worker-module hook surface. The main thread answers only two things: "where was this game socket going?" (`createTargetResolver`, reading the helper's per-PID temp file via a koffi TCP-owner lookup) and verdicts for packets it subscribed to. A ~150-line C++ helper side-loaded as `winhttp.dll` redirects `ws2_32!connect` on port 2050 to `127.0.0.1:2050`.

**Tech Stack:** Node ≥ 22.18 running TypeScript natively (type stripping; `.ts` import specifiers, `erasableSyntaxOnly`), Vitest 3, koffi 2, MSVC `cl.exe` x64 + MinHook.

**Spec:** [`docs/design.md`](../../design.md). Research: [`docs/research/`](../../research/).

## Global Constraints

- Node `>=22.18`; ESM (`"type": "module"`); every relative import uses a `.ts` extension; tsconfig has `erasableSyntaxOnly: true` and `verbatimModuleSyntax: true`. **No enums, namespaces, or constructor parameter properties anywhere** (Node's type stripping can't run them).
- Runtime dependencies for Phase 1: `koffi` only.
- Target platform is Windows x64. Tests must pass on `windows-latest`.
- Listen only on `127.0.0.1`. There are **no hard-coded game-server IPs** anywhere; the fallback server comes only from `--fallback`.
- Every file ported from realm-engine-client starts with `// Ported from realm-engine-client <original path> @ 9ab4f8f (MIT, see NOTICE).`
- realm-engine-client lives beside this repo. Commands below use `REC=../realm-engine-client` from the RealmTool root (`C:\Users\dap\Documents\GitHub\realmtool`).
- Helper temp files are named `realmtool_target_<pid>.txt` in `%TEMP%`. There is no shared legacy file.
- RC4 keys exist in exactly one place: `src/protocol/constants.ts`.
- Commit after every task. Use conventional commit messages ending with the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Port 2050 already taken** (Realm Engine or a second RealmTool running): `ProxyHost.start()` must reject with a message naming the address, not hang. Pinned in Task 8.
2. **Game disconnects while its HELLO is held** waiting for the target lookup: no crash, no timer leak, a single `closed` event. Pinned in Task 7.
3. **A verdict never comes back** (a future plugin bug): the backlog limit faults the session instead of growing memory without bound. Pinned in Task 7.
4. **Route token expires** (game slow to follow a RECONNECT): the token is ignored and the connection falls back to the helper target or faults clearly. Pinned in Task 4.
5. **A foreign `winhttp.dll` (e.g. Realm Engine's) is already in the game folder**: it's backed up and restored on uninstall, never overwritten or deleted. Pinned in Task 9.

---

## File Structure

```
package.json · tsconfig.json · vitest.config.ts · .gitignore · .gitattributes
LICENSE · NOTICE · AGENTS.md · CLAUDE.md · README.md · .github/workflows/ci.yml
data/packet-definitions.json · data/stat-types.json         (copied, canonical)
src/util/log.ts                                             console + sink logger
src/protocol/Packet.ts PacketReader.ts PacketWriter.ts      (ported codec)
src/protocol/PacketFactory.ts RC4Cipher.ts                  (ported codec)
src/protocol/constants.ts                                   RC4 keys, GAME_PORT, frame limits
src/protocol/frames.ts                                      FrameDecoder, isWholeFrame
src/protocol/schema.ts                                      loadSchema(), createFactory()
src/testing/wire.ts                                         test helpers: frames, HELLO/RECONNECT builders
src/testing/net.ts                                          test helpers: Peer, FakeServer, connectGame, until
src/routing/reconnectRoute.ts                               (ported) RECONNECT validation
src/routing/helloKey.ts                                     HELLO key offset + patch
src/routing/router.ts                                       Router: tokens, HELLO restore, RECONNECT rewrite
src/routing/tcpProcessIdentity.ts                           (ported) loopback socket → PID + creation time
src/routing/targetResolver.ts                               helper temp file → Destination
src/transport/messages.ts                                   worker ⇄ main message types, defaults
src/transport/interest.ts                                   Interest (verdict/observe sets)
src/transport/modules.ts                                    WorkerModule hook surface
src/transport/workerModules.ts                              bundled worker modules (empty in Phase 1)
src/transport/session.ts                                    Session: one game socket + its upstream
src/transport/worker.ts                                     worker entry
src/transport/host.ts                                       ProxyHost (main-thread client)
src/game/exaltFinder.ts · helperInstaller.ts · launcher.ts  find, install, launch
src/cli.ts                                                  realmtool CLI
native/helper/src/{dllmain.cpp,connect_hook.cpp,connect_hook.h,forwarders.g.h}
native/helper/vendor/minhook/**  · native/helper/build.cmd · native/helper/gen_forwarders.ps1
tools/verify-helper.ts                                      marker + size check of the built DLL
```

---

### Task 1: Repository bootstrap

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.gitattributes`, `LICENSE`, `NOTICE`, `AGENTS.md`, `CLAUDE.md`, `.github/workflows/ci.yml`, `src/util/log.ts`, `src/util/__tests__/log.test.ts`

**Interfaces:**
- Produces: `log.info(module, message)`, `log.warn(...)`, `log.error(module, message, error?)`, `log.debug(...)`, `log.addSink(fn): () => void`, `log.setConsole(enabled)`, `log.setDebug(enabled)`; `LogRecord { at, level, module, message }`.

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "realmtool",
  "version": "0.1.0",
  "private": true,
  "description": "Lightweight RotMG Exalt launcher with a small extensible plugin set",
  "type": "module",
  "engines": { "node": ">=22.18" },
  "scripts": {
    "start": "node src/cli.ts start",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test",
    "build:helper": "cmd /c native\\helper\\build.cmd",
    "verify:helper": "node tools/verify-helper.ts"
  },
  "dependencies": {
    "koffi": "^2.9.0"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "tools", "vitest.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
```

`.gitignore`:
```
node_modules/
dist/
release/
native/helper/bin/
native/helper/obj/
*.log
.DS_Store
```

`.gitattributes`:
```
* text=auto eol=lf
*.cmd text eol=crlf
*.bat text eol=crlf
*.ps1 text eol=crlf
*.dll binary
*.png binary
```

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Write license, notice and agent docs**

`LICENSE`: copy `$REC/LICENSE` verbatim, then add a second copyright line under the first:
```bash
REC=../realm-engine-client
cp "$REC/LICENSE" LICENSE
sed -i 's/^Copyright (c) 2026 Evergreen-Techworks$/Copyright (c) 2026 Evergreen-Techworks\nCopyright (c) 2026 DaAwesomePwner/' LICENSE
head -4 LICENSE
```
Expected: lines 3–4 show both copyright lines.

`NOTICE`:
```
RealmTool contains code ported from realm-engine-client
(https://github.com/Evergreen-Techworks/realm-engine-client, via the private
downstream DaAwesomePwner/realm-engine-client @ 9ab4f8f), MIT License,
Copyright (c) 2026 Evergreen-Techworks. Ported files begin with a
"Ported from realm-engine-client <path>" comment.

native/helper/vendor/minhook is MinHook (https://github.com/TsudaKageyu/minhook),
BSD 2-Clause License, Copyright (C) 2009-2017 Tsuda Kageyu.
```

`AGENTS.md`:
```markdown
# RealmTool — agent guide

- Design: `docs/design.md`. Plans: `docs/superpowers/plans/`. Research on the source project: `docs/research/`.
- Node runs our TypeScript directly (type stripping). Use `.ts` import specifiers, no enums,
  no namespaces, no constructor parameter properties. `npm run check` must pass before every commit.
- The network worker (`src/transport/worker.ts`) owns sockets and ciphers. Never route a
  time-critical decision through the main thread; use a worker module.
- RC4 keys live only in `src/protocol/constants.ts`. No hard-coded game-server IPs.
- Ported files keep their `// Ported from realm-engine-client …` header.
- The helper DLL builds with `npm run build:helper` (needs VS 2022 C++ x64 tools).
- GitHub: `DaAwesomePwner/RealmTool` (private). Branch per task, PR into `main`.
```

`CLAUDE.md`:
```markdown
@AGENTS.md
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: `package-lock.json` created, no errors.

- [ ] **Step 4: Write the failing logger test**

`src/util/__tests__/log.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { log, type LogRecord } from '../log.ts';

describe('log', () => {
  afterEach(() => { log.setConsole(true); log.setDebug(false); });

  it('delivers records to sinks until the sink is removed', () => {
    log.setConsole(false);
    const records: LogRecord[] = [];
    const remove = log.addSink(record => records.push(record));
    log.info('Test', 'hello');
    log.warn('Test', 'careful');
    remove();
    log.info('Test', 'after');
    expect(records.map(r => [r.level, r.module, r.message])).toEqual([
      ['info', 'Test', 'hello'],
      ['warn', 'Test', 'careful'],
    ]);
  });

  it('drops debug records unless debug is enabled', () => {
    log.setConsole(false);
    const records: LogRecord[] = [];
    const remove = log.addSink(record => records.push(record));
    log.debug('Test', 'hidden');
    log.setDebug(true);
    log.debug('Test', 'shown');
    remove();
    expect(records.map(r => r.message)).toEqual(['shown']);
  });

  it('appends the error message to error records', () => {
    log.setConsole(false);
    const records: LogRecord[] = [];
    const remove = log.addSink(record => records.push(record));
    log.error('Test', 'failed', new Error('boom'));
    remove();
    expect(records[0].message).toMatch(/^failed: .*boom/s);
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npx vitest run src/util`
Expected: FAIL, `Cannot find module '../log.ts'`.

- [ ] **Step 6: Implement the logger**

`src/util/log.ts`:
```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  at: number;
  level: LogLevel;
  module: string;
  message: string;
}

type Sink = (record: LogRecord) => void;

const sinks = new Set<Sink>();
let consoleEnabled = true;
let debugEnabled = process.env.REALMTOOL_DEBUG === '1';

function emit(level: LogLevel, module: string, message: string): void {
  if (level === 'debug' && !debugEnabled) return;
  const record: LogRecord = { at: Date.now(), level, module, message };
  if (consoleEnabled) {
    const time = new Date(record.at).toISOString().slice(11, 23);
    const prefix = level === 'info' ? '' : `${level.toUpperCase()}: `;
    const line = `[${time}] [${module}] ${prefix}${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
  for (const sink of sinks) sink(record);
}

export const log = {
  debug: (module: string, message: string): void => emit('debug', module, message),
  info: (module: string, message: string): void => emit('info', module, message),
  warn: (module: string, message: string): void => emit('warn', module, message),
  error: (module: string, message: string, error?: unknown): void => emit('error', module,
    error instanceof Error ? `${message}: ${error.stack ?? error.message}` : message),
  addSink(sink: Sink): () => void {
    sinks.add(sink);
    return () => { sinks.delete(sink); };
  },
  setConsole(enabled: boolean): void { consoleEnabled = enabled; },
  setDebug(enabled: boolean): void { debugEnabled = enabled; },
};
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npm run check`
Expected: typecheck clean; 3 tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: bootstrap RealmTool repository

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Protocol codec port

**Files:**
- Create (ported): `src/protocol/Packet.ts`, `src/protocol/PacketReader.ts`, `src/protocol/PacketWriter.ts`, `src/protocol/PacketFactory.ts`, `src/protocol/RC4Cipher.ts`, `data/packet-definitions.json`, `data/stat-types.json`
- Create: `src/protocol/constants.ts`, `src/protocol/schema.ts`, `src/testing/wire.ts`
- Test (ported): `src/protocol/__tests__/forReconnect.roundtrip.test.ts`, `optionalDefaults.roundtrip.test.ts`, `playershootRewrite.roundtrip.test.ts`
- Test: `src/protocol/__tests__/schema.test.ts`

**Interfaces:**
- Consumes: `log` (Task 1).
- Produces:
  - `PacketFactory` (unchanged API): `createFromBytes(raw, 'client'|'server'): Packet`, `createByName(name): Packet`, `serialize(packet): Buffer`, `getPacketName(id, direction): string` (returns `UNKNOWN_<id>` when undefined), `getPacketId(name): number | undefined`; types `DefsFile`, `StatTypesFile`, `PacketDirection`.
  - `Packet` interface: `{ id, name, direction, send, modified, data, rawBytes, unreadData, isDefined, bodyLength }`.
  - `RC4Cipher`: `new RC4Cipher(hexKey)`, `cipher(frame)` (in place, from byte 5), `reset()`.
  - `RC4_KEYS.clientToServer`, `RC4_KEYS.serverToClient`, `GAME_PORT = 2050`, `MIN_FRAME = 5`, `MAX_FRAME = 1_048_576`.
  - `ProtocolSchema { definitions: DefsFile; stats: StatTypesFile }`, `loadSchema(dataDir?: URL): ProtocolSchema`, `createFactory(schema?, quiet = true): PacketFactory`.
  - Test helpers: `frame(id, body?)`, `helloBytes(factory, key, overrides?)`, `reconnectBytes(factory, fields, tail?)`, `unknownId(factory)`.

- [ ] **Step 1: Copy the codec, data and tests**

```bash
REC=../realm-engine-client/client
mkdir -p src/protocol/__tests__ data src/testing
cp "$REC/src/packets/Packet.ts" "$REC/src/packets/PacketReader.ts" "$REC/src/packets/PacketWriter.ts" \
   "$REC/src/packets/PacketFactory.ts" src/protocol/
cp "$REC/src/crypto/RC4Cipher.ts" src/protocol/
cp "$REC/data/packet-definitions.json" "$REC/data/stat-types.json" data/
for t in forReconnect optionalDefaults playershootRewrite; do
  sed -e "s#^import PACKET_DEFINITIONS from '../packetDefinitions.generated.js';#import { loadSchema } from '../schema.ts';#" \
      -e "/statTypes.generated/d" \
      -e "s#new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any)#new PacketFactory(loadSchema().definitions, loadSchema().stats)#" \
      -e "s#\(from '\.\./[A-Za-z]*\)\.js'#\1.ts'#" \
      "$REC/src/packets/__tests__/$t.roundtrip.test.ts" > "src/protocol/__tests__/$t.roundtrip.test.ts"
done
grep -n "generated\|\.js'" src/protocol/__tests__/*.ts || echo "imports clean"
```
Expected: `imports clean`.

- [ ] **Step 2: Adapt the ported sources**

For each of `Packet.ts`, `PacketReader.ts`, `PacketWriter.ts`, `PacketFactory.ts`, `RC4Cipher.ts`, insert this first line (with the matching original path):
```ts
// Ported from realm-engine-client client/src/packets/PacketFactory.ts @ 9ab4f8f (MIT, see NOTICE).
```
(`RC4Cipher.ts`'s original path is `client/src/crypto/RC4Cipher.ts`.)

In `src/protocol/PacketFactory.ts`:
1. Replace the imports block with:
   ```ts
   import { readFileSync } from 'node:fs';
   import { PacketReader } from './PacketReader.ts';
   import { PacketWriter } from './PacketWriter.ts';
   import { createPacket, type Packet } from './Packet.ts';
   import { log } from '../util/log.ts';
   ```
2. Replace every `Logger.log(` with `log.info(` and every `Logger.warn(` with `log.warn(`.
3. Replace the constructor's parameter property. Change
   ```ts
   constructor(defsSource: string | DefsFile, statTypesSource: string | StatTypesFile, private readonly quiet = false) {
   ```
   to
   ```ts
   private readonly quiet: boolean;

   constructor(defsSource: string | DefsFile, statTypesSource: string | StatTypesFile, quiet = false) {
     this.quiet = quiet;
   ```

Run: `npx tsc --noEmit`
Expected: no errors. If tsc reports `TS1294` (non-erasable syntax) in another ported file, convert it the same way: a parameter property becomes a declared field plus an assignment in the constructor body, and an `enum` becomes a `const` object with `as const`.

- [ ] **Step 3: Write constants and the schema loader**

`src/protocol/constants.ts`:
```ts
/**
 * RC4 keys for the two directions of a RotMG connection. This is the only copy in
 * the codebase; update it here when a game build changes them.
 */
export const RC4_KEYS = Object.freeze({
  /** Game → server: decrypts what the game sends and encrypts what we send upstream. */
  clientToServer: '5a4d2016bc16dc64883194ffd9',
  /** Server → game: decrypts what the server sends and encrypts what we send to the game. */
  serverToClient: 'c91d9eec420160730d825604e0',
});

/** The game-server TCP port Exalt connects to, and the port the proxy listens on. */
export const GAME_PORT = 2050;
/** Smallest legal frame: 4-byte length + 1-byte packet id. */
export const MIN_FRAME = 5;
/** Largest frame accepted from either side. */
export const MAX_FRAME = 1_048_576;
```

`src/protocol/schema.ts`:
```ts
import { readFileSync } from 'node:fs';
import { PacketFactory, type DefsFile, type StatTypesFile } from './PacketFactory.ts';

export interface ProtocolSchema {
  definitions: DefsFile;
  stats: StatTypesFile;
}

const DATA_DIR = new URL('../../data/', import.meta.url);

/** Read the canonical packet and stat definitions from `data/`. */
export function loadSchema(dataDir: URL = DATA_DIR): ProtocolSchema {
  return {
    definitions: JSON.parse(readFileSync(new URL('packet-definitions.json', dataDir), 'utf8')) as DefsFile,
    stats: JSON.parse(readFileSync(new URL('stat-types.json', dataDir), 'utf8')) as StatTypesFile,
  };
}

export function createFactory(schema: ProtocolSchema = loadSchema(), quiet = true): PacketFactory {
  return new PacketFactory(schema.definitions, schema.stats, quiet);
}
```

- [ ] **Step 4: Write the wire test helpers**

`src/testing/wire.ts`:
```ts
import type { PacketFactory } from '../protocol/PacketFactory.ts';

/** A plaintext frame: [int32 length][id][body]. */
export function frame(id: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out.writeInt32BE(out.length, 0);
  out[4] = id;
  body.copy(out, 5);
  return out;
}

/** An id with no packet definition in either direction. */
export function unknownId(factory: PacketFactory): number {
  for (let id = 255; id > 0; id--) {
    if (factory.getPacketName(id, 'client').startsWith('UNKNOWN_')
      && factory.getPacketName(id, 'server').startsWith('UNKNOWN_')) return id;
  }
  throw new Error('every packet id is defined');
}

export function helloBytes(factory: PacketFactory, key: Buffer, overrides: Record<string, unknown> = {}): Buffer {
  const packet = factory.createByName('HELLO');
  packet.data = {
    gameId: -2, buildVersion: '6.9.0.1.0', accessToken: 'token-abc', keyTime: -1, key,
    gameNet: 'rotmg', playPlatform: 'rotmg', platformToken: '', userToken: 'user-1',
    clientIdentification: 'client-1', ...overrides,
  };
  return factory.serialize(packet);
}

export interface ReconnectFields {
  name?: string;
  host: string;
  port: number;
  gameId?: number;
  keyTime?: number;
  key: Buffer;
}

/** A RECONNECT frame, optionally followed by unknown trailing bytes the proxy must preserve. */
export function reconnectBytes(factory: PacketFactory, fields: ReconnectFields, tail: Buffer = Buffer.alloc(0)): Buffer {
  const packet = factory.createByName('RECONNECT');
  packet.data = { name: 'Realm', gameId: 0, keyTime: 0, ...fields };
  const body = factory.serialize(packet);
  if (tail.length === 0) return body;
  const out = Buffer.concat([body, tail]);
  out.writeInt32BE(out.length, 0);
  return out;
}
```

- [ ] **Step 5: Write the schema test**

`src/protocol/__tests__/schema.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createFactory } from '../schema.ts';
import { helloBytes, reconnectBytes } from '../../testing/wire.ts';

describe('protocol schema', () => {
  const factory = createFactory();

  it('knows the packets Phase 1 routes on', () => {
    expect(factory.getPacketId('HELLO')).toBe(74);
    expect(factory.getPacketId('RECONNECT')).toBe(45);
    expect(factory.getPacketName(45, 'server')).toBe('RECONNECT');
    expect(factory.getPacketName(74, 'client')).toBe('HELLO');
  });

  it('round-trips HELLO and RECONNECT byte-for-byte', () => {
    const hello = helloBytes(factory, Buffer.from('abc'));
    const decodedHello = factory.createFromBytes(hello, 'client');
    expect(decodedHello.isDefined).toBe(true);
    expect(factory.serialize(decodedHello).equals(hello)).toBe(true);

    const tail = Buffer.from([1, 2, 3]);
    const reconnect = reconnectBytes(factory, { host: '1.2.3.4', port: 2050, key: Buffer.from([9]) }, tail);
    const decoded = factory.createFromBytes(reconnect, 'server');
    expect(decoded.data).toMatchObject({ host: '1.2.3.4', port: 2050 });
    expect(decoded.unreadData.equals(tail)).toBe(true);
  });
});
```

- [ ] **Step 6: Run the protocol tests**

Run: `npx vitest run src/protocol`
Expected: PASS (schema test plus the three ported round-trip suites).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(protocol): port packet codec, RC4 and canonical schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Frame decoder and network test harness

**Files:**
- Create: `src/protocol/frames.ts`, `src/testing/net.ts`
- Test: `src/protocol/__tests__/frames.test.ts`

**Interfaces:**
- Consumes: `RC4Cipher`, `RC4_KEYS`, `MIN_FRAME`, `MAX_FRAME`, `frame()`.
- Produces:
  - `class FrameDecoder { constructor(cipher: RC4Cipher); get incomplete(): boolean; feed(data: Buffer, accept: (frame: Buffer) => void): void }`. `feed` throws `Error('Invalid frame length N')`.
  - `isWholeFrame(data: Buffer): boolean`.
  - Test harness: `class Peer { frames: Buffer[]; closed: boolean; send(plain: Buffer): void; destroy(): void }`, `connectGame(port): Promise<Peer>`, `class FakeServer { peers: Peer[]; port: number; listen(): Promise<number>; close(): Promise<void> }`, `until(condition, label, timeoutMs = 5000): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`src/protocol/__tests__/frames.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FrameDecoder, isWholeFrame } from '../frames.ts';
import { RC4Cipher } from '../RC4Cipher.ts';
import { RC4_KEYS } from '../constants.ts';
import { frame } from '../../testing/wire.ts';

function encryptAll(frames: Buffer[]): Buffer {
  const cipher = new RC4Cipher(RC4_KEYS.serverToClient);
  return Buffer.concat(frames.map(plain => { const copy = Buffer.from(plain); cipher.cipher(copy); return copy; }));
}

describe('FrameDecoder', () => {
  it('reassembles coalesced and fragmented frames and decrypts them in order', () => {
    const plain = [frame(10, Buffer.from('first')), frame(42, Buffer.alloc(300, 7)), frame(44, Buffer.from('third'))];
    const wire = encryptAll(plain);
    const decoder = new FrameDecoder(new RC4Cipher(RC4_KEYS.serverToClient));
    const out: Buffer[] = [];
    // Split at awkward points: inside a length header and inside a body.
    for (const chunk of [wire.subarray(0, 2), wire.subarray(2, 20), wire.subarray(20)]) {
      decoder.feed(chunk, f => out.push(f));
    }
    expect(out.map(f => f.toString('hex'))).toEqual(plain.map(f => f.toString('hex')));
    expect(decoder.incomplete).toBe(false);
  });

  it('reports a partial frame as incomplete', () => {
    const decoder = new FrameDecoder(new RC4Cipher(RC4_KEYS.serverToClient));
    decoder.feed(encryptAll([frame(10, Buffer.from('abc'))]).subarray(0, 6), () => {});
    expect(decoder.incomplete).toBe(true);
  });

  it('rejects impossible lengths', () => {
    const decoder = new FrameDecoder(new RC4Cipher(RC4_KEYS.serverToClient));
    const bad = Buffer.alloc(8); bad.writeInt32BE(4, 0);
    expect(() => decoder.feed(bad, () => {})).toThrow('Invalid frame length 4');
    const huge = Buffer.alloc(8); huge.writeInt32BE(2_000_000, 0);
    expect(() => new FrameDecoder(new RC4Cipher(RC4_KEYS.serverToClient)).feed(huge, () => {})).toThrow('Invalid frame length');
  });

  it('isWholeFrame checks the length header', () => {
    expect(isWholeFrame(frame(1, Buffer.from('ab')))).toBe(true);
    expect(isWholeFrame(Buffer.from([0, 0, 0, 9, 1]))).toBe(false);
    expect(isWholeFrame(Buffer.alloc(3))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/protocol/__tests__/frames.test.ts`
Expected: FAIL, `Cannot find module '../frames.ts'`.

- [ ] **Step 3: Implement the decoder**

`src/protocol/frames.ts`:
```ts
import { MAX_FRAME, MIN_FRAME } from './constants.ts';
import type { RC4Cipher } from './RC4Cipher.ts';

/**
 * Splits one direction of a TCP stream into [int32 length][id][body] frames and
 * decrypts each body in place. The cipher state carries across frames.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly cipher: RC4Cipher;

  constructor(cipher: RC4Cipher) {
    this.cipher = cipher;
  }

  get incomplete(): boolean {
    return this.buffer.length > 0;
  }

  /** Throws on an impossible length; the caller must treat that as a transport fault. */
  feed(data: Buffer, accept: (frame: Buffer) => void): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    let offset = 0;
    while (this.buffer.length - offset >= 4) {
      const size = this.buffer.readInt32BE(offset);
      if (size < MIN_FRAME || size > MAX_FRAME) throw new Error(`Invalid frame length ${size}`);
      if (this.buffer.length - offset < size) break;
      const frame = Buffer.from(this.buffer.subarray(offset, offset + size));
      offset += size;
      this.cipher.cipher(frame);
      accept(frame);
    }
    this.buffer = Buffer.from(this.buffer.subarray(offset));
  }
}

export function isWholeFrame(data: Buffer): boolean {
  return data.length >= MIN_FRAME && data.readInt32BE(0) === data.length;
}
```

- [ ] **Step 4: Write the network test harness**

`src/testing/net.ts`:
```ts
import net from 'node:net';
import { RC4_KEYS } from '../protocol/constants.ts';
import { FrameDecoder } from '../protocol/frames.ts';
import { RC4Cipher } from '../protocol/RC4Cipher.ts';

export async function until(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** One end of an encrypted RotMG stream. Records every decrypted frame it receives. */
export class Peer {
  readonly frames: Buffer[] = [];
  closed = false;
  private readonly socket: net.Socket;
  private readonly sendCipher: RC4Cipher;
  private readonly decoder: FrameDecoder;

  constructor(socket: net.Socket, sendKey: string, receiveKey: string) {
    this.socket = socket;
    this.sendCipher = new RC4Cipher(sendKey);
    this.decoder = new FrameDecoder(new RC4Cipher(receiveKey));
    socket.on('data', data => this.decoder.feed(data, frame => this.frames.push(frame)));
    socket.on('close', () => { this.closed = true; });
    socket.on('error', () => {});
  }

  send(plain: Buffer): void {
    const copy = Buffer.from(plain);
    this.sendCipher.cipher(copy);
    this.socket.write(copy);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** A fake game client connected to the proxy. */
export function connectGame(port: number): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () =>
      resolve(new Peer(socket, RC4_KEYS.clientToServer, RC4_KEYS.serverToClient)));
    socket.once('error', reject);
  });
}

/** A fake game server. Every connection the proxy makes becomes a Peer. */
export class FakeServer {
  readonly peers: Peer[] = [];
  port = 0;
  private readonly server = net.createServer(socket =>
    this.peers.push(new Peer(socket, RC4_KEYS.serverToClient, RC4_KEYS.clientToServer)));

  async listen(): Promise<number> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }

  async close(): Promise<void> {
    for (const peer of this.peers) peer.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(protocol): add frame decoder and loopback test harness

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Router — HELLO/RECONNECT handoff

**Files:**
- Create (ported): `src/routing/reconnectRoute.ts`
- Create: `src/routing/helloKey.ts`, `src/routing/router.ts`
- Test: `src/routing/__tests__/helloKey.test.ts`, `src/routing/__tests__/router.test.ts`

**Interfaces:**
- Consumes: `Packet`, `PacketReader`, `GAME_PORT`, test helpers.
- Produces:
  - `readReconnectRoute(packet): { name, host, port, gameId, keyTime, key, hostOff, portOff, keyOff, tail }` (throws on invalid).
  - `findHelloKeyOffset(raw: Buffer): number` (-1 if truncated), `patchHelloKey(raw, offset, key): Buffer`.
  - `interface Destination { host: string; port: number }`, `interface HelloRoute { destination: Destination; hello: Buffer; restored: boolean }`.
  - `class Router { constructor(options?: RouterOptions); readonly size: number; routeHello(hello: Packet, initial: Destination | null): HelloRoute | null; rewriteReconnect(packet: Packet, current: Destination): Buffer | null }`, `RouterOptions { tokenTtlMs?: number (120_000); maxTokens?: number (64); now?: () => number; newToken?: () => string; loopbackHost?: string ('127.0.0.1'); loopbackPort?: number (GAME_PORT) }`.

- [ ] **Step 1: Port reconnectRoute**

```bash
REC=../realm-engine-client/client
mkdir -p src/routing/__tests__
{ echo "// Ported from realm-engine-client client/src/proxy/reconnectRoute.ts @ 9ab4f8f (MIT, see NOTICE)."
  sed -e "s#'../packets/Packet.js'#'../protocol/Packet.ts'#" \
      -e "s#'../packets/PacketReader.js'#'../protocol/PacketReader.ts'#" \
      "$REC/src/proxy/reconnectRoute.ts"; } > src/routing/reconnectRoute.ts
grep -n "import" src/routing/reconnectRoute.ts
```
Expected: three imports, `node:net`, `../protocol/Packet.ts` (type), `../protocol/PacketReader.ts`.

- [ ] **Step 2: Write the failing tests**

`src/routing/__tests__/helloKey.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { findHelloKeyOffset, patchHelloKey } from '../helloKey.ts';
import { createFactory } from '../../protocol/schema.ts';
import { helloBytes } from '../../testing/wire.ts';

describe('HELLO key patching', () => {
  const factory = createFactory();

  it('replaces only the key and keeps every other byte', () => {
    const raw = helloBytes(factory, Buffer.from('token-123'));
    const offset = findHelloKeyOffset(raw);
    expect(offset).toBeGreaterThan(5);
    const realKey = Buffer.from([0, 0xff, 0x80, 0x42]);
    const patched = patchHelloKey(raw, offset, realKey);
    expect(patched.readInt32BE(0)).toBe(patched.length);
    const before = factory.createFromBytes(raw, 'client');
    const after = factory.createFromBytes(patched, 'client');
    expect((after.data.key as Buffer).equals(realKey)).toBe(true);
    expect({ ...after.data, key: null }).toEqual({ ...before.data, key: null });
  });

  it('returns -1 for a truncated HELLO', () => {
    const raw = helloBytes(factory, Buffer.from('token'));
    expect(findHelloKeyOffset(raw.subarray(0, 12))).toBe(-1);
  });
});
```

`src/routing/__tests__/router.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Router } from '../router.ts';
import { createFactory } from '../../protocol/schema.ts';
import { helloBytes, reconnectBytes } from '../../testing/wire.ts';

const factory = createFactory();
const fromServer = (raw: Buffer) => factory.createFromBytes(raw, 'server');
const fromClient = (raw: Buffer) => factory.createFromBytes(raw, 'client');

function clockedRouter(start = 0) {
  let now = start;
  let tokens = 0;
  const router = new Router({ now: () => now, newToken: () => `token-${++tokens}`, loopbackPort: 2050 });
  return { router, advance: (ms: number) => { now += ms; } };
}

describe('Router', () => {
  it('routes a fresh HELLO to the helper target unchanged', () => {
    const { router } = clockedRouter();
    const raw = helloBytes(factory, Buffer.alloc(0));
    const route = router.routeHello(fromClient(raw), { host: '10.0.0.5', port: 2050 });
    expect(route).toEqual({ destination: { host: '10.0.0.5', port: 2050 }, hello: raw, restored: false });
  });

  it('returns null when there is neither a token nor a target', () => {
    const { router } = clockedRouter();
    expect(router.routeHello(fromClient(helloBytes(factory, Buffer.alloc(0))), null)).toBeNull();
  });

  it('rewrites RECONNECT to loop back and restores the real key on the next HELLO', () => {
    const { router } = clockedRouter();
    const realKey = Buffer.from([0, 0xff, 0x80]);
    const tail = Buffer.from([0xde, 0xad]);
    const patched = router.rewriteReconnect(
      fromServer(reconnectBytes(factory, { host: '10.0.0.9', port: 2051, key: realKey, gameId: 7, keyTime: 99 }, tail)),
      { host: '10.0.0.5', port: 2050 });
    expect(patched).not.toBeNull();
    const rewritten = fromServer(patched!);
    expect(rewritten.data).toMatchObject({ host: '127.0.0.1', port: 2050, gameId: 7, keyTime: 99, name: 'Realm' });
    expect((rewritten.data.key as Buffer).toString('utf8')).toBe('token-1');
    expect(rewritten.unreadData.equals(tail)).toBe(true);

    const route = router.routeHello(fromClient(helloBytes(factory, Buffer.from('token-1'))), { host: '10.0.0.77', port: 2050 });
    expect(route?.restored).toBe(true);
    expect(route?.destination).toEqual({ host: '10.0.0.9', port: 2051 });
    expect((fromClient(route!.hello).data.key as Buffer).equals(realKey)).toBe(true);
  });

  it('keeps the current server when RECONNECT carries an empty host and zero port', () => {
    const { router } = clockedRouter();
    router.rewriteReconnect(fromServer(reconnectBytes(factory, { host: '', port: 0, key: Buffer.from('k') })),
      { host: '10.0.0.5', port: 2050 });
    const route = router.routeHello(fromClient(helloBytes(factory, Buffer.from('token-1'))), null);
    expect(route?.destination).toEqual({ host: '10.0.0.5', port: 2050 });
  });

  it('rejects a malformed RECONNECT without storing a route', () => {
    const { router } = clockedRouter();
    const garbage = Buffer.from([0, 0, 0, 8, 45, 0, 9, 1]);
    expect(router.rewriteReconnect(fromServer(garbage), { host: '10.0.0.5', port: 2050 })).toBeNull();
    expect(router.size).toBe(0);
  });

  it('expires tokens after the TTL', () => {
    const { router, advance } = clockedRouter();
    router.rewriteReconnect(fromServer(reconnectBytes(factory, { host: '10.0.0.9', port: 2050, key: Buffer.from('k') })),
      { host: '10.0.0.5', port: 2050 });
    advance(120_001);
    const route = router.routeHello(fromClient(helloBytes(factory, Buffer.from('token-1'))), { host: '10.0.0.5', port: 2050 });
    expect(route?.restored).toBe(false);
    expect(route?.destination.host).toBe('10.0.0.5');
    expect(router.size).toBe(0);
  });

  it('evicts the oldest token beyond maxTokens', () => {
    let tokens = 0;
    const router = new Router({ now: () => 0, newToken: () => `t${++tokens}`, maxTokens: 2 });
    for (let i = 0; i < 3; i++) {
      router.rewriteReconnect(fromServer(reconnectBytes(factory, { host: `10.0.0.${i}`, port: 2050, key: Buffer.from('k') })),
        { host: '10.0.0.5', port: 2050 });
    }
    expect(router.size).toBe(2);
    expect(router.routeHello(fromClient(helloBytes(factory, Buffer.from('t1'))), null)).toBeNull();
    expect(router.routeHello(fromClient(helloBytes(factory, Buffer.from('t3'))), null)?.destination.host).toBe('10.0.0.2');
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run src/routing`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement helloKey and Router**

`src/routing/helloKey.ts`:
```ts
/**
 * HELLO layout: [int32 len][id][int32 gameId][str buildVersion][str accessToken][int32 keyTime][byteArray16 key]...
 * Strings and byteArray16 are an int16 length followed by bytes.
 * Returns the offset of the key's length prefix, or -1 if the frame is truncated or malformed.
 */
export function findHelloKeyOffset(raw: Buffer): number {
  let offset = 5 + 4;
  for (let i = 0; i < 2; i++) {
    if (raw.length < offset + 2) return -1;
    const length = raw.readInt16BE(offset);
    if (length < 0) return -1;
    offset += 2 + length;
  }
  offset += 4;
  if (raw.length < offset + 2) return -1;
  const keyLength = raw.readInt16BE(offset);
  if (keyLength < 0 || raw.length < offset + 2 + keyLength) return -1;
  return offset;
}

/** Return a copy of `raw` with the key at `keyOffset` replaced and the frame length fixed. */
export function patchHelloKey(raw: Buffer, keyOffset: number, key: Buffer): Buffer {
  const oldLength = raw.readInt16BE(keyOffset);
  const before = raw.subarray(0, keyOffset);
  const after = raw.subarray(keyOffset + 2 + oldLength);
  const out = Buffer.alloc(before.length + 2 + key.length + after.length);
  let position = before.copy(out, 0);
  position = out.writeInt16BE(key.length, position);
  position += key.copy(out, position);
  after.copy(out, position);
  out.writeInt32BE(out.length, 0);
  return out;
}
```

`src/routing/router.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { GAME_PORT } from '../protocol/constants.ts';
import type { Packet } from '../protocol/Packet.ts';
import { findHelloKeyOffset, patchHelloKey } from './helloKey.ts';
import { readReconnectRoute } from './reconnectRoute.ts';

export interface Destination {
  host: string;
  port: number;
}

export interface HelloRoute {
  destination: Destination;
  /** The HELLO to send upstream: the original bytes, or a copy with the real key restored. */
  hello: Buffer;
  /** True when this HELLO followed a RECONNECT we rewrote. */
  restored: boolean;
}

export interface RouterOptions {
  tokenTtlMs?: number;
  maxTokens?: number;
  now?: () => number;
  newToken?: () => string;
  loopbackHost?: string;
  loopbackPort?: number;
}

interface PendingRoute {
  destination: Destination;
  key: Buffer;
  createdAt: number;
}

/**
 * The transfer handoff. A server RECONNECT names the next server and a key. We
 * rewrite it to point the game back at the proxy, carrying a random token in
 * place of the key. When the game's next HELLO presents that token, we connect
 * to the real server and send it the real key. Tokens are bounded and expire.
 */
export class Router {
  private readonly routes = new Map<string, PendingRoute>();
  private readonly ttlMs: number;
  private readonly maxTokens: number;
  private readonly now: () => number;
  private readonly newToken: () => string;
  private readonly loopbackHost: string;
  private readonly loopbackPort: number;

  constructor(options: RouterOptions = {}) {
    this.ttlMs = options.tokenTtlMs ?? 120_000;
    this.maxTokens = options.maxTokens ?? 64;
    this.now = options.now ?? (() => performance.now());
    this.newToken = options.newToken ?? (() => randomUUID().replace(/-/g, ''));
    this.loopbackHost = options.loopbackHost ?? '127.0.0.1';
    this.loopbackPort = options.loopbackPort ?? GAME_PORT;
  }

  get size(): number {
    this.prune();
    return this.routes.size;
  }

  routeHello(hello: Packet, initial: Destination | null): HelloRoute | null {
    if (hello.name !== 'HELLO' || !hello.isDefined) return null;
    const key = hello.data.key;
    const token = Buffer.isBuffer(key) && key.length > 0 ? key.toString('utf8') : '';
    const pending = token ? this.lookup(token) : null;
    if (pending) {
      const offset = findHelloKeyOffset(hello.rawBytes);
      if (offset < 0) return null;
      return { destination: { ...pending.destination }, hello: patchHelloKey(hello.rawBytes, offset, pending.key), restored: true };
    }
    if (!initial) return null;
    return { destination: { ...initial }, hello: Buffer.from(hello.rawBytes), restored: false };
  }

  /** Returns the rewritten frame, or null if the RECONNECT is malformed (drop it; keep the current route). */
  rewriteReconnect(packet: Packet, current: Destination): Buffer | null {
    let route: ReturnType<typeof readReconnectRoute>;
    try {
      route = readReconnectRoute(packet);
    } catch {
      return null;
    }
    const raw = packet.rawBytes;
    const token = this.newToken();
    const tokenBytes = Buffer.from(token, 'utf8');
    const hostBytes = Buffer.from(this.loopbackHost, 'utf8');
    const beforeHost = raw.subarray(0, route.hostOff);
    const portToKey = raw.subarray(route.portOff + 2, route.keyOff); // gameId + keyTime, untouched
    const out = Buffer.alloc(beforeHost.length + 2 + hostBytes.length + 2 + portToKey.length + 2 + tokenBytes.length + route.tail.length);
    let position = beforeHost.copy(out, 0);
    position = out.writeInt16BE(hostBytes.length, position);
    position += hostBytes.copy(out, position);
    position = out.writeUInt16BE(this.loopbackPort, position);
    position += portToKey.copy(out, position);
    position = out.writeInt16BE(tokenBytes.length, position);
    position += tokenBytes.copy(out, position);
    route.tail.copy(out, position);
    out.writeInt32BE(out.length, 0);
    this.store(token, {
      destination: { host: route.host || current.host, port: route.port || current.port },
      key: Buffer.from(route.key),
      createdAt: this.now(),
    });
    return out;
  }

  private lookup(token: string): PendingRoute | null {
    this.prune();
    return this.routes.get(token) ?? null;
  }

  private store(token: string, route: PendingRoute): void {
    this.prune();
    while (this.routes.size >= this.maxTokens) {
      const oldest = this.routes.keys().next().value;
      if (oldest === undefined) break;
      this.routes.delete(oldest);
    }
    this.routes.set(token, route);
  }

  /** Insertion order is creation order, so expired routes are always at the front. */
  private prune(): void {
    const now = this.now();
    for (const [token, route] of this.routes) {
      if (now - route.createdAt <= this.ttlMs) break;
      this.routes.delete(token);
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(routing): bounded HELLO/RECONNECT router with expiring tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Helper target resolution

**Files:**
- Create (ported, trimmed): `src/routing/tcpProcessIdentity.ts`
- Create: `src/routing/targetResolver.ts`
- Test: `src/routing/__tests__/tcpProcessIdentity.test.ts`, `src/routing/__tests__/targetResolver.test.ts`

**Interfaces:**
- Consumes: `Destination`, `GAME_PORT`, `log`.
- Produces:
  - `interface ProcessIdentity { readonly pid: number; readonly processStartTime: string }`, `interface TcpOwnerRow`, `interface TcpOwnerSource`, `readTcpProcessIdentity(gamePort, proxyPort, source?): ProcessIdentity | null`, `setTcpOwnerSource(source | null | undefined)`, `parseTcpOwnerTable(buffer)`, `readTcpTable(getTable)`.
  - `TARGET_FILE_PREFIX = 'realmtool_target_'`, `targetFilePath(pid, dir?)`, `parseTargetFile(text): string | null` (IPv4 dotted quad, not 127.x), `createTargetResolver(options?): (remotePort: number) => Destination | null`, `removeStaleTargetFiles(dir?): number`, `TargetResolverOptions { tempDir?: string; proxyPort?: number; identify?: (remotePort: number) => ProcessIdentity | null }`.

- [ ] **Step 1: Write the failing tests**

`src/routing/__tests__/tcpProcessIdentity.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseTcpOwnerTable, readTcpProcessIdentity, type TcpOwnerRow, type TcpOwnerSource } from '../tcpProcessIdentity.ts';

const LOOPBACK = 0x0100007f;
const ESTABLISHED = 5;
const netPort = (port: number) => ((port & 0xff) << 8) | (port >>> 8);

function table(rows: TcpOwnerRow[]): Buffer {
  const buffer = Buffer.alloc(4 + rows.length * 24);
  buffer.writeUInt32LE(rows.length, 0);
  rows.forEach((row, i) => {
    const o = 4 + i * 24;
    buffer.writeUInt32LE(row.state, o);
    buffer.writeUInt32LE(row.localAddr, o + 4);
    buffer.writeUInt32LE(netPort(row.localPort), o + 8);
    buffer.writeUInt32LE(row.remoteAddr, o + 12);
    buffer.writeUInt32LE(netPort(row.remotePort), o + 16);
    buffer.writeUInt32LE(row.pid, o + 20);
  });
  return buffer;
}

const gameRow: TcpOwnerRow = { state: ESTABLISHED, localAddr: LOOPBACK, localPort: 50123, remoteAddr: LOOPBACK, remotePort: 2050, pid: 4242 };
const source = (rows: TcpOwnerRow[], created: bigint | null = 133_000_000_000_000_000n): TcpOwnerSource =>
  ({ tcpRows: () => rows, processCreationTime: () => created });

describe('TCP process identity', () => {
  it('parses MIB_TCPTABLE_OWNER_PID rows with network-order ports', () => {
    expect(parseTcpOwnerTable(table([gameRow]))).toEqual([gameRow]);
    expect(parseTcpOwnerTable(Buffer.alloc(2))).toBeNull();
  });

  it('identifies the single established loopback row', () => {
    expect(readTcpProcessIdentity(50123, 2050, source([gameRow])))
      .toEqual({ pid: 4242, processStartTime: '133000000000000000' });
  });

  it('refuses ambiguous, non-established or creation-less matches', () => {
    expect(readTcpProcessIdentity(50123, 2050, source([gameRow, { ...gameRow, pid: 9 }]))).toBeNull();
    expect(readTcpProcessIdentity(50123, 2050, source([{ ...gameRow, state: 2 }]))).toBeNull();
    expect(readTcpProcessIdentity(50123, 2050, source([gameRow], null))).toBeNull();
    expect(readTcpProcessIdentity(0, 2050, source([gameRow]))).toBeNull();
  });
});
```

`src/routing/__tests__/targetResolver.test.ts`:
```ts
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTargetResolver, parseTargetFile, removeStaleTargetFiles, targetFilePath } from '../targetResolver.ts';

const identity = { pid: 777, processStartTime: '1' };

describe('target resolver', () => {
  it('accepts only non-loopback IPv4 dotted quads', () => {
    expect(parseTargetFile(' 54.86.47.176\r\n')).toBe('54.86.47.176');
    expect(parseTargetFile('127.0.0.1')).toBeNull();
    expect(parseTargetFile('256.1.1.1')).toBeNull();
    expect(parseTargetFile('01.2.3.4')).toBeNull();
    expect(parseTargetFile('example.com')).toBeNull();
    expect(parseTargetFile('')).toBeNull();
  });

  it('reads and deletes the per-PID file for the identified game process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realmtool-target-'));
    writeFileSync(targetFilePath(777, dir), '18.144.30.153');
    const resolve = createTargetResolver({ tempDir: dir, identify: () => identity });
    expect(resolve(50123)).toEqual({ host: '18.144.30.153', port: 2050 });
    expect(readdirSync(dir)).toEqual([]);
    expect(resolve(50123)).toBeNull();
  });

  it('returns null when the socket owner is unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realmtool-target-'));
    writeFileSync(targetFilePath(777, dir), '18.144.30.153');
    expect(createTargetResolver({ tempDir: dir, identify: () => null })(50123)).toBeNull();
  });

  it('removes stale target files only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realmtool-target-'));
    writeFileSync(targetFilePath(1, dir), '1.2.3.4');
    writeFileSync(targetFilePath(2, dir), '1.2.3.4');
    writeFileSync(join(dir, 'unrelated.txt'), 'x');
    expect(removeStaleTargetFiles(dir)).toBe(2);
    expect(readdirSync(dir)).toEqual(['unrelated.txt']);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/routing`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement tcpProcessIdentity (trimmed port)**

`src/routing/tcpProcessIdentity.ts`:
```ts
// Ported from realm-engine-client client/src/native/tcpProcessIdentity.ts @ 9ab4f8f (MIT, see NOTICE).
import { createRequire } from 'node:module';
import { log } from '../util/log.ts';

export interface ProcessIdentity {
  readonly pid: number;
  /** Process creation FILETIME as a decimal string (pairs with the helper's hello in Phase 4). */
  readonly processStartTime: string;
}

/** One IPv4 row of GetExtendedTcpTable(TCP_TABLE_OWNER_PID_ALL), ports in host order. */
export interface TcpOwnerRow {
  state: number;
  localAddr: number;
  localPort: number;
  remoteAddr: number;
  remotePort: number;
  pid: number;
}

export interface TcpOwnerSource {
  tcpRows(): TcpOwnerRow[] | null;
  processCreationTime(pid: number): bigint | null;
}

const MIB_TCP_STATE_ESTAB = 5;
// 127.0.0.1 as the network-order DWORD GetExtendedTcpTable stores, read little-endian.
const LOOPBACK = 0x0100007f;

const validPort = (port: number) => Number.isInteger(port) && port > 0 && port <= 65535;

/**
 * The game process behind an established loopback connection to the proxy. Exactly
 * one row may match; anything else (none, several, a vanished process) is null.
 */
export function readTcpProcessIdentity(
  gamePort: number,
  proxyPort: number,
  source: TcpOwnerSource | null = win32TcpOwnerSource(),
): ProcessIdentity | null {
  if (!source || !validPort(gamePort) || !validPort(proxyPort)) return null;
  try {
    const rows = source.tcpRows();
    if (!rows) return null;
    const matches = rows.filter(row => row.state === MIB_TCP_STATE_ESTAB
      && row.localAddr === LOOPBACK && row.remoteAddr === LOOPBACK
      && row.localPort === gamePort && row.remotePort === proxyPort);
    if (matches.length !== 1) return null;
    const { pid } = matches[0];
    const created = source.processCreationTime(pid);
    if (created === null || created <= 0n || pid <= 0) return null;
    return Object.freeze({ pid, processStartTime: created.toString() });
  } catch {
    return null;
  }
}

let win32Source: TcpOwnerSource | null | undefined;

/** Replace the OS source (tests); `undefined` restores lazy Win32 loading. */
export function setTcpOwnerSource(source: TcpOwnerSource | null | undefined): void {
  win32Source = source;
}

function win32TcpOwnerSource(): TcpOwnerSource | null {
  if (win32Source !== undefined) return win32Source;
  win32Source = null;
  if (process.platform !== 'win32') return null;
  try {
    const koffi = createRequire(import.meta.url)('koffi');
    const iphlpapi = koffi.load('iphlpapi.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const GetExtendedTcpTable = iphlpapi.func('uint32_t __stdcall GetExtendedTcpTable(void *pTcpTable, _Inout_ uint32_t *pdwSize, int bOrder, uint32_t ulAf, int TableClass, uint32_t Reserved)');
    const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)');
    const GetProcessTimes = kernel32.func('int __stdcall GetProcessTimes(void *hProcess, void *lpCreationTime, void *lpExitTime, void *lpKernelTime, void *lpUserTime)');
    const CloseHandle = kernel32.func('int __stdcall CloseHandle(void *hObject)');
    const AF_INET = 2;
    const TCP_TABLE_OWNER_PID_ALL = 5;
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    win32Source = {
      tcpRows: () => readTcpTable((buffer, size) =>
        GetExtendedTcpTable(buffer, size, 0, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0)),
      processCreationTime(pid) {
        const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if (!handle) return null;
        try {
          const creation = Buffer.alloc(8);
          const unused = Buffer.alloc(8);
          if (!GetProcessTimes(handle, creation, unused, Buffer.alloc(8), Buffer.alloc(8))) return null;
          const filetime = creation.readBigUInt64LE(0);
          return filetime === 0n ? null : filetime;
        } finally {
          CloseHandle(handle);
        }
      },
    };
  } catch (error) {
    log.warn('Routing', `TCP owner lookup unavailable (koffi/Win32 load failed): ${(error as Error).message}`);
    win32Source = null;
  }
  return win32Source;
}

const ROW_BYTES = 24;
const NO_ERROR = 0;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** Grow the buffer until GetExtendedTcpTable fits (the table can grow between calls). */
export function readTcpTable(getTable: (buffer: Buffer | null, size: number[]) => number): TcpOwnerRow[] | null {
  const size = [0];
  let buffer: Buffer | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const status = getTable(buffer, size);
    if (status === NO_ERROR && buffer) return parseTcpOwnerTable(buffer);
    if (status !== ERROR_INSUFFICIENT_BUFFER) return null;
    buffer = Buffer.alloc(size[0] + ROW_BYTES * 16);
    size[0] = buffer.length;
  }
  return null;
}

/** MIB_TCPTABLE_OWNER_PID: a DWORD count, then 24-byte rows; ports are network order. */
export function parseTcpOwnerTable(buffer: Buffer): TcpOwnerRow[] | null {
  if (buffer.length < 4) return null;
  const count = buffer.readUInt32LE(0);
  if (4 + count * ROW_BYTES > buffer.length) return null;
  const port = (raw: number) => ((raw & 0xff) << 8) | ((raw >>> 8) & 0xff);
  const rows: TcpOwnerRow[] = [];
  for (let i = 0, offset = 4; i < count; i++, offset += ROW_BYTES) {
    rows.push({
      state: buffer.readUInt32LE(offset),
      localAddr: buffer.readUInt32LE(offset + 4),
      localPort: port(buffer.readUInt32LE(offset + 8)),
      remoteAddr: buffer.readUInt32LE(offset + 12),
      remotePort: port(buffer.readUInt32LE(offset + 16)),
      pid: buffer.readUInt32LE(offset + 20),
    });
  }
  return rows;
}
```

- [ ] **Step 4: Implement the resolver**

`src/routing/targetResolver.ts`:
```ts
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAME_PORT } from '../protocol/constants.ts';
import type { Destination } from './router.ts';
import { readTcpProcessIdentity, type ProcessIdentity } from './tcpProcessIdentity.ts';

/** The helper writes %TEMP%\realmtool_target_<pid>.txt just before redirecting a connect. */
export const TARGET_FILE_PREFIX = 'realmtool_target_';

export function targetFilePath(pid: number, dir: string = tmpdir()): string {
  return join(dir, `${TARGET_FILE_PREFIX}${pid}.txt`);
}

export function parseTargetFile(text: string): string | null {
  const ip = text.trim();
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  if (!parts.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)) return null;
  if (parts[0] === '127') return null;
  return ip;
}

export interface TargetResolverOptions {
  tempDir?: string;
  proxyPort?: number;
  identify?: (remotePort: number) => ProcessIdentity | null;
}

/** Maps a new loopback game socket to the server the game originally tried to reach. */
export function createTargetResolver(options: TargetResolverOptions = {}): (remotePort: number) => Destination | null {
  const dir = options.tempDir ?? tmpdir();
  const proxyPort = options.proxyPort ?? GAME_PORT;
  const identify = options.identify ?? ((remotePort: number) => readTcpProcessIdentity(remotePort, proxyPort));
  return remotePort => {
    const identity = identify(remotePort);
    if (!identity) return null;
    const path = targetFilePath(identity.pid, dir);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return null;
    }
    try { unlinkSync(path); } catch { /* the next connect overwrites it anyway */ }
    const host = parseTargetFile(text);
    return host ? { host, port: GAME_PORT } : null;
  };
}

export function removeStaleTargetFiles(dir: string = tmpdir()): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith(TARGET_FILE_PREFIX) || !name.endsWith('.txt')) continue;
    try { unlinkSync(join(dir, name)); removed++; } catch { /* in use or already gone */ }
  }
  return removed;
}
```

- [ ] **Step 5: Run tests**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(routing): resolve the helper's recorded server per game process

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Transport contracts — messages, interest, worker modules

**Files:**
- Create: `src/transport/messages.ts`, `src/transport/interest.ts`, `src/transport/modules.ts`, `src/transport/workerModules.ts`
- Test: `src/transport/__tests__/interest.test.ts`

**Interfaces:**
- Consumes: `Destination`, `DefsFile`, `StatTypesFile`, `Packet`, `PacketFactory`.
- Produces (exact names used by Tasks 7–8 and Phases 2–3; the observation-id and `held()` surface exists for Phase 3b Collision HP):
  - `CloseSide = 'game' | 'server' | 'fault' | 'proxy'`
  - `WorkerEvent` union: `listening{port}`, `opened{id, remotePort}`, `routed{id, host, port, restored}`, `connected{id, generation}`, `packet{id, sequence, generation, fromClient, observeOnly, data}`, `closed{id, by}`, `diagnostic{id?, message}`, `fault{id?, message}`, `module{moduleId, id?, message}`
  - `WorkerCommand` union: `target{id, destination}`, `interest{interest}`, `forward{id, sequence, generation, data | null}`, `inject{id, data, toClient}`, `module{moduleId, id?, message}`, `close{id}`, `stop`
  - `WorkerInit { host, port, definitions, stats, fallbackDestination, targetTimeoutMs, helloTimeoutMs, maxPendingBytes, interest, moduleConfig }`
  - `DEFAULTS = { targetTimeoutMs: 2000, helloTimeoutMs: 3000, maxPendingBytes: 16 MiB }`
  - `InterestSpec { verdict?: DirectionalNames; observe?: DirectionalNames }`, `DirectionalNames { client?: readonly string[]; server?: readonly string[] }`, `InterestKind = 'verdict' | 'observe' | 'none'`, `class Interest { constructor(spec?); set(spec); classify(name, fromClient): InterestKind }`
  - `WriteKind = 'normal' | 'injected' | 'priority'`, `HeldPacket`, `WorkerSessionContext` (incl. `held()`), `WorkerSessionModule` (`observe(..., observationId)`, `written(..., observationId | null)`, `dropped(observationId, name, fromClient, now)`), `WorkerModule` (see code), `WORKER_MODULES: readonly WorkerModule[]`

- [ ] **Step 1: Write the failing test**

`src/transport/__tests__/interest.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Interest } from '../interest.ts';

describe('Interest', () => {
  it('classifies per direction, with verdict winning over observe', () => {
    const interest = new Interest({
      verdict: { server: ['TEXT'], client: ['ENEMYHIT'] },
      observe: { server: ['TEXT', 'MAPINFO'], client: ['MOVE'] },
    });
    expect(interest.classify('TEXT', false)).toBe('verdict');
    expect(interest.classify('TEXT', true)).toBe('none');
    expect(interest.classify('ENEMYHIT', true)).toBe('verdict');
    expect(interest.classify('MAPINFO', false)).toBe('observe');
    expect(interest.classify('MOVE', true)).toBe('observe');
    expect(interest.classify('NEWTICK', false)).toBe('none');
  });

  it('supports an observe-everything wildcard and replacement', () => {
    const interest = new Interest({ observe: { server: ['*'] } });
    expect(interest.classify('NEWTICK', false)).toBe('observe');
    interest.set({});
    expect(interest.classify('NEWTICK', false)).toBe('none');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/transport`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the contracts**

`src/transport/interest.ts`:
```ts
export interface DirectionalNames {
  client?: readonly string[];
  server?: readonly string[];
}

/** Which packets the main thread must decide on (verdict) or only see (observe). Everything else stays in the worker. */
export interface InterestSpec {
  verdict?: DirectionalNames;
  observe?: DirectionalNames;
}

export type InterestKind = 'verdict' | 'observe' | 'none';

interface Sides {
  client: Set<string>;
  server: Set<string>;
}

const sides = (names: DirectionalNames | undefined): Sides =>
  ({ client: new Set(names?.client ?? []), server: new Set(names?.server ?? []) });

export class Interest {
  private verdict: Sides = sides(undefined);
  private observed: Sides = sides(undefined);

  constructor(spec: InterestSpec = {}) {
    this.set(spec);
  }

  set(spec: InterestSpec): void {
    this.verdict = sides(spec.verdict);
    this.observed = sides(spec.observe);
  }

  classify(name: string, fromClient: boolean): InterestKind {
    const side = fromClient ? 'client' : 'server';
    if (this.verdict[side].has(name)) return 'verdict';
    if (this.observed[side].has(name) || this.observed[side].has('*')) return 'observe';
    return 'none';
  }
}
```

`src/transport/messages.ts`:
```ts
import type { DefsFile, StatTypesFile } from '../protocol/PacketFactory.ts';
import type { Destination } from '../routing/router.ts';
import type { InterestSpec } from './interest.ts';

export type CloseSide = 'game' | 'server' | 'fault' | 'proxy';

export const DEFAULTS = Object.freeze({
  targetTimeoutMs: 2000,
  helloTimeoutMs: 3000,
  maxPendingBytes: 16 * 1024 * 1024,
});

export interface WorkerInit {
  host: string;
  port: number;
  definitions: DefsFile;
  stats: StatTypesFile;
  fallbackDestination: Destination | null;
  targetTimeoutMs: number;
  helloTimeoutMs: number;
  maxPendingBytes: number;
  interest: InterestSpec;
  moduleConfig: Record<string, unknown>;
}

export type WorkerEvent =
  | { type: 'listening'; port: number }
  | { type: 'opened'; id: string; remotePort: number }
  | { type: 'routed'; id: string; host: string; port: number; restored: boolean }
  | { type: 'connected'; id: string; generation: number }
  | { type: 'packet'; id: string; sequence: number; generation: number; fromClient: boolean; observeOnly: boolean; data: Uint8Array }
  | { type: 'closed'; id: string; by: CloseSide }
  | { type: 'diagnostic'; id?: string; message: string }
  | { type: 'fault'; id?: string; message: string }
  | { type: 'module'; moduleId: string; id?: string; message: unknown };

export type WorkerCommand =
  | { type: 'target'; id: string; destination: Destination | null }
  | { type: 'interest'; interest: InterestSpec }
  | { type: 'forward'; id: string; sequence: number; generation: number; data: Uint8Array | null }
  | { type: 'inject'; id: string; data: Uint8Array; toClient: boolean }
  /** Without `id`: module-wide configuration. With `id`: a command for that session's module instance. */
  | { type: 'module'; moduleId: string; id?: string; message: unknown }
  | { type: 'close'; id: string }
  | { type: 'stop' };
```

`src/transport/modules.ts`:
```ts
import type { Packet } from '../protocol/Packet.ts';
import type { PacketFactory } from '../protocol/PacketFactory.ts';

/** How a frame reached the writer. `priority` frames bypass ordering and are never queued before the server connects. */
export type WriteKind = 'normal' | 'injected' | 'priority';

/** A packet waiting for a main-thread verdict. */
export interface HeldPacket {
  readonly observationId: number;
  readonly name: string;
  readonly fromClient: boolean;
  readonly receivedAt: number;
}

export interface WorkerSessionContext {
  readonly sessionId: string;
  readonly factory: PacketFactory;
  /** Upstream connection generation; increases on every (re)connect of this game socket. */
  generation(): number;
  now(): number;
  /** Encrypt and write now, ahead of anything awaiting a main-thread verdict. False if the socket can't take it. */
  writePriority(data: Buffer, toClient: boolean, done?: (error?: Error | null) => void): boolean;
  /** Whether the upstream is writable, and whether any traffic is still queued or in flight. */
  transport(): { available: boolean; backlog: boolean };
  /** Packets awaiting a main-thread verdict, oldest first (Collision HP's stalled-delivery fail-safe). */
  held(): readonly HeldPacket[];
  /** Message this module's main-thread half (a ProxyHost 'module' event). */
  post(message: unknown): void;
}

/**
 * Per-session hooks for realtime plugin halves that run beside the sockets.
 * Hooks must not throw. A thrown error is reported as a diagnostic and treated
 * as "no opinion" (traffic passes).
 */
export interface WorkerSessionModule {
  /** After decryption, before anything else. True swallows the frame (its input RC4 is already consumed). */
  suppressEntry?(name: string, fromClient: boolean): boolean;
  /**
   * Original packets named in the module's `observe` lists, before the main thread sees them.
   * `observationId` follows the frame to `written` or `dropped`, so a module can tell a delivered
   * hit report from one a plugin withheld (Collision HP must never charge a withheld report twice).
   */
  observe?(packet: Packet, fromClient: boolean, now: number, observationId: number): void;
  /** Last check before output RC4 for every write: released, injected, queued and priority. False drops it. */
  allowWrite?(name: string, toClient: boolean, kind: WriteKind, decode: () => Packet): boolean;
  /** A client→server packet named in `written` was accepted by the socket writer. `observationId` is null for injected/priority frames. */
  written?(packet: Packet, kind: WriteKind, now: number, observationId: number | null): void;
  /** An observed frame will never reach its socket: a plugin dropped it, a module vetoed it, or its upstream generation ended. */
  dropped?(observationId: number, name: string, fromClient: boolean, now: number): void;
  connectionChanged?(generation: number): void;
  tick?(now: number): void;
  command?(message: unknown): void;
  close?(): void;
}

export interface WorkerModule {
  readonly id: string;
  /** Lower runs first. Auto Nexus = 0, Auto Drink = 10. */
  readonly priority: number;
  readonly observe?: { readonly client?: readonly string[]; readonly server?: readonly string[] };
  readonly written?: readonly string[];
  /** Module-wide configuration from the main thread (delivered at startup and on change). */
  configure?(config: unknown): void;
  createSession(context: WorkerSessionContext): WorkerSessionModule;
}
```

`src/transport/workerModules.ts`:
```ts
import type { WorkerModule } from './modules.ts';

/** Realtime plugin halves bundled into the network worker. Phase 3 adds Auto Nexus and Auto Drink. */
export const WORKER_MODULES: readonly WorkerModule[] = [];
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(transport): worker message, interest and module contracts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Session — one game socket and its upstream

**Files:**
- Create: `src/transport/session.ts`
- Test: `src/transport/__tests__/session.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces:
  - `interface SessionEnv { factory; router; interest; modules; post(event); now(); fallbackDestination; targetTimeoutMs; helloTimeoutMs; maxPendingBytes; onClosed(id) }` (`router` is reassignable: the worker swaps it once the bound port is known).
  - `class Session { readonly id; constructor(id, client: net.Socket, env); setTarget(destination | null); forward(sequence, generation, data: Buffer | null); inject(data, toClient): boolean; command(moduleId, message); tick(now); close(by?) }`
  - Every frame accepted after HELLO gets an `observationId`. It goes to `observe`, then to exactly one of `written` (client→server frames named in `written`) or `dropped` (verdict drop, writer veto, unwritable socket, stale generation). Frames still queued when the session closes get neither.

- [ ] **Step 1: Write the failing tests**

`src/transport/__tests__/session.test.ts`:
```ts
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { Session, type SessionEnv } from '../session.ts';
import { Interest } from '../interest.ts';
import { DEFAULTS, type WorkerEvent } from '../messages.ts';
import type { WorkerModule } from '../modules.ts';
import { Router } from '../../routing/router.ts';
import { createFactory } from '../../protocol/schema.ts';
import { frame, helloBytes, reconnectBytes, unknownId } from '../../testing/wire.ts';
import { connectGame, FakeServer, until, type Peer } from '../../testing/net.ts';

const factory = createFactory();
const id = (name: string) => factory.getPacketId(name)!;
const UNKNOWN = unknownId(factory);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function harness(overrides: Partial<SessionEnv> = {}) {
  const events: WorkerEvent[] = [];
  const sessions = new Map<string, Session>();
  let count = 0;
  const env: SessionEnv = {
    factory, router: new Router(), interest: new Interest(), modules: [],
    post: event => events.push(event), now: () => performance.now(),
    fallbackDestination: null, targetTimeoutMs: 1000, helloTimeoutMs: DEFAULTS.helloTimeoutMs,
    maxPendingBytes: DEFAULTS.maxPendingBytes, onClosed: sessionId => { sessions.delete(sessionId); },
    ...overrides,
  };
  const all: Session[] = [];
  const listener = net.createServer(socket => {
    const session = new Session(`s${++count}`, socket, env);
    sessions.set(session.id, session);
    all.push(session);
  });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  env.router = overrides.router ?? new Router({ loopbackPort: port });
  cleanups.push(() => new Promise<void>(resolve => { for (const s of all) s.close(); listener.close(() => resolve()); }));
  return { env, events, sessions, all, port };
}

async function fakeServer(): Promise<FakeServer> {
  const server = new FakeServer();
  await server.listen();
  cleanups.push(() => server.close());
  return server;
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Game connects, sends HELLO, the main thread answers with `server` as the target. */
async function connected(h: Harness, server: FakeServer): Promise<{ game: Peer; upstream: Peer; session: Session }> {
  const peersBefore = server.peers.length;
  const game = await connectGame(h.port);
  cleanups.push(() => game.destroy());
  game.send(helloBytes(factory, Buffer.alloc(0)));
  await until(() => h.all.length > 0 && !!h.all.at(-1), 'session accepted');
  const session = h.all.at(-1)!;
  session.setTarget({ host: '127.0.0.1', port: server.port });
  await until(() => (server.peers[peersBefore]?.frames.length ?? 0) >= 1, 'HELLO upstream');
  return { game, upstream: server.peers[peersBefore], session };
}

const packets = (h: Harness) => h.events.filter((e): e is Extract<WorkerEvent, { type: 'packet' }> => e.type === 'packet');

describe('Session', () => {
  it('connects to the resolved destination and relays both directions unchanged', async () => {
    const h = await harness();
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    expect(factory.createFromBytes(upstream.frames[0], 'client').name).toBe('HELLO');

    const fromServer = frame(UNKNOWN, Buffer.from('payload'));
    upstream.send(fromServer);
    await until(() => game.frames.length === 1, 'server frame at game');
    expect(game.frames[0].equals(fromServer)).toBe(true);

    const fromGame = frame(id('MOVE'), Buffer.from([1, 2, 3]));
    game.send(fromGame);
    await until(() => upstream.frames.length === 2, 'game frame upstream');
    expect(upstream.frames[1].equals(fromGame)).toBe(true);
    expect(h.events.map(e => e.type)).toEqual(expect.arrayContaining(['opened', 'routed', 'connected']));
    expect(packets(h)).toHaveLength(0);
  });

  it('holds verdict packets, keeps later packets behind them, and applies drop or replace', async () => {
    const h = await harness({ interest: new Interest({ verdict: { server: ['TEXT'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    upstream.send(frame(id('TEXT'), Buffer.from('spam')));
    upstream.send(frame(UNKNOWN, Buffer.from('after-1')));
    upstream.send(frame(id('TEXT'), Buffer.from('hello')));
    upstream.send(frame(UNKNOWN, Buffer.from('after-2')));
    await until(() => packets(h).length === 2, 'two verdict events');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(game.frames).toHaveLength(0);

    const [spam, hello] = packets(h);
    expect(spam.observeOnly).toBe(false);
    const replacement = frame(id('TEXT'), Buffer.from('HELLO!'));
    session.forward(hello.sequence, hello.generation, replacement); // out of order: still held behind spam
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(game.frames).toHaveLength(0);
    session.forward(spam.sequence, spam.generation, null);
    await until(() => game.frames.length === 3, 'released in order');
    expect(game.frames.map(f => f.subarray(5).toString())).toEqual(['after-1', 'HELLO!', 'after-2']);
  });

  it('posts observe-only packets without holding traffic', async () => {
    const h = await harness({ interest: new Interest({ observe: { server: ['MAPINFO'] } }) });
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    upstream.send(frame(id('MAPINFO'), Buffer.from('map')));
    await until(() => game.frames.length === 1 && packets(h).length === 1, 'forwarded and observed');
    expect(packets(h)[0].observeOnly).toBe(true);
  });

  it('loops RECONNECT back through the proxy and restores the real key on the next HELLO', async () => {
    const h = await harness();
    const first = await fakeServer();
    const second = await fakeServer();
    const { game, upstream } = await connected(h, first);
    const realKey = Buffer.from([0, 0xff, 0x80, 0x42]);
    const tail = Buffer.from([0xde, 0xad, 0x00, 0xff]);
    upstream.send(reconnectBytes(factory, { host: '127.0.0.1', port: second.port, key: realKey, gameId: 7, keyTime: 99 }, tail));
    await until(() => game.frames.length === 1, 'rewritten RECONNECT');
    const rewritten = factory.createFromBytes(game.frames[0], 'server');
    expect(rewritten.data).toMatchObject({ host: '127.0.0.1', port: h.port, gameId: 7, keyTime: 99 });
    expect(rewritten.unreadData.equals(tail)).toBe(true);
    const token = rewritten.data.key as Buffer;
    expect(token.equals(realKey)).toBe(false);

    const game2 = await connectGame(h.port);
    cleanups.push(() => game2.destroy());
    game2.send(helloBytes(factory, token, { gameId: 7 }));
    await until(() => h.all.length === 2, 'second session');
    h.all[1].setTarget(null); // the helper records nothing for loopback connects
    await until(() => second.peers[0]?.frames.length === 1, 'HELLO at the second server');
    const upstreamHello = factory.createFromBytes(second.peers[0].frames[0], 'client');
    expect((upstreamHello.data.key as Buffer).equals(realKey)).toBe(true);
    expect(upstreamHello.data).toMatchObject({ gameId: 7, accessToken: 'token-abc' });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'routed', id: 's2', restored: true, port: second.port }));
  });

  it('drops a malformed RECONNECT and keeps relaying', async () => {
    const h = await harness();
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    upstream.send(frame(id('RECONNECT'), Buffer.from([0, 5, 1])));
    upstream.send(frame(UNKNOWN, Buffer.from('after')));
    await until(() => game.frames.length === 1, 'next frame');
    expect(game.frames[0][4]).toBe(UNKNOWN);
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'diagnostic', message: expect.stringContaining('RECONNECT') }));
  });

  it('faults clearly when no destination is known', async () => {
    const h = await harness();
    const game = await connectGame(h.port);
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => h.all.length === 1, 'session');
    h.all[0].setTarget(null);
    await until(() => game.closed, 'game socket closed');
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'fault', message: expect.stringContaining('No destination') }));
    expect(h.events.filter(e => e.type === 'closed')).toEqual([{ type: 'closed', id: 's1', by: 'fault' }]);
  });

  it('uses the fallback server when the main thread does not answer in time', async () => {
    const server = await fakeServer();
    const h = await harness({ targetTimeoutMs: 30, fallbackDestination: { host: '127.0.0.1', port: server.port } });
    const game = await connectGame(h.port);
    cleanups.push(() => game.destroy());
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => server.peers[0]?.frames.length === 1, 'HELLO via fallback');
  });

  it('survives the game disconnecting while its HELLO is held', async () => {
    const h = await harness({ targetTimeoutMs: 5000 });
    const game = await connectGame(h.port);
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => h.all.length === 1, 'session');
    game.destroy();
    await until(() => h.events.some(e => e.type === 'closed'), 'closed');
    h.all[0].setTarget({ host: '127.0.0.1', port: 1 }); // late answer: must be ignored
    expect(h.events.filter(e => e.type === 'closed')).toEqual([{ type: 'closed', id: 's1', by: 'game' }]);
    expect(h.sessions.size).toBe(0);
  });

  it('faults instead of buffering without bound when verdicts never come back', async () => {
    const h = await harness({ interest: new Interest({ verdict: { server: ['TEXT'] } }), maxPendingBytes: 64 * 1024 });
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    for (let i = 0; i < 20; i++) upstream.send(frame(id('TEXT'), Buffer.alloc(8 * 1024)));
    await until(() => game.closed, 'session faulted');
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'fault', message: expect.stringContaining('backlog') }));
  });

  it('retries an unanswered HELLO three times, then faults', async () => {
    const h = await harness({ helloTimeoutMs: 40 });
    const silent = await fakeServer();
    const game = await connectGame(h.port);
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => h.all.length === 1, 'session');
    h.all[0].setTarget({ host: '127.0.0.1', port: silent.port });
    await until(() => game.closed, 'gave up', 3000);
    expect(silent.peers.filter(peer => peer.frames.length === 1)).toHaveLength(4);
    expect(h.events.filter(e => e.type === 'diagnostic')).toHaveLength(3);
  });

  it('runs worker modules before the main thread: entry suppression, observe + priority write, writer veto', async () => {
    const observed: string[] = [];
    const module: WorkerModule = {
      id: 'test', priority: 0, observe: { server: ['DAMAGE'] },
      createSession: context => ({
        suppressEntry: (name, fromClient) => fromClient && name === 'PLAYERHIT',
        observe: packet => {
          observed.push(packet.name);
          context.writePriority(frame(id('ESCAPE')), false);
        },
        allowWrite: (name, toClient) => !(toClient === false && name === 'MOVE'),
      }),
    };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { server: ['DAMAGE'] } }) });
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);

    upstream.send(frame(id('DAMAGE')));
    // ESCAPE reaches the server although DAMAGE is still waiting for a main-thread verdict.
    await until(() => upstream.frames.length === 2, 'priority ESCAPE');
    expect(upstream.frames[1][4]).toBe(id('ESCAPE'));
    expect(observed).toEqual(['DAMAGE']);
    expect(game.frames).toHaveLength(0);

    game.send(frame(id('PLAYERHIT')));
    game.send(frame(id('MOVE')));
    game.send(frame(UNKNOWN));
    await until(() => upstream.frames.length === 3, 'later client frame');
    expect(upstream.frames[2][4]).toBe(UNKNOWN); // PLAYERHIT swallowed at entry, MOVE vetoed at the writer
  });

  it('links each observed report to exactly one written or dropped outcome, and exposes held packets', async () => {
    const outcomes: string[] = [];
    const ids: number[] = [];
    let held: () => readonly { name: string }[] = () => [];
    const module: WorkerModule = {
      id: 'ledger', priority: 0, observe: { client: ['PLAYERHIT'] }, written: ['PLAYERHIT'],
      createSession: context => {
        held = () => context.held();
        return {
          observe: (_packet, _fromClient, _now, observationId) => { ids.push(observationId); },
          written: (_packet, kind, _now, observationId) => { outcomes.push(`written:${observationId}:${kind}`); },
          dropped: (observationId, name) => { outcomes.push(`dropped:${observationId}:${name}`); },
        };
      },
    };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { client: ['PLAYERHIT'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    game.send(frame(id('PLAYERHIT'), Buffer.from([1])));
    game.send(frame(id('PLAYERHIT'), Buffer.from([2])));
    await until(() => packets(h).length === 2, 'two held reports');
    expect(held().map(p => p.name)).toEqual(['PLAYERHIT', 'PLAYERHIT']);
    const [first, second] = packets(h);
    session.forward(first.sequence, first.generation, first.data);
    session.forward(second.sequence, second.generation, null);
    await until(() => outcomes.length === 2, 'both outcomes');
    expect(outcomes).toEqual([`written:${ids[0]}:normal`, `dropped:${ids[1]}:PLAYERHIT`]);
    expect(held()).toEqual([]);
    expect(upstream.frames).toHaveLength(2); // HELLO + the passed report
  });

  it('reports a throwing module hook and lets traffic pass', async () => {
    const module: WorkerModule = {
      id: 'broken', priority: 0,
      createSession: () => ({ allowWrite: () => { throw new Error('oops'); } }),
    };
    const h = await harness({ modules: [module] });
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    upstream.send(frame(UNKNOWN, Buffer.from('x')));
    await until(() => game.frames.length === 1, 'passed');
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'diagnostic', message: expect.stringContaining('broken.allowWrite failed: oops') }));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/transport/__tests__/session.test.ts`
Expected: FAIL, `Cannot find module '../session.ts'`.

- [ ] **Step 3: Implement the session**

`src/transport/session.ts`:
```ts
import net from 'node:net';
import { RC4_KEYS } from '../protocol/constants.ts';
import { FrameDecoder, isWholeFrame } from '../protocol/frames.ts';
import { RC4Cipher } from '../protocol/RC4Cipher.ts';
import type { Packet } from '../protocol/Packet.ts';
import type { PacketFactory } from '../protocol/PacketFactory.ts';
import type { Destination, Router } from '../routing/router.ts';
import type { Interest } from './interest.ts';
import type { CloseSide, WorkerEvent } from './messages.ts';
import type { HeldPacket, WorkerModule, WorkerSessionContext, WorkerSessionModule, WriteKind } from './modules.ts';

export interface SessionEnv {
  factory: PacketFactory;
  router: Router;
  interest: Interest;
  modules: readonly WorkerModule[];
  post(event: WorkerEvent): void;
  now(): number;
  fallbackDestination: Destination | null;
  /** How long a new connection waits for the main thread's helper-target answer. */
  targetTimeoutMs: number;
  /** How long the server may stay silent after HELLO before a retry. */
  helloTimeoutMs: number;
  /** Bytes awaiting verdicts (or queued before connect) before the session is faulted. */
  maxPendingBytes: number;
  onClosed(id: string): void;
}

const MAX_HELLO_RETRIES = 3;

interface Pending {
  observationId: number;
  name: string;
  receivedAt: number;
  fromClient: boolean;
  generation: number;
  bytes: number;
  /** undefined = awaiting a verdict; null = drop; Buffer = write these bytes. */
  result?: Buffer | null;
}

interface ActiveModule {
  id: string;
  client: Set<string>;
  server: Set<string>;
  written: Set<string>;
  hooks: WorkerSessionModule;
}

interface Queued {
  data: Buffer;
  kind: WriteKind;
  observationId: number | null;
}

/**
 * One game TCP connection and its upstream. Owns both ciphers per direction,
 * per-direction ordering of main-thread verdicts, HELLO routing and the final
 * writer. Transfers between servers arrive as new Sessions (the game reconnects).
 */
export class Session {
  readonly id: string;
  private readonly client: net.Socket;
  private readonly env: SessionEnv;
  private readonly modules: ActiveModule[];
  private server: net.Socket | null = null;
  private serverReady = false;
  private serverResponded = false;
  private generation = 0;
  private destination: Destination | null = null;
  private target: Destination | null = null;
  private targetResolved = false;
  private targetTimer: ReturnType<typeof setTimeout> | null = null;
  private sawHello = false;
  private heldHello: Buffer | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private helloAttempt = 0;
  private clientFrames = new FrameDecoder(new RC4Cipher(RC4_KEYS.clientToServer));
  private serverFrames = new FrameDecoder(new RC4Cipher(RC4_KEYS.serverToClient));
  private toClientCipher = new RC4Cipher(RC4_KEYS.serverToClient);
  private toServerCipher = new RC4Cipher(RC4_KEYS.clientToServer);
  private pending = new Map<number, Pending>();
  private clientOrder: number[] = [];
  private serverOrder: number[] = [];
  private sequence = 0;
  private observations = 0;
  private pendingBytes = 0;
  private beforeConnect: Queued[] = [];
  private beforeConnectBytes = 0;
  private closed = false;

  constructor(id: string, client: net.Socket, env: SessionEnv) {
    this.id = id;
    this.client = client;
    this.env = env;
    this.modules = [...env.modules].sort((a, b) => a.priority - b.priority).map(module => ({
      id: module.id,
      client: new Set(module.observe?.client ?? []),
      server: new Set(module.observe?.server ?? []),
      written: new Set(module.written ?? []),
      hooks: module.createSession(this.context(module.id)),
    }));
    client.setNoDelay(true);
    client.on('data', data => this.receive(data, true, this.clientFrames));
    client.on('error', error => this.fault(error));
    client.on('close', () => this.close('game'));
    this.targetTimer = setTimeout(() => this.setTarget(null), env.targetTimeoutMs);
    env.post({ type: 'opened', id, remotePort: client.remotePort ?? 0 });
  }

  /** The main thread's answer: where the helper says this game socket was going (null = unknown). */
  setTarget(destination: Destination | null): void {
    if (this.closed || this.targetResolved) return;
    this.targetResolved = true;
    this.target = destination;
    if (this.targetTimer) { clearTimeout(this.targetTimer); this.targetTimer = null; }
    if (this.heldHello) this.routeHello(this.heldHello);
  }

  forward(sequence: number, generation: number, data: Buffer | null): void {
    const pending = this.pending.get(sequence);
    if (!pending || pending.generation !== generation || pending.result !== undefined) return;
    pending.result = data;
    this.flush(pending.fromClient);
  }

  inject(data: Buffer, toClient: boolean): boolean {
    return this.write(data, toClient, 'injected');
  }

  command(moduleId: string, message: unknown): void {
    const module = this.modules.find(m => m.id === moduleId);
    if (module) this.call(module, 'command', () => module.hooks.command?.(message), undefined);
  }

  tick(now: number): void {
    if (this.closed) return;
    for (const module of this.modules) this.call(module, 'tick', () => module.hooks.tick?.(now), undefined);
  }

  close(by: CloseSide = 'proxy'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.targetTimer) clearTimeout(this.targetTimer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    for (const module of this.modules) this.call(module, 'close', () => module.hooks.close?.(), undefined);
    this.client.destroy();
    this.server?.destroy();
    this.pending.clear();
    this.beforeConnect = [];
    this.env.post({ type: 'closed', id: this.id, by });
    this.env.onClosed(this.id);
  }

  private context(moduleId: string): WorkerSessionContext {
    return {
      sessionId: this.id,
      factory: this.env.factory,
      generation: () => this.generation,
      now: () => this.env.now(),
      writePriority: (data, toClient, done) => this.write(data, toClient, 'priority', done),
      transport: () => this.transport(),
      held: () => this.held(),
      post: message => this.env.post({ type: 'module', moduleId, id: this.id, message }),
    };
  }

  private held(): HeldPacket[] {
    const out: HeldPacket[] = [];
    for (const pending of this.pending.values()) {
      if (pending.result === undefined) {
        out.push({ observationId: pending.observationId, name: pending.name, fromClient: pending.fromClient, receivedAt: pending.receivedAt });
      }
    }
    return out;
  }

  private notifyDropped(observationId: number, name: string, fromClient: boolean): void {
    const now = this.env.now();
    for (const module of this.modules) {
      if ((fromClient ? module.client : module.server).has(name)) {
        this.call(module, 'dropped', () => module.hooks.dropped?.(observationId, name, fromClient, now), undefined);
      }
    }
  }

  private transport(): { available: boolean; backlog: boolean } {
    const server = this.server;
    const available = !this.closed && this.serverReady && !!server && !server.destroyed && server.writable;
    const backlog = this.pending.size > 0 || this.beforeConnect.length > 0
      || this.clientFrames.incomplete || this.serverFrames.incomplete
      || !!server?.writableNeedDrain || (server?.writableLength ?? 0) > 0 || (server?.readableLength ?? 0) > 0
      || this.client.readableLength > 0 || this.client.writableNeedDrain || this.client.writableLength > 0;
    return { available, backlog };
  }

  private call<T>(module: ActiveModule, hook: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (error) {
      this.env.post({ type: 'diagnostic', id: this.id, message: `Worker module ${module.id}.${hook} failed: ${(error as Error).message}` });
      return fallback;
    }
  }

  private fault(error: Error): void {
    if (this.closed) return;
    this.env.post({ type: 'fault', id: this.id, message: error.message });
    this.close('fault');
  }

  private receive(data: Buffer, fromClient: boolean, frames: FrameDecoder): void {
    try {
      frames.feed(data, frame => this.accept(frame, fromClient));
    } catch (error) {
      this.fault(error as Error);
    }
  }

  private accept(frame: Buffer, fromClient: boolean): void {
    if (this.closed) return;
    const direction = fromClient ? 'client' : 'server';
    const name = this.env.factory.getPacketName(frame[4], direction);
    for (const module of this.modules) {
      if (this.call(module, 'suppressEntry', () => module.hooks.suppressEntry?.(name, fromClient) ?? false, false)) return;
    }
    if (fromClient && !this.sawHello) {
      if (name !== 'HELLO') { this.fault(new Error(`Expected HELLO as the first game packet, got ${name}`)); return; }
      this.sawHello = true;
      if (this.targetResolved) this.routeHello(frame);
      else this.heldHello = frame;
      return;
    }
    let packet: Packet | null = null;
    const decode = (): Packet => (packet ??= this.env.factory.createFromBytes(frame, direction));
    const now = this.env.now();
    const observationId = ++this.observations;
    for (const module of this.modules) {
      if ((fromClient ? module.client : module.server).has(name)) {
        this.call(module, 'observe', () => module.hooks.observe?.(decode(), fromClient, now, observationId), undefined);
      }
      if (this.closed) return;
    }
    const kind = this.env.interest.classify(name, fromClient);
    const sequence = ++this.sequence;
    this.pending.set(sequence, { observationId, name, receivedAt: now, fromClient, generation: this.generation,
      bytes: frame.length, result: kind === 'verdict' ? undefined : frame });
    (fromClient ? this.clientOrder : this.serverOrder).push(sequence);
    this.pendingBytes += frame.length;
    if (this.pendingBytes > this.env.maxPendingBytes) {
      this.fault(new Error('Packets awaiting a plugin verdict exceeded the backlog limit'));
      return;
    }
    if (kind !== 'none') {
      this.env.post({ type: 'packet', id: this.id, sequence, generation: this.generation, fromClient, observeOnly: kind === 'observe', data: frame });
    }
    if (kind !== 'verdict') this.flush(fromClient);
  }

  private routeHello(frame: Buffer): void {
    this.heldHello = null;
    const hello = this.env.factory.createFromBytes(frame, 'client');
    const route = this.env.router.routeHello(hello, this.target ?? this.env.fallbackDestination);
    if (!route) {
      this.fault(new Error(hello.isDefined
        ? 'No destination for this connection: the helper recorded no server and no fallback server is configured'
        : "Could not decode the game's HELLO; packet definitions may be out of date for this game build"));
      return;
    }
    this.env.post({ type: 'routed', id: this.id, host: route.destination.host, port: route.destination.port, restored: route.restored });
    this.connect(route.destination, route.hello);
  }

  private flush(fromClient: boolean): void {
    const order = fromClient ? this.clientOrder : this.serverOrder;
    while (order.length > 0) {
      const sequence = order[0];
      const next = this.pending.get(sequence);
      if (next && next.result === undefined) break;
      order.shift();
      if (!next) continue;
      this.pending.delete(sequence);
      this.pendingBytes -= next.bytes;
      // Game packets belong to this socket forever; server packets only to their upstream generation.
      if (next.result && (next.fromClient || next.generation === this.generation)) {
        this.write(next.result, !next.fromClient, 'normal', undefined, next.observationId);
      } else {
        this.notifyDropped(next.observationId, next.name, next.fromClient);
      }
      if (this.closed) return;
    }
  }

  private connect(destination: Destination, hello: Buffer, retry = false): void {
    if (this.closed) return;
    ++this.generation;
    this.serverReady = false;
    this.serverResponded = false;
    this.destination = destination;
    for (const [sequence, pending] of this.pending) {
      if (!pending.fromClient && pending.generation !== this.generation) {
        this.pending.delete(sequence);
        this.pendingBytes -= pending.bytes;
        this.notifyDropped(pending.observationId, pending.name, pending.fromClient);
      }
    }
    this.serverOrder = this.serverOrder.filter(sequence => this.pending.has(sequence));
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    if (!retry) this.helloAttempt = 0;
    if (this.server) { this.server.removeAllListeners(); this.server.destroy(); }
    this.toServerCipher = new RC4Cipher(RC4_KEYS.clientToServer);
    const frames = this.serverFrames = new FrameDecoder(new RC4Cipher(RC4_KEYS.serverToClient));
    const generation = this.generation;
    for (const module of this.modules) {
      this.call(module, 'connectionChanged', () => module.hooks.connectionChanged?.(generation), undefined);
    }
    const server = this.server = new net.Socket();
    server.setNoDelay(true);
    const label = `${destination.host}:${destination.port}`;
    const retryHello = (error?: Error): void => {
      if (this.closed || this.server !== server) return;
      // A server that accepted HELLO and then reset has refused it; resending looks like a flood.
      if (error && this.serverReady && !this.serverResponded) {
        this.fault(new Error(`${label} reset the connection after HELLO (${error.message}); not retrying`));
        return;
      }
      if (this.serverResponded || this.helloAttempt >= MAX_HELLO_RETRIES) {
        this.fault(error ?? new Error(`${label} never answered HELLO`));
        return;
      }
      ++this.helloAttempt;
      this.env.post({ type: 'diagnostic', id: this.id, message: `${label} ${error
        ? `connect failed (${error.message})`
        : `did not answer HELLO within ${this.env.helloTimeoutMs} ms`}; retry ${this.helloAttempt}/${MAX_HELLO_RETRIES}` });
      this.connect(destination, hello, true);
    };
    server.on('data', data => {
      if (this.closed || this.server !== server) return;
      this.serverResponded = true;
      if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
      this.receive(data, false, frames);
    });
    server.on('error', error => retryHello(error));
    server.on('close', () => { if (this.server === server) this.close('server'); });
    server.connect(destination.port, destination.host, () => {
      if (this.closed || this.server !== server) return;
      this.serverReady = true;
      this.writeRaw(hello, false);
      const queued = this.beforeConnect;
      this.beforeConnect = [];
      this.beforeConnectBytes = 0;
      for (const item of queued) this.write(item.data, false, item.kind, undefined, item.observationId);
      this.env.post({ type: 'connected', id: this.id, generation });
      this.helloTimer = setTimeout(() => retryHello(), this.env.helloTimeoutMs);
    });
  }

  private write(data: Buffer, toClient: boolean, kind: WriteKind, done?: (error?: Error | null) => void,
    observationId: number | null = null): boolean {
    if (this.closed) return false;
    if (!isWholeFrame(data)) {
      this.env.post({ type: 'diagnostic', id: this.id, message: `Dropped a malformed ${kind} frame (${data.length} bytes)` });
      return false;
    }
    const direction = toClient ? 'server' : 'client';
    const name = this.env.factory.getPacketName(data[4], direction);
    let packet: Packet | null = null;
    const decode = (): Packet => (packet ??= this.env.factory.createFromBytes(data, direction));
    for (const module of this.modules) {
      if (!this.call(module, 'allowWrite', () => module.hooks.allowWrite?.(name, toClient, kind, decode) ?? true, true)) {
        if (observationId !== null) this.notifyDropped(observationId, name, !toClient);
        return false;
      }
    }
    if (!toClient && !this.serverReady) {
      if (kind === 'priority') return false;
      this.beforeConnectBytes += data.length;
      if (this.beforeConnectBytes > this.env.maxPendingBytes) {
        this.fault(new Error('Too much game traffic queued before the server connected'));
        return false;
      }
      this.beforeConnect.push({ data: Buffer.from(data), kind, observationId });
      return true;
    }
    let out = data;
    if (toClient && name === 'RECONNECT') {
      const rewritten = this.destination ? this.env.router.rewriteReconnect(decode(), this.destination) : null;
      if (!rewritten) {
        this.env.post({ type: 'diagnostic', id: this.id, message: 'Dropped a malformed RECONNECT; the current route is unchanged' });
        return false;
      }
      out = rewritten;
    }
    if (!this.writeRaw(out, toClient, done)) {
      if (observationId !== null) this.notifyDropped(observationId, name, !toClient);
      return false;
    }
    if (!toClient) {
      const now = this.env.now();
      for (const module of this.modules) {
        if (module.written.has(name)) this.call(module, 'written', () => module.hooks.written?.(decode(), kind, now, observationId), undefined);
      }
    }
    return true;
  }

  private writeRaw(data: Buffer, toClient: boolean, done?: (error?: Error | null) => void): boolean {
    const socket = toClient ? this.client : this.server;
    if (!socket || socket.destroyed || !socket.writable) return false;
    const encrypted = Buffer.from(data);
    (toClient ? this.toClientCipher : this.toServerCipher).cipher(encrypted);
    socket.write(encrypted, done);
    return true;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/transport/__tests__/session.test.ts`
Expected: 13 tests PASS. If the HELLO-retry test is flaky on a slow machine, raise its `until` timeout. Don't change `MAX_HELLO_RETRIES`.

Run: `npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(transport): session with ordered verdicts, routing and worker-module hooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Worker entry and ProxyHost

**Files:**
- Create: `src/transport/worker.ts`, `src/transport/host.ts`
- Test: `src/transport/__tests__/host.test.ts`

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces:
  - `interface PacketEvent { id; sequence; generation; fromClient; observeOnly; data: Buffer }`
  - `interface HostEvents` (listening, session, routed, connected, packet, closed, diagnostic, fault, module)
  - `interface ProxyHostOptions { schema: ProtocolSchema; listenHost?; listenPort?; fallbackDestination?; resolveTarget?: (remotePort) => Destination | null; interest?: InterestSpec; moduleConfig?; targetTimeoutMs?; helloTimeoutMs?; maxPendingBytes?; workerUrl?: URL }`
  - `class ProxyHost extends EventEmitter<HostEvents> { start(): Promise<number>; setInterest(spec); forward(id, sequence, generation, data: Buffer | null); inject(id, data, toClient); configureModule(moduleId, config); moduleCommand(moduleId, id, message); close(id); stop(): Promise<void> }`. A non-observe `packet` with no listener is auto-passed.

- [ ] **Step 1: Write the failing tests**

`src/transport/__tests__/host.test.ts`:
```ts
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ProxyHost } from '../host.ts';
import { createFactory, loadSchema } from '../../protocol/schema.ts';
import { frame, helloBytes, unknownId } from '../../testing/wire.ts';
import { connectGame, FakeServer, until } from '../../testing/net.ts';

const factory = createFactory();
const UNKNOWN = unknownId(factory);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe('ProxyHost', () => {
  it('runs sessions in the worker thread and supplies helper targets from the main thread', async () => {
    const server = new FakeServer();
    await server.listen();
    cleanups.push(() => server.close());
    const host = new ProxyHost({
      schema: loadSchema(), listenPort: 0,
      resolveTarget: () => ({ host: '127.0.0.1', port: server.port }),
      interest: { verdict: { server: ['TEXT'] } },
    });
    cleanups.push(() => host.stop());
    const sessions: string[] = [];
    host.on('session', info => sessions.push(info.id));
    host.on('packet', event => host.forward(event.id, event.sequence, event.generation, null)); // drop every TEXT
    const port = await host.start();

    const game = await connectGame(port);
    cleanups.push(() => game.destroy());
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => server.peers[0]?.frames.length === 1, 'HELLO via the worker');
    expect(sessions).toHaveLength(1);

    server.peers[0].send(frame(factory.getPacketId('TEXT')!, Buffer.from('spam')));
    server.peers[0].send(frame(UNKNOWN, Buffer.from('ok')));
    await until(() => game.frames.length === 1, 'filtered relay');
    expect(game.frames[0][4]).toBe(UNKNOWN);
  });

  it('auto-passes verdict packets when nobody listens for them', async () => {
    const server = new FakeServer();
    await server.listen();
    cleanups.push(() => server.close());
    const host = new ProxyHost({ schema: loadSchema(), listenPort: 0,
      resolveTarget: () => ({ host: '127.0.0.1', port: server.port }), interest: { verdict: { server: ['TEXT'] } } });
    cleanups.push(() => host.stop());
    const port = await host.start();
    const game = await connectGame(port);
    cleanups.push(() => game.destroy());
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => server.peers[0]?.frames.length === 1, 'HELLO');
    server.peers[0].send(frame(factory.getPacketId('TEXT')!, Buffer.from('hi')));
    await until(() => game.frames.length === 1, 'passed through');
  });

  it('rejects start() with the address when the port is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>(resolve => blocker.close(() => resolve())));
    const port = (blocker.address() as net.AddressInfo).port;
    const host = new ProxyHost({ schema: loadSchema(), listenPort: port });
    cleanups.push(() => host.stop());
    await expect(host.start()).rejects.toThrow(`127.0.0.1:${port}`);
  });

  it('stops cleanly', async () => {
    const host = new ProxyHost({ schema: loadSchema(), listenPort: 0 });
    const port = await host.start();
    await host.stop();
    await expect(connectGame(port)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/transport/__tests__/host.test.ts`
Expected: FAIL, `Cannot find module '../host.ts'`.

- [ ] **Step 3: Implement the worker entry**

`src/transport/worker.ts`:
```ts
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import { PacketFactory } from '../protocol/PacketFactory.ts';
import { Router } from '../routing/router.ts';
import { Interest } from './interest.ts';
import type { WorkerCommand, WorkerEvent, WorkerInit } from './messages.ts';
import { Session, type SessionEnv } from './session.ts';
import { WORKER_MODULES } from './workerModules.ts';

const TICK_MS = 8;
const init = workerData as WorkerInit;
const port = parentPort;
if (!port) throw new Error('src/transport/worker.ts must run as a worker thread');
const post = (event: WorkerEvent): void => port.postMessage(event);

for (const module of WORKER_MODULES) {
  const config = init.moduleConfig[module.id];
  if (config !== undefined) module.configure?.(config);
}

const sessions = new Map<string, Session>();
const env: SessionEnv = {
  factory: new PacketFactory(init.definitions, init.stats, true),
  router: new Router({ loopbackPort: init.port }),
  interest: new Interest(init.interest),
  modules: WORKER_MODULES,
  post,
  now: () => performance.now(),
  fallbackDestination: init.fallbackDestination,
  targetTimeoutMs: init.targetTimeoutMs,
  helloTimeoutMs: init.helloTimeoutMs,
  maxPendingBytes: init.maxPendingBytes,
  onClosed: id => { sessions.delete(id); },
};

const listener = net.createServer(socket => {
  const id = randomUUID();
  sessions.set(id, new Session(id, socket, env));
});
listener.on('error', error =>
  post({ type: 'fault', message: `Could not listen on ${init.host}:${init.port}: ${error.message}` }));
listener.listen(init.port, init.host, () => {
  const address = listener.address();
  const bound = typeof address === 'object' && address ? address.port : init.port;
  // RECONNECTs must point the game at the port we actually bound.
  env.router = new Router({ loopbackPort: bound });
  post({ type: 'listening', port: bound });
});

const timer = WORKER_MODULES.length > 0
  ? setInterval(() => {
    const now = performance.now();
    for (const session of sessions.values()) session.tick(now);
  }, TICK_MS)
  : null;

port.on('message', (command: WorkerCommand) => {
  if (command.type === 'stop') {
    if (timer) clearInterval(timer);
    for (const session of [...sessions.values()]) session.close('proxy');
    listener.close(() => port.close());
    return;
  }
  if (command.type === 'interest') {
    env.interest.set(command.interest);
    return;
  }
  if (command.type === 'module' && command.id === undefined) {
    WORKER_MODULES.find(module => module.id === command.moduleId)?.configure?.(command.message);
    return;
  }
  const session = sessions.get(command.id ?? '');
  if (!session) return;
  switch (command.type) {
    case 'target': session.setTarget(command.destination); break;
    case 'forward': session.forward(command.sequence, command.generation, command.data === null ? null : Buffer.from(command.data)); break;
    case 'inject': session.inject(Buffer.from(command.data), command.toClient); break;
    case 'module': session.command(command.moduleId, command.message); break;
    case 'close': session.close('proxy'); break;
  }
});
```

- [ ] **Step 4: Implement ProxyHost**

`src/transport/host.ts`:
```ts
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { GAME_PORT } from '../protocol/constants.ts';
import type { ProtocolSchema } from '../protocol/schema.ts';
import type { Destination } from '../routing/router.ts';
import type { InterestSpec } from './interest.ts';
import { DEFAULTS, type CloseSide, type WorkerCommand, type WorkerEvent, type WorkerInit } from './messages.ts';

export interface PacketEvent {
  id: string;
  sequence: number;
  generation: number;
  fromClient: boolean;
  /** True: already forwarded, informational. False: the worker waits for forward(). */
  observeOnly: boolean;
  data: Buffer;
}

export interface HostEvents {
  listening: [port: number];
  session: [info: { id: string; remotePort: number }];
  routed: [info: { id: string; host: string; port: number; restored: boolean }];
  connected: [info: { id: string; generation: number }];
  packet: [event: PacketEvent];
  closed: [info: { id: string; by: CloseSide }];
  diagnostic: [info: { id?: string; message: string }];
  fault: [info: { id?: string; message: string }];
  module: [info: { moduleId: string; id?: string; message: unknown }];
}

export interface ProxyHostOptions {
  schema: ProtocolSchema;
  listenHost?: string;
  listenPort?: number;
  fallbackDestination?: Destination | null;
  /** Main-thread lookup of where a new game socket was going (helper temp file). */
  resolveTarget?: (remotePort: number) => Destination | null;
  interest?: InterestSpec;
  moduleConfig?: Record<string, unknown>;
  targetTimeoutMs?: number;
  helloTimeoutMs?: number;
  maxPendingBytes?: number;
  workerUrl?: URL;
}

/** Main-thread handle on the network worker. */
export class ProxyHost extends EventEmitter<HostEvents> {
  private readonly options: ProxyHostOptions;
  private worker: Worker | null = null;
  private listening = false;
  private starting: { resolve(port: number): void; reject(error: Error): void } | null = null;

  constructor(options: ProxyHostOptions) {
    super();
    this.options = options;
  }

  start(): Promise<number> {
    if (this.worker) return Promise.reject(new Error('ProxyHost is already started'));
    const o = this.options;
    const init: WorkerInit = {
      host: o.listenHost ?? '127.0.0.1',
      port: o.listenPort ?? GAME_PORT,
      definitions: o.schema.definitions,
      stats: o.schema.stats,
      fallbackDestination: o.fallbackDestination ?? null,
      targetTimeoutMs: o.targetTimeoutMs ?? DEFAULTS.targetTimeoutMs,
      helloTimeoutMs: o.helloTimeoutMs ?? DEFAULTS.helloTimeoutMs,
      maxPendingBytes: o.maxPendingBytes ?? DEFAULTS.maxPendingBytes,
      interest: o.interest ?? {},
      moduleConfig: o.moduleConfig ?? {},
    };
    const worker = new Worker(o.workerUrl ?? new URL('./worker.ts', import.meta.url), { workerData: init });
    this.worker = worker;
    const started = new Promise<number>((resolve, reject) => { this.starting = { resolve, reject }; });
    worker.on('message', (event: WorkerEvent) => this.handle(event));
    worker.on('error', error => {
      this.failStart(error);
      this.emit('fault', { message: `Network worker crashed: ${error.message}` });
    });
    worker.on('exit', code => {
      if (this.worker === worker) this.worker = null;
      this.listening = false;
      this.failStart(new Error(`Network worker exited (code ${code}) before listening`));
    });
    return started;
  }

  setInterest(interest: InterestSpec): void { this.send({ type: 'interest', interest }); }

  forward(id: string, sequence: number, generation: number, data: Buffer | null): void {
    this.send({ type: 'forward', id, sequence, generation, data });
  }

  inject(id: string, data: Buffer, toClient: boolean): void { this.send({ type: 'inject', id, data, toClient }); }

  configureModule(moduleId: string, config: unknown): void { this.send({ type: 'module', moduleId, message: config }); }

  moduleCommand(moduleId: string, id: string, message: unknown): void { this.send({ type: 'module', moduleId, id, message }); }

  close(id: string): void { this.send({ type: 'close', id }); }

  async stop(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    worker.postMessage({ type: 'stop' } satisfies WorkerCommand);
    const timeout = setTimeout(() => { void worker.terminate(); }, 2000);
    await exited;
    clearTimeout(timeout);
  }

  private send(command: WorkerCommand): void {
    this.worker?.postMessage(command);
  }

  private failStart(error: Error): void {
    const starting = this.starting;
    this.starting = null;
    if (!starting) return;
    starting.reject(error);
    void this.worker?.terminate();
  }

  private handle(event: WorkerEvent): void {
    switch (event.type) {
      case 'listening':
        this.listening = true;
        this.starting?.resolve(event.port);
        this.starting = null;
        this.emit('listening', event.port);
        return;
      case 'opened': {
        this.emit('session', { id: event.id, remotePort: event.remotePort });
        let destination: Destination | null = null;
        try {
          destination = this.options.resolveTarget?.(event.remotePort) ?? null;
        } catch (error) {
          this.emit('diagnostic', { id: event.id, message: `Target lookup failed: ${(error as Error).message}` });
        }
        this.send({ type: 'target', id: event.id, destination });
        return;
      }
      case 'routed':
        this.emit('routed', { id: event.id, host: event.host, port: event.port, restored: event.restored });
        return;
      case 'connected':
        this.emit('connected', { id: event.id, generation: event.generation });
        return;
      case 'packet': {
        const data = Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength);
        const packet: PacketEvent = { id: event.id, sequence: event.sequence, generation: event.generation,
          fromClient: event.fromClient, observeOnly: event.observeOnly, data };
        if (!packet.observeOnly && this.listenerCount('packet') === 0) {
          this.forward(packet.id, packet.sequence, packet.generation, data);
          return;
        }
        this.emit('packet', packet);
        return;
      }
      case 'closed':
        this.emit('closed', { id: event.id, by: event.by });
        return;
      case 'diagnostic':
        this.emit('diagnostic', { id: event.id, message: event.message });
        return;
      case 'fault':
        if (!event.id && !this.listening) this.failStart(new Error(event.message));
        this.emit('fault', { id: event.id, message: event.message });
        return;
      case 'module':
        this.emit('module', { moduleId: event.moduleId, id: event.id, message: event.message });
        return;
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/transport`
Expected: all PASS. If the worker fails to load with `ERR_UNKNOWN_FILE_EXTENSION` or `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, check `node -v` (≥ 22.18) and look for non-erasable syntax in the worker import graph. Fix the syntax; don't add a loader.

Run: `npm run check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(transport): network worker entry and ProxyHost

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Find, install and launch the game

**Files:**
- Create: `src/game/exaltFinder.ts`, `src/game/helperInstaller.ts`, `src/game/launcher.ts`
- Test: `src/game/__tests__/exaltFinder.test.ts`, `src/game/__tests__/helperInstaller.test.ts`

**Interfaces:**
- Produces:
  - `EXALT_EXE = 'RotMG Exalt.exe'`, `interface FinderEnv { env; home; exists(path); readText(path): string | null }`, `steamLibraries(vdf): string[]`, `exaltCandidates(f): string[]`, `findExaltDirs(f?): string[]`, `isExaltDir(dir, exists?): boolean`.
  - `HELPER_FILE = 'winhttp.dll'`, `BACKUP_FILE = 'winhttp.dll.realmtool-backup'`, `HELPER_MARKER = 'RealmTool-Helper/'`, `DEFAULT_HELPER_PATH: string`, `isRealmToolHelper(path): boolean`, `installHelper(gameDir, helperPath): InstallResult` (`{ status: 'installed' | 'updated' | 'unchanged'; backedUp: boolean; target: string }`, throws `Error` with an actionable message), `uninstallHelper(gameDir): 'removed' | 'restored' | 'not-installed' | 'foreign'`.
  - `launchExalt(gameDir, args?): number | undefined`.

- [ ] **Step 1: Write the failing tests**

`src/game/__tests__/exaltFinder.test.ts`:
```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXALT_EXE, exaltCandidates, findExaltDirs, steamLibraries, type FinderEnv } from '../exaltFinder.ts';

function finder(files: string[], texts: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}): FinderEnv {
  return { env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ...env }, home: 'C:\\Users\\me',
    exists: path => files.includes(path), readText: path => texts[path] ?? null };
}

describe('Exalt finder', () => {
  it('parses Steam library folders, unescaping backslashes', () => {
    const vdf = '"libraryfolders"\n{\n "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" }\n "1" { "path"\t\t"D:\\\\Games\\\\SteamLibrary" }\n}';
    expect(steamLibraries(vdf)).toEqual(['C:\\Program Files (x86)\\Steam', 'D:\\Games\\SteamLibrary']);
  });

  it('prefers ROTMG_PATH, then the Deca launcher install, then Steam libraries', () => {
    const deca = join('C:\\Users\\me\\AppData\\Local', 'RealmOfTheMadGod', 'Production');
    const custom = 'E:\\Exalt';
    const steam = join('D:\\Games\\SteamLibrary', 'steamapps', 'common', 'RotMG Exalt');
    const vdfPath = join('C:\\Program Files (x86)\\Steam', 'steamapps', 'libraryfolders.vdf');
    const f = finder([join(deca, EXALT_EXE), join(custom, EXALT_EXE), join(steam, EXALT_EXE)],
      { [vdfPath]: '"path" "D:\\\\Games\\\\SteamLibrary"' }, { ROTMG_PATH: custom });
    expect(findExaltDirs(f)).toEqual([custom, deca, steam]);
    expect(exaltCandidates(f)[0]).toBe(custom);
  });

  it('returns nothing when no candidate holds the exe', () => {
    expect(findExaltDirs(finder([]))).toEqual([]);
  });
});
```

`src/game/__tests__/helperInstaller.test.ts`:
```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_FILE, HELPER_FILE, installHelper, uninstallHelper } from '../helperInstaller.ts';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'realmtool-install-'));
  const game = join(root, 'game');
  const helper = join(root, 'helper.dll');
  writeFileSync(helper, 'MZ...RealmTool-Helper/1...v2');
  mkdirSync(game);
  return { game, helper, target: join(game, HELPER_FILE), backup: join(game, BACKUP_FILE) };
}

describe('helper installer', () => {
  it('installs into an empty game folder and is idempotent', () => {
    const s = setup();
    expect(installHelper(s.game, s.helper)).toEqual({ status: 'installed', backedUp: false, target: s.target });
    expect(installHelper(s.game, s.helper).status).toBe('unchanged');
  });

  it('backs up a foreign winhttp.dll and restores it on uninstall', () => {
    const s = setup();
    writeFileSync(s.target, 'MZ realm engine redirector');
    expect(installHelper(s.game, s.helper)).toMatchObject({ status: 'installed', backedUp: true });
    expect(readFileSync(s.backup, 'utf8')).toBe('MZ realm engine redirector');
    expect(uninstallHelper(s.game)).toBe('restored');
    expect(readFileSync(s.target, 'utf8')).toBe('MZ realm engine redirector');
    expect(existsSync(s.backup)).toBe(false);
  });

  it('upgrades an older RealmTool helper in place without a backup', () => {
    const s = setup();
    writeFileSync(s.target, 'MZ...RealmTool-Helper/1...v1');
    expect(installHelper(s.game, s.helper)).toMatchObject({ status: 'updated', backedUp: false });
    expect(existsSync(s.backup)).toBe(false);
  });

  it('refuses to clobber an existing backup', () => {
    const s = setup();
    writeFileSync(s.target, 'foreign');
    writeFileSync(s.backup, 'older foreign');
    expect(() => installHelper(s.game, s.helper)).toThrow(BACKUP_FILE);
  });

  it('refuses a helper build without the marker', () => {
    const s = setup();
    writeFileSync(s.helper, 'MZ something else');
    expect(() => installHelper(s.game, s.helper)).toThrow('marker');
  });

  it('never deletes a foreign DLL on uninstall', () => {
    const s = setup();
    writeFileSync(s.target, 'foreign');
    expect(uninstallHelper(s.game)).toBe('foreign');
    expect(readFileSync(s.target, 'utf8')).toBe('foreign');
    expect(uninstallHelper(join(s.game, 'missing'))).toBe('not-installed');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/game`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the finder, installer and launcher**

`src/game/exaltFinder.ts`:
```ts
// Search order adapted from realm-engine-client client/src/hooker/ExaltFinder.ts @ 9ab4f8f (MIT, see NOTICE).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const EXALT_EXE = 'RotMG Exalt.exe';

export interface FinderEnv {
  env: NodeJS.ProcessEnv;
  home: string;
  exists(path: string): boolean;
  readText(path: string): string | null;
}

const STEAM_ROOTS = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
const STEAM_GAME_FOLDERS = ['RotMG Exalt', 'Realm of the Mad God'];

function defaultFinder(): FinderEnv {
  return {
    env: process.env,
    home: homedir(),
    exists: existsSync,
    readText: path => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
  };
}

/** Library paths from Steam's libraryfolders.vdf. */
export function steamLibraries(vdf: string): string[] {
  const paths: string[] = [];
  for (const match of vdf.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)) paths.push(match[1].replace(/\\\\/g, '\\'));
  return paths;
}

export function exaltCandidates(f: FinderEnv): string[] {
  const local = f.env.LOCALAPPDATA || join(f.home, 'AppData', 'Local');
  const libraries = new Set<string>(STEAM_ROOTS);
  for (const root of STEAM_ROOTS) {
    const vdf = f.readText(join(root, 'steamapps', 'libraryfolders.vdf'));
    if (vdf) for (const library of steamLibraries(vdf)) libraries.add(library);
  }
  return [
    f.env.ROTMG_PATH ?? '',
    join(local, 'RealmOfTheMadGod', 'Production'),
    join(f.home, 'Documents', 'RealmOfTheMadGod', 'Production'),
    ...[...libraries].flatMap(library => STEAM_GAME_FOLDERS.map(game => join(library, 'steamapps', 'common', game))),
  ].filter(dir => dir.length > 0);
}

/** Every Exalt install on this machine, best first. */
export function findExaltDirs(f: FinderEnv = defaultFinder()): string[] {
  const found: string[] = [];
  for (const dir of exaltCandidates(f)) {
    if (!found.includes(dir) && f.exists(join(dir, EXALT_EXE))) found.push(dir);
  }
  return found;
}

export function isExaltDir(dir: string, exists: (path: string) => boolean = existsSync): boolean {
  return exists(join(dir, EXALT_EXE));
}
```

`src/game/helperInstaller.ts`:
```ts
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HELPER_FILE = 'winhttp.dll';
export const BACKUP_FILE = 'winhttp.dll.realmtool-backup';
/** Embedded in every helper build (native/helper/src/dllmain.cpp) so we never mistake a foreign DLL for ours. */
export const HELPER_MARKER = 'RealmTool-Helper/';
export const DEFAULT_HELPER_PATH = fileURLToPath(new URL('../../native/helper/bin/winhttp.dll', import.meta.url));

export type InstallStatus = 'installed' | 'updated' | 'unchanged';
export interface InstallResult {
  status: InstallStatus;
  backedUp: boolean;
  target: string;
}
export type UninstallStatus = 'removed' | 'restored' | 'not-installed' | 'foreign';

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export function isRealmToolHelper(path: string): boolean {
  try { return readFileSync(path).includes(HELPER_MARKER, 0, 'latin1'); } catch { return false; }
}

export function installHelper(gameDir: string, helperPath: string): InstallResult {
  if (!existsSync(helperPath)) throw new Error(`Helper DLL not found at ${helperPath}. Run "npm run build:helper" first.`);
  if (!isRealmToolHelper(helperPath)) throw new Error(`${helperPath} is not a RealmTool helper build (marker missing).`);
  const target = join(gameDir, HELPER_FILE);
  const backup = join(gameDir, BACKUP_FILE);
  let status: InstallStatus = 'installed';
  let backedUp = false;
  if (existsSync(target)) {
    if (sha256(target) === sha256(helperPath)) return { status: 'unchanged', backedUp: false, target };
    if (isRealmToolHelper(target)) {
      status = 'updated';
    } else {
      if (existsSync(backup)) {
        throw new Error(`${target} is not RealmTool's and ${BACKUP_FILE} already exists. Move one of them aside and retry.`);
      }
      try { renameSync(target, backup); } catch (error) {
        throw new Error(`Could not back up ${target} (is the game running?): ${(error as Error).message}`);
      }
      backedUp = true;
    }
  }
  try { copyFileSync(helperPath, target); } catch (error) {
    throw new Error(`Could not write ${target} (is the game running?): ${(error as Error).message}`);
  }
  return { status, backedUp, target };
}

export function uninstallHelper(gameDir: string): UninstallStatus {
  const target = join(gameDir, HELPER_FILE);
  const backup = join(gameDir, BACKUP_FILE);
  if (!existsSync(target)) return 'not-installed';
  if (!isRealmToolHelper(target)) return 'foreign';
  unlinkSync(target);
  if (existsSync(backup)) {
    renameSync(backup, target);
    return 'restored';
  }
  return 'removed';
}
```

`src/game/launcher.ts`:
```ts
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { EXALT_EXE } from './exaltFinder.ts';

/** Start Exalt detached from RealmTool's lifetime. Returns the PID when the OS reports one. */
export function launchExalt(gameDir: string, args: string[] = []): number | undefined {
  const child = spawn(join(gameDir, EXALT_EXE), args, { cwd: gameDir, detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(game): find Exalt (incl. Steam libraries), install helper safely, launch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Native helper v1 (routing only)

**Files:**
- Create: `native/helper/src/dllmain.cpp`, `native/helper/build.cmd`, `tools/verify-helper.ts`
- Create (ported): `native/helper/src/connect_hook.cpp`, `native/helper/src/connect_hook.h`, `native/helper/src/forwarders.g.h`, `native/helper/gen_forwarders.ps1`, `native/helper/vendor/minhook/**`

**Interfaces:**
- Consumes: `TARGET_FILE_PREFIX` contract (`%TEMP%\realmtool_target_<pid>.txt`), `HELPER_MARKER` (`RealmTool-Helper/`).
- Produces: `native/helper/bin/winhttp.dll` (x64). It forwards every real winhttp export, hooks `ws2_32!connect` 3 s after load, and contains the marker string `RealmTool-Helper/1`.

- [ ] **Step 1: Copy sources and MinHook**

```bash
REC=../realm-engine-client
mkdir -p native/helper/src native/helper/vendor
cp "$REC/client/winhttp-proxy/src/connect_hook.cpp" "$REC/client/winhttp-proxy/src/connect_hook.h" \
   "$REC/client/winhttp-proxy/src/forwarders.g.h" native/helper/src/
cp "$REC/client/winhttp-proxy/gen_forwarders.ps1" native/helper/
cp -r "$REC/internal/vendor/minhook" native/helper/vendor/minhook
ls native/helper/vendor/minhook native/helper/vendor/minhook/hde
```
Expected: `MinHook.h buffer.c buffer.h hde hook.c trampoline.c trampoline.h`, plus `hde64.c` etc.

- [ ] **Step 2: Rewrite RecordOriginalTarget**

In `native/helper/src/connect_hook.cpp`, add `// Ported from realm-engine-client client/winhttp-proxy/src/connect_hook.cpp @ 9ab4f8f (MIT, see NOTICE).` as line 1. Then replace the whole `RecordOriginalTarget` function with:
```cpp
// %TEMP%\realmtool_target_<pid>.txt - read and deleted by src/routing/targetResolver.ts.
void RecordOriginalTarget(const char* ipDottedQuad) {
    char tmpDir[MAX_PATH];
    DWORD n = GetTempPathA(MAX_PATH, tmpDir);
    if (n == 0 || n >= MAX_PATH) return;

    char path[MAX_PATH];
    _snprintf_s(path, sizeof(path), _TRUNCATE,
                "%srealmtool_target_%lu.txt", tmpDir, GetCurrentProcessId());
    WriteWholeFile(path, ipDottedQuad);
}
```
Run: `grep -n "rotmg_proxy_target" native/helper/src/*.cpp || echo clean`
Expected: `clean`.

- [ ] **Step 3: Write dllmain.cpp (no splash bypass, with marker)**

`native/helper/src/dllmain.cpp`:
```cpp
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include "forwarders.g.h"
#include "connect_hook.h"

// src/game/helperInstaller.ts looks for this string to tell our build from any other winhttp.dll.
extern "C" __declspec(dllexport) const char RealmToolHelperMarker[] = "RealmTool-Helper/1";

static DWORD WINAPI InitThread(LPVOID) {
    // Avoid MinHook's thread suspension while Unity is inside il2cpp_init.
    Sleep(3000);
    InstallConnectHook();
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved) {
    switch (reason) {
        case DLL_PROCESS_ATTACH: {
            DisableThreadLibraryCalls(hinst);
            HANDLE thread = CreateThread(nullptr, 0, InitThread, nullptr, 0, nullptr);
            if (thread) CloseHandle(thread);
            break;
        }
        case DLL_PROCESS_DETACH:
            // reserved != NULL: the process is exiting; unhooking under the loader lock is unsafe and pointless.
            if (reserved) break;
            RemoveConnectHook();
            break;
        default:
            break;
    }
    return TRUE;
}
```

- [ ] **Step 4: Write build.cmd**

`native/helper/build.cmd`:
```bat
@echo off
setlocal
set "ROOT=%~dp0"

if /I "%VSCMD_ARG_TGT_ARCH%"=="x64" goto build
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo [helper] vswhere.exe not found. Install Visual Studio 2022 with "Desktop development with C++".
  exit /b 1
)
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
if not defined VSINSTALL (
  echo [helper] No Visual Studio install with x64 C++ tools found.
  exit /b 1
)
call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1

:build
set "MH=%ROOT%vendor\minhook"
if not exist "%ROOT%bin" mkdir "%ROOT%bin"
if not exist "%ROOT%obj" mkdir "%ROOT%obj"
cl /nologo /LD /O2 /MT /W3 /EHsc /std:c++17 ^
   /D_WIN32_WINNT=0x0A00 /DWIN32_LEAN_AND_MEAN ^
   /I "%ROOT%src" /I "%MH%" ^
   "%ROOT%src\dllmain.cpp" "%ROOT%src\connect_hook.cpp" ^
   "%MH%\hook.c" "%MH%\buffer.c" "%MH%\trampoline.c" "%MH%\hde\hde64.c" ^
   /Fo"%ROOT%obj\\" /Fe"%ROOT%bin\winhttp.dll" ^
   /link /DLL ws2_32.lib user32.lib
if errorlevel 1 exit /b 1
echo [helper] Built %ROOT%bin\winhttp.dll
```

- [ ] **Step 5: Write the verifier**

`tools/verify-helper.ts`:
```ts
import { readFileSync, statSync } from 'node:fs';
import { DEFAULT_HELPER_PATH, HELPER_MARKER } from '../src/game/helperInstaller.ts';

const path = process.argv[2] ?? DEFAULT_HELPER_PATH;
const bytes = readFileSync(path);
const size = statSync(path).size;
const problems: string[] = [];
if (bytes.readUInt16LE(0) !== 0x5a4d) problems.push('not a PE file (missing MZ)');
if (!bytes.includes(HELPER_MARKER, 0, 'latin1')) problems.push(`marker "${HELPER_MARKER}" missing`);
if (!bytes.includes('C:\\Windows\\System32\\winhttp.dll.WinHttpOpen', 0, 'latin1')) problems.push('winhttp export forwarders missing');
if (size > 200 * 1024) problems.push(`size ${size} bytes exceeds the 200 KiB budget`);
if (problems.length) {
  console.error(`verify-helper: ${path}\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`verify-helper: OK (${path}, ${(size / 1024).toFixed(1)} KiB)`);
```

- [ ] **Step 6: Build and verify**

Run: `npm run build:helper`
Expected: `[helper] Built ...\native\helper\bin\winhttp.dll`

Run: `npm run verify:helper`
Expected: `verify-helper: OK (... KiB)`. If the forwarder check fails, open `native/helper/src/forwarders.g.h` and confirm it uses `C:\\Windows\\System32\\winhttp.dll.` targets. Regenerate with `powershell -ExecutionPolicy Bypass -File native/helper/gen_forwarders.ps1` if needed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(native): routing-only helper DLL with RealmTool marker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: CLI and live smoke test

**Files:**
- Create: `src/cli.ts`
- Test: `src/__tests__/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `parseCli(argv): CliOptions` (`{ command: 'start' | 'find-game' | 'install-helper' | 'uninstall-helper' | 'help'; gameDir?: string; helper: string; fallback?: string; launch: boolean; port: number }`; throws on bad input), `main(argv): Promise<number>`, `HELP: string`.

- [ ] **Step 1: Write the failing test**

`src/__tests__/cli.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseCli } from '../cli.ts';
import { DEFAULT_HELPER_PATH } from '../game/helperInstaller.ts';

describe('parseCli', () => {
  it('defaults to help', () => {
    expect(parseCli([]).command).toBe('help');
    expect(parseCli(['start', '--help']).command).toBe('help');
  });

  it('parses start options', () => {
    expect(parseCli(['start', '--game-dir', 'D:\\Exalt', '--no-launch', '--fallback', '54.86.47.176', '--port', '2051']))
      .toEqual({ command: 'start', gameDir: 'D:\\Exalt', helper: DEFAULT_HELPER_PATH, fallback: '54.86.47.176', launch: false, port: 2051 });
    expect(parseCli(['start'])).toMatchObject({ launch: true, port: 2050, fallback: undefined });
  });

  it('rejects bad input with a clear message', () => {
    expect(() => parseCli(['launch'])).toThrow('Unknown command "launch"');
    expect(() => parseCli(['start', '--port', '99999'])).toThrow('--port');
    expect(() => parseCli(['start', '--fallback', 'usw.example.com'])).toThrow('--fallback');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/__tests__/cli.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the CLI**

`src/cli.ts`:
```ts
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findExaltDirs, isExaltDir } from './game/exaltFinder.ts';
import { DEFAULT_HELPER_PATH, installHelper, uninstallHelper } from './game/helperInstaller.ts';
import { launchExalt } from './game/launcher.ts';
import { GAME_PORT } from './protocol/constants.ts';
import { loadSchema } from './protocol/schema.ts';
import { createTargetResolver, parseTargetFile, removeStaleTargetFiles } from './routing/targetResolver.ts';
import { ProxyHost } from './transport/host.ts';
import { log } from './util/log.ts';

const COMMANDS = ['start', 'find-game', 'install-helper', 'uninstall-helper', 'help'] as const;
type Command = typeof COMMANDS[number];

export interface CliOptions {
  command: Command;
  gameDir?: string;
  helper: string;
  fallback?: string;
  launch: boolean;
  port: number;
}

export const HELP = `Usage: realmtool <command> [options]

Commands:
  start              Install the helper, launch Exalt and run the proxy (Ctrl+C to stop)
  find-game          List detected Exalt install folders
  install-helper     Copy the helper DLL into the game folder
  uninstall-helper   Remove the helper DLL and restore any backed-up winhttp.dll

Options:
  --game-dir <dir>   Exalt "Production" folder (default: auto-detect)
  --helper <file>    Helper DLL to install (default: native/helper/bin/winhttp.dll)
  --fallback <ip>    Server to use when the helper recorded none
  --no-launch        start: don't launch the game
  --port <n>         Listen port (default ${GAME_PORT})
  -h, --help         Show this help
`;

export function parseCli(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'game-dir': { type: 'string' },
      helper: { type: 'string' },
      fallback: { type: 'string' },
      'no-launch': { type: 'boolean', default: false },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const requested = values.help ? 'help' : (positionals[0] ?? 'help');
  if (!(COMMANDS as readonly string[]).includes(requested)) throw new Error(`Unknown command "${requested}". Run "realmtool help".`);
  const port = values.port === undefined ? GAME_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0-65535, got ${values.port}`);
  if (values.fallback !== undefined && parseTargetFile(values.fallback) === null) {
    throw new Error(`--fallback must be a public IPv4 address, got ${values.fallback}`);
  }
  return {
    command: requested as Command,
    gameDir: values['game-dir'],
    helper: values.helper ?? DEFAULT_HELPER_PATH,
    fallback: values.fallback,
    launch: !values['no-launch'],
    port,
  };
}

function resolveGameDir(options: CliOptions): string | null {
  if (options.gameDir) return isExaltDir(options.gameDir) ? options.gameDir : null;
  return findExaltDirs()[0] ?? null;
}

async function start(options: CliOptions, gameDir: string): Promise<number> {
  const installed = installHelper(gameDir, options.helper);
  log.info('Helper', `${installed.status} at ${installed.target}${installed.backedUp ? ' (previous winhttp.dll backed up)' : ''}`);
  const stale = removeStaleTargetFiles();
  if (stale) log.info('Helper', `Removed ${stale} stale target file(s)`);

  const host = new ProxyHost({
    schema: loadSchema(),
    listenPort: options.port,
    fallbackDestination: options.fallback ? { host: options.fallback, port: GAME_PORT } : null,
    resolveTarget: createTargetResolver({ proxyPort: options.port }),
  });
  host.on('session', ({ id, remotePort }) => log.info('Proxy', `Game connected (${id.slice(0, 8)}, port ${remotePort})`));
  host.on('routed', ({ id, host: server, port, restored }) =>
    log.info('Proxy', `${id.slice(0, 8)} → ${server}:${port}${restored ? ' (transfer)' : ''}`));
  host.on('closed', ({ id, by }) => log.info('Proxy', `${id.slice(0, 8)} closed by ${by}`));
  host.on('diagnostic', ({ id, message }) => log.warn('Proxy', `${id ? `${id.slice(0, 8)}: ` : ''}${message}`));
  host.on('fault', ({ id, message }) => log.error('Proxy', `${id ? `${id.slice(0, 8)}: ` : ''}${message}`));

  const port = await host.start();
  log.info('Proxy', `Listening on 127.0.0.1:${port}`);
  if (options.launch) {
    const pid = launchExalt(gameDir);
    log.info('Game', `Launched Exalt${pid ? ` (pid ${pid})` : ''}`);
  }
  await new Promise<void>(resolve => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  log.info('Proxy', 'Stopping…');
  await host.stop();
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  if (options.command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (options.command === 'find-game') {
    const dirs = findExaltDirs();
    console.log(dirs.length ? dirs.join('\n') : 'No Exalt install found. Pass --game-dir or set ROTMG_PATH.');
    return dirs.length ? 0 : 1;
  }
  const gameDir = resolveGameDir(options);
  if (!gameDir) {
    log.error('Game', options.gameDir
      ? `"${options.gameDir}" does not contain RotMG Exalt.exe`
      : 'No Exalt install found. Pass --game-dir or set ROTMG_PATH.');
    return 1;
  }
  try {
    if (options.command === 'install-helper') {
      const result = installHelper(gameDir, options.helper);
      log.info('Helper', `${result.status} at ${result.target}${result.backedUp ? ' (previous winhttp.dll backed up)' : ''}`);
      return 0;
    }
    if (options.command === 'uninstall-helper') {
      log.info('Helper', `${uninstallHelper(gameDir)} (${gameDir})`);
      return 0;
    }
    return await start(options, gameDir);
  } catch (error) {
    log.error('RealmTool', (error as Error).message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
```

- [ ] **Step 4: Run tests**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 5: Live smoke test (manual, needs the game)**

1. Close Exalt and Realm Engine.
2. Run: `node src/cli.ts find-game`. Expected: your Production folder.
3. Run: `npm start`. Expected logs, in order: `Helper installed …` (or `backed up` if Realm Engine's DLL was there), `Listening on 127.0.0.1:2050`, `Launched Exalt`.
4. Log in. Expected: `Game connected …` then `… → <server ip>:2050`. If you see `No destination for this connection`, the helper didn't record a target. Check that `%TEMP%\realmtool_target_<pid>.txt` appears when you connect.
5. Enter a realm, then a dungeon, then Nexus. Expected for each: a `(transfer)` routed line, and gameplay is normal.
6. Leave it idle for 2 minutes, then move around. No disconnects.
7. Ctrl+C. Expected: `Stopping…` and the game disconnects.
8. Run: `node src/cli.ts uninstall-helper`. Expected: `restored` if a backup existed, else `removed`.

Record the game build version, the results of steps 4–7 and any log anomalies in the PR description.

- [ ] **Step 6: Commit and open the Phase 1 PR**

```bash
git add -A
git commit -m "feat(cli): realmtool start/find-game/install-helper/uninstall-helper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin HEAD
gh pr create --repo DaAwesomePwner/RealmTool --base main --title "Phase 1: pass-through proxy" --body "Implements docs/superpowers/plans/2026-10-03-phase1-passthrough-proxy.md. Smoke test results: <fill from Step 5>.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Phase 1 exit criteria

- `npm run check` passes locally and in CI (`windows-latest`).
- `npm run verify:helper` passes.
- The live smoke test passes: login, realm, dungeon and Nexus transfers, idle, stop, uninstall.
- No file in `src/` imports from `realm-engine-client` at runtime. Ported files carry provenance headers.
