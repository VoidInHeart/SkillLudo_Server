import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BOARD_CALIBRATION_SEQUENCE, BoardCalibrationStore } from '../src/game/BoardCalibrationStore.js';

test('board calibration stores named coordinates and advances through the defined sequence', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'skillludo-calibration-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'board-positions.json');
  const store = new BoardCalibrationStore(file);

  assert.equal(store.resolveKey('1'), '01');
  assert.equal(store.resolveKey('track-02'), '02');
  assert.equal(store.resolveKey('YELLOW-AIRPORT-1'), 'yellow-airport-1');
  assert.equal(store.resolveKey(), BOARD_CALIBRATION_SEQUENCE[0]);

  const saved = store.save('yellow-airport-1', { x: -301.24, y: 268.87 });
  assert.deepEqual(saved.positions['yellow-airport-1'], { x: -301.2, y: 268.9 });
  assert.equal(saved.completed.includes('yellow-airport-1'), true);
  assert.equal(store.nextAfter('yellow-airport-1'), 'yellow-airport-2');

  const persisted = JSON.parse(readFileSync(file, 'utf8')) as { positions: Record<string, { x: number; y: number }> };
  assert.deepEqual(persisted.positions['yellow-airport-1'], { x: -301.2, y: 268.9 });
});
