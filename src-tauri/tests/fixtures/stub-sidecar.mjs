import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const token = process.env.REALMTOOL_API_TOKEN;
delete process.env.REALMTOOL_API_TOKEN;
if (!token || !process.env.REALMTOOL_RESOURCES || process.env.REALMTOOL_UI_ORIGINS !== 'http://tauri.localhost') process.exit(2);
const mode = process.argv[3];
if (mode === 'print-pid-then-ready') console.log(`PID ${process.pid}`);
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}` || req.headers.host !== `127.0.0.1:${server.address().port}`) {
    res.writeHead(401).end();
    return;
  }
  if (req.url === '/api/shutdown' && req.method === 'POST' && req.headers['content-type'] === 'application/json') {
    res.end('{}');
    if (mode !== 'ignore') server.close(() => process.exit(0));
  } else if (req.url === '/api/state') {
    res.end(JSON.stringify({ proxy: { state: 'running' } }));
  } else res.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => {
  console.log('discard this startup output');
  console.error('discard stderr too');
  if (mode === 'spawn-grandchild') {
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { detached: true, stdio: 'ignore' });
    grandchild.unref();
    writeFileSync(process.argv[4], String(grandchild.pid));
    console.log(`GRANDCHILD ${grandchild.pid}`);
  }
  if (mode !== 'no-ready') console.log(`REALMTOOL_READY ${JSON.stringify({ port: server.address().port })}`);
});
process.stdin.resume();
process.stdin.on('end', () => { if (mode !== 'ignore') process.exit(0); });
