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
const AI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';  // cheapest tier, auto-tracks latest

/* ---- tiny TTL cache ---- */
const cache = new Map();
function cached(key, ttlMs, fn){
  const hit = cache.get(key);
  if(hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return fn().then(v => {
    cache.set(key, { t: Date.now(), v });
    if(cache.size > 600){ cache.delete(cache.keys().next().value); }
    return v;
  });
}

app.get('/api/health', (req, res) => res.json({ ok: true, fsq: !!FSQ, tm: !!TM, ai: !!AI }));

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

app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log('local-atlas listening on :' + PORT));
