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

app.get('/api/health', (req, res) => res.json({ ok: true, fsq: !!FSQ, tm: !!TM, ai: !!AI, owm: !!OWM, redis: !!RURL, nps: !!NPS }));

/* ---- Foursquare places ---- */
const FSQ_CATS = {
  services: '12000,15000',      // community/government, health
  attractions: '16000,10000',   // landmarks/outdoors, arts & entertainment
  food: '13000',                // dining & drinking
  shopping: '17000',            // retail
  kids: '10000'                 // arts & entertainment (OSM covers playgrounds etc.)
};
app.get('/api/places', async (req, res) => {
  try{
    if(!FSQ) return res.status(503).json({ error: 'FSQ_API_KEY not set' });
    const { lat, lon, radius = '7000', category = 'food' } = req.query;
    if(!lat || !lon || !FSQ_CATS[category]) return res.status(400).json({ error: 'bad params' });
    const r = Math.min(parseInt(radius, 10) || 7000, 100000);
    const url = 'https://api.foursquare.com/v3/places/search' +
      `?ll=${encodeURIComponent(lat)}%2C${encodeURIComponent(lon)}` +
      `&radius=${r}&categories=${FSQ_CATS[category]}&limit=50` +
      '&fields=fsq_id%2Cname%2Cgeocodes%2Ccategories%2Clocation%2Cdistance%2Cwebsite%2Ctel%2Chours';
    const data = await cached('fsq:' + url, 6 * 3600e3, async () => {
      const rr = await fetch(url, { headers: { Authorization: FSQ, Accept: 'application/json' } });
      if(!rr.ok) throw new Error('Foursquare HTTP ' + rr.status);
      return rr.json();
    });
    const items = (data.results || []).map(p => ({
      fsqId: p.fsq_id || '',
      name: p.name,
      kind: (p.categories?.[0]?.name || '').toLowerCase(),
      lat: p.geocodes?.main?.latitude,
      lon: p.geocodes?.main?.longitude,
      dist: (p.distance || 0) / 1609,
      website: p.website || '',
      phone: p.tel || '',
      hours: p.hours?.display || '',
      openNow: typeof p.hours?.open_now === 'boolean' ? p.hours.open_now : null,
      addr: p.location?.formatted_address || '',
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
function rssTitles(xml, limit){
  const out = [];
  const rx = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g;
  let m;
  while((m = rx.exec(xml)) && out.length < limit){
    let t = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if(t.includes(' - ')) t = t.split(' - ').slice(0, -1).join(' - ');
    out.push(t);
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
    const data = await cached('st:weird', 24 * 3600e3, async () => {
      const perState = await mapLimit(STATES, 6, async ([name, abbr, lat, lon]) => {
        try{
          const feed = 'https://news.google.com/rss/search?q=' +
            encodeURIComponent(`"${name} man"`) + '&hl=en-US&gl=US&ceid=US:en';
          const rr = await fetch(feed);
          if(!rr.ok) return { name, abbr, lat, lon, titles: [] };
          return { name, abbr, lat, lon, titles: rssTitles(await rr.text(), 8) };
        }catch(e){ return { name, abbr, lat, lon, titles: [] }; }
      });
      let ranked;
      try{
        const compact = Object.fromEntries(perState.filter(st => st.titles.length)
          .map(st => [st.name, st.titles]));
        ranked = await geminiJSON(
`Below are recent news headlines that begin with or feature "<State> man". Score each state 0-10 for how absurd, silly, shocking, or dumb its "<State> man" stories are — the "Florida Man" phenomenon. Respond ONLY with a JSON array of the 12 weirdest states, best first:
[{"state":"...","score":9.4,"headlines":["up to 3 of the funniest verbatim headlines for that state, funniest first"]}]

HEADLINES:
${JSON.stringify(compact).slice(0, 14000)}`, 1200);
      }catch(e){
        ranked = perState.map(st => ({ state: st.name, score: st.titles.length, headlines: st.titles.slice(0, 3) }))
          .sort((a, b) => b.score - a.score).slice(0, 12);
      }
      return ranked.map(r => {
        const st = STATES.find(x => x[0] === r.state);
        return { ...r, abbr: st?.[1] || '', lat: st?.[2], lon: st?.[3] };
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
    const data = await cached('st:visit:' + monthKey, 24 * 3600e3, async () => {
      const month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const ranked = await geminiJSON(
`It is ${month}. Rank the 10 best US states to visit this month, considering typical weather, seasonal scenery, festivals, and outdoor conditions. Respond ONLY with a JSON array, best first:
[{"state":"...","why":"one concrete sentence on why this month specifically"}]`, 900);
      return ranked.map(r => {
        const st = STATES.find(x => x[0] === r.state);
        return { ...r, abbr: st?.[1] || '', lat: st?.[2], lon: st?.[3] };
      });
    });
    res.json({ items: data });
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
    const out = await cached(`cs:${(+lat).toFixed(2)},${(+lon).toFixed(2)}`, 7 * 86400e3, async () => {
      const fr = await fetch(`https://geo.fcc.gov/api/census/area?lat=${lat}&lon=${lon}&format=json`);
      if(!fr.ok) throw new Error('FCC HTTP ' + fr.status);
      const a = (await fr.json()).results?.[0];
      if(!a?.county_fips) throw new Error('outside US census coverage');
      const st = a.county_fips.slice(0, 2), co = a.county_fips.slice(2);
      const key = CENSUS ? '&key=' + CENSUS : '';
      const cr = await fetch('https://api.census.gov/data/2023/acs/acs5' +
        `?get=NAME,B01003_001E,B19013_001E,B01002_001E&for=county:${co}&in=state:${st}${key}`);
      if(!cr.ok) throw new Error('Census HTTP ' + cr.status);
      const row = (await cr.json())[1];
      return { county: row[0], population: +row[1], medianIncome: +row[2], medianAge: +row[3] };
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
    const data = await cached('fd:' + id, 86400e3, async () => {
      const rr = await fetch(`https://api.foursquare.com/v3/places/${id}?fields=rating%2Cprice%2Cphotos`,
        { headers: { Authorization: FSQ, Accept: 'application/json' } });
      if(!rr.ok) throw new Error('Foursquare HTTP ' + rr.status);
      return rr.json();
    });
    res.json({
      rating: data.rating ?? null,
      price: data.price ?? null,
      photo: data.photos?.[0] ? data.photos[0].prefix + '500x300' + data.photos[0].suffix : ''
    });
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
}
app.listen(PORT, () => console.log('local-atlas listening on :' + PORT));
