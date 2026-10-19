// Extra public platforms students/alumni use. Each connector returns alumni records that already passed strict checks.
//  - LeetCode: public profile has school + company + (often) the exact LinkedIn URL  -> official public GraphQL API
//  - Topmate:  alumni who offer mentoring publicly                                    -> Google index + AI extraction with verifiable quote
// Every record is then cross-checked against the person's own LinkedIn profile (batch year, location, still-a-student check).
import { serperQuery, mentionsCollege, graduationYear, worksAtCollege, collegeQuery } from './sources.js';
import { linkedinFor } from './news.js';
import { gemini, aiAvailable } from './ai.js';

const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s = '') => s.toLowerCase().replace(/[\u2013\u2014]/g, '-').replace(/[^a-z0-9 \-]+/g, ' ').replace(/\s+/g, ' ').trim();
const liNorm = (u) => (u ? u.split('?')[0].replace(/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com/i, 'https://www.linkedin.com').replace(/\/+$/, '') : null);
const companyOk = (co, intent) => !intent.companies.length || (co && intent.companies.some((c) => new RegExp(`(^|[^a-z])${rx(c.toLowerCase())}([^a-z]|$)`).test(co.toLowerCase())));
const NOT_EMPLOYER = /\b(aicte|internshala|nptel|smart india|gssoc|girlscript|google developer|gdsc|gdg|student|campus ambassador|virtual internship|freelanc\w*|self[- ]employed|open to work|looking)\b/i;
const STILL_STUDYING = /\bpursuing\b|\bcurrently studying\b|\bstudent (?:at|of|@)\b|\bi am (?:a )?(?:\d\w* year )?student\b|\bfinal[- ]year\b|\bpre[- ]final\b/i;
const pool = async (items, n, fn) => { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); } })); return out; };

// ---------------------------------------------------------------- LeetCode
async function lcUser(username) {
  const q = (fields) => fetch('https://leetcode.com/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json', referer: 'https://leetcode.com' }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ query: `query($u:String!){matchedUser(username:$u){username profile{${fields}} linkedinUrl githubUrl}}`, variables: { u: username } }),
  }).then((r) => r.json());
  let j = await q('realName school company jobTitle countryName');
  if (j.errors) j = await q('realName school company countryName');
  return j.data?.matchedUser || null;
}

