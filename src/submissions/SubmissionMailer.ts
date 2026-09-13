import nodemailer from 'nodemailer';
import type { Submission, SubmissionMailer } from './SubmissionService.js';

const sender = 'skillludo@163.com';
const recipient = 'skillludoadapter@163.com';
export function submissionMail(document: Submission) {
  const design = document.design;
  const summary = design.kind === 'COUNTRY'
    ? `${design.country.name}\n${design.country.description}\n\n${design.country.skills.map((s, i) => `${i + 1}. ${s.name} [${s.type}]\n触发：${s.trigger || '见效果描述'}\n效果：${s.description}${s.cooldown ? `\n冷却：${s.cooldown}` : ''}`).join('\n\n')}`
    : design.content;
  return {
    from: sender, to: recipient,
    subject: design.kind === 'COUNTRY' ? `${design.country.name}技能设计` : `SkillLudo 用户反馈 · ${document.id}`,
    text: `提交编号：${document.id}\n账号：${document.author.username}\n账号 ID：${document.author.accountId}\n昵称：${document.author.nickname}\n时间：${document.submittedAt}\n\n${summary}\n\n附件为版本化 JSON，供后续开发整理。`,
    attachments: [{ filename: `skillludo-${document.id}.json`, content: JSON.stringify(document, null, 2), contentType: 'application/json; charset=utf-8' }],
    disableFileAccess: true, disableUrlAccess: true,
  };
}
export function createSubmissionMailer(env = process.env): (SubmissionMailer & { verify(): Promise<true> }) | undefined {
  if (!env.SMTP_AUTH_CODE) return undefined;
  const transport = nodemailer.createTransport({ host: 'smtp.163.com', port: 465, secure: true,
    auth: { user: sender, pass: env.SMTP_AUTH_CODE }, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, dnsTimeout: 10000,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true });
  return { verify: () => transport.verify(), send: async (document) => {
    const result = await transport.sendMail(submissionMail(document));
    if (!result.accepted.some((address) => String(address).toLowerCase() === recipient)) throw Object.assign(new Error('SMTP recipient rejected'), { responseCode: 550 });
  } };
}
