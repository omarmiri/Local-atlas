# Local Atlas

A single-file web app for exploring any US or Canadian town: pick a place by ZIP, city, or
current location, and get a zoomed-in map with weather, active weather alerts,
local news, public services, attractions, kids activities, and places to eat. Zoom out and tap
any nearby town marker to explore it the same way. Your last place is
remembered between visits.

## Data sources (all keyless)

| Feature | Source |
|---|---|
| Map tiles | CARTO light basemap / OpenStreetMap |
| ZIP / postal code lookup | zippopotam.us (US + CA) |
| City geocoding | Open-Meteo Geocoding API |
| Reverse geocoding | BigDataCloud client API |
| Weather | National Weather Service (US) / Open-Meteo (Canada + fallback) |
| Alerts | National Weather Service (US) / Environment Canada GeoMet (Canada) |
| Services / attractions / food | Overpass API (OpenStreetMap) |
| Local news | Google News RSS (deployed) or Claude web search (inside claude.ai) |
| Last-place memory | localStorage (deployed) or artifact storage (inside claude.ai) |

## Deploy on Render (Node Web Service)

1. Render dashboard → **New → Web Service** → connect this repo
2. Runtime: Node · Build command: `npm install` · Start command: `npm start`
3. Environment tab → add keys (all encrypted, never in the repo):
   - `FSQ_API_KEY` — Foursquare Places (places coverage, photos, ratings)
   - `TICKETMASTER_API_KEY` — events tab
   - `CENSUS_API_KEY` — optional; raises rate limits on the county-profile lookups
   - `GEMINI_API_KEY` — the AI "Brief" tab (Gemini Flash-Lite, cheapest tier; free key at aistudio.google.com). Optional `GEMINI_MODEL` overrides the model.
   - `OPENWEATHER_API_KEY` — optional; Clouds and Temperature map layers (free key at openweathermap.org; free tier is ~3 h delayed and 60 calls/min — the server caps and caches to stay under it).
   - `WINDY_API_KEY` — optional; the Cams tab (live nearby webcams; free key at api.windy.com, attribution to Windy required and shown).
   - `NPS_API_KEY` — optional; national-park event counts in the Top States leaderboards (free key at nps.gov/subjects/developer).
4. Deploy. Every feature degrades gracefully when its key is absent.

Without `FSQ_API_KEY`, everything still works from OpenStreetMap — Foursquare
just adds coverage. The server also proxies news, Reddit, and deal-scans
(no more public CORS proxies) and keeps a shared response cache.

## Run locally

Any static server works:

    python3 -m http.server 8000

then open http://localhost:8000. (Opening index.html directly as a `file://`
URL also works for most features, but geolocation requires http(s).)

## Notes

- Geolocation needs HTTPS and user permission; if unavailable or denied, the
  app falls back to an approximate IP-based location automatically.
- Overpass (the places database) is a shared free service and can be slow at
  peak times — re-open the tab to retry.
