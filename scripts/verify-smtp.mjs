import { createSubmissionMailer } from '../dist/submissions/SubmissionMailer.js';
try {
  const mailer = createSubmissionMailer();
  if (!mailer) throw new Error('SMTP_AUTH_CODE is not configured');
  await mailer.verify();
  console.log('SMTP TLS 465 authentication passed; no message sent.');
} catch {
  console.error('SMTP verification failed. Check runtime secret, DNS, TCP 465 and provider settings. No credentials are logged.');
  process.exitCode = 1;
}
