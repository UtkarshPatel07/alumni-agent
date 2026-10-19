// Natural-language → structured intent. Uses an LLM when a key exists (Gemini or Hugging Face),
// otherwise a deterministic rule-based parser so the app always works offline.
const KNOWN = {
  google: 'Google', alphabet: 'Google', microsoft: 'Microsoft', oracle: 'Oracle', amazon: 'Amazon', aws: 'Amazon',
  meta: 'Meta', facebook: 'Meta', apple: 'Apple', nvidia: 'NVIDIA', adobe: 'Adobe', ibm: 'IBM', salesforce: 'Salesforce',
  infosys: 'Infosys', tcs: 'TCS', wipro: 'Wipro', accenture: 'Accenture', deloitte: 'Deloitte', flipkart: 'Flipkart',
};
const canon = (s) => KNOWN[s.toLowerCase().trim()] || s.trim().replace(/\b\w/g, (c) => c.toUpperCase());
const yr = (n) => (n < 100 ? 2000 + n : n);

const STOP = new Set(['from', 'of', 'and', 'batch', 'batches', 'in', 'at', 'the', 'a', 'an', 'alumni', 'alumnus', 'students', 'student', 'asked', 'for', 'to', 'who', 'work', 'works', 'working', 'find', 'me', 'give', 'show', 'only', 'i', 'want', 'need', 'please', 'class', 'with', 'pass', 'passed', 'out']);
function detectCollege(text) {
  const tokens = text.replace(/[,!?.]/g, ' ').split(/\s+/).filter(Boolean);
  // "<words> University|College|Institute|School" - take the capitalised-or-plain words directly before the keyword
  const kw = tokens.findIndex((w) => /^(university|college|institute|institution|school|academy|vidyapeeth)$/i.test(w));
  if (kw >= 0) {
    let i = kw;
    while (i > 0 && !STOP.has(tokens[i - 1].toLowerCase()) && !/^\d/.test(tokens[i - 1]) && kw - i < 5) i--;
    let end = kw;
    if (/^(of)$/i.test(tokens[kw + 1] || '') && tokens[kw + 2] && !/^\d/.test(tokens[kw + 2])) end = kw + 2; // "University of Mumbai"
    const name = tokens.slice(i, end + 1).join(' ');
    if (name.split(' ').length >= 2) return name;
  }
  if (/\buniversal\s*ai\b/i.test(text)) return 'Universal AI University';
  // Abbreviations only in CAPITALS (so "mit" inside normal words never matches), optionally followed by a Capitalised campus name
  const abbr = text.match(/\b(IIT|NIT|IIIT|BITS|VIT|SRM|MIT|NMIMS|DTU|NSIT|AIIMS|IIM)\b(?:\s+([A-Z][a-z]+))?/);
  if (abbr) return abbr[0].trim();
  // "alumni from/of <Name>" only if <Name> has a Capitalised word that isn't a filler or a company
  const c = text.match(/alumni\s+(?:from|of)\s+(.+?)(?:\s+(?:from|of|batch(?:es)?|who|working|in|at)\b|\s\d|[!,.]|$)/i);
  if (c) {
    const words = c[1].trim().split(/\s+/);
    const ok = words.some((w) => /^[A-Z]/.test(w) && !STOP.has(w.toLowerCase()) && !KNOWN[w.toLowerCase()]);
    if (ok) return c[1].trim();
  }
  return null; // unknown -> the agent asks the user instead of guessing
}
export function ruleParse(q) {
  const text = q.replace(/\s+/g, ' ').trim();
  let batches = [];
  const range = text.match(/\b(20\d{2}|\d{2})\s*(?:to|-|–|till|through)\s*(20\d{2}|\d{2})\b(?:\s*batch)?/i);
  if (range) {
    const [a, b] = [yr(+range[1]), yr(+range[2])].sort((x, y) => x - y);
    for (let y = a; y <= b; y++) batches.push(y);
  } else {
    batches = [...text.matchAll(/\b(20[12]\d)\b/g)].map((m) => +m[1]);
  }
  const lower = text.toLowerCase();
  const companies = new Set();
  const m = text.match(/(?:work(?:s|ing)?|employed|placed|based)\s+(?:at|in|with|for)\s+(.+?)(?:[!.?]|\bplease\b|\btell\b|\band share\b|$)/i);
  const seg = m ? m[1] : text;
  for (const part of seg.split(/,|\bor\b|\band\b|\//i)) {
    const k = part.trim().toLowerCase().replace(/[^a-z ]/g, '');
    if (KNOWN[k]) companies.add(KNOWN[k]);
  }
  if (!companies.size) for (const k of Object.keys(KNOWN)) if (new RegExp(`\\b${k}\\b`, 'i').test(lower)) companies.add(KNOWN[k]);
  const college = detectCollege(text);
  return {
    college, batches, companies: [...companies],
    wants: { location: /location|where|city|based|map/i.test(text), email: /e-?mail/i.test(text), linkedin: /linkedin/i.test(text) || true },
    engine: 'rules',
  };
}

async function llmParse(q) {
  const prompt = `You are an AI query parser for an Alumni intelligence agent.
The user query may be in English, Hindi (Devanagari script), or Hinglish (Romanized Hindi, e.g. "Galgotias University ke alumni find karo jo Google me kaam karte hai batch 2022" or "मुंबई विश्वविद्यालय के 2023 बैच के पूर्व छात्र").

Extract JSON {"college":string,"aliases":string[],"constituents":string[],"batches":number[],"companies":string[]} from this alumni search request.
- college: the OFFICIAL full name of the institution in English (e.g. "Galgotias University", "University of Mumbai", "University of Petroleum and Energy Studies"). Translate/transliterate Hindi or abbreviated college names into official English.
- aliases: up to 4 other names people write on LinkedIn for the SAME institution only (short form, abbreviation, name with city). Never include a different/sister institution.
- constituents: up to 12 official names of institutes/schools that are PART OF this same university and award its degrees (e.g. Symbiosis International University -> "Symbiosis Institute of Business Management", "Symbiosis Law School", ...). Empty if it has none.
- batches: 4-digit graduation years; expand ranges like "20 to 26" => 2020..2026.
- companies: employers mentioned in English (e.g. ["Google", "TCS"]).
JSON only.

${q}`;
  if (process.env.GEMINI_API_KEY) {
    const models = [process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'];
    for (const m of models) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }),
          signal: AbortSignal.timeout(15000),
        });
        const j = await r.json();
        if (j.candidates?.[0]?.content?.parts?.[0]?.text) {
          return { ...JSON.parse(j.candidates[0].content.parts[0].text.replace(/^```json|```$/g, '').trim()), engine: `gemini (${m})` };
        }
      } catch (err) {
        // try next model
      }
    }
  }
  if (process.env.HF_TOKEN) {
    const r = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.HF_TOKEN}` },
      body: JSON.stringify({ model: process.env.HF_MODEL || 'Qwen/Qwen2.5-72B-Instruct', messages: [{ role: 'user', content: prompt }], max_tokens: 200 }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    const txt = j.choices[0].message.content;
    return { ...JSON.parse(txt.match(/\{[\s\S]*\}/)[0]), engine: 'huggingface' };
  }
  return null;
}

export async function parseQuery(q) {
  const base = ruleParse(q);
  try {
    let l = null;
    for (let i = 0; i < 3 && !l; i++) { try { l = await llmParse(q); } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); } }
    if (l && l.college) {
      const aliases = [...new Set([...(Array.isArray(l.aliases) ? l.aliases : []), base.college].filter((x) => x && x.trim().length >= 3 && x.toLowerCase() !== l.college.toLowerCase()))].slice(0, 5);
      const constituents = [...new Set((Array.isArray(l.constituents) ? l.constituents : []).filter((x) => x && x.trim().length >= 6 && x.toLowerCase() !== l.college.toLowerCase()))].slice(0, 12);
      return { ...base, college: l.college, aliases, constituents, batches: l.batches?.length ? l.batches : base.batches,
        companies: l.companies?.length ? l.companies.map(canon) : base.companies, engine: l.engine };
    }
  } catch (e) { base.note = `LLM parse failed (${e.message}); used rules`; }
  return base;
}
