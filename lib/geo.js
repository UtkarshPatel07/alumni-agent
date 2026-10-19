// Live geocoding via OpenStreetMap Nominatim (free, rate-limited to 1 req/s), cached in the lake.
import { db } from './db.js';

let last = 0;
export async function geocode(location) {
  if (!location) return null;
  const key = location.toLowerCase().trim();
  const hit = db.prepare('SELECT lat,lng FROM geo WHERE location=?').get(key);
  if (hit) return hit.lat == null ? null : hit;
  const wait = 1100 - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`, {
      headers: { 'user-agent': 'AlumniAgentMVP/1.0 (student project)' }, signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    const g = j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : { lat: null, lng: null };
    db.prepare('INSERT OR REPLACE INTO geo VALUES (?,?,?)').run(key, g.lat, g.lng);
    return g.lat == null ? null : g;
  } catch { return null; }
}
