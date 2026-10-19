const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let map, layer, lastResults = [], lastIntent = {}, currentES = null, fYear = 'all', fCo = 'all', fConfirmed = false;

// Tabs
document.querySelectorAll('.tab[data-tab]').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tab[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === b.dataset.tab));
  if (b.dataset.tab === 'lake') { loadLake(); loadCampaign(); loadColleges(); } else map?.invalidateSize();
});

// Voice input (Web Speech API)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) $('#mic').style.display = 'none';
else {
  const rec = new SR(); rec.lang = 'en-IN'; rec.interimResults = true; rec.continuous = false;
  let on = false;
  $('#mic').onclick = () => { on ? rec.stop() : rec.start(); };
  rec.onstart = () => { on = true; $('#mic').classList.add('rec'); };
  rec.onend = () => { on = false; $('#mic').classList.remove('rec'); if ($('#q').value.trim()) $('#form').requestSubmit(); };
  rec.onresult = (e) => { $('#q').value = [...e.results].map((r) => r[0].transcript).join(' '); };
}

const palette = ['#7c5cff', '#22d3ee', '#f472b6', '#34d399', '#fb923c', '#60a5fa'];
const color = (s) => palette[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % palette.length];
const initials = (n) => n.split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase();

const SRC = { web: ['LinkedIn', ''], news: ['Placement news', 'p'], leetcode: ['LeetCode', ''], topmate: ['Open to mentoring \u00b7 Topmate', 'g'], register: ['College register', 'g'], self: ['Self-registered', 'g'], pdl: ['People Data Labs', ''] };
const srcTags = (a) => String(a.source || '').split(',').filter(Boolean).map((s) => { const [l, c] = SRC[s] || [s, '']; return `<span class="tag ${c}">${esc(l)}</span>`; }).join('');
function card(a) {
  const li = a.linkedin ? `<div>🔗 <a href="${esc(a.linkedin)}" target="_blank" rel="noopener">${esc(a.linkedin.replace(/^https?:\/\/(www\.)?/, ''))}</a></div>` : '';
  const email = a.email ? `<div>✉️ <a href="mailto:${esc(a.email)}">${esc(a.email)}</a></div>` : `<div class="muted">✉️ No public email · use LinkedIn</div>`;
  return `<div class="person"><div class="ph"><div class="av" style="background:${color(a.name)}">${esc(initials(a.name))}</div>
    <div><h4>${esc(a.name)}</h4><div class="role">${esc(a.title || a.headline || '—')} · <b>${esc(a.company || 'Company not listed')}</b></div></div></div>
    ${a.evidence && a.source !== 'sample' ? `<div class="why" title="${esc(a.evidence)}">🔎 <b>Why matched:</b> ${esc(a.evidence)}</div>` : ''}
    <div class="meta"><div>📍 ${esc(a.location || 'Location unknown')}</div>${email}${li}</div>
    <div class="tags">${a.batch ? `<span class="tag p">Batch ${a.batch}${a.batch_source === 'register' ? ' \u2713 college register' : a.verified ? ' \u2713 self-confirmed' : a.batch_source === 'news' ? ' \u2713 placement news' : ' \u00b7 from profile'}</span>` : '<span class="tag y">Batch unverified</span>'}
    ${a.email && !a.verified ? '<span class="tag y" title="Found on a public page; not confirmed by the alumnus">Email unverified</span>' : ''}
    ${a.verified ? '<span class="tag g">✓ Verified by alumnus</span>' : ''}
    ${a.status === 'joined' ? '<span class="tag g">✓ Joined</span>' : a.status === 'invited' ? '<span class="tag p">Invite sent</span>' : '<span class="tag">Not invited yet</span>'}
    ${a.li_verified ? '<span class="tag g">✓ LinkedIn verified</span>' : ''}
    ${srcTags(a)}</div>
    ${a.status !== 'joined' && a.id ? `<div class="invrow">${a.linkedin ? `<button class="inv li" data-id="${a.id}" data-ch="LinkedIn">Invite on LinkedIn</button>` : ''}${a.email ? `<button class="inv em" data-id="${a.id}" data-ch="email">Email invite</button>` : ''}</div>` : ''}</div>`;
}

