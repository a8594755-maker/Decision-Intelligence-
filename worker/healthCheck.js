/**
 * healthCheck.js — Simple HTTP health endpoint for the worker process.
 *
 * GET /healthz → 200 OK (worker is alive)
 * GET /readyz  → 200 OK if actively polling, 503 if stopped
 */

import { createServer } from 'node:http';

let _ready = false;

export function setReady(val) { _ready = !!val; }

export function startHealthServer(port = 9100) {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
    } else if (req.url === '/readyz') {
      const code = _ready ? 200 : 503;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: _ready, pid: process.pid }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    console.log(`[Worker] Health check listening on http://localhost:${port}/healthz`);
  });

  return server;
}
