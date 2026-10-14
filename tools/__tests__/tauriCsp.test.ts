import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('allows Tauri IPC and loopback backend connections without loosening other directives', () => {
  const config = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const directives = Object.fromEntries(config.app.security.csp.split(';').map((directive: string) => {
    const [name, ...sources] = directive.trim().split(/\s+/);
    return [name, sources];
  }));
  expect(directives).toEqual({
    'default-src': ["'self'"],
    'connect-src': ['http://127.0.0.1:*', 'ws://127.0.0.1:*', 'ipc:', 'http://ipc.localhost'],
    'img-src': ["'self'", 'data:'],
    'style-src': ["'self'"],
    'script-src': ["'self'"],
  });
});