export async function leetcodeDiscover(intent, log) {
  if (!process.env.SERPER_API_KEY) return [];
  const base = `site:leetcode.com/u ${collegeQuery(intent.college)}`;
  const qs = intent.companies.length ? intent.companies.flatMap((c) => [[`${base} "${c}"`, 1], [`${base} "${c}"`, 2]]) : [[base, 1], [base, 2], [base, 3]];
  const users = new Set();
  await Promise.all(qs.map(async ([q, p]) => {
    const j = await serperQuery(q, p).catch(() => ({}));
    for (const o of j.organic || []) { const m = o.link.match(/leetcode\.com\/u\/([^/?#]+)/i); if (m) users.add(m[1]); }
  }));
  const reasons = {}; const no = (r) => { reasons[r] = (reasons[r] || 0) + 1; return null; };
  const recs = (await pool([...users].slice(0, 30), 5, async (u) => {
    const d = await lcUser(u);
    if (!d) return no('profile unavailable');
    const p = d.profile || {}, school = (p.school || '').trim(), company = (p.company || '').trim(), job = (p.jobTitle || '').trim();
    if (!school || !mentionsCollege(school, intent.college)) return no('different institution');
    if (!company || NOT_EMPLOYER.test(company)) return no('no real employer (student programme / none)');
    if (/\bstudent\b|\bpursuing\b/i.test(`${company} ${job}`)) return no('current student');
    if (worksAtCollege(company, intent.college)) return no('staff of the college');
    if (!companyOk(company, intent)) return no('works elsewhere');
    return {
      name: (p.realName || '').trim() || d.username, title: job || null, company, location: p.countryName || null, batch: null,
      college: intent.college, linkedin: liNorm(d.linkedinUrl), email: null, source: 'leetcode',
      headline: [job, company].filter(Boolean).join(' at '),
      evidence: `LeetCode profile leetcode.com/u/${d.username}: school "${school}", company "${company}"${d.linkedinUrl ? ', LinkedIn linked by the user' : ''}`,
    };
  })).filter(Boolean);
  const rej = Object.entries(reasons).map(([k, v]) => `${v} ${k}`).join(', ');
  log(`LeetCode agent: ${users.size} public profiles found, ${recs.length} alumni pass checks (${recs.filter((r) => r.linkedin).length} with their own LinkedIn link)${rej ? `; rejected: ${rej}` : ''}`, 'ok');
  return recs;
}

// ---------------------------------------------------------------- Topmate (mentors)
export async function topmateDiscover(intent, log) {
  if (!process.env.SERPER_API_KEY || !aiAvailable()) return [];
  const base = `site:topmate.io ${collegeQuery(intent.college)}`;
  const qs = [[base, 1], [base, 2], ...intent.companies.map((c) => [`${base} "${c}"`, 1])];
  const docs = new Map();
  await Promise.all(qs.map(async ([q, p]) => {
    const j = await serperQuery(q, p).catch(() => ({}));
    for (const o of j.organic || []) if (/topmate\.io\/[^/?#]+\/?$/i.test(o.link) && !docs.has(o.link)) docs.set(o.link, { url: o.link, text: `${o.title}. ${o.snippet}` });
  }));
  const list = [...docs.values()].slice(0, 20);
  if (!list.length) { log('Topmate agent: no public mentor profiles for this college', 'info'); return []; }
  const res = await gemini(`For each public mentor profile below, decide about the target institution "${intent.college}" (exact institution only; a different institution with a similar name does not count).
Return ONLY a JSON array: [{"i":0,"name":"full name of the mentor","company":"current employer or null","title":"current role or null","studied_at_target":true|false,"works_at_target":true|false,"grad_year":number|null,"quote":"exact words (max 25) from the text proving they studied at the target"}]
studied_at_target is true only if the text says they studied / graduated there AND have finished (false if still pursuing/studying). grad_year only if written next to the institution. Never invent.

${list.map((d, i) => `[${i}] ${d.url}\nTEXT: ${d.text}`).join('\n\n')}`).catch(() => []);
  const out = [];
  for (const v of Array.isArray(res) ? res : []) {
    const d = list[v.i];
    if (!d || !v.studied_at_target || v.works_at_target || !v.name || !v.quote) continue;
    if (!norm(d.text).includes(norm(v.quote)) || !mentionsCollege(v.quote, intent.college)) continue;   // proof must be real
    if (STILL_STUDYING.test(d.text)) continue;                                                            // still a student
    const endY = graduationYear(d.text, intent.college);
    if (endY && endY >= new Date().getFullYear()) continue;                                              // graduates in the future
    if (endY && intent.batches.length && !intent.batches.includes(endY)) continue;
    if (v.company && NOT_EMPLOYER.test(v.company)) v.company = null;
    if (worksAtCollege(v.company || '', intent.college) || !companyOk(v.company, intent)) continue;
    const gy = Number.isInteger(v.grad_year) && new RegExp(`\\b${v.grad_year}\\b`).test(d.text) ? v.grad_year : null;
    if (gy && (gy >= new Date().getFullYear() || (intent.batches.length && !intent.batches.includes(gy)))) continue;
    out.push({
      name: v.name, title: v.title || null, company: v.company || null, location: null, batch: gy, batch_source: gy ? 'profile' : null,
      college: intent.college, linkedin: null, email: null, source: 'topmate', headline: [v.title, v.company].filter(Boolean).join(' at '),
      evidence: `Topmate mentor profile (${d.url.replace(/^https?:\/\//, '')}): "${v.quote}"`,
    });
  }
  log(`Topmate agent: ${list.length} mentor profiles read, ${out.length} verified alumni open to mentoring`, 'ok');
  return out;
}

// ---------------------------------------------------------------- LinkedIn cross-check for platform records
/** Uses the person's own LinkedIn profile to add batch year + city, and to drop current students / wrong batches. */
export async function crossCheckLinkedIn(recs, intent, log) {
  const now = new Date().getFullYear();
  let years = 0, dropped = 0, linked = 0;
  const checked = await pool(recs.slice(0, 20), 4, async (r) => {
    let text = '', sub = '';
    if (r.linkedin) {
      const handle = r.linkedin.split('/in/')[1];
      const j = await serperQuery(`site:linkedin.com/in/${handle} "${intent.college}"`, 1).catch(() => ({}));
      const o = (j.organic || []).find((x) => liNorm(x.link) === r.linkedin) || (j.organic || [])[0];
      if (o) { text = `${o.title} ${o.snippet} ${o.subtitle || ''}`; sub = o.subtitle || ''; const n = (o.title || '').split(/\s[-\u2013|]\s/)[0].trim(); if (!/\s/.test(r.name) && /\s/.test(n) && n.length < 40) r.name = n; }
    } else {
      const li = await linkedinFor({ name: r.name, company: r.company }, intent.college);
      if (li) { r.linkedin = li.linkedin; text = li.text || ''; linked++; if (li.location) r.location = li.location; if (!r.title && li.title) r.title = li.title; }
    }
    const parts = sub.split(/\s\u00b7\s/).map((s) => s.trim());
    if (parts.length >= 3) { r.location = parts[0]; if (!r.title) r.title = parts[1]; }
    if (text && STILL_STUDYING.test(text)) { dropped++; return null; }
    const y = text ? graduationYear(text, intent.college) : null;
    if (y && y >= now) { dropped++; return null; }                                           // still studying
    if (y && intent.batches.length && !intent.batches.includes(y)) { dropped++; return null; } // other batch
    if (y && !r.batch) { r.batch = y; r.batch_source = 'profile'; years++; r.evidence += ` | LinkedIn education ends ${y}`; }
    return r;
  });
  // A result is only useful if the student can contact the person: keep only records with a LinkedIn profile or email
  const all = [...checked.filter(Boolean), ...recs.slice(20)];
  const out = all.filter((r) => r.linkedin || r.email);
  dropped += all.length - out.length;
  if (recs.length) log(`LinkedIn cross-check: ${recs.length} platform alumni checked, ${linked} LinkedIn profiles found, ${years} batch years confirmed, ${dropped} dropped (student / other batch / no LinkedIn or email)`, 'ok');
  return out;
}
