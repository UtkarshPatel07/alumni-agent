import express from 'express';
import fs from 'node:fs';
import { db, upsertAlumni, logEvent, applyRegister, normName } from './lib/db.js';
import { parseQuery } from './lib/parser.js';
import { discover, findSchool } from './lib/sources.js';
import { geocode } from './lib/geo.js';
import { prepareInvite, markSent, aiNote, inviteMessage, joinLink, smtpReady, BASE } from './lib/mailer.js';
import crypto from 'node:crypto';
import { enrichEmail } from './lib/enrich.js';

if (fs.existsSync('.env')) for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const app = express();
app.use(express.json());
app.use(express.static('public', { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

const pub = (r) => ({ ...r, invite_token: undefined, email: r.email, verified: !!r.verified });

// Records found by THIS run always count; records only in the lake count only if they match the request exactly
// (same college, a batch that is KNOWN and requested, and the requested company).
function lakeQuery(intent, found = new Set()) {
  const rows = db.prepare('SELECT * FROM alumni WHERE lower(college)=lower(?)').all(intent.college);
  return rows.filter((r) => found.has(r.id) || (
    (!intent.companies.length || intent.companies.some((c) => r.company?.toLowerCase().includes(c.toLowerCase())))
    && (!intent.batches.length || (r.batch && intent.batches.includes(r.batch)))));
}

// Public deployment guard: per-visitor and per-day search limits protect the Serper/Gemini credits.
const LIMIT_IP_HOUR = +(process.env.MAX_SEARCHES_PER_IP_HOUR || 60), LIMIT_DAY = +(process.env.MAX_SEARCHES_PER_DAY || 500);
const hits = new Map(); let day = new Date().toDateString(), dayCount = 0;
function allowSearch(req, deep) {
  const today = new Date().toDateString(); if (today !== day) { day = today; dayCount = 0; hits.clear(); }
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  const cost = deep ? 3 : 1;
  if (list.length + cost > LIMIT_IP_HOUR) return 'Hourly search limit reached for this demo. Please try again later.';
  if (dayCount + cost > LIMIT_DAY) return 'Daily search limit reached for this demo (protects the API credits). Please try again tomorrow.';
  for (let i = 0; i < cost; i++) list.push(now); hits.set(ip, list); dayCount += cost; return null;
}

/** The agent run, streamed as Server-Sent Events so the UI can show every step live. */
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  console.log(`[Search] New query: "${q}"`);
  if (!q) return res.status(400).json({ error: 'q required' });
  
  // Anti-buffering headers for Cloudflare / Nginx proxies
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  // Send 2KB initial comment padding to force Cloudflare proxy to immediately flush the SSE stream
  res.write(`: ${' '.repeat(2048)}\n\n`);

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const step = (text, level = 'info', id) => send('step', { text, level, id, t: Date.now() });

  if (process.env.ACCESS_CODE && req.query.code !== process.env.ACCESS_CODE) {
    step('This demo needs an access code. Add ?code=YOUR_CODE to the page address.', 'warn');
    send('done', {}); return res.end();
  }
  const blocked = allowSearch(req, req.query.deep === '1');
  if (blocked) {
    step(blocked, 'warn');
    send('done', {}); return res.end();
  }
  try {
    step('Understanding your request…', 'run', 'parse');
    const intent = await parseQuery(q);
    if (intent.college && /universal\s*ai/i.test(intent.college)) intent.college = 'Universal AI University';
    // Exact filters from the form override what the AI understood from the sentence
    const fy = +req.query.from || null, ty = +req.query.to || null;
    if (fy || ty) { const a = Math.min(fy || ty, ty || fy), b = Math.max(fy || ty, ty || fy); intent.batches = []; for (let y = a; y <= b; y++) intent.batches.push(y); }
    if (req.query.companies) intent.companies = String(req.query.companies).split(',').map((s) => s.trim()).filter(Boolean);
    intent.deep = req.query.deep === '1';
    send('intent', intent);
    if (!intent.college) {
      step("I couldn't tell which college you mean. Please name it, e.g. 'alumni of Amity University, 2019 batch'.", 'warn');
      send('results', []); send('done', {}); return res.end();
    }
    step(`Parsed with ${intent.engine}: ${intent.college} · batches ${intent.batches[0] ?? '–'}–${intent.batches.at(-1) ?? '–'} · ${intent.companies.join(', ') || 'any company'}${intent.deep ? ' · DEEP SEARCH' : ''}`, 'ok', 'parse');

    // LinkedIn's official alumni tool (filters by graduation year) - real batch confirmation, opened by the user while logged in
    const schoolP = (async () => {
      let s = db.prepare('SELECT * FROM schools WHERE lower(college)=lower(?)').get(intent.college);
      if (!s) { try { s = await findSchool(intent.college); } catch { s = null; } if (s) db.prepare('INSERT OR REPLACE INTO schools VALUES (?,?,?)').run(intent.college, s.slug, s.url); }
      if (!s) { step(`Note: no official LinkedIn page found for "${intent.college}" - check the spelling of the college name`, 'warn'); return; }
      const min = intent.batches[0], max = intent.batches.at(-1);
      const link = (kw) => `https://www.linkedin.com/school/${s.slug}/people/?${new URLSearchParams({ ...(min ? { educationStartYear: String(min - 4) } : {}), ...(max ? { educationEndYear: String(max) } : {}), ...(kw ? { keywords: kw } : {}) })}`;
      send('school', { college: intent.college, url: s.url, links: (intent.companies.length ? intent.companies : [null]).map((c) => ({ company: c, url: link(c) })) });
    })();
    const found = new Set();
    const cached = lakeQuery(intent, found).length;
    step(`Checking data lake… ${cached} known alumni already match`, 'ok');

    step('Discovering alumni from live sources…', 'run', 'discover');
    const { live, items } = await discover(intent, (t, l) => step(t, l));
    step(`Discovery finished: ${items.length} candidate(s)${live ? '' : ' (no live source reachable)'}`, 'ok', 'discover');

    let created = 0;
    for (const a of items) {
      if (a.location) { const g = await geocode(a.location); if (g) Object.assign(a, g); }
      const { id, isNew } = upsertAlumni(a); found.add(id);
      db.prepare('UPDATE alumni SET evidence=COALESCE(?,evidence), batch_source=COALESCE(batch_source,?) WHERE id=?').run(a.evidence || null, a.batch_source || null, id);
      if (isNew) created++;
    }
    step(`Data lake updated: +${created} new, ${items.length - created} refreshed`, 'ok');
    const confirmed = applyRegister(intent.college);
    if (confirmed) step(`College register: ${confirmed} record(s) batch-confirmed from the official alumni list`, 'ok');
    await schoolP;

    const todo = lakeQuery(intent, found).filter((r) => !r.email && !r.enriched && !/sample|register/.test(r.source || '')).slice(0, 12);
    if (todo.length) {
      step(`Email-finder agent: checking public sources (GitHub, web) for ${todo.length} profile(s)…`, 'run', 'enrich');
      let found = 0;
      for (const r of todo) {
        const hit = await enrichEmail(r);
        db.prepare('UPDATE alumni SET enriched=1, email=COALESCE(?,email), evidence=COALESCE(?,evidence) WHERE id=?')
          .run(hit?.email ?? null, hit ? `${r.evidence || ''} | email via ${hit.via}` : null, r.id);
        if (hit) { found++; logEvent('email_found', r.id, { via: hit.via }); }
      }
      step(`Email-finder: ${found} public email(s) found; others fall back to LinkedIn`, 'ok', 'enrich');
    }


    const rows = lakeQuery(intent, found);
    let drafted = 0, emailed = 0;
    for (const r of rows) { const out = await prepareInvite(r); if (out) { drafted++; if (out.status.startsWith('sent')) emailed++; } }
    step(`Invite agent: ${drafted} personalised invite(s) drafted${emailed ? `, ${emailed} emailed` : ''}. LinkedIn invites: use the "Invite on LinkedIn" button on each card (one click, sent by you)`, 'ok');

    db.prepare('INSERT INTO searches(query,parsed,found,created_at) VALUES (?,?,?,?)').run(q, JSON.stringify(intent), rows.length, new Date().toISOString());
    const final = db.prepare('SELECT * FROM alumni WHERE id IN (' + (rows.map(() => '?').join(',') || "''") + ')').all(...rows.map((r) => r.id)).map(pub);
    send('results', final);
  } catch (e) {
    step(`Agent error: ${e.message}`, 'warn');
  }
  send('done', {}); res.end();
});

/** College admin uploads the OFFICIAL alumni register (CSV). This is the ground truth for batch years. */
app.post('/api/register', express.text({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const college = String(req.query.college || '').trim();
  if (!college) return res.status(400).json({ error: 'college required' });
  const rows = parseCsv(String(req.body || ''));
  if (!rows.length) return res.status(400).json({ error: 'CSV is empty' });
  const col = (r, ...names) => { for (const n of names) { const k = Object.keys(r).find((x) => x.toLowerCase().replace(/[^a-z]/g, '') === n); if (k && r[k]) return r[k].trim(); } return null; };
  let added = 0, skipped = 0;
  for (const r of rows) {
    const name = col(r, 'name', 'fullname', 'studentname'); const batch = +(col(r, 'batch', 'year', 'graduationyear', 'passingyear', 'passoutyear') || 0);
    if (!name || !batch) { skipped++; continue; }
    const email = col(r, 'email', 'emailid', 'mail'), linkedin = col(r, 'linkedin', 'linkedinurl', 'linkedinprofile'), program = col(r, 'program', 'course', 'degree', 'branch');
    db.prepare('INSERT OR REPLACE INTO register VALUES (?,?,?,?,?,?,?)').run(college, normName(name), name, batch, email, linkedin, program);
    // Only create a lake record if this person isn't already there (otherwise applyRegister just confirms the existing one)
    const exists = db.prepare('SELECT id,name FROM alumni WHERE lower(college)=lower(?)').all(college).some((x) => normName(x.name) === normName(name));
    if (!exists) upsertAlumni({ name, college, batch, email, linkedin, source: 'register', company: col(r, 'company', 'currentcompany', 'employer'), location: col(r, 'location', 'city') });
    added++;
  }
  const matched = applyRegister(college);
  logEvent('register_import', null, { college, added });
  res.json({ ok: true, added, skipped, matched });
});

function parseCsv(text) {
  const lines = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); lines.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); lines.push(row); }
  const [head, ...body] = lines.filter((l) => l.some((x) => x.trim()));
  return head ? body.map((l) => Object.fromEntries(head.map((h, i) => [h.trim(), l[i] ?? '']))) : [];
}

