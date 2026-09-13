import type { Session } from '../auth/SessionManager.js';

export type SubmissionKind = 'COUNTRY' | 'FEEDBACK';
export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'UNCERTAIN';
export interface SkillDraft { name: string; type: 'NORMAL' | 'LIMITED' | 'COOLDOWN' | 'AWAKENING'; trigger: string; description: string; cooldown: string; }
export type Draft = { kind: 'COUNTRY'; country: { name: string; description: string; skills: SkillDraft[] } } | { kind: 'FEEDBACK'; content: string };
export interface Submission {
  schemaVersion: 1; id: string; submittedAt: string;
  author: { accountId: string; username: string; nickname: string };
  design: Draft;
}
export interface StoredSubmission { document: Submission; status: DeliveryStatus; }
export interface SubmissionStore {
  find(accountId: string, id: string): Promise<StoredSubmission | undefined>;
  checkQuota(accountId: string): Promise<boolean>;
  insert(document: Submission): Promise<void>;
  mark(accountId: string, id: string, status: DeliveryStatus): Promise<void>;
}
export interface SubmissionMailer { send(document: Submission): Promise<void>; }
export class SubmissionError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SubmissionError('提交内容格式不正确');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, label: string, required = false, line = false): string {
  if (typeof value !== 'string') throw new SubmissionError(`请填写${label}`);
  const clean = value.trim();
  if ((required && !clean) || clean.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(clean) || (line && /[\r\n]/.test(clean))) throw new SubmissionError(`${label}需为${required ? '1' : '0'}–${max}字${line ? '单行文字' : ''}`);
  return clean;
}
/** Formalize human designs without executing text or inventing skill semantics. */
export function normalizeDraft(value: unknown): Draft {
  const data = record(value);
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 12000) throw new SubmissionError('内容过长，请将整份投稿控制在约 3500 个汉字以内');
  if (data.kind === 'FEEDBACK') return { kind: 'FEEDBACK', content: text(data.content, 3000, '反馈', true) };
  if (data.kind !== 'COUNTRY') throw new SubmissionError('未知投稿类型');
  const country = record(data.country);
  if (!Array.isArray(country.skills) || country.skills.length < 1 || country.skills.length > 6) throw new SubmissionError('每个国家需有 1–6 个技能');
  const skills = country.skills.map((value): SkillDraft => {
    const skill = record(value);
    if (!['NORMAL', 'LIMITED', 'COOLDOWN', 'AWAKENING'].includes(String(skill.type))) throw new SubmissionError('请选择有效的技能类型');
    return { name: text(skill.name, 30, '技能名称', true, true), type: skill.type as SkillDraft['type'], trigger: text(skill.trigger, 100, '触发条件'),
      description: text(skill.description, 600, '技能效果', true), cooldown: skill.type === 'COOLDOWN' ? text(skill.cooldown, 60, '冷却规则', true) : '' };
  });
  return { kind: 'COUNTRY', country: { name: text(country.name, 30, '国家名称', true, true), description: text(country.description, 300, '国家介绍'), skills } };
}

export class SubmissionService {
  private readonly active = new Set<string>();
  public constructor(private readonly store: SubmissionStore, private readonly mailer?: SubmissionMailer) {}
  public async submit(session: Session, value: unknown): Promise<{ id: string; status: DeliveryStatus; message: string }> {
    if (!session.username || !session.playerId.startsWith('u_')) throw new SubmissionError('请先登录注册账号，再提交设计或反馈');
    if (!this.mailer) throw new SubmissionError('邮件功能暂未配置，请稍后提交；草稿仍保留');
    const data = record(value), id = text(data.id, 64, '提交编号', true, true);
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) throw new SubmissionError('提交编号无效');
    const design = normalizeDraft(data.draft), accountId = session.playerId.slice(2);
    if (this.active.has(accountId) || this.active.size >= 2) throw new SubmissionError('正在处理投稿，请稍后重试');
    this.active.add(accountId);
    try {
      const previous = await this.store.find(accountId, id);
      if (previous) {
        if (JSON.stringify(previous.document.design) !== JSON.stringify(design)) throw new SubmissionError('该编号已有其他内容，请新建投稿');
        return this.result(id, previous.status);
      }
      if (!await this.store.checkQuota(accountId)) throw new SubmissionError('每分钟可提交一次，每个账号每天最多 10 次；繁忙时请稍后再试');
      const document: Submission = { schemaVersion: 1, id, submittedAt: new Date().toISOString(), author: { accountId, username: session.username, nickname: session.nickname }, design };
      await this.store.insert(document);
      let status: DeliveryStatus = 'SENT';
      try { await this.mailer.send(document); }
      catch (error) {
        // Only an explicit SMTP rejection is definitely unsent. Network loss can
        // happen after acceptance, so never automatically resend an uncertain mail.
        const responseCode = (error as { responseCode?: number })?.responseCode;
        status = responseCode && responseCode >= 400 ? 'FAILED' : 'UNCERTAIN';
      }
      try { await this.store.mark(accountId, id, status); }
      catch { return this.result(id, 'UNCERTAIN'); }
      return this.result(id, status);
    } finally { this.active.delete(accountId); }
  }
  private result(id: string, status: DeliveryStatus) {
    const message = { SENT: '提交成功，邮件服务器已接收。感谢你的创意与反馈！', PENDING: '内容已保存，邮件发送处理中或待确认；重复提交不会重复发信。', FAILED: '内容已保存，但邮件服务器拒绝接收。请稍后联系管理员并提供提交编号。', UNCERTAIN: '内容已保存，邮件送达状态待确认。请保留提交编号，避免重复投稿。' }[status];
    return { id, status, message };
  }
}
