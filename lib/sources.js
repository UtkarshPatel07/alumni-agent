import { aiVerify, aiAvailable } from './ai.js';
import { newsDiscover } from './news.js';
import { leetcodeDiscover, topmateDiscover, crossCheckLinkedIn } from './platforms.js';
// Discovery sources. Each returns normalized alumni records. No emails are ever guessed or fabricated.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AlumniAgentMVP/1.0';
const clean = (s = '') => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

const SAMPLE = [
  ['Aarav Mehta', 'Software Engineer', 'Google', 'Bengaluru, India', 2022],
  ['Ishita Rao', 'Cloud Solutions Architect', 'Microsoft', 'Hyderabad, India', 2021],
  ['Kabir Shah', 'Applied Scientist', 'Microsoft', 'Seattle, USA', 2023],
  ['Meera Nair', 'Database Engineer', 'Oracle', 'Mumbai, India', 2020],
  ['Rohan Iyer', 'ML Engineer', 'Google', 'Zurich, Switzerland', 2024],
  ['Sanya Kapoor', 'Product Analyst', 'Oracle', 'Pune, India', 2025],
  ['Dev Malhotra', 'SDE II', 'Microsoft', 'Dublin, Ireland', 2022],
  ['Tanvi Joshi', 'Data Scientist', 'Google', 'London, UK', 2023],
].map(([name, title, company, location, batch], i) => ({
  name, title, company, location, batch, headline: `${title} at ${company}`, source: 'sample',
  college: 'Universal AI University', linkedin: `https://www.linkedin.com/in/sample-${i}-demo`, email: null,
  evidence: 'Fictional sample record for demo purposes',
}));

