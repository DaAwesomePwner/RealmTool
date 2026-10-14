import { bounded, type Cdp, type CdpEvent } from './cdp.ts';

/** Node's built-in WebSocket, with bounded commands and disconnect rejection. */
export async function connect(url: string, socket = new WebSocket(url), timeoutMs = 5000): Promise<Cdp> {
  let sequence = 0;
  const listeners = new Set<(event: CdpEvent) => void>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let disconnected: Error | undefined;
  const fail = (error: Error) => {
    disconnected = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.addEventListener('close', () => fail(new Error('CDP WebSocket closed')));
  socket.addEventListener('error', () => fail(new Error('CDP WebSocket failed')));
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === 'number') {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request?.reject(new Error(`CDP: ${message.error.message}`));
        else request?.resolve(message.result);
      } else for (const listener of listeners) listener(message);
    } catch { fail(new Error('Invalid CDP message')); }
  });
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
      socket.addEventListener('close', () => reject(new Error('CDP closed before opening')), { once: true });
    }), timeoutMs, 'CDP connection');
  } catch (error) { socket.close(); throw error; }
  return {
    async send(method, params = {}) {
      if (disconnected) throw disconnected;
      const id = ++sequence;
      try {
        return await bounded(new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
        }), timeoutMs, method);
      } finally { pending.delete(id); }
    },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { fail(new Error('CDP client closed')); listeners.clear(); socket.close(); },
  };
}
