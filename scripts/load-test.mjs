import WebSocket from 'ws';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

// Opt-in load tool. Four real connections per room; never uses forced dice or AI trustees.
const url = process.env.LOAD_URL ?? 'ws://127.0.0.1:3000';
const roomCount = Number(process.env.LOAD_ROOMS ?? 25);
const duration = Number(process.env.LOAD_SECONDS ?? 60);
const pace = Number(process.env.LOAD_STEP_MS ?? 700);
if (![roomCount, duration, pace].every(Number.isFinite) || roomCount < 1 || roomCount > 1000 || duration < 5 || duration > 600 || pace < 100) throw new Error('Invalid bounded load parameters');
const run = `load-${Date.now()}`;
const peers = [], rooms = [], latencies = [], errors = [];
let requestSequence = 0, commands = 0, bytesIn = 0, bytesOut = 0, messagesIn = 0, failedRooms = 0;
let measuring = false;
class Peer {
  pending = new Map();
  constructor() {
    this.socket = new WebSocket(url);
    peers.push(this);
    this.socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (measuring) { bytesIn += Buffer.byteLength(raw); messagesIn++; }
      const pending = this.pending.get(message.requestId);
      if (message.type === 'ERROR') {
        if (pending) { pending.finish(); pending.reject(new Error(message.data.code)); }
        else errors.push(message.data.code);
      } else if (pending && message.type === pending.expected) {
        pending.finish();
        if (measuring) { latencies.push(performance.now() - pending.started); commands++; }
        pending.resolve(message.data);
      }
    });
    this.socket.on('error', () => {});
    this.socket.on('close', () => { for (const entry of this.pending.values()) { entry.finish(); entry.reject(new Error('closed')); } });
  }
  async open() {
    const timeout = setTimeout(() => this.socket.terminate(), 8000);
    try { await once(this.socket, 'open'); } finally { clearTimeout(timeout); }
    const auth = await this.request('AUTH', { guestId: `${run}-${peers.length}` }, 'AUTH_OK');
    this.id = auth.playerId;
  }
  request(type, data, expected) {
    return new Promise((resolve, reject) => {
      const requestId = `${run}-${++requestSequence}`;
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${type} timeout`)); }, 8000);
      const finish = () => { clearTimeout(timer); this.pending.delete(requestId); };
      this.pending.set(requestId, { expected, started: performance.now(), resolve, reject, finish });
      const message = JSON.stringify({ type, requestId, data });
      if (measuring) bytesOut += Buffer.byteLength(message);
      this.socket.send(message);
    });
  }
}
async function createRoom() {
  const players = [];
  for (let seat = 0; seat < 4; seat++) { const peer = new Peer(); await peer.open(); players.push(peer); }
  const { roomId } = await players[0].request('CREATE_ROOM', {}, 'ROOM_CREATED');
  const room = { roomId, players, snapshot: null }; rooms.push(room);
  for (const peer of players.slice(1)) await peer.request('JOIN_ROOM', { roomId }, 'GAME_STATE');
  for (const peer of players) await peer.request('READY', { roomId }, 'PLAYER_READY_CHANGED');
  room.snapshot = await players[0].request('START_GAME', { roomId }, 'GAME_START');
}
async function play(room, end) {
  const { roomId, players } = room;
  let lastPing = 0;
  try {
    await delay(Math.random() * pace);
    while (performance.now() < end) {
      if (performance.now() - lastPing > 10_000) {
        await Promise.all(players.map((peer) => peer.request('PING', {}, 'PONG')));
        lastPing = performance.now();
      }
      const state = room.snapshot;
      if (state.roomStatus !== 'PLAYING' || state.phase === 'GAME_OVER') { await delay(pace); continue; }
      const peer = players.find((candidate) => candidate.id === state.currentPlayerId);
      if (!peer) throw new Error('Unexpected current player');
      if (state.phase === 'WAIT_ROLL') await peer.request('ROLL_DICE', { roomId }, 'DICE_RESULT');
      else if (state.phase === 'WAIT_SELECT_DIE') await peer.request('SELECT_DIE', { roomId, dieIndex: state.diceChoices[1] > state.diceChoices[0] ? 1 : 0, rollId: state.rollId }, 'DIE_SELECTED');
      else if (state.phase === 'WAIT_SELECT_PIECE') await peer.request('SELECT_PIECE', { roomId, pieceId: state.movablePieceIds[0], rollId: state.rollId }, 'MOVE_RESULT');
      room.snapshot = await peer.request('RECONNECT', { roomId }, 'GAME_STATE');
      await delay(pace);
    }
  } catch (error) { failedRooms++; errors.push(error.message); }
}
const rampStart = performance.now();
try {
  // Bound login/setup concurrency and keep existing sockets alive during ramp-up.
  const heartbeat = setInterval(() => { for (const peer of peers) if (peer.id && peer.socket.readyState === 1) void peer.request('PING', {}, 'PONG').catch(() => {}); }, 15_000);
  try { for (let index = 0; index < roomCount; index++) await createRoom(); }
  finally { clearInterval(heartbeat); }
  const started = performance.now();
  const rampSeconds = (started - rampStart) / 1000;
  measuring = true;
  await Promise.all(rooms.map((room) => play(room, started + duration * 1000)));
  measuring = false;
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const percentile = (p) => Number((latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0).toFixed(2));
  const result = { timestamp: new Date().toISOString(), url, rooms: roomCount, connections: peers.length, durationSeconds: Number(elapsed.toFixed(2)), rampSeconds: Number(rampSeconds.toFixed(2)), stepMs: pace, commands, commandsPerSecond: Number((commands / elapsed).toFixed(2)), latencyMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: percentile(1) }, receivedMessages: messagesIn, receivedMbitPerSecond: Number((bytesIn * 8 / elapsed / 1e6).toFixed(3)), sentMbitPerSecond: Number((bytesOut * 8 / elapsed / 1e6).toFixed(3)), failedRooms, errors: errors.slice(0, 20), errorCount: errors.length };
  if (process.env.LOAD_OUTPUT) writeFileSync(process.env.LOAD_OUTPUT, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  if (errors.length || failedRooms) process.exitCode = 1;
} finally {
  measuring = false;
  for (const room of rooms) for (const peer of room.players) if (peer.socket.readyState === 1) peer.socket.send(JSON.stringify({ type: 'LEAVE_ROOM', requestId: `${run}-leave-${++requestSequence}`, data: { roomId: room.roomId } }));
  await delay(300);
  peers.forEach((peer) => peer.socket.close());
}
