import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { UserRepository } from '../dist/auth/UserRepository.js';
import { SessionManager } from '../dist/auth/SessionManager.js';
import { SubmissionRepository } from '../dist/submissions/SubmissionRepository.js';
import { SubmissionService } from '../dist/submissions/SubmissionService.js';

// Real persistence and identity, fake SMTP: CI never sends mail to people.
const users = new UserRepository(); let account;
try {
  account = await users.register(`mail_${randomUUID().slice(0, 12).replaceAll('-', '')}`, randomUUID(), '投稿回归');
  const session = await new SessionManager(users).login({ username: account.username, password: 'wrong-password' }).then(() => assert.fail('bad login'), () => null);
  assert.equal(session, null);
  const stored = await users.createSession(account), sessions = new SessionManager(users);
  const author = await sessions.restorePersistentSession(stored.sessionId);
  const repository = new SubmissionRepository(users.database); let sends = 0;
  const service = new SubmissionService(repository, { send: async (document) => {
    sends++; assert.equal((await repository.find(account.id, document.id)).status, 'PENDING');
  } });
  const request = { id: 'integration_123', draft: { kind: 'FEEDBACK', content: '真实 MySQL 验证\n🙂 中文' } };
  assert.equal((await service.submit(author, request)).status, 'SENT');
  assert.equal((await service.submit(author, request)).status, 'SENT'); assert.equal(sends, 1);
  const row = await repository.find(account.id, request.id);
  assert.equal(row.document.author.username, account.username); assert.equal(row.document.design.content, request.draft.content);
  await assert.rejects(service.submit(author, { ...request, id: 'integration_456' }), /每分钟/);
  assert.equal(await repository.find('another-account', request.id), undefined);
  console.log('Real MySQL submissions: identity, Unicode JSON, persistent deduplication, quota and account isolation passed; SMTP mocked.');
} finally {
  if (account) await users.database.execute('DELETE FROM users WHERE id = ?', [account.id]);
  await users.close();
}
