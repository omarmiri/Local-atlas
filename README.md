# Local Atlas

A local-exploration web app for any US or Canadian location. Pick a place — by ZIP,
Canadian postal code, city name, "use my location," or by tapping anywhere on the map —
and get a zoomed-in view with weather, radar, alerts, news, events, places to eat/shop/see,
recreation, webcams, radio, surf, quirky laws, cost of living, and more. Zoom out and tap any
town marker to explore it the same way. A separate **US Ranks** panel scores all 50 states on
"weirdest news," "most happening," and "best to visit this month."

The frontend is a single `index.html` (map UI + all tabs). The backend is a small
Node/Express server (`server.js`) that serves the static file and proxies every keyed or
CORS-restricted API, holding a shared two-level cache. Current app version badge: **v5.5**
(shown in the header; bump it when you ship so you can confirm a deploy landed).

## Architecture

```
Browser (index.html, Leaflet map, vanilla JS)
   |  /api/* calls
Node/Express (server.js)
   |- proxies keyed APIs (keys stay server-side)
   |- two-level cache: in-memory L1  +  Upstash Redis L2 (optional but recommended)
   |- keep-alive self-ping every 10 min (prevents free-tier spin-down)
   |- background pre-warm on boot: state leaderboards + all 50 state law/tax sets
```

Everything degrades gracefully: any feature whose key is missing simply hides or shows a
neutral "not available" state. The app is fully usable with **zero** keys (OpenStreetMap +
National Weather Service + Open-Meteo + Radio Browser + RainViewer are all keyless).

## Environment variables (Render -> Environment tab)

All optional unless noted; all encrypted, never in the repo. Health endpoint `/api/health`
returns a boolean per key so you can confirm what's wired.

