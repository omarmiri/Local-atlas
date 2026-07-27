# Local Atlas

A local-exploration web app for any US or Canadian location. Pick a place — by ZIP,
Canadian postal code, city name, "use my location," or by tapping anywhere on the map —
and get a zoomed-in view with weather, radar, alerts, news, events, places to eat/shop/see,
recreation, webcams, radio, surf, quirky laws, cost of living, and more. Zoom out and tap any
town marker to explore it the same way. A separate **US Ranks** panel scores all 50 states on
"weirdest news," "most happening," and "best to visit this month."

The frontend is a single `index.html` (map UI + all tabs). The backend is a small
Node/Express server (`server.js`) that serves the static file and proxies every keyed or
CORS-restricted API, holding a shared two-level cache. Current app version badge: **v5.3**
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
| `FSQ_API_KEY` | Same enrichment, from Foursquare | **Foursquare "Service" key**, not a legacy fsq3 key. Legacy v3 API shut down May 2026; this app uses the new Places API (`places-api.foursquare.com`, `X-Places-Api-Version` header). Optional now that Google is wired in — set both and results merge, set either alone and it works, set neither and places still come from OpenStreetMap. |
| `TICKETMASTER_API_KEY` | Events tab + "Most Happening" leaderboard | Use the **Consumer Key**, not the secret. |
| `GEMINI_API_KEY` | AI Brief, quirky Laws, state tax summary, "Weirdest/Visit" leaderboards | Free tier at aistudio.google.com. Model defaults to `gemini-flash-lite-latest`; `GEMINI_MODEL` overrides. |
| `OPENWEATHER_API_KEY` | Clouds + Temperature map layers | Free tier is ~3 h delayed and 60 calls/min. Server caps at 50/min, caches tiles 45 min, and limits native zoom to stay under the limit. New keys can take ~2 h to activate. |
| `WINDY_API_KEY` | Cams tab (nearby live webcams) | Free key at api.windy.com. Image URLs carry 10-min tokens, so the cache TTL stays under that. Windy attribution is required and shown. |
| `NASA_API_KEY` | Natural Events map layer (wildfires/storms/volcanoes/floods) | Free key at api.nasa.gov. EONET itself is keyless; the key just gates the feature flag. |
| `NPS_API_KEY` | National-park event counts in "Most Happening" | Free key at nps.gov/subjects/developer. |
| `CENSUS_API_KEY` | Higher rate limits on the town-profile + Cost lookups | Optional; the Census geocoder and ACS work without it at lower limits. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Persistent L2 cache | **Strongly recommended.** Free tier: 256 MB, 500k commands/mo, no card. Use the **REST** URL+token (not the redis:// string). Without it, caches reset on every restart/spin-down, re-running Gemini/Foursquare calls unnecessarily. |
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
  merges them server-side on normalised name before the browser sees anything. Google wins ties
  (fresher hours and ratings); Foursquare fills the gaps. Add `&provider=google` or
  `&provider=fsq` to isolate one provider when debugging.
- **Rating scales differ.** Foursquare is 0-10, Google is 0-5. The server normalises everything to
  the 0-10 `rating` field so one sort works across providers, and carries the raw Google values in
  `rating5` / `ratingCount` for display. If you add a third provider, normalise it the same way.
- `/api/placedetails?src=goog|fsq&id=` fetches the photo, price, review count, and (Google only)
  editorial blurb when a card is expanded. `/api/fsqdetails` is kept as a legacy alias because
  service-worker-cached frontends still call it.
- Leaderboards and AI features (Laws, Cost's tax block, Weirdest, Visit) are computed **once per
  location/period** and cached server-side, shared across all users. With Redis they survive
  restarts. The server pre-warms the three leaderboards and all 50 state law sets on boot.
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
