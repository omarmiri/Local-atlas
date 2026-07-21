/* Local Atlas backend
   - Serves the static app
   - /api/places : Foursquare Places (key from FSQ_API_KEY env var — set in
     Render's Environment tab; never committed to the repo)
   - /api/news   : Google News RSS fetched server-side (no CORS proxies)
   - /api/reddit : Reddit search fetched server-side
   - /api/fetch  : generic page fetch for the deals scanner
   All responses share an in-memory TTL cache, so one user's lookup warms
   the next user's. */
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const FSQ = process.env.FSQ_API_KEY || '';
const TM = process.env.TICKETMASTER_API_KEY || '';
const CENSUS = process.env.CENSUS_API_KEY || '';
const AI = process.env.GEMINI_API_KEY || '';
const OWM = process.env.OPENWEATHER_API_KEY || '';
const NPS = process.env.NPS_API_KEY || '';
const WINDY = process.env.WINDY_API_KEY || '';
const NASA = process.env.NASA_API_KEY || '';
const AI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';  // cheapest tier, auto-tracks latest

/* ---- two-level TTL cache: in-memory L1, optional Upstash Redis L2 ----
   Redis survives restarts and free-tier spin-downs, so one visitor's lookups
   warm the cache for everyone, permanently. Configure with
   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN; works without them. */
