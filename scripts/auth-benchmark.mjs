// Run inside the database-enabled server pod via stdin; creates and removes its own accounts.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import mysql from 'mysql2/promise';

const count = 32, concurrency = 4;
const prefix = `bench_${Date.now().toString(36)}_`;
const usernames = Array.from({ length: count }, (_, i) => `${prefix}${i}`);
const password = randomBytes(24).toString('base64url');
const samples = { REGISTER: [], LOGIN: [], RESTORE: [] };
const sockets = [];
let sequence = 0, next = 0;
async function connect() {
  const socket = new WebSocket('ws://127.0.0.1:3000'); sockets.push(socket);
  await once(socket, 'open'); return socket;
}
function request(socket, type, data, sample = type) {
  return new Promise((resolve, reject) => {
    const requestId = `auth-benchmark-${++sequence}`, started = performance.now();
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`${type} timeout`)); }, 8000);
    const cleanup = () => { clearTimeout(timeout); socket.off('message', receive); };
    const receive = (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'ERROR') { cleanup(); reject(new Error(message.data.code)); }
      else if (message.type === 'AUTH_OK' && message.requestId === requestId) { cleanup(); samples[sample].push(performance.now() - started); resolve(message.data); }
    };
    socket.on('message', receive);
    socket.send(JSON.stringify({ type, requestId, data }));
  });
}
const database = await mysql.createConnection({ host: process.env.SKILLLUDO_DB_HOST, port: Number(process.env.SKILLLUDO_DB_PORT ?? 3306), user: process.env.SKILLLUDO_DB_USER, password: process.env.SKILLLUDO_DB_PASSWORD, database: process.env.SKILLLUDO_DB_NAME });
const start = performance.now();
try {
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < count) {
      const username = usernames[next++];
      const socket = await connect();
      const registered = await request(socket, 'REGISTER', { username, password });
      const loggedIn = await request(socket, 'LOGIN', { username, password });
      assert.equal(registered.playerId, loggedIn.playerId);
      socket.close();
      const fresh = await connect();
      const restored = await request(fresh, 'AUTH', { sessionId: loggedIn.sessionId }, 'RESTORE');
      assert.equal(restored.playerId, loggedIn.playerId);
      fresh.close();
    }
  }));
  const report = { accounts: count, concurrency, durationSeconds: Number(((performance.now() - start) / 1000).toFixed(2)), latencyMs: {} };
  for (const [operation, values] of Object.entries(samples)) {
    values.sort((a, b) => a - b);
    report.latencyMs[operation] = { count: values.length, p50: Number(values[Math.floor(values.length * .5)].toFixed(2)), p95: Number(values[Math.floor(values.length * .95)].toFixed(2)), max: Number(values.at(-1).toFixed(2)) };
  }
  console.log(JSON.stringify(report));
} finally {
  sockets.forEach((socket) => socket.close());
  // Exact generated names, parameterized; foreign keys remove only these accounts' profiles/sessions.
  for (const username of usernames) await database.execute('DELETE FROM users WHERE username = ?', [username]);
  const [rows] = await database.execute('SELECT COUNT(*) AS remaining FROM users WHERE username IN (' + usernames.map(() => '?').join(',') + ')', usernames);
  assert.equal(rows[0].remaining, 0);
  await database.end();
  console.log('Temporary benchmark accounts removed.');
}
