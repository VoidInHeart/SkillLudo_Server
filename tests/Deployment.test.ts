import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { GameWebSocketServer } from '../src/network/WebSocketServer.js';

test('D01: readiness reflects database failure without exposing the error; liveness remains available', async () => {
  let databaseReady = true;
  const server = new GameWebSocketServer(0, undefined, async () => { if (!databaseReady) throw new Error('sensitive database details'); });
  try {
    await server.ready;
    const endpoint = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${endpoint}/readyz`)).status, 200);
    databaseReady = false;
    const failed = await fetch(`${endpoint}/readyz`);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json() as {status: string}).status, 'unavailable');
    assert.equal((await fetch(`${endpoint}/healthz`)).status, 200);
    assert.equal((await fetch(`${endpoint}/unknown`)).status, 404);
  } finally { await server.close(); }
});

test('D02: shutdown closes an active WebSocket with restart code and is idempotent', { timeout: 8000 }, async () => {
  const server = new GameWebSocketServer(0);
  await server.ready;
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  try {
    await once(socket, 'open');
    const closed = once(socket, 'close');
    await Promise.all([server.close(), server.close()]);
    assert.equal((await closed)[0], 1012);
  } finally { socket.terminate(); await server.close(); }
});

test('D03: oversized WebSocket messages are rejected before application parsing', async () => {
  const server = new GameWebSocketServer(0);
  await server.ready;
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  try {
    await once(socket, 'open');
    const closed = once(socket, 'close');
    socket.send('x'.repeat(16 * 1024 + 1));
    assert.equal((await closed)[0], 1009);
  } finally { socket.terminate(); await server.close(); }
});