function filtersBar(list) {
  const years = [...new Set(list.map((a) => a.batch).filter(Boolean))].sort();
  const cos = [...new Set(list.map((a) => a.company).filter(Boolean))].sort();
  const chip = (v, label, n) => `<button class="fchip ${String(fYear) === String(v) ? 'on' : ''}" data-y="${v}">${label} <i>${n}</i></button>`;
  return `<div class="filters">${chip('all', 'All', list.length)}${years.map((y) => chip(y, y, list.filter((a) => a.batch === y).length)).join('')}${chip('unknown', 'Batch not public', list.filter((a) => !a.batch).length)}
    <select id="fCo"><option value="all">All companies</option>${cos.map((c) => `<option ${c === fCo ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <label class="ftoggle"><input type="checkbox" id="fConf" ${fConfirmed ? 'checked' : ''}> Confirmed batch only${list.some((a) => !a.batch) ? ` <i class="muted">(${list.filter((a) => !a.batch).length} unverified hidden)</i>` : ''}</label></div>`;
}
function applyFilters(list) {
  return list.filter((a) => (fYear === 'all' || (fYear === 'unknown' ? !a.batch : a.batch === +fYear)) && (fCo === 'all' || a.company === fCo) && (!fConfirmed || a.batch));
}
function wireFilters() {
  document.querySelectorAll('.fchip').forEach((b) => b.onclick = () => { fYear = b.dataset.y; render(lastResults, true); });
  const s = $('#fCo'); if (s) s.onchange = () => { fCo = s.value; render(lastResults, true); };
  const c = $('#fConf'); if (c) c.onchange = () => { fConfirmed = c.checked; render(lastResults, true); };
}

function render(all, keepFilters) {
  if (!keepFilters) { fYear = 'all'; fCo = 'all'; fConfirmed = (lastIntent.batches || []).length > 0; }
  lastResults = all;
  const list = applyFilters(all);
  const want = lastIntent.batches || [];
  const sure = want.length ? list.filter((a) => a.batch) : list, maybe = want.length ? list.filter((a) => !a.batch) : [];
  $('#resTitle').textContent = want.length ? `${sure.length} confirmed batch \u00b7 ${maybe.length} possible` : `${list.length} alumni found`;
  const cos = new Set(list.map((a) => a.company)), loc = list.filter((a) => a.lat).length;
  $('#statrow').innerHTML = [[list.length, 'Alumni'], [cos.size, 'Companies'], [list.filter((a) => a.email).length, 'With email'], [list.filter((a) => a.batch).length, 'Batch known'], [list.filter((a) => a.linkedin).length, 'LinkedIn'], [loc, 'Mapped']]
    .map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
  $('#results').innerHTML = filtersBar(all) + (list.length ? sure.map(card).join('') + (maybe.length ? '<div class="divider">Possible matches \u2014 batch not stated on their public profile, so it could not be verified</div>' + maybe.map(card).join('') : '') : '<div class="empty">No alumni match these filters. Try another batch year, or widen the search.</div>');
  wireFilters();
  if (!map) { map = L.map('map', { scrollWheelZoom: false }).setView([20, 40], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '\u00a9 OpenStreetMap contributors', maxZoom: 19 }).addTo(map); }
  layer?.remove(); layer = L.layerGroup().addTo(map);
  const pts = [];
  list.filter((a) => a.lat).forEach((a) => {
    L.circleMarker([a.lat, a.lng], { radius: 9, color: '#fff', weight: 1.5, fillColor: color(a.company || ''), fillOpacity: .9 })
      .bindPopup(`<b>${esc(a.name)}</b><br>${esc(a.title || '')} @ ${esc(a.company || '')}<br>${esc(a.location)}`).addTo(layer);
    pts.push([a.lat, a.lng]);
  });
  setTimeout(() => { map.invalidateSize(); pts.length && map.fitBounds(pts, { padding: [40, 40], maxZoom: 6 }); }, 80);
}

document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chips button');
  if (!chip) return;
  const query = chip.dataset.q;
  if (!query) return;
  $('#q').value = query;
  $('#form').requestSubmit();
});

$('#form').onsubmit = (e) => {
  e.preventDefault();
  const college = $('#fCollege').value.trim(), from = $('#fFrom').value, to = $('#fTo').value, cos = $('#fCos').value.trim(), deep = $('#fDeep').checked;
  let q = $('#q').value.trim() || (college ? `Find alumni of ${college}` : $('#q').placeholder);
  if (college && !q.toLowerCase().includes(college.toLowerCase())) q += ` (alumni of ${college})`;
  if (!$('#q').value.trim()) $('#q').value = q;
  const params = new URLSearchParams({ q });
  const code = new URLSearchParams(location.search).get('code'); if (code) params.set('code', code);
  if (from) params.set('from', from); if (to) params.set('to', to); if (cos) params.set('companies', cos); if (deep) params.set('deep', '1');
  $('#workspace').classList.remove('hidden'); $('#steps').innerHTML = ''; $('#go').disabled = true; $('#go').textContent = 'Agent working…';
  $('#workspace').scrollIntoView({ behavior: 'smooth' });
  if (currentES) currentES.close(); // never mix two searches
  $('#results').innerHTML = ''; $('#statrow').innerHTML = ''; $('#verifyBar').innerHTML = ''; $('#resTitle').textContent = 'Searching…'; layer?.clearLayers();
  const es = currentES = new EventSource('/api/search?' + params.toString());
  const byId = {};
  es.addEventListener('step', (ev) => {
    const s = JSON.parse(ev.data);
    let li = s.id && byId[s.id];
    if (!li) { li = document.createElement('li'); $('#steps').appendChild(li); if (s.id) byId[s.id] = li; }
    li.className = s.level; li.innerHTML = `<i>${s.level === 'ok' ? '✓' : s.level === 'warn' ? '!' : ''}</i><span>${esc(s.text)}</span>`;
    $('#steps').scrollTop = 1e6;
  });
  es.addEventListener('intent', (ev) => { lastIntent = JSON.parse(ev.data); $('#engine').textContent = lastIntent.engine; });
  es.addEventListener('results', (ev) => render(JSON.parse(ev.data)));
  es.addEventListener('school', (ev) => {
    const s = JSON.parse(ev.data);
    $('#verifyBar').innerHTML = `<div class="verify"><span>🎓 <b>Confirm batch years</b> on LinkedIn's official ${esc(s.college)} alumni tool (filters by graduation year; opens in your logged-in LinkedIn):</span>${s.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.company || 'All alumni')} →</a>`).join('')}</div>`;
  });
  es.addEventListener('done', () => { es.close(); $('#go').disabled = false; $('#go').textContent = 'Run agent →'; refreshBadge(); });
  es.onerror = () => { es.close(); $('#go').disabled = false; $('#go').textContent = 'Run agent →'; };
};

