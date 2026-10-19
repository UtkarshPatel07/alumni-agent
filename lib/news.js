// Placement-news agent: public news / press releases / college posts name students with batch + company.
// Gemini extracts {name, batch, company, quote}; the quote must literally exist in the article. Each person is then
// cross-linked to their public LinkedIn profile. Batch here comes from a published source, so it's high confidence.
import { gemini, aiAvailable } from './ai.js';
import { serperQuery, mentionsCollege, serperThrottle } from './sources.js';

const BLOCKED = /facebook\.com|instagram\.com|linkedin\.com|x\.com|twitter\.com|youtube\.com|reddit\.com/i;
const norm = (s = '') => s.toLowerCase().replace(/[\u2013\u2014]/g, '-').replace(/[^a-z0-9 \-]+/g, ' ').replace(/\s+/g, ' ').trim();
const nameKey = (n = '') => norm(n).split(' ').filter((w) => w.length > 1).slice(0, 2).join(' ');

async function serperNews(q) {
  await serperThrottle();
  const r = await fetch('https://google.serper.dev/news', {
    method: 'POST', headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ q, num: 10 }), signal: AbortSignal.timeout(15000),
  });
  return r.ok ? ((await r.json()).news || []) : [];
}

async function pageText(url) {
  if (BLOCKED.test(url)) return '';
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 AlumniAgent/1.0' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok || !/text\/html/.test(r.headers.get('content-type') || '')) return '';
    return (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').slice(0, 7000);
  } catch { return ''; }
}

async function extract(intent, doc) {
  const res = await gemini(`From this public article/post, extract every person it explicitly says studied at "${intent.college}" (exact institution only).
For each: name (full name as written), program (degree/branch if given), grad_year (graduation year: "Batch of 2023" -> 2023, "2019-2023" -> 2023; null if not stated), company (employer/recruiter they joined; null if none), quote (exact words from the text, max 30 words, that mention the person). Never invent.
Return ONLY a JSON array: [{"name":"","program":"","grad_year":null,"company":"","quote":""}]

SOURCE: ${doc.url}
TEXT: ${doc.text}`, { timeout: 20000 });
  return (Array.isArray(res) ? res : []).filter((p) => p?.name && p.quote && norm(doc.text).includes(norm(p.quote)) && norm(p.quote).includes(norm(p.name).split(' ')[0]));
}

/** Finds the person's public LinkedIn profile: name must match, and the snippet must mention the college or the company. */
export async function linkedinFor(person, college) {
  const q = `site:linkedin.com/in "${person.name}" "${college}"`;
  const j = await serperQuery(q, 1).catch(() => ({}));
  for (const o of j.organic || []) {
    const title = (o.title || '').split(/\s[-\u2013|]\s/)[0];
    if (nameKey(title) !== nameKey(person.name)) continue;
    const text = `${o.title} ${o.snippet} ${o.subtitle || ''}`;
    if (!mentionsCollege(text, college) && !(person.company && norm(text).includes(norm(person.company)))) continue;
    const sub = (o.subtitle || '').split(/\s\u00b7\s/).map((s) => s.trim());
    return { linkedin: o.link.split('?')[0].replace(/https?:\/\/[a-z]{2,3}\.linkedin\.com/i, 'https://www.linkedin.com'), location: sub.length >= 3 ? sub[0] : null, title: sub.length >= 3 ? sub[1] : null, current: sub.length >= 2 ? sub.at(-1) : null, text };
  }
  return null;
}

export async function newsDiscover(intent, log) {
  if (!process.env.SERPER_API_KEY || !aiAvailable()) return [];
  const cos = intent.companies.length ? intent.companies : [null];
  const queries = [];
  for (const c of cos) {
    const co = c ? ` "${c}"` : '';
    queries.push(`"${intent.college}" student placed${co}`, `"${intent.college}" alumnus${co}`, `"${intent.college}" secures package${co}`);
    for (const y of intent.batches.slice(-3)) queries.push(`"${intent.college}" "batch ${y}"${co} placed`);
  }
  log(`Placement-news agent: searching news & public posts (${queries.length} queries)…`, 'run', 'news');
  const docs = new Map();
  await Promise.all(queries.map(async (q) => {
    const [web, news] = await Promise.all([serperQuery(q, 1).then((j) => j.organic || []).catch(() => []), serperNews(q)]);
    for (const o of [...web, ...news]) {
      if (!o.link || docs.has(o.link)) continue;
      const blob = `${o.title} ${o.snippet}`;
      if (!mentionsCollege(blob, intent.college) || !/placed|secur|package|lpa|offer|joins|joined|recruit|alumn|batch/i.test(blob)) continue;
      docs.set(o.link, { url: o.link, snippet: blob });
    }
  }));
  const list = [...docs.values()].slice(0, 12);
  for (const d of list) d.text = ((await pageText(d.url)) || d.snippet);
  const people = new Map();
  for (let i = 0; i < list.length; i += 4) {
    const batch = await Promise.all(list.slice(i, i + 4).map((d) => extract(intent, d).then((ps) => ps.map((p) => ({ ...p, source: d.url }))).catch(() => [])));
    for (const p of batch.flat()) if (!people.has(nameKey(p.name))) people.set(nameKey(p.name), p);
  }
  const now = new Date().getFullYear();
  let skipped = 0;
  const wanted = [...people.values()].filter((p) => {
    const gy = Number.isInteger(p.grad_year) ? p.grad_year : null;
    if (gy && gy >= now) { skipped++; return false; }                                         // offer received but not graduated yet
    if (intent.batches.length && (!gy || !intent.batches.includes(gy))) { skipped++; return false; }
    if (intent.companies.length && !(p.company && intent.companies.some((c) => norm(p.company).includes(norm(c))))) { skipped++; return false; }
    return true;
  }).slice(0, 15);
  const out = [];
  await Promise.all(wanted.map(async (p) => {
    const li = await linkedinFor(p, intent.college);
    const host = new URL(p.source).hostname.replace(/^www\./, '');
    if (p.name.trim().split(/\s+/).length < 2 || !li) return; // must be contactable via LinkedIn
    out.push({
      name: p.name.replace(/\b\w/g, (c) => c.toUpperCase()), title: li?.title || p.program || null, company: li?.current || p.company || null,
      location: li?.location || null, batch: p.grad_year, batch_source: 'news', college: intent.college, linkedin: li?.linkedin || null, email: null,
      source: 'news', headline: [p.program, p.company].filter(Boolean).join(' · '), evidence: `Placement news (${host}): "${p.quote}"`,
    });
  }));
  log(`Placement-news agent: ${list.length} articles read, ${people.size} people extracted, ${out.length} match your filters (${out.filter((o) => o.linkedin).length} linked to LinkedIn)${skipped ? `, ${skipped} skipped (batch/company/not graduated)` : ''}`, 'ok', 'news');
  return out;
}
