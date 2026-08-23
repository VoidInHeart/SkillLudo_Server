import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BoardCalibrationData, BoardPosition, PlayerColor } from '../protocol.js';

const COLORS: PlayerColor[] = ['YELLOW', 'BLUE', 'RED', 'GREEN'];

export const BOARD_CALIBRATION_SEQUENCE: string[] = [
  ...COLORS.flatMap((color) => [1, 2, 3, 4].map((seq) => `${color.toLowerCase()}-airport-${seq}`)),
  ...COLORS.map((color) => `${color.toLowerCase()}-takeoff`),
  ...Array.from({ length: 52 }, (_, index) => String(index + 1).padStart(2, '0')),
  ...COLORS.flatMap((color) => [1, 2, 3, 4, 5, 6].map((seq) => `${color.toLowerCase()}-landing-${seq}`))
];

interface StoredBoardCalibration {
  version?: number;
  positions?: Record<string, BoardPosition>;
  completed?: string[];
}

/** Small version-controlled JSON store for artwork coordinates; this is board configuration, not user data. */
export class BoardCalibrationStore {
  private data: BoardCalibrationData;

  public constructor(private readonly filePath = resolve(process.cwd(), 'config', 'board-positions.json')) {
    this.data = this.load();
  }

  public getData(): BoardCalibrationData {
    return {
      version: this.data.version,
      positions: { ...this.data.positions },
      completed: [...this.data.completed],
      sequence: [...BOARD_CALIBRATION_SEQUENCE]
    };
  }

  public resolveKey(value?: string): string {
    if (!value?.trim()) return BOARD_CALIBRATION_SEQUENCE.find((key) => !this.data.completed.includes(key)) ?? BOARD_CALIBRATION_SEQUENCE[0];
    const raw = value.trim().toLowerCase();
    const numeric = /^\d{1,2}$/.test(raw) ? raw.padStart(2, '0') : raw.replace(/^track-/, '').padStart(2, '0');
    const key = BOARD_CALIBRATION_SEQUENCE.includes(numeric) ? numeric : raw;
    if (!BOARD_CALIBRATION_SEQUENCE.includes(key)) throw new Error('INVALID_CALIBRATION_KEY');
    return key;
  }

  public describe(key: string, single = false): { key: string; index: number; total: number; position?: BoardPosition; single: boolean } {
    const normalized = this.resolveKey(key);
    return {
      key: normalized,
      index: BOARD_CALIBRATION_SEQUENCE.indexOf(normalized) + 1,
      total: BOARD_CALIBRATION_SEQUENCE.length,
      position: this.data.positions[normalized],
      single
    };
  }

  public save(key: string, position: BoardPosition): BoardCalibrationData {
    const normalized = this.resolveKey(key);
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || Math.abs(position.x) > 1_000 || Math.abs(position.y) > 1_000) {
      throw new Error('INVALID_CALIBRATION_POSITION');
    }
    this.data.positions[normalized] = { x: Math.round(position.x * 10) / 10, y: Math.round(position.y * 10) / 10 };
    if (!this.data.completed.includes(normalized)) this.data.completed.push(normalized);
    this.data.version += 1;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify({ version: this.data.version, positions: this.data.positions, completed: this.data.completed }, null, 2)}\n`, 'utf8');
    return this.getData();
  }

  public nextAfter(key: string): string | undefined {
    const index = BOARD_CALIBRATION_SEQUENCE.indexOf(this.resolveKey(key));
    return BOARD_CALIBRATION_SEQUENCE.slice(index + 1).find((candidate) => !this.data.completed.includes(candidate));
  }

  private load(): BoardCalibrationData {
    let stored: StoredBoardCalibration = {};
    try { stored = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredBoardCalibration; } catch { /* first startup */ }
    const positions = Object.fromEntries(Object.entries(stored.positions ?? {}).filter(([key, value]) => BOARD_CALIBRATION_SEQUENCE.includes(key) && isPosition(value)));
    const completed = (stored.completed ?? []).filter((key) => BOARD_CALIBRATION_SEQUENCE.includes(key) && !!positions[key]);
    return { version: Math.max(1, stored.version ?? 1), positions, completed, sequence: [...BOARD_CALIBRATION_SEQUENCE] };
  }
}

function isPosition(value: unknown): value is BoardPosition {
  return typeof value === 'object' && value !== null && 'x' in value && 'y' in value
    && typeof value.x === 'number' && typeof value.y === 'number' && Number.isFinite(value.x) && Number.isFinite(value.y);
}