| Variable | Enables | Notes / free tier |
|---|---|---|
| `GOOGLE_API_KEY` | Place ratings, reviews counts, photos, editorial blurbs, opening hours on Eat/Shop/See/Rec/Kids | **Google Places API (New).** Enable *Places API (New)* in the Cloud project and attach billing; an AI Studio / Gemini key will **not** work. Requesting `rating`, `priceLevel`, `regularOpeningHours`, `websiteUri` puts Nearby Search on the **Enterprise** SKU — see "Cost control" below. Verify with `/api/layer-test` → `google_search`. |
| `FSQ_API_KEY` | Extra place **coverage** + website/phone on Eat/Shop/See/Rec/Kids | **Foursquare "Service" key**, not a legacy fsq3 key. Legacy v3 API shut down May 2026; this app uses the new Places API (`places-api.foursquare.com`, `X-Places-Api-Version` header). Supplement only — Google is the primary. Set both and results merge, set either alone and it works, set neither and places still come from OpenStreetMap. |
| `FSQ_PREMIUM_FIELDS` | Asks Foursquare for `hours` + `rating` too | Off by default. Those two fields sit behind a **separately metered premium quota** that returns **429 on those fields alone** once spent, while plain search keeps working. Ratings now come from Google, so spending that quota buys little. Set to `1` only if you have premium quota to burn. |
| `TICKETMASTER_API_KEY` | Events tab + "Most Happening" leaderboard | Use the **Consumer Key**, not the secret. |
| `GEMINI_API_KEY` | AI Brief, quirky Laws, state tax summary, "Weirdest/Visit" leaderboards | Free tier at aistudio.google.com. Model defaults to `gemini-flash-lite-latest`; `GEMINI_MODEL` overrides. |
| `OPENWEATHER_API_KEY` | Clouds + Temperature map layers | Free tier is ~3 h delayed and 60 calls/min. Server caps at 50/min, caches tiles 45 min, and limits native zoom to stay under the limit. New keys can take ~2 h to activate. |
| `WINDY_API_KEY` | Cams tab (nearby live webcams) | Free key at api.windy.com. Image URLs carry 10-min tokens, so the cache TTL stays under that. Windy attribution is required and shown. |
| `NASA_API_KEY` | Natural Events map layer (wildfires/storms/volcanoes/floods) | Free key at api.nasa.gov. EONET itself is keyless; the key just gates the feature flag. |
| `NPS_API_KEY` | National-park event counts in "Most Happening" | Free key at nps.gov/subjects/developer. |
| `CENSUS_API_KEY` | Higher rate limits on the town-profile + Cost lookups | Optional; the Census geocoder and ACS work without it at lower limits. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Persistent L2 cache | Check it with **`/api/cache-test`**, which forces a real round-trip and reports the verdict. The `redis` flag on `/api/health` used to be `!!RURL` — it only proved the env var was non-empty, and since every Redis error is swallowed, a bad token looked exactly like a permanently cold cache. **Strongly recommended.** Free tier: 256 MB, 500k commands/mo, no card. Use the **REST** URL+token (not the redis:// string). Without it, caches reset on every restart/spin-down, re-running Gemini/Foursquare calls unnecessarily. |
| `GEMINI_MODEL` | Overrides the Gemini model string | Optional. |
| `SELF_PING_URL` | Overrides the keep-alive target | Optional; defaults to Render's `RENDER_EXTERNAL_URL`. |

## Deploy on Render (Node Web Service)

1. Render dashboard -> **New -> Web Service** -> connect this repo (`omarmiri/Local-atlas`, branch `main`).
2. Runtime **Node** - Build `npm install` - Start `npm start`.
3. Add the environment variables above (at minimum the ones whose features you want).
4. Deploy. Render auto-deploys on every push to `main`.
5. Verify: open `/api/health` and confirm the expected flags are `true`; check the version
   badge in the header matches your latest commit.

`RENDER_EXTERNAL_URL` is provided automatically and drives the keep-alive self-ping.

> **Live URL note:** the running service is the web service at the `-api` host
> (e.g. `local-atlas-api.onrender.com`). An older static-site deploy of the same name may
> still exist; the web service is the canonical one. Saved favorites live in the browser and
> are domain-bound, so changing the host resets a user's saved list.

## Feature map (tabs & panels)

- **Green "Local Atlas" panel** - Weather (NWS/Open-Meteo + AQI/UV), Surf (coastal only:
  wave/swell + 7-day chart + named breaks & board rentals with directions), Alerts, News,
  Events, Services, See & Do, Eat, Shop, Rec (golf/trails/fishing/theaters/bowling/arcades/
  marinas), Kids, Cams (Windy grid + branded in-app player), Radio (Radio Browser + persistent
  mini-player), Social (Reddit + platform chips), Brief (AI digest), Laws (quirky town+state,
  permanently cached), Cost (Census housing/income/property-tax + effective rate + state tax
  summary), Saved.
- **Gold "US Ranks" panel** - Weirdest ("<State> man" headlines, AI-scored, article links),
  Most Happening (Ticketmaster + NPS + festivals), Visit This Month (AI seasonal + tourism/
  Lonely Planet/Wikivoyage links). Top-10 get numbered map pins.
- **Map layers menu** - animated rain radar, NASA satellite (clouds/smoke), live clouds,
  temperature, fire hotspots, natural events. All proxied server-side.
- **Other** - severe-alert banner (merges NWS alerts + nearby EONET events), county/town census
  stats line, dark mode toggle (cookie-persisted, follows system preference, darkens map tiles),
  shareable URLs (`#p=lat,lon,country,name`), recent-places chips, PWA (installable, offline
  shell, never caches `/api/`).

## Place data & caching model

- Place tabs merge **OpenStreetMap** (coverage) with **Google Places** and/or **Foursquare**
  ratings/price/photos, then offer Nearest / Top-rated sort. OSM finds places; the commercial
  providers rank them.
- `/api/places?lat=&lon=&radius=&category=` queries every configured provider in parallel and
  merges them server-side on normalised name before the browser sees anything. Add
  `&provider=google` or `&provider=fsq` to isolate one provider when debugging.
- **Google is the primary; Foursquare is a best-effort supplement.** Google is listed first so it
  wins every merge tie, and it gets a 10 s deadline against Foursquare's 6 s — a slow or hung
  Foursquare can never hold up a response Google already answered. A timed-out call still
  finishes into the cache, so it costs latency once, not the result.
- **The two providers do different jobs.** Measured on one Chicago `food` lookup: Google returned
  20 places and *all* 20 ratings; Foursquare returned 44 more places Google didn't have, and
  between them website/phone landed on 63 of 64 results. Google ranks, Foursquare broadens. That
  split is why Foursquare stays wired in even though its premium tier is exhausted — see
  `FSQ_PREMIUM_FIELDS` above.
- **Google's `includedTypes` matches a place's *secondary* types**, so a science centre with an
  IMAX comes back under `movie_theater` and a hotel gym under `fitness_center`. `googOffTopic()`
  drops a result only when another tab plainly owns its **primary** type. Two things about it are
  load-bearing and easy to break:
  - It is *not* "primaryType must be in the requested list". Google's restaurants carry qualified
    primary types (`pizza_restaurant`, `soul_food_restaurant`) that appear in no list, and that
    stricter rule empties the Eat tab. Unit cases guard this.
  - Matching is on the **base** of a qualified type (`art_museum` → `museum`), because an exact
    comparison let `art_museum` onto Rec while `pizza_restaurant` still had to resolve to food.
- **Rating scales differ.** Foursquare is 0-10, Google is 0-5. The server normalises everything to
  the 0-10 `rating` field so one sort works across providers, and carries the raw Google values in
  `rating5` / `ratingCount` for display. If you add a third provider, normalise it the same way.
- `/api/placedetails?src=goog|fsq&id=` fetches the photo, price, review count, and (Google only)
  editorial blurb when a card is expanded. `/api/fsqdetails` is kept as a legacy alias because
  service-worker-cached frontends still call it.
- Leaderboards and AI features (Laws, Cost's tax block, Weirdest, Visit) are computed **once per
  location/period** and cached server-side, shared across all users. With Redis they survive
  restarts. The server pre-warms the three leaderboards and all 50 state law sets on boot.
- **Overpass (OSM places) reads through `/api/overpass` but is still fetched by the browser.**
  It is the slowest call in a place load (~10 s, mirrors 504 under load), and calling mirrors
  directly meant it could never be cached — every visitor paid full price and nobody's lookup
  warmed anyone else's. `/api/overpass` serves it from the shared cache when present.
  - **Overpass rate-limits by IP, and Render's outbound IP is shared across many services, so it
    is 429'd essentially all the time.** Verified from the deployed host: `overpass-api.de`
    returns 429/504 and the other two mirrors hang past 40 s. Server-side fetching is therefore
    not viable here, and an endpoint that *waits* on it makes every load slower than doing
    nothing. This was a real regression when the proxy first shipped.
  - So: a cache **hit** is served in ~100 ms; a **miss** returns 503 `{miss:true}` in ~2 ms via a
    circuit breaker (15 min cooldown) and the browser fetches from its own IP. The server still
    retries upstream once per cooldown, because one success caches a town for everyone for 24 h.
  - The browser's mirror fallback and the 5 s client timeout on `/api/overpass` are both
    load-bearing. **Don't remove either** — without them a throttled server stalls every user.
  - Watch it with `/api/cache-test` → `overpass: {circuitOpen, tries, wins, lastErr}`.
  - Cross-user warming is therefore mostly **not** happening for OSM data today. Making it work
    would mean letting clients POST their fetched results back for caching — which is a cache
    poisoning vector on an unauthenticated endpoint, so it is deliberately not implemented.
- **Cache-key discipline:** when you change the *shape* of cached data, bump its key prefix
  (e.g. census went `cs:` -> `cs6:`). Otherwise stale entries are served indefinitely and the fix
  appears not to work. This has bitten us repeatedly - it is the first thing to check when a data
  fix "doesn't deploy."

### Cost control (Google Places)

Google Places is **not free** the way the rest of this app's providers are. The field mask decides
the SKU, and this app requests `rating`, `priceLevel`, `regularOpeningHours`, `websiteUri`, and
`nationalPhoneNumber` — all **Enterprise**-tier fields. Budget accordingly:

- One place lookup costs **5 Nearby Search calls** (one per category bucket), not one.
- Results are cached **6 h** per `category x coordinate(4dp) x radius`, in memory *and* in Redis
  when configured. **Set up Upstash** - without it every free-tier spin-down re-bills every lookup.
- Place details are cached **24 h** per place id and only fire when a user expands a card.
- Set a **budget alert and a quota cap** in the Cloud console. Nothing in this app enforces a
  spend ceiling.
- To drop to the cheaper Pro SKU, remove the Enterprise fields from `GOOG_MASK` in `server.js` -
  you lose ratings and hours but keep names, locations, addresses, and photos.

## Weather: "now" must be an observation

`pt.properties.forecast` from NWS returns **12-hour periods** — "Today", "Tonight" — whose
temperature is that block's high (daytime) or low (overnight). Rendering `periods[0]` as the
current reading showed the day's high all afternoon and the overnight low all night. Measured
against live station data: Denver was **12 F too high**, Seattle 8, Phoenix 6, and the condition
text described the whole block ("Showers And Thunderstorms Likely") rather than the sky right now
("Partly Cloudy").

`nwsCurrent()` resolves "now" in this order, and the order matters:

1. **Nearest station's latest observation** (`/stations/{id}/observations/latest`) — the only true
   current reading. Walks up to 3 stations.
2. **Hourly forecast** (`forecastHourly`) — current-hour model value.
3. The 12-hour period, last resort, i.e. the old behaviour.

Two guards are load-bearing, both confirmed against live data:

- **A station can return `temperature.value: null`.** Honolulu's two nearest stations (PHNL, PHNG)
  both did; the third gave 78 F. Without the null check, `Math.round(null * 9/5 + 32)` yields a
  perfectly plausible **32 F in Hawaii**. Never arithmetic on an unchecked observation value.
- **Observations older than 3 h are rejected**, so a station that quietly stopped reporting falls
  through to the hourly forecast instead of pinning a stale number.

Weather is also re-fetched after 10 minutes on a page left open — "current" has to mean current.

## Census geography (town-level stats)

The Cost tab and stats line resolve a coordinate to its municipality via the Census geocoder,
then query ACS 2023. The lookup tries three tiers, in order:
1. **Incorporated Place** (cities - Detroit, Dearborn)
2. **County Subdivision** (townships - NJ/PA/New England/MI, which are *not* "places" in Census
   geography; skip COUSUB `00000`)
3. **County** (only where neither exists - rural/unincorporated)

Do **not** try to synthesize a town figure by averaging sub-geographies - medians can't be
averaged, and the Census already publishes the correct municipal total.

## Development workflow

1. Edit `index.html` / `server.js` in place.
2. **Syntax-gate before every push** (this repo has been broken by unchecked pushes):
   - extract the inline `<script>` to a temp file and run `node --check` on it
   - run `node --check server.js`
   - confirm any new function names actually exist
3. Commit and push to `main`; Render auto-deploys.
4. Bump the header version badge so you can confirm the deploy landed.

When editing, prefer unique-anchor string replacement and assert exactly one match - duplicate
anchors have caused silent breakage. Never leave a duplicated CSS/JS block behind.

## Run locally

The frontend needs the backend for `/api/*`, so run the server:

    npm install
    npm start        # serves index.html + /api on :10000 (or $PORT)

then open the printed URL. Geolocation requires http(s) + user permission; if denied, the app
falls back to approximate IP location.

## Known constraints (by design, not bugs)

- **Live webcams** are best-effort: Windy relays owner-run streams (often YouTube); some are
  offline or block embedding. The in-app player is sandboxed (no pop-outs), with a 10-second
  flakiness timeout that offers the always-works timelapse.
- **Surf** appears only where Open-Meteo Marine returns wave data (coastal points).
- **Overpass** (OSM places) is a shared free service and can be slow at peak; re-open the tab to
  retry.
- **OSM coverage varies** - surf breaks, trails, and niche categories are rich in some regions,
  thin in others.
- **Quirky Laws / tax summaries** are AI-generated folklore/general info, clearly labeled, not
  legal or tax advice.