// ---------------- Invites ----------------
const byId = (id) => db.prepare('SELECT * FROM alumni WHERE id=?').get(id);
app.post('/api/invite/:id', async (req, res) => {
  const a = byId(req.params.id); if (!a) return res.status(404).json({ error: 'not found' });
  const link = joinLink(a), m = inviteMessage(a, link);
  res.json({ note: await aiNote(a, link), link, linkedin: a.linkedin, email: a.email, subject: m.subject, body: m.body });
});
app.post('/api/invite/:id/sent', (req, res) => {
  const a = byId(req.params.id); if (!a) return res.status(404).json({ error: 'not found' });
  markSent(a, String(req.body?.channel || 'LinkedIn').slice(0, 30)); res.json({ ok: true });
});
app.get('/api/config', (_req, res) => {
  const last = db.prepare('SELECT parsed FROM searches ORDER BY id DESC LIMIT 1').get();
  res.json({ linkedinLogin: !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET), smtp: smtpReady(), base: BASE(), lastCollege: last ? JSON.parse(last.parsed).college : null });
});

// ---------------- Sign in with LinkedIn (official OpenID Connect: name + verified email + photo of the person who logs in) ----------------
const oauthStates = new Map();
app.get('/auth/linkedin', (req, res) => {
  if (!process.env.LINKEDIN_CLIENT_ID) return res.redirect('/join.html?li=off');
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { t: req.query.t || null, c: req.query.c || null, at: Date.now() });
  const q = new URLSearchParams({ response_type: 'code', client_id: process.env.LINKEDIN_CLIENT_ID, redirect_uri: `${BASE()}/auth/linkedin/callback`, state, scope: 'openid profile email' });
  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${q}`);
});
app.get('/auth/linkedin/callback', async (req, res) => {
  const st = oauthStates.get(req.query.state); oauthStates.delete(req.query.state);
  if (!st || !req.query.code) return res.redirect('/join.html?li=err');
  try {
    const tok = await fetch('https://www.linkedin.com/oauth/v2/accessToken', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: `${BASE()}/auth/linkedin/callback`, client_id: process.env.LINKEDIN_CLIENT_ID, client_secret: process.env.LINKEDIN_CLIENT_SECRET }) }).then((r) => r.json());
    if (!tok.access_token) throw new Error(tok.error_description || 'no token');
    const u = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
    let a = st.t ? db.prepare('SELECT * FROM alumni WHERE invite_token=?').get(st.t) : null;
    if (!a) { const { id } = upsertAlumni({ name: u.name, college: st.c || 'Unknown', email: u.email || null, source: 'self' }); a = byId(id); }
    db.prepare('UPDATE alumni SET email=COALESCE(?,email), li_verified=1 WHERE id=?').run(u.email_verified === false ? null : (u.email || null), a.id);
    logEvent('linkedin_verified', a.id, { email: !!u.email });
    res.redirect(`/join.html?t=${joinLink(a).split('t=')[1]}&li=1`);
  } catch (e) { console.error('LinkedIn login failed:', e.message); res.redirect('/join.html?li=err'); }
});

app.get('/api/lake', (_req, res) => {
  const total = (sql) => db.prepare(sql).get().n;
  res.json({
    stats: {
      alumni: total('SELECT COUNT(*) n FROM alumni'), invited: total("SELECT COUNT(*) n FROM alumni WHERE status='invited'"),
      joined: total("SELECT COUNT(*) n FROM alumni WHERE status='joined'"), drafted: total("SELECT COUNT(*) n FROM outbox WHERE status LIKE 'draft%'"), searches: total('SELECT COUNT(*) n FROM searches'),
      withEmail: total('SELECT COUNT(*) n FROM alumni WHERE email IS NOT NULL'),
      register: total('SELECT COUNT(*) n FROM register'), batchConfirmed: total("SELECT COUNT(*) n FROM alumni WHERE batch_source='register' OR verified=1"),
    },
    byCompany: db.prepare('SELECT company label, COUNT(*) n FROM alumni GROUP BY company ORDER BY n DESC').all(),
    byBatch: db.prepare('SELECT batch label, COUNT(*) n FROM alumni WHERE batch IS NOT NULL GROUP BY batch ORDER BY batch').all(),
    alumni: db.prepare('SELECT * FROM alumni ORDER BY last_seen DESC').all().map(pub),
    events: db.prepare('SELECT e.*, a.name FROM events e LEFT JOIN alumni a ON a.id=e.alumni_id ORDER BY e.id DESC LIMIT 25').all(),
    outbox: db.prepare('SELECT o.*, a.name FROM outbox o LEFT JOIN alumni a ON a.id=o.alumni_id ORDER BY o.id DESC LIMIT 25').all(),
  });
});

app.get('/api/join/:token', (req, res) => {
  const a = db.prepare('SELECT name,company,title,location,batch,college,email,linkedin,status,li_verified FROM alumni WHERE invite_token=?').get(req.params.token);
  a ? res.json(a) : res.status(404).json({ error: 'Invalid or expired invite' });
});

/** Alumnus accepts → self-reported, verified data is written back to the lake. */
app.post('/api/join/:token', async (req, res) => {
  const a = db.prepare('SELECT * FROM alumni WHERE invite_token=?').get(req.params.token);
  if (!a) return res.status(404).json({ error: 'Invalid or expired invite' });
  const b = req.body || {};
  if (!b.consent) return res.status(400).json({ error: 'Consent is required' });
  const g = b.location ? await geocode(b.location) : null;
  db.prepare(`UPDATE alumni SET name=?, company=?, title=?, location=?, lat=COALESCE(?,lat), lng=COALESCE(?,lng), batch=?, email=?, linkedin=?,
    verified=1, status='joined', joined_at=? WHERE id=?`).run(
    b.name || a.name, b.company || a.company, b.title || a.title, b.location || a.location, g?.lat ?? null, g?.lng ?? null,
    +b.batch || a.batch, b.email || a.email, b.linkedin || a.linkedin, new Date().toISOString(), a.id);
  logEvent('joined', a.id, { repopulated: true });
  res.json({ ok: true });
});

/** Open (no-invite) signup so any alumnus can self-register. */
app.post('/api/signup', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.consent) return res.status(400).json({ error: 'Name and consent required' });
  const g = b.location ? await geocode(b.location) : null;
  const rec = { name: b.name, company: b.company, title: b.title, location: b.location, batch: +b.batch || null, college: String(b.college || 'Unknown').slice(0, 120),
    email: b.email, linkedin: b.linkedin || null, source: 'self', ...(g || {}) };
  const { id } = upsertAlumni(rec);
  db.prepare("UPDATE alumni SET verified=1,status='joined',joined_at=? WHERE id=?").run(new Date().toISOString(), id);
  logEvent('joined', id, { self: true });
  res.json({ ok: true });
});

/** Colleges in the data lake (for the download picker) */
app.get('/api/colleges', (_req, res) => {
  res.json(db.prepare("SELECT college, COUNT(*) n, SUM(batch IS NOT NULL) withBatch FROM alumni WHERE college IS NOT NULL AND source != 'sample' GROUP BY lower(college) ORDER BY n DESC").all());
});

/** CSV download, filtered by college / batch range / company / confirmed batch only. Opens cleanly in Excel (UTF-8 BOM). */
app.get('/api/export.csv', (req, res) => {
  const where = ["source != 'sample'"], args = [];
  if (req.query.college) { where.push('lower(college)=lower(?)'); args.push(String(req.query.college)); }
  const fy = +req.query.from || null, ty = +req.query.to || null;
  if (fy || ty) {
    const cond = [fy ? 'batch >= ?' : '', ty ? 'batch <= ?' : ''].filter(Boolean).join(' AND ');
    where.push(req.query.confirmed === '1' ? `(${cond})` : `(batch IS NULL OR (${cond}))`); // unknown-batch alumni kept unless "confirmed only"
    if (fy) args.push(fy); if (ty) args.push(ty);
  }
  if (req.query.confirmed === '1') where.push('batch IS NOT NULL');
  if (req.query.company) { where.push("lower(company) LIKE '%' || lower(?) || '%'"); args.push(String(req.query.company)); }
  if (req.query.ids) { const ids = String(req.query.ids).split(',').filter(Boolean).slice(0, 2000); where.push(`id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
  const rows = db.prepare(`SELECT name, college, batch, CASE WHEN batch IS NULL THEN 'not public' WHEN batch_source='register' THEN 'college register' WHEN verified=1 THEN 'self-confirmed' WHEN batch_source='news' THEN 'placement news' ELSE 'from profile' END AS batch_proof,
      company, title, location, email, linkedin, status AS invite_status, source, evidence AS why_matched, last_seen
      FROM alumni WHERE ${where.join(' AND ')} ORDER BY college, batch DESC, name`).all(...args);
  const cols = ['name', 'college', 'batch', 'batch_proof', 'company', 'title', 'location', 'email', 'linkedin', 'invite_status', 'source', 'why_matched', 'last_seen'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const slug = (req.query.college || 'all-colleges').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const yrs = fy || ty ? `-${fy || ''}-${ty || ''}` : '';
  res.set('content-disposition', `attachment; filename="alumni-${slug}${yrs}.csv"`);
  res.type('text/csv; charset=utf-8').send('\ufeff' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n'));
});

const port = process.env.PORT || 3000;
app.get('/healthz', (_req, res) => res.send('ok'));
app.listen(port, '0.0.0.0', () => console.log(`Alumni Agent running → http://localhost:${port}`));
