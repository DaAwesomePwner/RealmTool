import net from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { Session } from '../session.ts';
import { Interest } from '../interest.ts';
import { DEFAULTS } from '../messages.ts';
import { Router } from '../../routing/router.ts';
import { createFactory } from '../../protocol/schema.ts';
import { RC4_KEYS } from '../../protocol/constants.ts';
import { RC4Cipher } from '../../protocol/RC4Cipher.ts';
import { helloBytes } from '../../testing/wire.ts';

const sessions: Session[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });
function fixture() {
  const factory = createFactory();
  const socket = new net.Socket();
  const cipher = new RC4Cipher(RC4_KEYS.clientToServer);
  let now = 0;
  const times: (number | undefined)[] = [];
  const session = new Session('timestamps', socket, {
    factory, router: new Router(), interest: new Interest(),
    now: () => now, post: () => {}, onClosed: () => {},
    ...DEFAULTS, fallbackDestination: null,
    modules: [{ id: 'timestamp-test', priority: 0, observe: { client: ['PLAYERTEXT'] },
      createSession: () => ({ observe(_p, _from, _now, _id, receivedAt) {
        times.push(receivedAt); now += 5; // Processing one frame must not change the next frame's chunk time.
      } }) }],
  });
  sessions.push(session);
  const hello = helloBytes(factory, Buffer.alloc(0)); cipher.cipher(hello);
  socket.emit('data', hello); // HELLO stays held while target lookup is outstanding.
  function frame() {
    const packet = factory.createByName('PLAYERTEXT'); packet.data.text = 'hello';
    const bytes = factory.serialize(packet); cipher.cipher(bytes); return bytes;
  }
  return { frame, times, chunk: (bytes: Buffer, at: number) => { now = at; socket.emit('data', bytes); } };
}
it('gives all frames in one chunk the data-event timestamp', () => {
  const f = fixture(); f.chunk(Buffer.concat([f.frame(), f.frame(), f.frame()]), 100);
  expect(f.times).toEqual([100, 100, 100]);
});
it.each([2, 3])('retains first-byte time across %i chunks', parts => {
  const f = fixture(), frame = f.frame();
  f.chunk(frame.subarray(0, 2), 100);
  expect(f.times).toEqual([]);
  if (parts === 3) { f.chunk(frame.subarray(2, 5), 200); expect(f.times).toEqual([]); }
  f.chunk(frame.subarray(parts === 3 ? 5 : 2), 300);
  expect(f.times).toEqual([100]);
});
it('keeps separate times when a chunk completes a partial frame and starts another', () => {
  const f = fixture(), first = f.frame(), second = f.frame(), third = f.frame();
  f.chunk(first.subarray(0, 2), 100);
  f.chunk(Buffer.concat([first.subarray(2), second, third.subarray(0, 3)]), 200);
  expect(f.times).toEqual([100, 200]);
  f.chunk(third.subarray(3), 300);
  expect(f.times).toEqual([100, 200, 200]);
});
