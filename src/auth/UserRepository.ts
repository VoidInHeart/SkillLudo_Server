import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';

const scryptAsync = promisify(scrypt);
const SESSION_LIFETIME_DAYS = 30;

export class AuthError extends Error {
  public constructor(public readonly code: 'USERNAME_TAKEN' | 'INVALID_CREDENTIALS' | 'AUTH_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface Account {
  id: string;
  username: string;
  nickname: string;
}

export interface PersistedSession extends Account {
  sessionId: string;
}

interface UserRow extends RowDataPacket {
  id: string;
  username: string;
  nickname: string;
  password_hash: string;
}

interface SessionRow extends RowDataPacket {
  id: string;
  username: string;
  nickname: string;
}

/** MySQL persistence for account identity and long-lived, opaque session tokens. */
export class UserRepository {
  private readonly pool: Pool;

  public constructor() {
    const password = process.env.SKILLLUDO_DB_PASSWORD;
    if (!password) throw new AuthError('AUTH_UNAVAILABLE', '未配置 SKILLLUDO_DB_PASSWORD，无法启用账号登录');
    this.pool = mysql.createPool({
      host: process.env.SKILLLUDO_DB_HOST ?? '127.0.0.1',
      port: parsePort(process.env.SKILLLUDO_DB_PORT),
      user: process.env.SKILLLUDO_DB_USER ?? 'skillludo_app',
      password,
      database: process.env.SKILLLUDO_DB_NAME ?? 'skill_ludo',
      waitForConnections: true,
      connectionLimit: 8,
      enableKeepAlive: true,
      charset: 'utf8mb4_unicode_ci'
    });
  }

  public async verifyConnection(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async register(username: string, password: string, nickname?: string): Promise<Account> {
    const cleanUsername = cleanUsernameOrThrow(username);
    const cleanPassword = passwordOrThrow(password);
    const account: Account = {
      id: randomUUID(),
      username: cleanUsername,
      nickname: cleanNickname(nickname || cleanUsername)
    };
    try {
      await this.pool.execute(
        'INSERT INTO users (id, username, password_hash, nickname) VALUES (?, ?, ?, ?)',
        [account.id, account.username, await hashPassword(cleanPassword), account.nickname]
      );
      await this.pool.execute('INSERT INTO player_profiles (user_id) VALUES (?)', [account.id]);
      return account;
    } catch (error) {
      if (isDuplicateEntry(error)) throw new AuthError('USERNAME_TAKEN', '该账号名已被使用');
      throw error;
    }
  }

  public async login(username: string, password: string, nickname?: string): Promise<Account> {
    const cleanUsername = cleanUsernameOrThrow(username);
    const [rows] = await this.pool.execute<UserRow[]>(
      'SELECT id, username, nickname, password_hash FROM users WHERE username = ? LIMIT 1',
      [cleanUsername]
    );
    const row = rows[0];
    if (!row || !await verifyPassword(password, row.password_hash)) throw new AuthError('INVALID_CREDENTIALS', '账号或密码不正确');
    const updatedNickname = nickname?.trim() ? cleanNickname(nickname) : row.nickname;
    if (updatedNickname !== row.nickname) await this.pool.execute('UPDATE users SET nickname = ? WHERE id = ?', [updatedNickname, row.id]);
    return { id: row.id, username: row.username, nickname: updatedNickname };
  }

  public async createSession(account: Account): Promise<PersistedSession> {
    const sessionId = randomUUID();
    await this.pool.execute(
      'INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))',
      [tokenHash(sessionId), account.id, SESSION_LIFETIME_DAYS]
    );
    return { ...account, sessionId };
  }

  public async resumeSession(sessionId: string, nickname?: string): Promise<PersistedSession | null> {
    const [rows] = await this.pool.execute<SessionRow[]>(
      `SELECT u.id, u.username, u.nickname
       FROM user_sessions s INNER JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() LIMIT 1`,
      [tokenHash(sessionId)]
    );
    const row = rows[0];
    if (!row) return null;
    const updatedNickname = nickname?.trim() ? cleanNickname(nickname) : row.nickname;
    await this.pool.execute('UPDATE user_sessions SET last_seen_at = UTC_TIMESTAMP() WHERE token_hash = ?', [tokenHash(sessionId)]);
    if (updatedNickname !== row.nickname) await this.pool.execute('UPDATE users SET nickname = ? WHERE id = ?', [updatedNickname, row.id]);
    return { id: row.id, username: row.username, nickname: updatedNickname, sessionId };
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const key = Buffer.from(await scryptAsync(password, salt, 64) as ArrayBuffer).toString('base64url');
  return `scrypt$${salt}$${key}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, expected] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = Buffer.from(await scryptAsync(password, salt, 64) as ArrayBuffer);
  const expectedBuffer = Buffer.from(expected, 'base64url');
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function tokenHash(token: string): Buffer { return createHash('sha256').update(token).digest(); }
function cleanUsernameOrThrow(value: string): string {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new AuthError('INVALID_CREDENTIALS', '账号须为 3–32 位小写字母、数字或下划线');
  return username;
}
function passwordOrThrow(value: string): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new AuthError('INVALID_CREDENTIALS', '密码长度须为 8–128 位');
  return value;
}
function cleanNickname(value: string): string { return value.trim().slice(0, 20) || '玩家'; }
function parsePort(value: string | undefined): number { const port = Number.parseInt(value ?? '3306', 10); return Number.isInteger(port) && port > 0 ? port : 3306; }
function isDuplicateEntry(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY'; }
