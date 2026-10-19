import fs from 'node:fs';
for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2]; }
const q = 'i want alumni from 2019 batch and of amity university who work at google';
const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ contents: [{ parts: [{ text: `Extract JSON {"college":string,"batches":number[],"companies":string[]} from: ${q}` }] }], generationConfig: { responseMimeType: 'application/json' } }),
});
console.log(r.status, (await r.text()).slice(0, 700));
