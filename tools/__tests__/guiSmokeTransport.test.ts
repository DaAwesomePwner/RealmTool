import { afterEach, expect, it, vi } from 'vitest';
import { connect } from '../gui-smoke/transport.ts';

afterEach(() => vi.useRealTimers());
class Socket extends EventTarget {
  send = vi.fn();
  close = vi.fn(() => this.dispatchEvent(new Event('close')));
  reply(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
async function connected(timeout = 500) {
  const socket = new Socket();
  const connecting = connect('ws://127.0.0.1:9241/page', socket as unknown as WebSocket, timeout);
  socket.dispatchEvent(new Event('open'));
  return { socket, cdp: await connecting };
}

it('correlates out-of-order replies and forwards events', async () => {
  const { socket, cdp } = await connected(); const event = vi.fn(); cdp.onEvent(event);
  const first = cdp.send('Runtime.enable'); const second = cdp.send('Page.enable');
  socket.reply({ id: 2, result: { second: true } }); socket.reply({ id: 1, result: {} });
  expect(await second).toEqual({ second: true }); expect(await first).toEqual({});
  socket.reply({ method: 'Runtime.exceptionThrown', params: {} });
  expect(event).toHaveBeenCalledWith({ method: 'Runtime.exceptionThrown', params: {} }); cdp.close();
});

it('reports protocol errors and rejects commands on disconnect', async () => {
  const { socket, cdp } = await connected();
  const failure = expect(cdp.send('Page.enable')).rejects.toThrow('unsupported');
  socket.reply({ id: 1, error: { message: 'unsupported' } }); await failure;
  const lost = expect(cdp.send('Runtime.enable')).rejects.toThrow('closed'); socket.close(); await lost;
  await expect(cdp.send('Log.enable')).rejects.toThrow('closed');
});

it('bounds unresponsive commands and releases the socket', async () => {
  vi.useFakeTimers(); const { socket, cdp } = await connected();
  const result = expect(cdp.send('Runtime.evaluate')).rejects.toThrow('Timed out waiting for Runtime.evaluate');
  await vi.advanceTimersByTimeAsync(500); await result; cdp.close(); expect(socket.close).toHaveBeenCalledOnce();
});

it('bounds connection startup and closes a socket that never opens', async () => {
  vi.useFakeTimers(); const socket = new Socket();
  const result = expect(connect('ws://unused', socket as unknown as WebSocket, 500)).rejects.toThrow('CDP connection');
  await vi.advanceTimersByTimeAsync(500); await result; expect(socket.close).toHaveBeenCalledOnce();
});
