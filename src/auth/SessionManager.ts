import { randomUUID } from 'node:crypto';
import type { AuthData } from '../protocol.js';
import { AuthError, type UserRepository } from './UserRepository.js';

export interface Session {
  playerId: string;
  sessionId: string;
  guestId?: string;
  nickname: string;
  roomId?: string;
  processedRequestIds: Set<string>;
  createdAt: number;
}

/**
 * Development identity provider. Production AUTH should exchange a WeChat login
 * code on HTTPS before this manager creates its opaque session id.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly guestSessions = new Map<string, string>();

  public constructor(private readonly users?: UserRepository) {}

  public async authenticate(data: AuthData): Promise<Session> {
    if (data.sessionId) {
      const existing = this.sessions.get(data.sessionId);
      if (!existing) throw new Error('INVALID_SESSION');
      if (data.nickname?.trim()) existing.nickname = this.cleanNickname(data.nickname);
      return existing;
    }
    const knownSessionId = data.guestId ? this.guestSessions.get(data.guestId) : undefined;
    if (knownSessionId) {
      const existing = this.sessions.get(knownSessionId);
      if (existing) {
        if (data.nickname?.trim()) existing.nickname = this.cleanNickname(data.nickname);
        return existing;
      }
    }
    const session: Session = {
      playerId: `p_${randomUUID()}`,
      sessionId: randomUUID(),
      guestId: data.guestId,
      nickname: this.cleanNickname(data.nickname ?? '游客'),
      processedRequestIds: new Set(),
      createdAt: Date.now()
    };
    this.sessions.set(session.sessionId, session);
    if (session.guestId) this.guestSessions.set(session.guestId, session.sessionId);
    return session;
  }

  public async register(data: AuthData): Promise<Session> {
    if (!this.users) throw new AuthError('AUTH_UNAVAILABLE', '服务器未启用账号登录');
    const account = await this.users.register(data.username ?? '', data.password ?? '', data.nickname);
    return this.fromPersistedAccount(await this.users.createSession(account));
  }

  public async login(data: AuthData): Promise<Session> {
    if (!this.users) throw new AuthError('AUTH_UNAVAILABLE', '服务器未启用账号登录');
    const account = await this.users.login(data.username ?? '', data.password ?? '', data.nickname);
    return this.fromPersistedAccount(await this.users.createSession(account));
  }

  public async restorePersistentSession(sessionId: string, nickname?: string): Promise<Session | null> {
    if (!this.users) return null;
    const persisted = await this.users.resumeSession(sessionId, nickname);
    return persisted ? this.fromPersistedAccount(persisted) : null;
  }

  public get(sessionId: string): Session | undefined { return this.sessions.get(sessionId); }

  private cleanNickname(value: string): string {
    return value.trim().slice(0, 20) || '游客';
  }

  private fromPersistedAccount(account: { id: string; nickname: string; sessionId: string }): Session {
    const existing = this.sessions.get(account.sessionId);
    if (existing) {
      existing.nickname = account.nickname;
      return existing;
    }
    const session: Session = {
      playerId: `u_${account.id}`,
      sessionId: account.sessionId,
      nickname: account.nickname,
      processedRequestIds: new Set(),
      createdAt: Date.now()
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }
}
