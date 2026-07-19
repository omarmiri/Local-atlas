# Local Atlas

A single-file web app for exploring any US town: pick a place by ZIP, city, or
current location, and get a zoomed-in map with weather, active weather alerts,
local news, public services, attractions, and places to eat. Zoom out and tap
any nearby town marker to explore it the same way. Your last place is
remembered between visits.

## Data sources (all keyless)

| Feature | Source |
|---|---|
| Map tiles | CARTO light basemap / OpenStreetMap |
| ZIP lookup | zippopotam.us |
| City geocoding | Open-Meteo Geocoding API |
| Reverse geocoding | BigDataCloud client API |
| Weather + alerts | National Weather Service (api.weather.gov) |
| Services / attractions / food | Overpass API (OpenStreetMap) |
| Local news | Google News RSS (deployed) or Claude web search (inside claude.ai) |
| Last-place memory | localStorage (deployed) or artifact storage (inside claude.ai) |

## Deploy on Render

1. Render dashboard → **New → Static Site**
2. Connect this repo
3. Build command: *(leave empty)* — Publish directory: `.`
4. Deploy. That's it — there is no build step and no server.

`render.yaml` is included, so **New → Blueprint** pointed at this repo works too.

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
