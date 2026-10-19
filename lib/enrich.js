// Email enrichment from legitimate public sources only. Never guesses addresses.
//  1) GitHub profile email (only if the person chose to make it public)
//  2) Public web pages via Google (Serper) – personal sites, papers, speaker bios, etc.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const JUNK = /noreply|no-reply|example\.|@sentry|@2x|\.png|\.jpg|support@|info@|contact@|privacy@|press@/i;
const tokens = (name) => name.toLowerCase().replace(/[^a-z ]/g, '').split(' ').filter((t) => t.length >= 3);
const collegeDomain = (email, college) => { const dom = email.split('@')[1].toLowerCase().split('.').slice(0, -1).join('').replace(/[^a-z]/g, ''); const c = (college || '').toLowerCase().replace(/[^a-z]/g, ''); return dom.length >= 4 && (c.includes(dom) || dom.includes(c)); };
// Accept a public-web email only if it is a personal mailbox or belongs to the person's CURRENT company.
// (Random old-employer addresses like name@previouscompany.com are rejected.)
const PERSONAL = /@(gmail|outlook|hotmail|yahoo|proton|protonmail|icloud|live)\./i;
const domainOk = (email, a) => PERSONAL.test(email) || (a.company && email.split('@')[1].toLowerCase().replace(/[^a-z]/g, '').includes(a.company.toLowerCase().replace(/[^a-z]/g, '')));
const plausible = (email, name) => { const l = email.split('@')[0].toLowerCase().replace(/[^a-z]/g, ''); return tokens(name).some((t) => l.includes(t)); };

async function github(a) {
  const h = { 'user-agent': 'AlumniAgentMVP', accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const s = await fetch(`https://api.github.com/search/users?per_page=3&q=${encodeURIComponent(`"${a.name}" in:fullname`)}`, { headers: h, signal: AbortSignal.timeout(8000) });
  if (!s.ok) return null;
  for (const it of (await s.json()).items || []) {
    const u = await (await fetch(it.url, { headers: h, signal: AbortSignal.timeout(8000) })).json();
    const blob = `${u.company || ''} ${u.bio || ''}`.toLowerCase();
    const sameCo = !!a.company && blob.includes(a.company.toLowerCase());
    const sameName = u.name && tokens(a.name).every((t) => u.name.toLowerCase().includes(t));
    if (u.email && !collegeDomain(u.email, a.college) && sameName && (sameCo || (a.location && u.location && a.location.toLowerCase().includes(u.location.toLowerCase().split(',')[0])))) {
      return { email: u.email, via: `GitHub profile (${u.html_url})` };
    }
  }
  return null;
}

async function web(a) {
  if (!process.env.SERPER_API_KEY) return null;
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST', headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ q: `"${a.name}"${a.company ? ` "${a.company}"` : ` "${a.college}"`} email "@"`, num: 10 }), signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) return null;
  for (const o of (await r.json()).organic || []) {
    const hay = `${o.title} ${o.snippet}`;
    if (!hay.toLowerCase().includes(tokens(a.name)[0] || '~')) continue;
    const hit = (hay.match(EMAIL_RE) || []).find((e) => !JUNK.test(e) && plausible(e, a.name) && !collegeDomain(e, a.college) && domainOk(e, a));
    if (hit) return { email: hit.toLowerCase(), via: `Public web (${new URL(o.link).hostname})` };
  }
  return null;
}

export async function enrichEmail(a) {
  for (const f of [github, web]) { try { const r = await f(a); if (r) return r; } catch { /* try next source */ } }
  return null;
}