const cache = new Map();
const RURL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || '';
async function redisGet(key){
  if(!RURL) return null;
  try{
    const r = await fetch(`${RURL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: 'Bearer ' + RTOK } });
    if(!r.ok) return null;
    const j = await r.json();
    return typeof j.result === 'string' ? j.result : null;
  }catch(e){ return null; }
}
function redisSet(key, val, ttlMs){
  if(!RURL) return;
  fetch(`${RURL}/set/${encodeURIComponent(key)}?px=${Math.max(1000, Math.round(ttlMs))}`,
    { method: 'POST', headers: { Authorization: 'Bearer ' + RTOK }, body: val })
    .catch(()=>{});
}
const encVal = v => Buffer.isBuffer(v) ? 'b64:' + v.toString('base64')
  : typeof v === 'string' ? 'str:' + v : 'jsn:' + JSON.stringify(v);
function decVal(s){
  const tag = s.slice(0, 4), body = s.slice(4);
  if(tag === 'b64:') return Buffer.from(body, 'base64');
  if(tag === 'str:') return body;
  try{ return JSON.parse(body); }catch(e){ return null; }
}
async function cached(key, ttlMs, fn){
  const hit = cache.get(key);
  if(hit && Date.now() - hit.t < ttlMs) return hit.v;
  const rv = await redisGet(key);
  if(rv != null){
    const v = decVal(rv);
    if(v != null){ cache.set(key, { t: Date.now(), v }); return v; }
  }
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  if(cache.size > 600){ cache.delete(cache.keys().next().value); }
  redisSet(key, encVal(v), ttlMs);
  return v;
}

app.get('/api/health', (req, res) => res.json({ ok: true, fsq: !!FSQ, tm: !!TM, ai: !!AI, owm: !!OWM, redis: !!RURL, nps: !!NPS, windy: !!WINDY, nasa: !!NASA }));

/* ---- Foursquare places ---- */
/* Legacy v3 was shut down May 15 2026 — this is the new Places API.
   Requires a Service API Key (not a legacy fsq3 key). */
const FSQ_BASE = 'https://places-api.foursquare.com';
const FSQ_HDRS = () => ({ Authorization: 'Bearer ' + FSQ,
  'X-Places-Api-Version': '2025-06-17', Accept: 'application/json' });
const FSQ_CATS = {
  services:    '4d4b7105d754a06375d81259',                          // professional & other
  attractions: '4d4b7104d754a06370d81259,4d4b7105d754a06377d81259', // arts & entertainment, outdoors
  food:        '4d4b7105d754a06374d81259',                          // dining & drinking
  shopping:    '4d4b7105d754a06378d81259',                          // retail
  kids:        '4d4b7104d754a06370d81259'                           // arts & entertainment
};
const FSQ_FIELDS = 'fsq_place_id,name,latitude,longitude,location,categories,distance,website,tel,hours,rating';
app.get('/api/places', async (req, res) => {
  try{
    if(!FSQ) return res.status(503).json({ error: 'FSQ_API_KEY not set' });
    const { lat, lon, radius = '7000', category = 'food' } = req.query;
    if(!lat || !lon || !FSQ_CATS[category]) return res.status(400).json({ error: 'bad params' });
    const r = Math.min(parseInt(radius, 10) || 7000, 100000);
    const ll = `${encodeURIComponent(lat)}%2C${encodeURIComponent(lon)}`;
    const mkUrl = (withFields, withCats) => `${FSQ_BASE}/places/search?ll=${ll}&radius=${r}&limit=50` +
      (withCats ? `&fsq_category_ids=${FSQ_CATS[category]}` : '') +
      (withFields ? `&fields=${encodeURIComponent(FSQ_FIELDS)}` : '');
    const data = await cached('fsqn:' + category + ':' + ll + ':' + r, 6 * 3600e3, async () => {
      // degrade gracefully if a field or category id is rejected
      for(const [wf, wc] of [[true, true], [false, true], [false, false]]){
        const rr = await fetch(mkUrl(wf, wc), { headers: FSQ_HDRS() });
        if(rr.ok) return rr.json();
        if(rr.status !== 400) throw new Error('Foursquare HTTP ' + rr.status);
      }
      throw new Error('Foursquare HTTP 400');
    });
    const items = (data.results || []).map(p => ({
      fsqId: p.fsq_place_id || p.fsq_id || '',
      name: p.name,
      kind: (p.categories?.[0]?.name || '').toLowerCase(),
      lat: p.latitude ?? p.geocodes?.main?.latitude,
      lon: p.longitude ?? p.geocodes?.main?.longitude,
      dist: (p.distance || 0) / 1609,
      website: p.website || '',
      phone: p.tel || '',
      hours: p.hours?.display || '',
      openNow: typeof p.hours?.open_now === 'boolean' ? p.hours.open_now : null,
      addr: p.location?.formatted_address || '',
      rating: p.rating ?? null,
      src: 'fsq'
    })).filter(p => p.lat != null && p.name);
    res.json({ items });
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* ---- local news (Google News RSS, server-side) ---- */
app.get('/api/news', async (req, res) => {
  try{
    const q = String(req.query.q || '').slice(0, 80);
    const cc = req.query.country === 'CA' ? 'CA' : 'US';
    if(!q) return res.status(400).json({ error: 'q required' });
    const feed = 'https://news.google.com/rss/search' +
      `?q=${encodeURIComponent('"' + q + '" local news')}&hl=en-${cc}&gl=${cc}&ceid=${cc}:en`;
    const xml = await cached('news:' + feed, 15 * 60e3, async () => {
      const rr = await fetch(feed);
      if(!rr.ok) throw new Error('feed HTTP ' + rr.status);
      return rr.text();
    });
    const items = [];
    const pick = (b, t) => {
      const m = b.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>'));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    };
    const rx = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while((m = rx.exec(xml)) && items.length < 12){
      items.push({ title: pick(m[1], 'title'), link: pick(m[1], 'link'),
                   pub: pick(m[1], 'pubDate'), src: pick(m[1], 'source') });
    }
    res.json({ items });
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* ---- Reddit search (server-side) ---- */
app.get('/api/reddit', async (req, res) => {
  try{
    const q = String(req.query.q || '').slice(0, 120);
    if(!q) return res.status(400).json({ error: 'q required' });
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&limit=12&t=month`;
    const data = await cached('rd:' + url, 10 * 60e3, async () => {
      const rr = await fetch(url, { headers: { 'User-Agent': 'local-atlas/1.0 (personal project)' } });
      if(!rr.ok) throw new Error('reddit HTTP ' + rr.status);
      const txt = await rr.text();
      if(txt.trim().startsWith('<')) throw new Error('reddit blocked this host');
      return JSON.parse(txt);
    });
    res.json(data);
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* ---- generic page fetch for the deals scanner ---- */
app.get('/api/fetch', async (req, res) => {
  try{
    const u = new URL(String(req.query.url || ''));
    if(!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
    if(/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(u.hostname))
      throw new Error('blocked host');
    const txt = await cached('f:' + u.href, 3600e3, async () => {
      const rr = await fetch(u.href, { redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; local-atlas)' } });
      if(!rr.ok) throw new Error('HTTP ' + rr.status);
      return (await rr.text()).slice(0, 500000);
    });
    res.type('text/plain').send(txt);
  }catch(e){ res.status(502).send('fetch failed: ' + String(e.message || e)); }
});

/* ---- Top US States leaderboards ---- */
const STATES = [
 ['Alabama','AL',32.8,-86.8],['Alaska','AK',64.0,-152.0],['Arizona','AZ',34.2,-111.6],
 ['Arkansas','AR',34.8,-92.4],['California','CA',37.2,-119.3],['Colorado','CO',39.0,-105.5],
 ['Connecticut','CT',41.6,-72.7],['Delaware','DE',39.0,-75.5],['Florida','FL',28.6,-82.4],
 ['Georgia','GA',32.6,-83.4],['Hawaii','HI',20.8,-156.3],['Idaho','ID',44.4,-114.6],
 ['Illinois','IL',40.0,-89.2],['Indiana','IN',39.9,-86.3],['Iowa','IA',42.0,-93.5],
 ['Kansas','KS',38.5,-98.4],['Kentucky','KY',37.5,-85.3],['Louisiana','LA',31.0,-92.0],
 ['Maine','ME',45.4,-69.2],['Maryland','MD',39.0,-76.8],['Massachusetts','MA',42.3,-71.8],
 ['Michigan','MI',44.3,-85.4],['Minnesota','MN',46.3,-94.3],['Mississippi','MS',32.7,-89.7],
 ['Missouri','MO',38.4,-92.5],['Montana','MT',47.0,-109.6],['Nebraska','NE',41.5,-99.8],
 ['Nevada','NV',39.3,-116.6],['New Hampshire','NH',43.7,-71.6],['New Jersey','NJ',40.2,-74.7],
 ['New Mexico','NM',34.4,-106.1],['New York','NY',42.9,-75.5],['North Carolina','NC',35.5,-79.4],
 ['North Dakota','ND',47.4,-100.5],['Ohio','OH',40.3,-82.8],['Oklahoma','OK',35.6,-97.5],
 ['Oregon','OR',43.9,-120.6],['Pennsylvania','PA',40.9,-77.8],['Rhode Island','RI',41.7,-71.6],
 ['South Carolina','SC',33.9,-80.9],['South Dakota','SD',44.4,-100.2],['Tennessee','TN',35.9,-86.4],
 ['Texas','TX',31.5,-99.4],['Utah','UT',39.3,-111.7],['Vermont','VT',44.1,-72.7],
 ['Virginia','VA',37.5,-78.9],['Washington','WA',47.4,-120.4],['West Virginia','WV',38.6,-80.6],
 ['Wisconsin','WI',44.6,-89.7],['Wyoming','WY',43.0,-107.6]
];
async function geminiJSON(prompt, maxTokens){
  if(!AI) throw new Error('no AI key');
  const rr = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${AI}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens }
    })
  });
  if(!rr.ok) throw new Error('Gemini HTTP ' + rr.status);
  const j = await rr.json();
  const txt = (j.candidates?.[0]?.content?.parts || []).map(pt => pt.text || '').join('');
  const m = txt.match(/\[[\s\S]*\]/);
  return JSON.parse(m ? m[0] : txt.replace(/```json|```/g, '').trim());
}
function rssItems(xml, limit){
  const out = [];
  const rx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while((m = rx.exec(xml)) && out.length < limit){
    const block = m[1];
    const tm = block.match(/<title>([\s\S]*?)<\/title>/);
    const lm = block.match(/<link>([\s\S]*?)<\/link>/);
    if(!tm) continue;
    let t = tm[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if(t.includes(' - ')) t = t.split(' - ').slice(0, -1).join(' - ');
    out.push({ title: t, link: lm ? lm[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '' });
  }
  return out;
}
async function mapLimit(items, limit, fn){
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while(i < items.length){ const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

/* Weirdest state: "<State> man" headlines, AI-judged for absurdity */
app.get('/api/states/weird', async (req, res) => {
  try{
    const data = await cached('st:weird:v2', 24 * 3600e3, async () => {
      const perState = await mapLimit(STATES, 6, async ([name, abbr, lat, lon]) => {
        try{
          const feed = 'https://news.google.com/rss/search?q=' +
            encodeURIComponent(`"${name} man"`) + '&hl=en-US&gl=US&ceid=US:en';
          const rr = await fetch(feed);
          if(!rr.ok) return { name, abbr, lat, lon, items: [] };
          return { name, abbr, lat, lon, items: rssItems(await rr.text(), 8) };
        }catch(e){ return { name, abbr, lat, lon, items: [] }; }
      });
      let ranked;
      try{
        const compact = Object.fromEntries(perState.filter(st => st.items.length)
          .map(st => [st.name, st.items.map(i => i.title)]));
        ranked = await geminiJSON(
`Below are recent news headlines that begin with or feature "<State> man". Score each state 0-10 for how absurd, silly, shocking, or dumb its "<State> man" stories are — the "Florida Man" phenomenon. Respond ONLY with a JSON array of the 12 weirdest states, best first:
[{"state":"...","score":9.4,"headlines":["up to 3 of the funniest verbatim headlines for that state, funniest first"]}]

HEADLINES:
${JSON.stringify(compact).slice(0, 14000)}`, 1200);
      }catch(e){
        ranked = perState.map(st => ({ state: st.name, score: st.items.length,
            headlines: st.items.slice(0, 3).map(i => i.title) }))
          .sort((a, b) => b.score - a.score).slice(0, 12);
      }
      const norm = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
      return ranked.map(r => {
        const st = STATES.find(x => x[0] === r.state);
        const src = perState.find(x => x.name === r.state);
        const headlines = (r.headlines || []).map(h => {
          const nh = norm(h);
          const hit = (src?.items || []).find(i => {
            const ni = norm(i.title);
            return ni === nh || ni.includes(nh.slice(0, 40)) || nh.includes(ni.slice(0, 40));
          });
          return { title: h, url: hit?.link || '' };
        });
        return { ...r, headlines, abbr: st?.[1] || '', lat: st?.[2], lon: st?.[3] };
      });
    });
    res.json({ items: data });
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* Most happening: Ticketmaster volume + national-park events + festivals (AI-blended) */
app.get('/api/states/events', async (req, res) => {
  try{
    if(!TM) return res.status(503).json({ error: 'events not configured' });
    const data = await cached('st:events:v2', 12 * 3600e3, async () => {
      const start = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      const end = new Date(Date.now() + 30 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
      const rows = await mapLimit(STATES, 3, async ([name, abbr, lat, lon]) => {
        const row = { state: name, abbr, lat, lon, count: 0, top: '', nps: 0 };
        try{
          const url = 'https://app.ticketmaster.com/discovery/v2/events.json' +
            `?apikey=${TM}&stateCode=${abbr}&size=1&startDateTime=${start}&endDateTime=${end}`;
          const rr = await fetch(url);
          if(rr.ok){
            const j = await rr.json();
            row.count = j.page?.totalElements || 0;
            row.top = j._embedded?.events?.[0]?.name || '';
          }
          await new Promise(r => setTimeout(r, 120));
        }catch(e){}
        if(NPS){
          try{
            const nr = await fetch(`https://developer.nps.gov/api/v1/events?stateCode=${abbr}&pageSize=1&api_key=${NPS}`);
            if(nr.ok){ row.nps = parseInt((await nr.json()).total, 10) || 0; }
          }catch(e){}
        }
        return row;
      });
      const month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      let ranked;
      try{
        const compact = rows.map(r => ({ state: r.state, ticketed: r.count, parkEvents: r.nps }));
        const ai = await geminiJSON(
`It is ${month}. Below is per-state data: ticketed events in the next 30 days${NPS ? ' and national-park events' : ''}. Rank the 12 "most happening" US states for a visitor this month — blend the numbers with well-known festivals, state fairs, harvest celebrations, and cultural events that traditionally occur in ${month.split(' ')[0]}. Do not just rank by population or raw counts. Respond ONLY with a JSON array, best first:
[{"state":"...","festival":"one notable festival/fair/celebration in that state this month (empty string if none)","note":"one short sentence on why this state is happening right now"}]

DATA:
${JSON.stringify(compact)}`, 1400);
        ranked = ai.map(r => ({ ...rows.find(x => x.state === r.state), festival: r.festival || '', note: r.note || '' }))
          .filter(r => r.state);
      }catch(e){
        ranked = rows.sort((a, b) => b.count - a.count).slice(0, 12)
          .map(r => ({ ...r, festival: '', note: '' }));
      }
      return ranked;
    });
    res.json({ items: data });
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* Best to visit this month: AI seasonal picks */
app.get('/api/states/visit', async (req, res) => {
  try{
    if(!AI) return res.status(503).json({ error: 'not configured' });
    const monthKey = new Date().toISOString().slice(0, 7);
    const data = await cached('st:visit:v2:' + monthKey, 24 * 3600e3, async () => {
      const month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const ranked = await geminiJSON(
`It is ${month}. Rank the 10 best US states to visit this month, considering typical weather, seasonal scenery, festivals, and outdoor conditions. Respond ONLY with a JSON array, best first:
[{"state":"...","why":"one concrete sentence on why this month specifically","site":"the official state tourism board homepage URL, e.g. https://www.visitcalifornia.com"}]`, 1100);
      return ranked.map(r => {
        const st = STATES.find(x => x[0] === r.state);
        const site = typeof r.site === 'string' && /^https?:\/\//.test(r.site) ? r.site : '';
        return { ...r, site, abbr: st?.[1] || '', lat: st?.[2], lon: st?.[3] };
      });
    });
    res.json({ items: data });
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* ---- Quirky laws (Gemini, cached permanently per location) ---- */
async function lawsFor(scope, place, region){
  // long TTL: folklore doesn't change. Redis makes this a one-time cost per place.
  const key = 'laws:' + scope + ':' + place.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cached(key, 365 * 86400e3, async () => {
    const where = scope === 'state' ? `the US state of ${place}` : `${place}${region ? ', ' + region : ''}`;
    const ranked = await geminiJSON(
`List 5-7 quirky, unusual, funny, or surprising laws or ordinances associated with ${where}. Prefer genuinely local specifics over generic ones. For each, give a one-line plain description. Many such laws are historical, rarely enforced, or possibly apocryphal — reflect that honestly in a "status" field. Respond ONLY with a JSON array:
[{"law":"short description of the law","status":"one of: on the books, historical, rarely enforced, or disputed"}]`, 1100);
    return Array.isArray(ranked) ? ranked.slice(0, 7) : [];
  });
}
app.get('/api/taxes', async (req, res) => {
  try{
    if(!AI) return res.status(503).json({ error: 'not configured' });
    const stName = String(req.query.state || '').slice(0, 40);
    if(!stName) return res.status(400).json({ error: 'state required' });
    const data = await cached('taxes:' + stName.toLowerCase().replace(/[^a-z]/g, ''), 180 * 86400e3, async () => {
      return geminiJSON(
`Give current general tax and common government-fee information for the US state of ${stName}. Use typical/approximate figures where exact varies locally, and note when something varies. Respond ONLY with a JSON array of {"label":"...","value":"..."} pairs covering: state sales tax rate, state income tax (rate or range, or "none"), gas tax, vehicle registration (typical annual/base cost), and typical real-estate transfer or recording context if notable. Keep values short.
[{"label":"Sales tax","value":"6.625%"}]`, 900);
    });
    res.json({ items: Array.isArray(data) ? data : [] });
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/api/laws', async (req, res) => {
  try{
    if(!AI) return res.status(503).json({ error: 'not configured' });
    const scope = req.query.scope === 'town' ? 'town' : 'state';
    const place = String(req.query.place || '').slice(0, 80);
    const region = String(req.query.region || '').slice(0, 40);
    if(!place) return res.status(400).json({ error: 'place required' });
    const laws = await lawsFor(scope, place, region);
    res.json({ laws });
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* ---- Ticketmaster events ---- */
app.get('/api/events', async (req, res) => {
  try{
    if(!TM) return res.status(503).json({ error: 'TICKETMASTER_API_KEY not set' });
    const { lat, lon, radius = '25' } = req.query;
    if(!lat || !lon) return res.status(400).json({ error: 'bad params' });
    const r = Math.min(parseInt(radius, 10) || 25, 100);
    const url = 'https://app.ticketmaster.com/discovery/v2/events.json' +
      `?apikey=${TM}&latlong=${encodeURIComponent(lat)},${encodeURIComponent(lon)}` +
      `&radius=${r}&unit=miles&sort=date,asc&size=30`;
    const data = await cached('tm:' + url, 30 * 60e3, async () => {
      const rr = await fetch(url);
      if(!rr.ok) throw new Error('Ticketmaster HTTP ' + rr.status);
      return rr.json();
    });
    const events = (data._embedded?.events || []).map(e => ({
      name: e.name, url: e.url || '',
      date: e.dates?.start?.localDate || '', time: e.dates?.start?.localTime || '',
      venue: e._embedded?.venues?.[0]?.name || '',
      img: (e.images || []).find(i => i.ratio === '16_9' && i.width >= 300)?.url || e.images?.[0]?.url || '',
      seg: e.classifications?.[0]?.segment?.name || ''
    }));
    res.json({ events });
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* ---- county profile (FCC geo → Census ACS; key optional but recommended) ---- */
app.get('/api/census', async (req, res) => {
  try{
    const { lat, lon } = req.query;
    if(!lat || !lon) return res.status(400).json({ error: 'bad params' });
    const out = await cached(`cs6:${(+lat).toFixed(3)},${(+lon).toFixed(3)}`, 30 * 86400e3, async () => {
      const key = CENSUS ? '&key=' + CENSUS : '';
      const vars = 'NAME,B01003_001E,B19013_001E,B01002_001E,B25077_001E,B25064_001E,B25103_001E';   // +median home value, gross rent, property tax
      // Census geocoder → the incorporated city/town containing this point.
      // Only these two layers matter; we deliberately do NOT request sub-place
      // or tract layers, which is what surfaced neighborhoods before.
      // Incorporated Places covers cities; County Subdivisions covers townships
      // (NJ/PA/New England/MI), which aren't "places" in Census geography.
      const gr = await fetch('https://geocoding.geo.census.gov/geocoder/geographies/coordinates' +
        `?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current` +
        '&layers=Incorporated%20Places,County%20Subdivisions,Counties&format=json');
      if(!gr.ok) throw new Error('Census geocoder HTTP ' + gr.status);
      const geos = (await gr.json())?.result?.geographies || {};
      const place = (geos['Incorporated Places'] || [])[0];
      const subdiv = (geos['County Subdivisions'] || [])[0];
      const county = (geos['Counties'] || [])[0];

      const getRow = async (forClause) => {
        const cr = await fetch(`https://api.census.gov/data/2023/acs/acs5?get=${vars}&${forClause}${key}`);
        if(!cr.ok) return null;
        const j = await cr.json();
        return Array.isArray(j) && j[1] ? j[1] : null;
      };
      const clean = n => (n||'').replace(/,.*$/, '');

      // 1) incorporated city/town
      if(place?.STATE && place?.PLACE){
        const row = await getRow(`for=place:${place.PLACE}&in=state:${place.STATE}`);
        if(row && +row[1] > 0)
          return { area: clean(row[0]), level: 'town',
            population: +row[1], medianIncome: +row[2], medianAge: +row[3],
            homeValue: +row[4] || null, rent: +row[5] || null, propertyTax: +row[6] || null };
      }
      // 2) township / county subdivision (skip "not defined" subdivisions, code 00000)
      if(subdiv?.STATE && subdiv?.COUNTY && subdiv?.COUSUB && subdiv.COUSUB !== '00000'){
        const row = await getRow(`for=county%20subdivision:${subdiv.COUSUB}&in=state:${subdiv.STATE}%20county:${subdiv.COUNTY}`);
        if(row && +row[1] > 0)
          return { area: clean(row[0]), level: 'town',
            population: +row[1], medianIncome: +row[2], medianAge: +row[3],
            homeValue: +row[4] || null, rent: +row[5] || null, propertyTax: +row[6] || null };
      }
      // 3) county fallback
      if(county?.STATE && county?.COUNTY){
        const row = await getRow(`for=county:${county.COUNTY}&in=state:${county.STATE}`);
        if(row)
          return { area: row[0], level: 'county',
            population: +row[1], medianIncome: +row[2], medianAge: +row[3],
            homeValue: +row[4] || null, rent: +row[5] || null, propertyTax: +row[6] || null };
      }
      throw new Error('outside US census coverage');
    });
    res.json(out);
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* ---- Foursquare place details (photo, rating, price) ---- */
app.get('/api/fsqdetails', async (req, res) => {
  try{
    if(!FSQ) return res.status(503).json({ error: 'FSQ_API_KEY not set' });
    const id = String(req.query.id || '').replace(/[^\w]/g, '');
    if(!id) return res.status(400).json({ error: 'id required' });
    const data = await cached('fdn:' + id, 86400e3, async () => {
      const out = { rating: null, price: null, photo: '' };
      try{
        const rr = await fetch(`${FSQ_BASE}/places/${id}?fields=rating%2Cprice`, { headers: FSQ_HDRS() });
        if(rr.ok){ const j = await rr.json(); out.rating = j.rating ?? null; out.price = j.price ?? null; }
      }catch(e){}
      try{
        const pr = await fetch(`${FSQ_BASE}/places/${id}/photos?limit=1`, { headers: FSQ_HDRS() });
        if(pr.ok){
          const ph = await pr.json();
          const first = Array.isArray(ph) ? ph[0] : ph?.photos?.[0];
          if(first?.prefix) out.photo = first.prefix + '500x300' + first.suffix;
        }
      }catch(e){}
      return out;
    });
    res.json(data);
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* ---- AI town brief (Anthropic; cached per place per 6 h) ---- */
app.post('/api/brief', express.json({ limit: '200kb' }), async (req, res) => {
  try{
    if(!AI) return res.status(503).json({ error: 'GEMINI_API_KEY not set' });
    const { name = '', country = 'US', data = {} } = req.body || {};
    if(!name) return res.status(400).json({ error: 'name required' });
    const key = 'brief:' + name + ':' + new Date().toISOString().slice(0, 10);
    const text = await cached(key, 6 * 3600e3, async () => {
      const rr = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${AI}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text:
            'You write compact local-town briefings. Plain text only, no markdown symbols, no preamble.' }] },
          contents: [{ role: 'user', parts: [{ text:
`Write a compact local briefing for ${name} (${country}). Use ONLY the data below. Four short sections titled OVERVIEW, NEWS, COMMUNITY, THIS WEEK, each 2-3 sentences. Lead with any active weather alerts.

DATA:
${JSON.stringify(data).slice(0, 12000)}` }] }],
          generationConfig: { maxOutputTokens: 700 }
        })
      });
      if(!rr.ok) throw new Error('Gemini HTTP ' + rr.status);
      const j = await rr.json();
      return (j.candidates?.[0]?.content?.parts || []).map(pt => pt.text || '').join('').trim();
    });
    res.json({ text });
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* ---- NASA EONET natural events (wildfires, storms, volcanoes, floods…) ---- */
app.get('/api/events-natural', async (req, res) => {
  try{
    const data = await cached('eonet:open', 20 * 60e3, async () => {
      const rr = await fetch('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=200');
      if(!rr.ok) throw new Error('EONET HTTP ' + rr.status);
      return rr.json();
    });
    const events = (data.events || []).map(e => {
      const geo = (e.geometry || []).slice(-1)[0];   // most recent position
      if(!geo || !Array.isArray(geo.coordinates)) return null;
      const [lon, lat] = geo.coordinates;
      if(typeof lat !== 'number' || typeof lon !== 'number') return null;
      return {
        id: e.id, title: e.title,
        category: e.categories?.[0]?.title || 'Event',
        cat: e.categories?.[0]?.id || '',
        lat, lon,
        date: geo.date || '',
        url: e.sources?.[0]?.url || (e.link || '')
      };
    }).filter(Boolean);
    res.json({ events });
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* ---- nearby webcams (Windy Webcams API v3) ----
   Free-tier image URLs carry tokens that expire in 10 minutes, so the cache
   TTL stays safely under that. */
app.get('/api/webcams', async (req, res) => {
  try{
    if(!WINDY) return res.status(503).json({ error: 'not configured' });
    const { lat, lon } = req.query;
    if(!lat || !lon) return res.status(400).json({ error: 'bad params' });
    const key = `wc:${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
    const data = await cached(key, 8 * 60e3, async () => {
      const url = 'https://api.windy.com/webcams/api/v3/webcams' +
        `?nearby=${encodeURIComponent(lat)}%2C${encodeURIComponent(lon)}%2C80` +
        '&limit=24&include=images%2Clocation%2Cplayer%2Curls';
      const rr = await fetch(url, { headers: { 'x-windy-api-key': WINDY, Accept: 'application/json' } });
      if(!rr.ok) throw new Error('Windy HTTP ' + rr.status);
      return rr.json();
    });
    const cams = (data.webcams || []).map(w => {
      const pid = w.webcamId || w.id || '';
      const pl = w.player || {};
      // v3 sometimes returns player modes as flags rather than URLs — Windy's
      // embed player URL is deterministic, so build it from the cam id
      const embed = m => pid ? `https://webcams.windy.com/webcams/public/embed/player/${pid}/${m}` : '';
      const asUrl = (v, m) => typeof v === 'string' && v.startsWith('http') ? v : (v ? embed(m) : '');
      return {
        id: pid,
        title: w.title || 'Webcam',
        lat: w.location?.latitude,
        lon: w.location?.longitude,
        city: [w.location?.city, w.location?.region].filter(Boolean).join(', '),
        img: w.images?.current?.preview || w.images?.current?.thumbnail || '',
        page: w.urls?.detail || w.urls?.webcam ||
              (pid ? 'https://www.windy.com/webcams/' + pid : ''),
        playerLive: asUrl(pl.live, 'live'),
        playerDay: asUrl(pl.day, 'day') || asUrl(pl.month, 'month'),
        live: !!pl.live
      };
    }).filter(w => w.img && w.lat != null);
    res.json({ cams });
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});

/* ---- radar proxy (RainViewer) — same-origin so filtered networks still work ---- */
app.get('/api/radar/meta', async (req, res) => {
  try{
    const d = await cached('radar:meta', 5 * 60e3, async () => {
      const rr = await fetch('https://api.rainviewer.com/public/weather-maps.json');
      if(!rr.ok) throw new Error('RainViewer HTTP ' + rr.status);
      return rr.json();
    });
    res.json(d);
  }catch(e){ res.status(502).json({ error: String(e.message || e) }); }
});
app.get('/api/radar/tile', async (req, res) => {
  try{
    const { p, z, x, y } = req.query;
    if(!/^\/v2\/(radar|nowcast)\/[\w-]+$/.test(String(p))) throw new Error('bad path');
    if(![z, x, y].every(v => /^\d+$/.test(String(v)))) throw new Error('bad coords');
    // free tier: 512px tiles, Universal Blue (2), max zoom 7
    const url = `https://tilecache.rainviewer.com${p}/512/${z}/${x}/${y}/2/1_1.png`;
    const buf = await cached('rt:' + url, 5 * 60e3, async () => {
      const rr = await fetch(url);
      if(!rr.ok) throw new Error('tile HTTP ' + rr.status);
      return Buffer.from(await rr.arrayBuffer());
    });
    res.type('image/png').send(buf);
  }catch(e){ res.status(502).send(''); }
});

/* ---- OpenWeatherMap tile proxy (clouds / temperature; key stays server-side) ---- */
let owmCalls = [];
function owmAllowed(){
  const now = Date.now();
  owmCalls = owmCalls.filter(t => now - t < 60e3);
  if(owmCalls.length >= 50) return false;    // hard ceiling under OWM's 60/min
  owmCalls.push(now);
  return true;
}
app.get('/api/wx-tile', async (req, res) => {
  try{
    if(!OWM) return res.status(503).send('');
    const { layer, z, x, y } = req.query;
    if(!['clouds_new','temp_new','wind_new','pressure_new'].includes(String(layer))) throw new Error('bad layer');
    if(![z, x, y].every(v => /^\d+$/.test(String(v)))) throw new Error('bad coords');
    const url = `https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${OWM}`;
    // free-tier data is ~3 h stale anyway, so a 45-min tile cache loses nothing
    const buf = await cached('owm:' + url, 45 * 60e3, async () => {
      if(!owmAllowed()) throw new Error('OWM rate ceiling');
      const rr = await fetch(url);
      if(!rr.ok) throw new Error('OWM HTTP ' + rr.status);
      return Buffer.from(await rr.arrayBuffer());
    });
    res.type('image/png').send(buf);
  }catch(e){ res.status(502).send(''); }
});

/* ---- NASA GIBS tile proxy (satellite true-color, fire hotspots; keyless) ---- */
const GIBS_LAYERS = {
  satellite: { id:'VIIRS_SNPP_CorrectedReflectance_TrueColor', tms:'GoogleMapsCompatible_Level9', ext:'jpg' },
  fires:     { id:'VIIRS_SNPP_Thermal_Anomalies_375m_All',     tms:'GoogleMapsCompatible_Level8', ext:'png' }
};
app.get('/api/gibs-tile', async (req, res) => {
  try{
    const L = GIBS_LAYERS[String(req.query.layer)];
    const { z, x, y } = req.query;
    if(!L) throw new Error('bad layer');
    if(![z, x, y].every(v => /^\d+$/.test(String(v)))) throw new Error('bad coords');
    const mkUrl = t => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${L.id}/default/${t}/${L.tms}/${z}/${y}/${x}.${L.ext}`;
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const buf = await cached('gibs:' + L.id + ':' + z + ':' + y + ':' + x, 30 * 60e3, async () => {
      for(const t of ['default', yesterday]){
        const rr = await fetch(mkUrl(t));
        if(rr.ok) return Buffer.from(await rr.arrayBuffer());
      }
      throw new Error('GIBS unavailable');
    });
    res.type(L.ext === 'jpg' ? 'image/jpeg' : 'image/png').send(buf);
  }catch(e){ res.status(502).send(''); }
});

/* ---- layer diagnostics: fetches one sample tile per provider, reports upstream status ---- */
app.get('/api/layer-test', async (req, res) => {
  const out = {};
  const probe = async (name, url, opts) => {
    try{
      const rr = await fetch(url, opts);
      out[name] = { status: rr.status, type: rr.headers.get('content-type') };
    }catch(e){ out[name] = { error: String(e.message || e) }; }
  };
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  await Promise.all([
    probe('gibs_satellite_default', 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/default/GoogleMapsCompatible_Level9/4/5/4.jpg'),
    probe('gibs_satellite_dated', `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${yesterday}/GoogleMapsCompatible_Level9/4/5/4.jpg`),
    probe('gibs_fires', `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_Thermal_Anomalies_375m_All/default/${yesterday}/GoogleMapsCompatible_Level8/4/5/4.png`),
    OWM ? probe('owm_clouds', `https://tile.openweathermap.org/map/clouds_new/4/4/5.png?appid=${OWM}`) : Promise.resolve(out.owm_clouds = { error: 'no key' }),
    FSQ ? probe('fsq_search', `${FSQ_BASE}/places/search?ll=42.33%2C-83.05&radius=1000&limit=1`, { headers: FSQ_HDRS() }) : Promise.resolve(out.fsq_search = { error: 'no key' }),
    probe('rainviewer_meta', 'https://api.rainviewer.com/public/weather-maps.json')
  ]);
  res.json(out);
});

app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
const SELF = (process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
if(SELF){
  setInterval(() => { fetch(SELF + '/api/health').catch(()=>{}); }, 10 * 60e3);
  console.log('keep-alive: pinging ' + SELF + ' every 10 min');
  const warm = () => ['/api/states/visit', '/api/states/weird', '/api/states/events']
    .forEach((ep, i) => setTimeout(() => fetch(SELF + ep).catch(()=>{}), i * 30e3));
  setTimeout(warm, 30e3);                 // warm shortly after boot
  setInterval(warm, 6 * 3600e3);          // and keep the daily caches fresh
  // one-time pre-warm of all 50 state law sets (cached ~forever via Redis)
  if(AI) STATES.forEach(([name], i) =>
    setTimeout(() => fetch(SELF + '/api/laws?scope=state&place=' + encodeURIComponent(name)).catch(()=>{}), 120e3 + i * 4000));
}
app.listen(PORT, () => console.log('local-atlas listening on :' + PORT));