$('#csv').onclick = () => {
  const shown = applyFilters(lastResults);
  if (!shown.length) return toast('Nothing to export: no results match the current filters.');
  const p = new URLSearchParams({ ids: shown.map((a) => a.id).join(','), college: lastIntent.college || '' });
  location.href = '/api/export.csv?' + p;
};

async function refreshBadge() { try { $('#lakeBadge').textContent = (await (await fetch('/api/lake')).json()).stats.alumni; } catch {} }

async function loadLake() {
  const d = await (await fetch('/api/lake')).json();
  $('#lakeBadge').textContent = d.stats.alumni;
  $('#lakeStats').innerHTML = [['alumni', 'Alumni records'], ['drafted', 'Invites drafted'], ['invited', 'Invites sent'], ['joined', 'Joined (verified)'], ['withEmail', 'With email']]
    .map(([k, l]) => `<div class="stat"><b>${d.stats[k]}</b><span>${l}</span></div>`).join('');
  const bars = (arr) => { const m = Math.max(1, ...arr.map((x) => x.n)); return arr.map((x) => `<div class="row"><span>${esc(x.label ?? '—')}</span><div class="bar" style="width:${(x.n / m) * 100}%"></div><b>${x.n}</b></div>`).join('') || '<span class="muted">Empty – run a search</span>'; };
  $('#byCompany').innerHTML = bars(d.byCompany); $('#byBatch').innerHTML = bars(d.byBatch);
  const formatEvent = (e) => {
    let tag = `<span class="tag">${esc(e.type)}</span>`;
    if (e.type === 'discovered') tag = '<span class="tag">discovered</span>';
    else if (e.type === 'invite_drafted') tag = '<span class="tag y">drafted</span>';
    else if (e.type === 'invite_sent') tag = '<span class="tag g">invite sent</span>';
    else if (e.type === 'email_found') tag = '<span class="tag g">email found</span>';
    else if (e.type === 'joined') tag = '<span class="tag g">joined ✓</span>';
    return `<li>${tag} · <b>${esc(e.name || '')}</b> <span class="muted">${new Date(e.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></li>`;
  };
  $('#events').innerHTML = d.events.map(formatEvent).join('') || '<li class="muted">No events</li>';
  $('#table').innerHTML = '<tr><th>Name</th><th>Company</th><th>Title</th><th>Location</th><th>Batch</th><th>Email</th><th>LinkedIn</th><th>Status</th><th>Seen</th></tr>' +
    d.alumni.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.company)}</td><td>${esc(a.title)}</td><td>${esc(a.location)}</td><td>${a.batch ?? ''}</td><td>${esc(a.email)}</td><td>${a.linkedin ? `<a href="${esc(a.linkedin)}" target="_blank">profile</a>` : ''}</td><td>${esc(a.status)}${a.verified ? ' ✓' : ''}</td><td>${a.seen_count}×</td></tr>`).join('');
  $('#outbox').innerHTML = d.outbox.map((o) => `<details style="margin:8px 0"><summary><b>${esc(o.name)}</b> → ${esc(o.to_addr || 'LinkedIn')} <span class="tag ${/^sent/.test(o.status) ? 'g' : /^fail/.test(o.status) ? 'y' : ''}">${esc(o.status)}</span> ${/^draft · LinkedIn/.test(o.status) ? `<button class="inv li sm" data-id="${o.alumni_id}" data-ch="LinkedIn">Send on LinkedIn</button>` : ''}</summary><pre style="white-space:pre-wrap;color:var(--mut)">${esc(o.subject)}\n\n${esc(o.body)}</pre></details>`).join('') || '<span class="muted">No invites yet</span>';
}
refreshBadge();

// ---------------- Invites: one click, sent by a human (LinkedIn does not allow apps to auto-message) ----------------
function toast(html, ms = 9000) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.innerHTML = html; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.inv'); if (!b) return;
  e.preventDefault(); b.disabled = true; const label = b.textContent; b.textContent = 'Preparing…';
  try {
    const d = await (await fetch('/api/invite/' + b.dataset.id, { method: 'POST' })).json();
    if (b.dataset.ch === 'LinkedIn') {
      await navigator.clipboard.writeText(d.note).catch(() => {});
      window.open(d.linkedin, '_blank', 'noopener');
      toast(`<b>Invite note copied ✓</b><br>On their LinkedIn profile: <b>Connect → Add a note → Ctrl+V → Send</b>.<pre>${esc(d.note)}</pre>`);
    } else {
      location.href = `mailto:${encodeURIComponent(d.email)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
      toast('<b>Email draft opened</b> with their personal join link. Press Send in your mail app.');
    }
    await fetch('/api/invite/' + b.dataset.id + '/sent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: b.dataset.ch }) });
    b.textContent = 'Invite sent ✓'; b.classList.add('done');
    const tag = b.closest('.person')?.querySelector('.tags .tag:not(.p):not(.g):not(.y)'); if (tag && /Not invited/.test(tag.textContent)) { tag.textContent = 'Invite sent'; tag.classList.add('p'); }
  } catch { b.textContent = label; b.disabled = false; toast('Could not prepare the invite. Try again.'); }
});

