// Auto-invite: sends via SMTP when configured, always records to the outbox (audit trail / dry-run).
import nodemailer from 'nodemailer';
import { db, logEvent } from './db.js';
import crypto from 'node:crypto';

const BASE = () => process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
let transport;
const smtp = () => (process.env.SMTP_HOST ? (transport ??= nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587),
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
})) : null);

export function inviteMessage(a, link) {
  return {
    subject: `${a.name.split(' ')[0]}, your ${a.college} alumni network is growing`,
    body: `Hi ${a.name.split(' ')[0]},\n\nStudents at ${a.college} are searching for alumni${a.company ? ` working at ${a.company}` : ''} — and your name came up.\n\nJoin the alumni network (30 seconds, you control what's shared):\n${link}\n\nMentor a student, share your journey, or just stay connected.\n\n— ${a.college} Alumni Agent`,
  };
}

export async function autoInvite(a) {
  if (a.status === 'joined' || a.invited_at) return null;
  const token = a.invite_token || crypto.randomBytes(12).toString('hex');
  const link = `${BASE()}/join.html?t=${token}`;
  const msg = inviteMessage(a, link);
  let status;
  if (a.email) {
    const t = smtp();
    if (t) {
      try { await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: a.email, ...{ subject: msg.subject, text: msg.body } }); status = 'sent'; }
      catch (e) { status = `failed: ${e.message}`; }
    } else status = 'queued (no SMTP configured)';
  } else status = 'needs-linkedin-outreach';
  db.prepare('INSERT INTO outbox(alumni_id,to_addr,subject,body,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(a.id, a.email, msg.subject, msg.body, status, new Date().toISOString());
  db.prepare("UPDATE alumni SET invite_token=?, invited_at=?, status='invited' WHERE id=?").run(token, new Date().toISOString(), a.id);
  logEvent('invited', a.id, { status });
  return { status, link };
}