/** People Data Labs - structured, licensed data. Needs PDL_API_KEY. Returns work emails when plan allows. */
async function pdl(intent, log) {
  const esc = (s) => s.replace(/'/g, "''");
  const sql = `SELECT * FROM person WHERE education.school.name='${esc(intent.college.toLowerCase())}' AND job_company_name IN (${intent.companies.map((c) => `'${esc(c.toLowerCase())}'`).join(',')})`;
  const r = await fetch(`https://api.peopledatalabs.com/v5/person/search?size=25&sql=${encodeURIComponent(sql)}`, {
    headers: { 'X-Api-Key': process.env.PDL_API_KEY }, signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || r.statusText);
  log(`PDL returned ${j.data?.length || 0} profiles`);
  return (j.data || []).map((p) => {
    const edu = (p.education || []).find((e) => /universal ai/i.test(e.school?.name || ''));
    const batch = edu?.end_date ? +String(edu.end_date).slice(0, 4) : null;
    return {
      name: p.full_name?.replace(/\b\w/g, (c) => c.toUpperCase()), title: p.job_title, company: p.job_company_name?.replace(/\b\w/g, (c) => c.toUpperCase()),
      location: p.location_name, batch, headline: p.headline, college: intent.college, source: 'pdl',
      linkedin: p.linkedin_url ? `https://${p.linkedin_url.replace(/^https?:\/\//, '')}` : null,
      email: p.work_email || (p.emails?.[0]?.address ?? null), evidence: 'People Data Labs',
    };
  });
}

/** Google results via Serper.dev (SERPER_API_KEY). Serper exposes LinkedIn "subtitle" = "Location - Title - Company". */
// Shared rate limiter: Serper allows 5 requests/second across ALL agents running in parallel -> space calls ~230ms apart,
// and retry automatically when the API says "rate limit".
let nextSlot = 0;
export async function serperThrottle() { const now = Date.now(); const wait = Math.max(0, nextSlot - now); nextSlot = Math.max(now, nextSlot) + 230; if (wait) await new Promise((r) => setTimeout(r, wait)); }
export async function serperQuery(q, page = 1, attempt = 0) {
  await serperThrottle();
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST', headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ q, num: 10, page }), signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if ((r.status === 429 || /rate limit/i.test(j.message || '')) && attempt < 4) { await new Promise((res) => setTimeout(res, 1200 * (attempt + 1))); return serperQuery(q, page, attempt + 1); }
    throw new Error(j.message || r.statusText);
  }
  return j;
}

/**
 * Query plan (learned from analysis):
 *  - batch-range queries ("2016 - 2020") make Google show the EDUCATION section with dates -> batch year becomes provable
 *  - degree queries ("Bachelor of Technology", "MBA") also surface the education section
 *  - broad + role queries widen coverage
 */
function planQueries(intent, company) {
  const base = `site:linkedin.com/in ${collegeQuery(intent.college)}${company ? ` "${company}"` : ''}`;
  const years = intent.batches.slice(-7);
  const plan = [[base, 1, null], [base, 2, null], [base, 3, null]];
  // 4-year (B.Tech), 3-year (BBA/BCA/B.Sc) and 2-year (MBA/MCA/M.Tech) programmes ending in each requested batch year
  for (const y of years) plan.push([`${base} "${y - 4} - ${y}"`, 1, [y - 4, y]], [`${base} "${y - 4} - ${y}"`, 2, [y - 4, y]], [`${base} "${y - 3} - ${y}"`, 1, [y - 3, y]], [`${base} "${y - 2} - ${y}"`, 1, [y - 2, y]]);
  // Big colleges: sweep the top campus recruiters too (each returns a different slice of alumni)
  if (!company) for (const r of ['TCS', 'Infosys', 'Accenture', 'Wipro', 'Cognizant', 'Capgemini', 'HCLTech', 'Deloitte', 'Amazon', 'Genpact', 'EY', 'KPMG']) plan.push([`${base} "${r}"`, 1, null]);
  // DEEP SEARCH: many more distinct slices (Google returns max 10 per query, so coverage = number of different queries)
  if (intent.deep) {
    const co = company ? ` "${company}"` : '';
    plan.push([base, 4, null], [base, 5, null]);
    for (const n of (intent.constituents || []).slice(0, 10)) plan.push([`site:linkedin.com/in "${n}"${co}`, 1, null]);
    for (const n of [intent.college, ...(intent.aliases || [])].slice(0, 4)) plan.push([`site:linkedin.com/in "${n}"${co}`, 1, null], [`site:linkedin.com/in "${n}"${co}`, 2, null]);
    for (const y of years) plan.push([`${base} "${y - 4} - ${y}"`, 3, [y - 4, y]], [`${base} "${y - 3} - ${y}"`, 2, [y - 3, y]], [`${base} "${y - 2} - ${y}"`, 2, [y - 2, y]], [`${base} "${y}"`, 1, null]);
    for (const c of ['Bengaluru', 'Pune', 'Mumbai', 'Delhi', 'Gurugram', 'Hyderabad', 'Noida', 'Chennai', 'Kolkata', 'Dubai', 'London', 'United States']) plan.push([`${base} "${c}"`, 1, null]);
    for (const r of ['Developer', 'Associate', 'Lead', 'Marketing', 'Finance', 'Human Resources', 'Operations', 'Sales', 'Designer', 'Lawyer', 'Data', 'Product']) plan.push([`${base} "${r}"`, 1, null]);
    if (!company) for (const r of ['Google', 'Microsoft', 'IBM', 'Oracle', 'JPMorgan', 'Goldman Sachs', 'American Express', 'Barclays', 'HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Reliance', 'Tata', 'Mahindra', 'Bajaj', 'PwC', 'ZS Associates', 'Flipkart', 'Paytm', 'Zomato', 'Swiggy', 'Byju', 'Ernst', 'Bosch', 'Siemens', 'Adobe', 'SAP', 'Dell', 'Cisco', 'L&T']) plan.push([`${base} "${r}"`, 1, null]);
  }
  for (const d of ['"Bachelor of Technology"', '"B.Tech"', '"MBA"', '"Master of"']) plan.push([`${base} ${d}`, 1, null]);
  for (const r of ['"Software Engineer"', '"Analyst"', '"Manager"', '"Consultant"']) plan.push([`${base} ${r}`, 1, null]);
  if (!years.length) { plan.push([base, 3, null]); for (const r of ['"Engineer"', '"Data"', '"Product"']) plan.push([`${base} ${r}`, 1, null]); }
  return plan;
}

const profileKey = (u = '') => u.toLowerCase().split('?')[0].replace(/^https?:\/\/([a-z]{2,3}\.)?/, '').replace(/\/+$/, '');

async function serper(intent, company, log) {
  const plan = planQueries(intent, company);
  const status = new Map(); // linkedin -> { rec } | { review } | { reject }
  const rank = (s) => (s.veto ? 4 : s.rec ? 3 : s.review ? 2 : 1);
  const VETO = new Set(['outside requested batch', 'current student', 'staff of the college', 'currently at the college']);
  let raw = 0, idx = 0, failed = false; const retried = new Set();
  const worker = async () => {
    while (idx < plan.length && !failed) {
      const [q, page, range] = plan[idx++];
      try {
        const j = await serperQuery(q, page);
        for (const o of j.organic || []) {
          raw++;
          const r = toRecord(intent, company, o.link, clean(o.title), clean(o.snippet), clean(o.subtitle), { range });
          const key = profileKey((r.rec || r.candidate)?.linkedin || o.link);
          // Hard evidence AGAINST a person (outside batch, student, staff) found in ANY snippet always wins over a weaker positive one
          const next = r.rec ? { rec: r.rec } : r.candidate ? { review: r.candidate } : { reject: r.reject, veto: VETO.has(r.reject) };
          const prev = status.get(key);
          if (!prev || rank(next) > rank(prev)) status.set(key, next);
          else if (prev.rec && next.rec && !prev.rec.batch && next.rec.batch) prev.rec.batch = next.rec.batch; // later query proved the year
        }
      } catch (e) {
        if (/fetch failed|timeout|aborted/i.test(e.message) && !retried.has(q + page)) { retried.add(q + page); plan.push([q, page, range]); await new Promise((r) => setTimeout(r, 1200)); }
        else if (!/fetch failed|timeout|aborted/i.test(e.message)) { failed = true; log(`Serper query failed: ${e.message}`, 'warn'); }
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const items = [], review = [], reasons = {};
  for (const s of status.values()) { if (s.rec) items.push(s.rec); else if (s.review) review.push(s.review); else reasons[s.reject] = (reasons[s.reject] || 0) + 1; }
  log(`Google (Serper) "${company || 'any company'}": ${plan.length} queries, ${raw} hits, ${status.size} unique profiles -> ${items.length} proven, ${review.length} for AI review`);
  return { items, review, reasons };
}

const BAD_EMPLOYER = /ambassador|campus|student club|analytics certif/i;
const ORG_NAME = /university|institute|college|school|iit\b|nit\b|academy|google|microsoft|oracle|company|team|group|alumni/i;
const STAFF = /student|pursuing|aspiring|professor|faculty|dean|chancellor|registrar|placement officer|alumni relations|teaching associate|lecturer|admissions/i;
const EDU_WORDS = /b\.?\s?tech|bba|mba|m\.?tech|attended|junior|senior @|batch|memoria|\bclass of\b|undergrad|\bpursuing\b|enthusiast/i;
const JOBWORD = /\b(evangelist|consultant|manager|engineer|specialist|executive|analyst|freelanc\w*|self[- ]employed|looking|seeking|open to|student|intern|enthusiast)\b/i;
// Alias registry: official name + short forms of the SAME institution (from the AI planner), e.g. UPES <-> University of Petroleum and Energy Studies
const ALIASES = new Map();
export function setAliases(college, list = []) { ALIASES.set(college.toLowerCase(), [...new Set(list.map((x) => x.toLowerCase().trim()).filter((x) => x.length >= 3))]); }
/** Google query fragment matching any name of the college: ("Official Name" OR "SHORT") */
export function collegeQuery(college) { const names = [college, ...(ALIASES.get(college.toLowerCase()) || []).filter((a) => a.split(' ').length <= 4)].slice(0, 3); return names.length > 1 ? `(${names.map((n) => `"${n}"`).join(' OR ')})` : `"${college}"`; }
/** Whole-word search so a short alias like "upes" never matches inside another word */
const findA = (low, a, from = 0) => { const re = new RegExp(`(?<![a-z0-9])${rx(a)}(?![a-z0-9])`, 'g'); re.lastIndex = from; const m = re.exec(low); return m ? m.index : -1; };
const ra = (a) => `(?<![a-z0-9])${rx(a)}(?![a-z0-9])`;
const collegeAliases = (c) => {
  const a = [c.toLowerCase(), ...(ALIASES.get(c.toLowerCase()) || [])];
  const m = c.match(/^(IIT|NIT|IIIT|BITS)\s+(.+)$/i);
  if (m) {
    const full = { IIT: 'Indian Institute of Technology', NIT: 'National Institute of Technology', IIIT: 'Indian Institute of Information Technology', BITS: 'Birla Institute of Technology and Science' }[m[1].toUpperCase()];
    a.push(`${full} ${m[2]}`.toLowerCase(), `${full}, ${m[2]}`.toLowerCase());
  }
  if (/^birla institute of technology/i.test(c)) a.push('bits pilani');
  return a;
};

function cleanName(raw) {
  return raw.replace(/\b(Dr|Prof|Mr|Ms|Mrs)\.?\s+/i, '').replace(/,.*$/, '').replace(/\s*\(.*?\)/g, '')
    .replace(/[^\p{L}\s.'-]/gu, '').replace(/\s+\./g, '').replace(/\s+/g, ' ').trim();
}

/** Turn a raw LinkedIn "company" string into a real company name, or null if it is really a job description. */
function cleanCompany(raw) {
  if (!raw) return null;
  if (/\|/.test(raw)) return null;                       // "F&A || SAP FI Consultant" -> ambiguous
  const c = raw.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!c || c.length > 60 || JOBWORD.test(c)) return null; // "AI Evangelist" -> not a company
  return c;
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+';
const DEGREE = /bachelor|master|\bmba\b|\bbba\b|b\.?\s?tech|m\.?\s?tech|\bbca\b|\bmca\b|\bb\.?sc\b|\bm\.?sc\b|\bb\.?com\b|\bpgdm\b|\bdiploma\b|degree|engineering|\bb\.?e\b/i;
/** Graduation year for THIS college. Only trusts education-style dates (ignores job dates like "Jun 2019 - Present"). */
export function graduationYear(text, college) {
  const t = text.replace(/\s+/g, ' ');
  const cls = t.match(/(?:class of|batch of|batch|passed out in|pass ?out(?: year)?:?)\s*['’]?\s*(20[0-3]\d)\b/i);
  if (cls) return +cls[1];
  for (const a of collegeAliases(college)) {
    const m = new RegExp(`(?<![a-z0-9])${rx(a)}\\s*['’\u2019]\\s?(\\d{2})(?!\\d)`, 'i').exec(t);
    if (m) return 2000 + +m[1];
  }
  const rangeRe = new RegExp(`(?<!${MONTH})\\b(20[0-2]\\d)\\s*[-\\u2013\\u2014]\\s*(20[0-3]\\d)\\b`, 'i');
  const singleRe = new RegExp(`(?<!${MONTH})\\b(20[0-3]\\d)\\b(?!\\s*[-\\u2013\\u2014]\\s*(?:present|current))`, 'i');
  for (const a of collegeAliases(college)) {
    const i = findA(t.toLowerCase(), a);
    if (i < 0) continue;
    const win = t.slice(i, i + a.length + 160);
    const r = win.match(rangeRe);
    if (r && +r[2] - +r[1] <= 6) return +r[2];
    if (DEGREE.test(win)) { const y = win.slice(a.length).match(singleRe); if (y) return +y[1]; }
  }
  return null;
}

/** True only if the profile text shows the person STUDIED at the college.
 *  - If LinkedIn's "Education:" field is present it must be this college.
 *  - Mentions inside clubs/communities ("Google Developer Student Clubs - X") don't count. */
const CLUB = /(club|clubs|chapter|ambassador|society|community|cell|council|fest|hackathon|student developer|developer student)[^.|·]{0,25}$/i;
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Returns {how, quote} only with STRONG proof the person studied at the college, else null.
 *  Accepted proof (from Google's copy of the public LinkedIn profile):
 *   1. LinkedIn "Education:" field names the college
 *   2. LinkedIn top card "<current company> <college>" (LinkedIn shows current employer + school side by side)
 *   3. An explicit education phrase: "B.Tech ... <college>", "<college> alumnus/graduate"
 *  A loose mention anywhere on the page (clubs, "people also viewed", random words) is NOT accepted. */
function collegeEvidence(text, college, employers = []) {
  const t = text.replace(/\s+/g, ' ');
  const aliases = collegeAliases(college);
  const quote = (i, len) => t.slice(Math.max(0, i - 60), i + len + 40).trim();
  const edu = t.match(/Education:\s*([^·|]+?)(?:\s+·|\s+\||\s+Location:|$)/i);
  if (edu) {
    const v = edu[1].trim().toLowerCase().replace(/\.\.\.|…/g, '').trim();
    const sameInst = (a) => { const k = findA(v, a); return (k >= 0 && !/^\s+(of\s+[a-z]+|international|institute|college|school)\b/.test(v.slice(k + a.length))) || (v.length >= 6 && a.startsWith(v)); };
    return aliases.some(sameInst) ? { how: 'LinkedIn Education field', quote: quote(edu.index, edu[0].length) } : null;
  }
  for (const emp of employers) for (const a of aliases) {
    const m = new RegExp(`${rx(emp)}[\\s.,·|-]{1,4}${ra(a)}(?!\\s+of\\s+[A-Za-z])(?!\\s+(?:international|institute|college|school)\\b)`, 'i').exec(t);
    if (m) return { how: 'LinkedIn top card (current company + school)', quote: quote(m.index, m[0].length) };
  }
  for (const a of aliases) {
    const m = new RegExp(`\\b(alumn\\w*|graduat\\w*|studied|b\\.?\\s?tech|m\\.?\\s?tech|mba|bba|bca|mca|b\\.?sc|m\\.?sc|b\\.?com|pgdm|bachelor\\w*|master\\w*)\\b[^.|·]{0,40}${ra(a)}(?!\\s+of\\s+[A-Za-z])(?!\\s+(?:international|institute|college|school)\\b)|${ra(a)}(?!\\s+of\\s+[A-Za-z])(?!\\s+(?:international|institute|college|school)\\b)[^.|·]{0,15}\\b(alumn\\w*|graduat\\w*)`, 'i').exec(t);
    if (m && !CLUB.test(t.slice(Math.max(0, m.index - 45), m.index))) return { how: 'Education stated on profile', quote: quote(m.index, m[0].length) };
  }
  return null;
}

/** Finds the college's official LinkedIn school page (for LinkedIn's own alumni tool with year filters). */
export async function findSchool(college) {
  if (!process.env.SERPER_API_KEY) return null;
  const j = await serperQuery(`site:linkedin.com/school "${college}"`, 1);
  const want = college.toLowerCase();
  const hit = (j.organic || []).find((o) => /linkedin\.com\/school\/[^/?]+/.test(o.link) && o.title.toLowerCase().startsWith(want) && !/online|school-of|alumni-association/i.test(o.link))
    || (j.organic || []).find((o) => /linkedin\.com\/school\/[^/?]+/.test(o.link) && o.title.toLowerCase().includes(want));
  if (!hit) return null;
  const slug = hit.link.match(/linkedin\.com\/school\/([^/?]+)/)[1];
  return { slug, url: `https://www.linkedin.com/school/${slug}/` };
}

const GENERIC = /^(university|college|institute|institution|school|academy|of|the|and|for|international|national|deemed|technology|technological|management|engineering|sciences?|studies|research|ai|campus)$/;
const distinctWords = (s = '') => s.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !GENERIC.test(w));
/** "SYMBIOSIS" / "Symbiosis International University" / "Galgotias University" as employer => works at the college. */
export function worksAtCollege(emp, college) {
  const ew = distinctWords(emp);
  if (!ew.length) return false;
  return collegeAliases(college).some((al) => { const cw = distinctWords(al); return cw.length > 0 && ew.length <= cw.length + 3 && cw.every((w) => ew.includes(w)); });
}

const SENIOR = /\b(vice president|vp|avp|svp|evp|director|general manager|head of|chief [a-z]+ officer|managing partner)\b/i;
/** Returns a reason if the visible career history makes the requested batch impossible (used only when the batch year itself is unknown). */
export function careerVeto(text, title, intent) {
  if (!intent.batches.length) return null;
  const minB = Math.min(...intent.batches), now = new Date().getFullYear();
  const t = (text || '').replace(/\s+/g, ' ');
  const work = [...t.matchAll(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+((?:19|20)\d\d)\b/gi)].map((m) => +m[1]);
  const earliest = work.length ? Math.min(...work) : null;
  if (earliest && earliest < minB - 6) return `career started ${earliest}`;
  const durs = [...t.matchAll(/\b(\d{1,2})\+?\s*(?:yrs?|years?)\b(?!\s*old)/gi)].map((m) => +m[1]).filter((n) => n > 0 && n < 45);
  const maxDur = durs.length ? Math.max(...durs) : 0;
  if (maxDur && now - maxDur < minB - 6) return `${maxDur}+ years of experience`;
  if (minB >= now - 8 && SENIOR.test(`${title || ''} ${t.slice(0, 220)}`)) return 'too senior for requested batch';
  return null;
}

/** Exact-institution check used to validate AI quotes ("Symbiosis University" != "Symbiosis University of Applied Sciences"). */
export function mentionsCollege(text, college) {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  return collegeAliases(college).some((a) => { let i = findA(t, a); while (i >= 0) { if (!/^\s+(of\s+[a-z]+|international|institute|college|school)\b/.test(t.slice(i + a.length))) return true; i = findA(t, a, i + 1); } return false; });
}

/** Returns { rec } (proven alumnus), { reject, candidate } (passes every check but proof is weak -> AI review) or { reject }. */
function toRecord(intent, company, url, title, snippet, subtitle = '', hint = {}) {
  const R = (reject, candidate) => ({ reject, candidate });
  if (!/linkedin\.com\/in\//i.test(url)) return R('not a profile');
  const parts = title.replace(/\s*\|\s*LinkedIn.*$/i, '').split(/\s[-\u2013]\s/);
  const name = cleanName(parts[0]);
  if (!name || name.split(' ').length < 2 || name.split(' ').length > 5 || /\.\.\.$/.test(parts[0]) || ORG_NAME.test(name)) return R('not a person');
  const sub = subtitle.split(/\s\u00b7\s/).map((s) => s.trim());
  const employer = sub.length >= 2 ? sub[sub.length - 1] : '';
  const titleAt = (parts[1] || '').match(/\bat\s+(.+)$/i)?.[1] || parts[2] || '';
  const cre = !company ? /$^/ : new RegExp(`^${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'i');
  if (company && !((employer && cre.test(employer) && !BAD_EMPLOYER.test(employer)) || (!employer && cre.test(titleAt.trim())))) return R('works elsewhere');
  const text = `${title} ${snippet} ${subtitle}`;
  if (/\bstudent (?:at|@)|\bcurrently pursuing\b|\bpursuing\b|\baspiring\b|\bfresher\b/i.test(`${title} ${snippet}`)) return R('current student');
  if ([employer, titleAt, (parts[1] || '').replace(/^.*\bat\s+/i, '')].some((emp) => worksAtCollege(emp, intent.college))) return R('staff of the college');
  if (collegeAliases(intent.college).some((a) => new RegExp(rx(a) + '[^|]{0,60}?(?:present|current)', 'i').test(text))) return R('currently at the college');
  const rawEmp = (employer || titleAt).trim();
  const empIsSchool = !company && /university|college|school|institute|academy|\.\.\.|\u2026/i.test(rawEmp);
  const employerName = company || (empIsSchool ? null : cleanCompany(rawEmp));
  const noEmployer = !company && !employerName; // decided after the graduation year is known
  const headline = `${sub.length >= 3 ? sub[1] : ''} ${parts.slice(1).join(' ')}`;
  if (!company && (STAFF.test(headline) || EDU_WORDS.test(headline))) return R('current student');
  let location = sub.length >= 3 ? sub[0] : (snippet.match(/(?:Location|Based in)[:\s]+([^\u00b7.|]+)/i)?.[1] || null);
  location = location?.trim().replace(/^Greater (.+) Area$/i, '$1') || null;
  if (location && (location.length < 3 || /^(greater|area|remote|\d+)$/i.test(location))) location = null;
  const jobTitle = (sub.length >= 3 ? sub[1] : (parts[1] || '').replace(/\s+at\s+.*$/i, '')) || null;
  if (jobTitle && /\b(company|inc\.?|ltd|llc)$/i.test(jobTitle)) return R('not a person');
  // Batch year: education dates next to the college, or the exact range this query asked for
  const hinted = hint.range && new RegExp(`${hint.range[0]}\\s*[-\u2013\u2014]\\s*${hint.range[1]}`).test(text) && mentionsCollege(text, intent.college) ? hint.range[1] : null;
  const year = graduationYear(text, intent.college) ?? hinted;
  if (year && year >= new Date().getFullYear()) return R('current student');
  if (noEmployer && !year) return R('no current employer');
  if (!year && careerVeto(text, jobTitle, intent)) return R('outside requested batch');                       // no job and no proven past graduation => could be a student
  if (year && intent.batches.length && !intent.batches.includes(year)) return R('outside requested batch');
  const linkedin = url.split('?')[0].replace(/https?:\/\/[a-z]{2,3}\.linkedin\.com/i, 'https://www.linkedin.com');
  const base = { name, title: jobTitle, company: employerName, location, batch: year, college: intent.college, linkedin, email: null, source: 'web',
    headline: [jobTitle, employerName].filter(Boolean).join(' at '), text: text.slice(0, 700) };
  const ev = collegeEvidence(text, intent.college, [employer, company, titleAt.trim()].filter((x) => x && x.length > 1));
  if (!ev) return mentionsCollege(text, intent.college) ? R('no proof of study', base) : R('different institution');
  return { rec: { ...base, evidence: `${ev.how}: "${ev.quote}"`, batch_source: year ? 'profile' : null } };
}


/** Keyless public web search (DuckDuckGo HTML) for public LinkedIn result snippets. Best-effort; may be rate-limited. */
async function webSearch(intent, company, log) {
  const q = `site:linkedin.com/in "${intent.college}"${company ? ` "${company}"` : ''}`;
  const r = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q }).toString(), signal: AbortSignal.timeout(12000),
  });
  const html = await r.text();
  if (/anomaly|captcha/i.test(html) || r.status === 202) throw new Error('search engine rate-limited');
  const out = [];
  for (const b of html.split('class="result results_links').slice(1)) {
    const href = b.match(/class="result__a"[^>]*href="([^"]+)"/)?.[1];
    const title = clean(b.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/)?.[1]);
    const snippet = clean(b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1]);
    if (!href || !title) continue;
    const url = decodeURIComponent((href.match(/uddg=([^&]+)/) || [, href])[1]);
    const r = toRecord(intent, company, url, title, snippet);
    if (r.rec) out.push(r.rec);
  }
  log(`Web search "${company}": ${out.length} public profile(s)`);
  return out;
}

export async function discover(intent, log) {
  setAliases(intent.college, [...(intent.aliases || []), ...(intent.constituents || [])]);
  if (intent.constituents?.length) log(`Counting alumni of its constituent institutes too: ${intent.constituents.slice(0, 6).join(', ')}${intent.constituents.length > 6 ? '…' : ''}`, 'info');
  if (intent.aliases?.length) log(`Also searching the other names of this college: ${intent.aliases.join(', ')}`, 'info');
  const results = [], review = [], reasons = {};
  let live = false;
  if (process.env.PDL_API_KEY) {
    try { results.push(...await pdl(intent, log)); live = true; } catch (e) { log(`PDL failed: ${e.message}`, 'warn'); }
  }
  const platP = Promise.all([
    leetcodeDiscover(intent, log).catch((e) => { log(`LeetCode agent failed: ${e.message}`, 'warn'); return []; }),
    topmateDiscover(intent, log).catch((e) => { log(`Topmate agent failed: ${e.message}`, 'warn'); return []; }),
  ]).then((a) => a.flat());
  const newsP = newsDiscover(intent, log).catch((e) => { log(`Placement-news agent failed: ${e.message}`, 'warn'); return []; });
  if (!results.length) {
    for (const c of intent.companies.length ? intent.companies : [null]) {
      try {
        if (process.env.SERPER_API_KEY) {
          const r = await serper(intent, c, log); live = true;
          results.push(...r.items); review.push(...r.review);
          for (const [k, v] of Object.entries(r.reasons)) reasons[k] = (reasons[k] || 0) + v;
        } else { results.push(...await webSearch(intent, c, log)); live = true; }
      } catch (e) { log(`Search failed for ${c || 'any company'}: ${e.message}`, 'warn'); }
    }
  }

  // AI judge: re-checks every proven profile (catches staff/students rules missed) and reviews weak-proof ones.
  if (aiAvailable() && (results.length || review.length)) {
    const all = [...results.map((r) => ({ r, proven: true })), ...review.map((r) => ({ r, proven: false }))];
    log(`AI judge (${process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'}) reviewing ${all.length} profile(s)…`, 'run', 'ai');
    const verdicts = await aiVerify(intent, all.map(({ r }) => r), (q) => mentionsCollege(q, intent.college));
    const kept = []; let judged = 0, rescued = 0;
    all.forEach(({ r, proven }, i) => {
      const v = verdicts[i];
      if (v) judged++;
      if (v && ['student', 'staff', 'other'].includes(v.verdict)) { const k = { student: 'current student (AI)', staff: 'staff of the college (AI)', other: 'different institution (AI)' }[v.verdict]; reasons[k] = (reasons[k] || 0) + 1; return; }
      if (!proven && !(v && v.verdict === 'alumnus')) { reasons['no proof of study'] = (reasons['no proof of study'] || 0) + 1; return; }
      if (!proven) { r.evidence = `AI-verified from profile text: "${v.quote}"`; rescued++; }
      if (v?.grad_year && !r.batch) {
        if (v.grad_year >= new Date().getFullYear()) { reasons['current student (AI)'] = (reasons['current student (AI)'] || 0) + 1; return; }
        if (intent.batches.length && !intent.batches.includes(v.grad_year)) { reasons['outside requested batch'] = (reasons['outside requested batch'] || 0) + 1; return; }
        r.batch = v.grad_year; r.batch_source = 'profile';
      }
      kept.push(r);
    });
    results.length = 0; results.push(...kept);
    log(`AI judge: ${judged} judged with verifiable quotes, ${rescued} extra alumni confirmed, ${kept.length} kept`, 'ok', 'ai');
  } else {
    for (const _ of review) reasons['no proof of study'] = (reasons['no proof of study'] || 0) + 1;
  }
  // Merge the placement-news source: same LinkedIn profile => upgrade batch/proof; otherwise add as a new alumnus
  const news = await newsP; let merged = 0, added = 0;
  const lk = (u) => (u || '').toLowerCase().replace(/\/+$/, '');
  const nk = (n) => (n || '').toLowerCase().replace(/[^a-z ]/g, '').split(' ').filter(Boolean).slice(0, 2).join(' ');
  for (const n of news) {
    const hit = results.find((r) => (n.linkedin && lk(r.linkedin) === lk(n.linkedin)) || nk(r.name) === nk(n.name));
    if (hit) { if (!hit.batch || hit.batch_source !== 'register') { hit.batch = n.batch; hit.batch_source = 'news'; } hit.evidence = `${hit.evidence} | ${n.evidence}`; merged++; }
    else { results.push(n); added++; }
  }
  // Merge LeetCode / Topmate (after their own checks + a LinkedIn cross-check)
  const plat = await platP;
  const fresh = plat.filter((p) => !results.some((r) => (p.linkedin && lk(r.linkedin) === lk(p.linkedin)) || nk(r.name) === nk(p.name)));
  for (const p of plat.filter((x) => !fresh.includes(x))) {
    const hit = results.find((r) => (p.linkedin && lk(r.linkedin) === lk(p.linkedin)) || nk(r.name) === nk(p.name));
    hit.source = [...new Set([...String(hit.source).split(','), p.source])].join(',');
    hit.linkedin ||= p.linkedin; hit.location ||= p.location; hit.title ||= p.title;
    hit.evidence = `${hit.evidence} | ${p.evidence}`;
  }
  const checked = await crossCheckLinkedIn(fresh, intent, log);
  for (const p of checked) { const dup = results.find((r) => p.linkedin && lk(r.linkedin) === lk(p.linkedin)); if (dup) { dup.source = [...new Set([...String(dup.source).split(','), p.source])].join(','); dup.evidence += ` | ${p.evidence}`; } else results.push(p); }
  if (plat.length) log(`Sources combined: ${checked.length} alumni added from LeetCode/Topmate, ${plat.length - fresh.length} already found on LinkedIn (now multi-source confirmed)`, 'ok');
  if (news.length) log(`Sources combined: LinkedIn search + placement news -> ${added} new alumni, ${merged} existing alumni got a news-confirmed batch`, 'ok');
  const rej = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  if (rej.length) log(`Rejected ${rej.reduce((s, [, n]) => s + n, 0)} profile(s): ${rej.map(([k, n]) => `${n} ${k}`).join(', ')}`, 'info');
  // Batch verification: for people whose year is unknown, look up their own LinkedIn education entry
  if (intent.batches.length) {
    const now = new Date().getFullYear();
    for (let i = results.length - 1; i >= 0; i--) if (!results[i].batch && careerVeto(results[i].text || '', results[i].title, intent)) { results.splice(i, 1); reasons['outside requested batch'] = (reasons['outside requested batch'] || 0) + 1; }
    const unknown = results.filter((r) => !r.batch && r.linkedin).slice(0, intent.deep ? 40 : 20);
    if (unknown.length) {
      log(`Batch-check agent: verifying graduation year of ${unknown.length} profile(s) on their own LinkedIn…`, 'run', 'bcheck');
      let ok = 0, bad = 0; const drop = new Set(); let k = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (k < unknown.length) {
          const r = unknown[k++]; const handle = (r.linkedin.split('/in/')[1] || '').replace(/\/+$/, '');
          if (!handle) continue;
          const j = await serperQuery(`site:linkedin.com/in/${handle} ${collegeQuery(intent.college)}`, 1).catch(() => ({}));
          const o = (j.organic || []).find((x) => x.link.toLowerCase().includes(handle.toLowerCase()));
          if (!o) continue;
          const text = `${o.title} ${o.snippet} ${o.subtitle || ''}`;
          const y = graduationYear(text, intent.college);
          if (y && (y >= now || !intent.batches.includes(y))) { drop.add(r); bad++; }
          else if (y) { r.batch = y; r.batch_source = 'profile'; r.evidence += ` | LinkedIn education ends ${y}`; ok++; }
          else if (careerVeto(text, r.title, intent)) { drop.add(r); bad++; }
        }
      }));
      for (let i = results.length - 1; i >= 0; i--) if (drop.has(results[i])) results.splice(i, 1);
      reasons['outside requested batch'] = (reasons['outside requested batch'] || 0) + bad;
      log(`Batch-check agent: ${ok} batch year(s) confirmed, ${bad} removed (graduated in another year)`, 'ok', 'bcheck');
    }
  }
  if (intent.batches.length) log(`Final: ${results.length} alumni, ${results.filter((r) => r.batch).length} with a proven batch year`, 'ok');
  for (const r of results) delete r.text;
  return { live, items: results };
}