// ---------------- Campaign: invite many alumni at once via a shareable post ----------------
async function loadCampaign() {
  const c = await (await fetch('/api/config')).json();
  const college = $('#campCollege').value.trim() || c.lastCollege || '';
  if (!$('#campCollege').value && college) $('#campCollege').value = college;
  const link = `${c.base}/join.html?c=${encodeURIComponent(college)}`;
  const text = `Calling all ${college} alumni! Students are building our alumni network so juniors can learn from your journey. Join in 30 seconds: ${link}`;
  $('#campLink').textContent = link;
  $('#campLi').href = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(link)}`;
  $('#campWa').href = `https://wa.me/?text=${encodeURIComponent(text)}`;
  $('#campCopy').onclick = () => { navigator.clipboard.writeText(text); toast('<b>Post text + link copied ✓</b> Paste it in alumni WhatsApp groups, LinkedIn or email.'); };
  $('#campStatus').innerHTML = `Email auto-send: <b>${c.smtp ? 'ON' : 'OFF (add SMTP in .env)'}</b> · Sign in with LinkedIn on join page: <b>${c.linkedinLogin ? 'ON' : 'OFF (add LINKEDIN_CLIENT_ID/SECRET)'}</b>`;
}
$('#campCollege').onchange = loadCampaign;

