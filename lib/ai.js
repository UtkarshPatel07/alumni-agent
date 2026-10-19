// Gemini helper + AI verifier ("AI judge").
// The AI never adds data on its own: every verdict must quote words that literally exist in the real Google/LinkedIn snippet,
// and that quote is re-checked in code. Anything it cannot prove is discarded.
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
export const aiAvailable = () => !!process.env.GEMINI_API_KEY;

export async function gemini(prompt, { timeout = 20000 } = {}) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeout),
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || r.statusText);
  const txt = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return JSON.parse(txt.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim());
}

const EDU_PROOF = /\b(b\.?\s?tech|m\.?\s?tech|b\.?\s?e\b|bachelor|master|mba|bba|bca|mca|b\.?\s?sc|m\.?\s?sc|b\.?\s?com|m\.?\s?com|pgdm|ph\.?\s?d|diploma|degree|graduat\w*|alumn\w*|studied|batch|class of|education|activities and societies|cgpa|gpa|engineering|b\.?\s?pharm|m\.?\s?pharm|llb|b\.?\s?des)/i;
const norm = (s = '') => s.toLowerCase().replace(/[\u2013\u2014]/g, '-').replace(/[^a-z0-9@.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * @param intent      { college, batches }
 * @param candidates  [{ name, title, company, text }]
 * @param mentionsCollege (quote) => boolean   exact-institution check from sources.js
 * @returns array aligned with candidates: { verdict, grad_year, quote } | null (no valid judgement)
 */
export async function aiVerify(intent, candidates, mentionsCollege) {
  const out = new Array(candidates.length).fill(null);
  if (!aiAvailable() || !candidates.length) return out;
  const years = intent.batches.length ? `${intent.batches[0]}-${intent.batches.at(-1)}` : 'any';
  const chunks = [];
  for (let i = 0; i < candidates.length; i += 12) chunks.push(candidates.slice(i, i + 12).map((c, k) => ({ ...c, i: i + k })));
  const ask = async (chunk) => {
    const prompt = `You verify LinkedIn search-result snippets for a university alumni directory.
Target institution: "${intent.college}". Only this exact institution counts. A different institution with a similar name (for example "${intent.college} of Applied Sciences", a sister college, or a different campus brand) does NOT count. A mention inside a club, event, hackathon, certification or "people also viewed" does NOT count.
Requested graduation years: ${years}.
For each candidate return one verdict:
- "alumnus": the text shows they STUDIED at the target institution and have finished.
- "student": still studying there ("Student at", "pursuing", education end year in the future).
- "staff": works or worked/taught at the target institution (job titles, "Full-time", month-year ranges like "Jul 2016 - Jan 2018" are EMPLOYMENT, not study).
- "other": they studied somewhere else, or the target is mentioned only incidentally.
- "unclear": not enough evidence.
grad_year: the year their studies at the target institution ended, ONLY if that year is written in the text next to the institution/degree; otherwise null. Ignore ranges longer than 6 years (they mix school and college).
quote: copy the exact words from the text (max 25 words) that prove the verdict. Never paraphrase, never invent.
Return ONLY a JSON array: [{"i":<number>,"verdict":"...","grad_year":<number|null>,"quote":"..."}]

Candidates:
${chunk.map((c) => `[${c.i}] ${c.name} | ${c.title || ''} @ ${c.company || ''}\nTEXT: ${c.text}`).join('\n\n')}`;
    try {
      const res = await gemini(prompt);
      for (const v of Array.isArray(res) ? res : res.results || []) {
        const c = candidates[v.i];
        if (!c || !v.verdict) continue;
        const quoteOk = v.quote && norm(c.text).includes(norm(v.quote)) && norm(v.quote).length >= 6;
        if (!quoteOk) continue;                                                  // hallucinated quote => ignore the judgement
        if (v.verdict === 'alumnus' && !mentionsCollege(v.quote)) continue;      // proof must name the exact institution
        if (v.verdict === 'alumnus' && !EDU_PROOF.test(v.quote)) continue;       // proof must be about STUDYING (degree, batch, education), not a job
        const gy = Number.isInteger(v.grad_year) && new RegExp(`\\b${v.grad_year}\\b`).test(c.text) ? v.grad_year : null;
        out[v.i] = { verdict: v.verdict, grad_year: gy, quote: v.quote };
      }
    } catch { /* AI unavailable for this chunk => rules-only decision */ }
  };
  for (let i = 0; i < chunks.length; i += 3) await Promise.all(chunks.slice(i, i + 3).map(ask));
  return out;
}
