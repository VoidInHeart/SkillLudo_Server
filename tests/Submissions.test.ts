import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { GameWebSocketServer } from '../src/network/WebSocketServer.js';
import { SessionManager, type Session } from '../src/auth/SessionManager.js';
import { normalizeDraft, SubmissionService, type Submission, type SubmissionStore, type StoredSubmission } from '../src/submissions/SubmissionService.js';
import { createSubmissionMailer, submissionMail } from '../src/submissions/SubmissionMailer.js';

const session: Session = { playerId: 'u_account-123', username: 'real_account', nickname: '机长', sessionId: 'secret-session', isAdmin: false, processedRequestIds: new Set(), createdAt: 0 };
const country = { kind: 'COUNTRY', country: { name: '  新国家  ', description: '介绍', skills: [{ name: '技能', type: 'COOLDOWN', trigger: '选择点数后', description: '点数加一', cooldown: '每 3 个正常回合' }] } };
function setup(send: (document: Submission) => Promise<void> = async () => {}) {
  const records = new Map<string, StoredSubmission>(); let quota = true;
  const store: SubmissionStore = {
    find: async (account, id) => records.get(`${account}/${id}`), checkQuota: async () => quota,
    insert: async (document) => { records.set(`${document.author.accountId}/${document.id}`, { document, status: 'PENDING' }); },
    mark: async (account, id, status) => { records.get(`${account}/${id}`)!.status = status; },
  };
  return { service: new SubmissionService(store, { send }), records, store, block: () => { quota = false; } };
}

test('M01: country and feedback become bounded structured data; invalid types, headers and oversized content fail', () => {
  assert.equal((normalizeDraft(country) as typeof country).country.name, '新国家');
  assert.deepEqual(normalizeDraft({ kind: 'FEEDBACK', content: ' 建议\n第二行 ', accountId: 'spoof' }), { kind: 'FEEDBACK', content: '建议\n第二行' });
  for (const edit of [ { ...country, country: { ...country.country, name: '国家\r\nBcc: other@example.com' } },
    { ...country, country: { ...country.country, skills: [] } },
    { ...country, country: { ...country.country, skills: [{ ...country.country.skills[0], type: 'CODE' }] } },
    { ...country, country: { ...country.country, skills: [{ ...country.country.skills[0], cooldown: '' }] } },
    { kind: 'FEEDBACK', content: 'a'.repeat(3001) }, { kind: 'FEEDBACK', content: '' } ]) assert.throws(() => normalizeDraft(edit));
});
test('M02: authenticated identity replaces claimed account; stored submission precedes SMTP; repeats never send twice', async () => {
  let count = 0; const s = setup(async (document) => { count++; assert.equal(s.records.size, 1); assert.equal(document.author.username, 'real_account'); });
  const request = { id: 'design_123', draft: country, author: { username: 'spoof' } };
  assert.equal((await s.service.submit(session, request)).status, 'SENT');
  assert.equal((await s.service.submit(session, request)).status, 'SENT'); assert.equal(count, 1);
  const doc = s.records.values().next().value!.document;
  assert.equal(JSON.stringify(doc).includes(session.sessionId), false);
  await assert.rejects(s.service.submit(session, { ...request, draft: { kind: 'FEEDBACK', content: 'different' } }));
  const mail = submissionMail(doc); assert.equal(mail.subject, '新国家技能设计'); assert.equal(mail.from, 'skillludo@163.com'); assert.equal(mail.to, 'skillludoadapter@163.com');
  assert.deepEqual(JSON.parse(mail.attachments[0].content), doc); assert.ok(mail.disableFileAccess && mail.disableUrlAccess);
});
test('M03: guests, missing SMTP and exhausted quotas cannot create records or send', async () => {
  const s = setup(async () => assert.fail('must not send')), request = { id: 'feedback_1', draft: { kind: 'FEEDBACK', content: '建议' } };
  await assert.rejects(s.service.submit({ ...session, playerId: 'p_guest', username: undefined }, request), /登录/);
  assert.equal(createSubmissionMailer({}), undefined);
  await assert.rejects(new SubmissionService(s.store).submit(session, request), /暂未配置/);
  s.block(); await assert.rejects(s.service.submit(session, request), /每分钟/); assert.equal(s.records.size, 0);
});
test('M04: rejection and ambiguous network failure remain durable and never auto resend', async () => {
  for (const [error, status] of [[{ responseCode: 550 }, 'FAILED'], [new Error('credential-must-not-leak'), 'UNCERTAIN']] as const) {
    let count = 0; const s = setup(async () => { count++; throw error; }), request = { id: 'feedback_2', draft: { kind: 'FEEDBACK', content: '反馈' } };
    const result = await s.service.submit(session, request); assert.equal(result.status, status); assert.ok(!result.message.includes('credential'));
    assert.equal((await s.service.submit(session, request)).status, status); assert.equal(count, 1);
  }
});
test('M05: per-account concurrency blocks simultaneous requests before a second write', async () => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const s = setup(async () => gate), request = { id: 'feedback_3', draft: { kind: 'FEEDBACK', content: '反馈' } };
  const sending = s.service.submit(session, request);
  await assert.rejects(s.service.submit(session, request), /正在处理/); release(); await sending; assert.equal(s.records.size, 1);
});
test('M06: real socket returns isolated submission results; SMTP wait does not block heartbeat or leak identity', async () => {
  class Accounts extends SessionManager { override async authenticate() { return session; } }
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const s = setup(async () => gate);
  const server = new GameWebSocketServer(0, new Accounts(), async () => {}, s.service); await server.ready;
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`); const messages: Array<{ type: string; requestId: string; data: { status?: string } }> = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw)))); await once(ws, 'open');
  const waitFor = async (id: string) => { for (let i = 0; i < 200; i++) { const m = messages.find((m) => m.requestId === id); if (m) return m; await new Promise((r) => setTimeout(r, 5)); } throw new Error(`Missing ${id}`); };
  const send = (type: string, requestId: string, data: unknown) => ws.send(JSON.stringify({ type, requestId, data }));
  try {
    send('AUTH', 'auth', {}); await waitFor('auth');
    send('SUBMIT_CREATION', 'submission', { id: 'socket_123', draft: { kind: 'FEEDBACK', content: '真实消息测试' } });
    send('PING', 'heartbeat', {}); assert.equal((await waitFor('heartbeat')).type, 'PONG');
    release(); const result = await waitFor('submission'); assert.equal(result.type, 'SUBMISSION_RESULT'); assert.equal(result.data.status, 'SENT');
    send('SUBMIT_CREATION', 'invalid', { id: 'invalid_1', draft: { kind: 'CODE' } }); assert.equal((await waitFor('invalid')).data.status, 'ERROR');
  } finally { release(); ws.close(); await server.close(); }
});