// ---------------- CSV download by college ----------------
async function loadColleges() {
  const list = await (await fetch('/api/colleges')).json();
  const sel = $('#dlCollege'), keep = sel.value;
  sel.innerHTML = '<option value="">All colleges</option>' + list.map((c) => `<option value="${esc(c.college)}">${esc(c.college)} (${c.n} alumni, ${c.withBatch} with batch)</option>`).join('');
  if (keep) sel.value = keep; else if (lastIntent.college && list.some((c) => c.college.toLowerCase() === lastIntent.college.toLowerCase())) sel.value = list.find((c) => c.college.toLowerCase() === lastIntent.college.toLowerCase()).college;
  $('#dlInfo').textContent = list.length ? 'Columns: name, college, batch, batch proof, company, title, location, email, LinkedIn, invite status, source, why matched. Opens directly in Excel / Google Sheets.' : 'The data lake is empty: run a search first.';
}
$('#dlBtn').onclick = () => {
  const p = new URLSearchParams();
  if ($('#dlCollege').value) p.set('college', $('#dlCollege').value);
  if ($('#dlFrom').value) p.set('from', $('#dlFrom').value);
  if ($('#dlTo').value) p.set('to', $('#dlTo').value);
  if ($('#dlCo').value.trim()) p.set('company', $('#dlCo').value.trim());
  if ($('#dlConf').checked) p.set('confirmed', '1');
  location.href = '/api/export.csv?' + p;
};

$('#regBtn').onclick = async () => {
  const college = $('#regCollege').value.trim(), f = $('#regFile').files[0];
  if (!college || !f) { $('#regMsg').innerHTML = '<div class="msg err">Enter the college name and choose a CSV file.</div>'; return; }
  const r = await fetch('/api/register?college=' + encodeURIComponent(college), { method: 'POST', headers: { 'content-type': 'text/csv' }, body: await f.text() });
  const j = await r.json();
  $('#regMsg').innerHTML = r.ok ? `<div class="msg ok">Imported ${j.added} alumni (${j.skipped} rows skipped). ${j.matched} lake record(s) now have a confirmed batch.</div>` : `<div class="msg err">${esc(j.error)}</div>`;
  loadLake();
};
