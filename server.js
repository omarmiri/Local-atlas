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

app.get('/api/health', (req, res) => res.json({ ok: true, fsq: !!FSQ }));

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
      '&fields=name%2Cgeocodes%2Ccategories%2Clocation%2Cdistance%2Cwebsite%2Ctel%2Chours';
    const data = await cached('fsq:' + url, 6 * 3600e3, async () => {
      const rr = await fetch(url, { headers: { Authorization: FSQ, Accept: 'application/json' } });
      if(!rr.ok) throw new Error('Foursquare HTTP ' + rr.status);
      return rr.json();
    });
    const items = (data.results || []).map(p => ({
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

app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log('local-atlas listening on :' + PORT));
