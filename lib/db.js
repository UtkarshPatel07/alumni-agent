// The "data lake": a single SQLite file (Node built-in node:sqlite, zero native deps).
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

fs.mkdirSync('data', { recursive: true });
export const db = new DatabaseSync('data/lake.db');

db.exec(`
CREATE TABLE IF NOT EXISTS alumni (
  id TEXT PRIMARY KEY, name TEXT, headline TEXT, company TEXT, title TEXT,
  location TEXT, lat REAL, lng REAL, batch INTEGER, college TEXT,
  email TEXT, linkedin TEXT, source TEXT, verified INTEGER DEFAULT 0,
  status TEXT DEFAULT 'discovered', invite_token TEXT, invited_at TEXT,
  joined_at TEXT, first_seen TEXT, last_seen TEXT, seen_count INTEGER DEFAULT 1,
  evidence TEXT
);
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT, parsed TEXT, found INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, alumni_id TEXT, payload TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, alumni_id TEXT, to_addr TEXT, subject TEXT, body TEXT,
  status TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS geo (location TEXT PRIMARY KEY, lat REAL, lng REAL);
`);
try { db.exec('ALTER TABLE alumni ADD COLUMN enriched INTEGER DEFAULT 0'); } catch { /* already migrated */ }
try { db.exec('ALTER TABLE alumni ADD COLUMN batch_source TEXT'); } catch { /* already migrated */ }
try { db.exec('ALTER TABLE alumni ADD COLUMN li_verified INTEGER DEFAULT 0'); } catch { /* already migrated */ }
db.exec(`
CREATE TABLE IF NOT EXISTS register (college TEXT, name_norm TEXT, name TEXT, batch INTEGER, email TEXT, linkedin TEXT, program TEXT,
  PRIMARY KEY (college, name_norm, batch));
CREATE TABLE IF NOT EXISTS schools (college TEXT PRIMARY KEY, slug TEXT, url TEXT);
`);
export const normName = (n = '') => n.toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1).sort().join(' ');

/** Official college register = ground truth. Copies its batch onto matching lake records (by LinkedIn URL, or by exact name). */
export function applyRegister(college) {
  const regs = db.prepare('SELECT * FROM register WHERE lower(college)=lower(?)').all(college);
  if (!regs.length) return 0;
  const byName = new Map(regs.map((r) => [r.name_norm, r]));
  const byLi = new Map(regs.filter((r) => r.linkedin).map((r) => [r.linkedin.toLowerCase().replace(/\/$/, ''), r]));
  let n = 0;
  for (const a of db.prepare('SELECT id,name,linkedin,email FROM alumni WHERE lower(college)=lower(?)').all(college)) {
    const r = (a.linkedin && byLi.get(a.linkedin.toLowerCase().replace(/\/$/, ''))) || byName.get(normName(a.name));
    if (!r) continue;
    db.prepare("UPDATE alumni SET batch=?, batch_source='register', email=COALESCE(email,?) WHERE id=?").run(r.batch, r.email || null, a.id);
    n++;
  }
  return n;
}


export const normLi = (url = '') => {
  if (!url) return '';
  return url
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^(?:[a-z]{2,3}\.)?linkedin\.com\//, 'linkedin.com/')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
};

const now = () => new Date().toISOString();
export const makeId = (a) => {
  const li = normLi(a.linkedin);
  if (li) return crypto.createHash('sha1').update(li).digest('hex').slice(0, 16);
  const norm = normName(a.name);
  const col = (a.college || '').toLowerCase().trim();
  return crypto.createHash('sha1').update(`${norm}|${col}`).digest('hex').slice(0, 16);
};

export function logEvent(type, alumni_id, payload = {}) {
  db.prepare('INSERT INTO events(type,alumni_id,payload,created_at) VALUES (?,?,?,?)')
    .run(type, alumni_id || null, JSON.stringify(payload), now());
}

/** Insert or enrich. Deduplicates strictly by normalized LinkedIn, ID, or normalized name+college. Never duplicates a person. */
export function upsertAlumni(a) {
  const id = makeId(a);
  const liKey = normLi(a.linkedin);
  const nameNorm = normName(a.name);

  // 1. Try finding by ID
  let row = db.prepare('SELECT * FROM alumni WHERE id=?').get(id);

  // 2. Try finding by normalized LinkedIn URL (handles in.linkedin.com vs www.linkedin.com)
  if (!row && liKey) {
    row = db.prepare('SELECT * FROM alumni WHERE linkedin IS NOT NULL AND lower(linkedin) LIKE ?').get(`%${liKey}%`);
  }

  // 3. Try finding by normalized name + same college
  if (!row && nameNorm && a.college) {
    const candidates = db.prepare('SELECT * FROM alumni WHERE lower(college)=lower(?)').all(a.college);
    row = candidates.find((r) => normName(r.name) === nameNorm);
  }

  if (!row) {
    // Brand new alumnus in the data lake
    db.prepare(`INSERT INTO alumni(id,name,headline,company,title,location,lat,lng,batch,college,email,linkedin,
      source,verified,status,first_seen,last_seen,evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, a.name, a.headline ?? null, a.company ?? null, a.title ?? null, a.location ?? null,
        a.lat ?? null, a.lng ?? null, a.batch ?? null, a.college ?? null, a.email ?? null, a.linkedin ? a.linkedin.replace(/\/$/, '') : null,
        a.source, 0, 'discovered', now(), now(), a.evidence ?? null);
    logEvent('discovered', id, { source: a.source });
    return { id, isNew: true };
  }

  // Already exists! Never create a duplicate record. Merge and increment seen_count.
  const targetId = row.id;
  const keep = row.verified === 1;
  const newEvidence = a.evidence && (!row.evidence || !row.evidence.includes(a.evidence))
    ? (row.evidence ? `${row.evidence} | ${a.evidence}` : a.evidence)
    : row.evidence;
  const newSource = [...new Set([...String(row.source || '').split(','), a.source].filter(Boolean))].join(',');

  db.prepare(`UPDATE alumni SET last_seen=?, seen_count=seen_count+1,
      source=?,
      evidence=COALESCE(?,evidence),
      headline=COALESCE(headline,?),
      title=${keep ? 'title' : 'COALESCE(title,?)'},
      company=${keep ? 'company' : 'COALESCE(company,?)'},
      location=${keep ? 'location' : 'COALESCE(location,?)'},
      lat=COALESCE(lat,?), lng=COALESCE(lng,?),
      batch=COALESCE(batch,?),
      email=COALESCE(email,?),
      linkedin=COALESCE(linkedin,?)
      WHERE id=?`)
    .run(
      now(),
      newSource,
      newEvidence,
      a.headline ?? null,
      a.title ?? null,
      a.company ?? null,
      a.location ?? null,
      a.lat ?? null, a.lng ?? null,
      a.batch ?? null,
      a.email ?? null,
      a.linkedin ? a.linkedin.replace(/\/$/, '') : null,
      targetId
    );

  return { id: targetId, isNew: false };
}

// On fresh cloud deployment, preload seed data if lake is empty
try {
  const cnt = db.prepare('SELECT count(*) c FROM alumni').get().c;
  if (cnt === 0 && fs.existsSync('data/seed.json')) {
    const seed = JSON.parse(fs.readFileSync('data/seed.json', 'utf8'));
    for (const a of seed) upsertAlumni(a);
  }
} catch { /* ignore */ }

