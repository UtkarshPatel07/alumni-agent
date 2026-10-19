// Invite agent. LinkedIn does NOT allow apps to send messages/connection requests on a user's behalf (partner-only API,
// automation bots violate its terms), so the honest, compliant flow is:
//   1. The agent DRAFTS a personalised invite (+ unique join link) for every alumnus it finds.
//   2. Email is SENT automatically when the alumnus has an email and SMTP is configured.
//   3. LinkedIn invites are sent by a human in one click: the note is copied and the profile opens -> Connect -> Add note -> paste.
//   4. The alumnus joins via the link (optionally "Sign in with LinkedIn" for a verified identity) -> data lake re-populated.
import nodemailer from 'nodemailer';
import { db, logEvent } from './db.js';
import crypto from 'node:crypto';
import { gemini, aiAvailable } from './ai.js';

export const BASE = () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
let transport;
const smtp = () => (process.env.SMTP_HOST ? (transport ??= nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587),
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
})) : null);
export const smtpReady = () => !!process.env.SMTP_HOST;

export function inviteMessage(a, link) {
  const first = (a.name || '').split(' ')[0];
  return {
    subject: `${first}, students from ${a.college} would love to connect`,
    body: `Hi ${first},\n\nStudents at ${a.college} are searching for alumni${a.company ? ` working at ${a.company}` : ''}, and your profile came up.\n\nJoin the alumni network (30 seconds, you control what's shared):\n${link}\n\nMentor a student, share your journey, or just stay connected.\n\n— ${a.college} Alumni Network`,
  };
}

/** LinkedIn connection notes are limited to 300 characters. */
export function linkedinNote(a, link) {
  const first = (a.name || '').split(' ')[0];
  const role = a.company ? ` at ${a.company}` : '';
  const variants = [
    `Hi ${first}! I'm a student from ${a.college} and saw your journey${role}. We're building our alumni network so students can learn from alumni like you. Would you join? It takes 30 sec: ${link}`,
    `Hi ${first}, fellow ${a.college} here! Building our alumni network for students. Would love you to join (30 sec): ${link}`,
    `Hi ${first}, ${a.college} alumni network: ${link}`,
  ];
  return variants.find((v) => v.length <= 300) || variants.at(-1).slice(0, 300);
}

/** Optional AI personalisation (kept under 300 chars, falls back to the template). */
export async function aiNote(a, link) {
  if (!aiAvailable()) return linkedinNote(a, link);
  try {
    const r = await gemini(`Write a warm, professional LinkedIn connection note (max 220 characters, no hashtags, no emojis) from a current student of "${a.college}" to alumnus ${a.name}${a.title ? `, ${a.title}` : ''}${a.company ? ` at ${a.company}` : ''}, inviting them to join the college alumni network to guide students. Do not include any link. Return JSON {"note":"..."}`, { timeout: 6000 });
    const n = String(r.note || '').replace(/\s+/g, ' ').trim();
    const full = `${n} Join here: ${link}`;
    return n && full.length <= 300 ? full : linkedinNote(a, link);
  } catch { return linkedinNote(a, link); }
}

const ensureToken = (a) => {
  if (a.invite_token) return a.invite_token;
  const token = crypto.randomBytes(12).toString('hex');
  db.prepare('UPDATE alumni SET invite_token=? WHERE id=?').run(token, a.id);
  a.invite_token = token; return token;
};
export const joinLink = (a) => `${BASE()}/join.html?t=${ensureToken(a)}`;

/** Called by the agent for every alumnus found: drafts (and emails when possible). Never pretends something was sent. */
export async function prepareInvite(a) {
  if (a.status === 'joined' || db.prepare('SELECT 1 FROM outbox WHERE alumni_id=?').get(a.id)) return null;
  const link = joinLink(a);
  const msg = inviteMessage(a, link);
  let status = a.email ? (smtpReady() ? 'sending' : 'draft · email (add SMTP to auto-send)') : (a.linkedin ? 'draft · LinkedIn (one-click send)' : 'draft · no contact');
  if (a.email && smtpReady()) {
    try { await smtp().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: a.email, subject: msg.subject, text: msg.body }); status = 'sent · email'; }
    catch (e) { status = `failed · email (${e.message.slice(0, 60)})`; }
  }
  db.prepare('INSERT INTO outbox(alumni_id,to_addr,subject,body,status,created_at) VALUES (?,?,?,?,?,?)').run(a.id, a.email, msg.subject, msg.body, status, new Date().toISOString());
  if (status.startsWith('sent')) { db.prepare("UPDATE alumni SET invited_at=?, status='invited' WHERE id=?").run(new Date().toISOString(), a.id); logEvent('invite_sent', a.id, { channel: 'email' }); }
  else logEvent('invite_drafted', a.id, { status });
  return { status, link };
}

/** A human sent the invite (LinkedIn note / manual email). */
export function markSent(a, channel) {
  const now = new Date().toISOString();
  const row = db.prepare('SELECT id FROM outbox WHERE alumni_id=? ORDER BY id DESC').get(a.id);
  if (row) db.prepare('UPDATE outbox SET status=? WHERE id=?').run(`sent · ${channel}`, row.id);
  else db.prepare('INSERT INTO outbox(alumni_id,to_addr,subject,body,status,created_at) VALUES (?,?,?,?,?,?)').run(a.id, a.email, 'Alumni invite', '', `sent · ${channel}`, now);
  if (a.status !== 'joined') db.prepare("UPDATE alumni SET invited_at=?, status='invited' WHERE id=?").run(now, a.id);
  logEvent('invite_sent', a.id, { channel });
}
