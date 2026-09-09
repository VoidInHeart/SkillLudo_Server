import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = join(root, '.runtime');
const statePath = join(runtime, 'server.json');
const outputPath = join(runtime, 'server.out.log');
const errorPath = join(runtime, 'server.err.log');
const foreground = process.argv.includes('--foreground');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function listening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (ready) => { socket.destroy(); resolve(ready); };
    socket.setTimeout(400);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--foreground')) throw new Error('Usage: start.sh [--foreground] / start.ps1 [-Foreground]');
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) throw new Error('Missing .env. Copy .env.example to .env and configure the local database first.');
  // Parse dotenv as data; never source it as shell code. Local project values
  // win over inherited values, including when launched from another directory.
  const env = { ...process.env, ...parseEnv(readFileSync(envPath, 'utf8')) };
  delete env.MYSQL_ROOT_PASSWORD;
  if (!env.SKILLLUDO_DB_PASSWORD || env.SKILLLUDO_DB_PASSWORD === 'replace-with-a-local-secret') throw new Error('Configure SKILLLUDO_DB_PASSWORD in .env first.');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  if (await listening(port)) {
    let previous;
    try { previous = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* not started by this script */ }
    if (previous?.root === root && previous.port === port && Number.isInteger(previous.pid) && previous.pid > 0 && alive(previous.pid)) {
      console.log(`SkillLudo already running: ws://127.0.0.1:${port} (PID ${previous.pid})`);
      return;
    }
    throw new Error(`Port ${port} is already occupied. No process was stopped; inspect the existing service first.`);
  }
  const compiler = join(root, 'node_modules/typescript/bin/tsc');
  if (!existsSync(compiler) || !existsSync(join(root, 'node_modules/mysql2'))) throw new Error('Dependencies missing. Run npm ci in SkillLudo_Server first.');
  console.log('Building SkillLudo server...');
  const build = spawnSync(process.execPath, [compiler, '-p', join(root, 'tsconfig.json')], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (build.error || build.status !== 0) throw new Error('Build failed; the backend was not started.');
  const entry = join(root, 'dist/index.js');
  if (foreground) {
    const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
    child.once('error', () => { console.error('Could not start the backend.'); process.exitCode = 1; });
    child.once('exit', (code) => { process.exitCode = code ?? 1; });
    return;
  }
  mkdirSync(runtime, { recursive: true });
  const output = openSync(outputPath, 'a'), errors = openSync(errorPath, 'a');
  const child = spawn(process.execPath, [entry], { cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', output, errors] });
  closeSync(output); closeSync(errors);
  let failed = false;
  child.once('error', () => { failed = true; });
  child.once('exit', () => { failed = true; });
  child.unref();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await delay(150);
    if (failed || !child.pid || !alive(child.pid)) throw new Error(`Backend exited during startup. Check ${errorPath}`);
    if (await listening(port)) {
      writeFileSync(statePath, JSON.stringify({ pid: child.pid, port, root, startedAt: new Date().toISOString() }, null, 2) + '\n');
      console.log(`SkillLudo started: ws://127.0.0.1:${port} (PID ${child.pid})`);
      console.log(`Output: ${outputPath}\nErrors: ${errorPath}\nProcess record: ${statePath}`);
      return;
    }
  }
  // Only terminate the child created by this invocation, never a PID read from disk.
  child.kill();
  throw new Error(`Backend did not become ready within 15 seconds. Check ${errorPath}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
