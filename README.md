# Spokane Fire Watch

A live wildfire, smoke, and fire-weather dashboard for any address. The interface is map-first and mobile-optimized,
pulling together real-time air quality, National Weather Service alerts, active fire incident data, real terrain,
and weather-driven fire risk into a single static site deployed on GitHub Pages — no server, no build step, just
open it.

## Status

- [x] Live AQI, fire weather alerts, nearby active fires
- [x] Address search (recenter everything on any address, remembered in `localStorage`)
- [x] Transparent composite risk score with a visible factor breakdown
- [x] Claude-grounded hypothesis of elevated-risk directions (bring-your-own API key)
- [x] Topographical terrain rendering (MapLibre GL + AWS Terrarium elevation tiles)
- [x] Weather-driven risk coloring (Fosberg Fire Weather Index grid)
- [x] Simplified elliptical wind/terrain-driven spread projection
- [x] Land cover overlay (ESA WorldCover, labeled as a fuel-type *proxy*, not real fuel data)
- [ ] Optional: WindNinja terrain-corrected wind — not wired in. Its public API's CORS policy, auth, and
      latency couldn't be confirmed from this environment (its `robots.txt` blocks automated fetching), so the
      app deliberately sticks to point wind from Open-Meteo everywhere rather than guess at an unverified
      integration. See `app.js` for where a real WindNinja call would slot in if the API is confirmed later.

## How it's built

Plain static site, no build step: `index.html` + `style.css` + `app.js`, plus `sw.js` for an offline app shell and
`manifest.webmanifest` for PWA install. Every data call goes straight from the browser to a public, CORS-enabled
API — the only exception is the AI hypothesis feature, which calls Anthropic directly from the browser using a
key the visitor supplies and stores only in their own `localStorage`.

## Data Sources

| Source | What it provides |
|--------|-----------------|
| [Open-Meteo](https://open-meteo.com/) | Air quality index, wind, temperature, humidity (current + 3-day forecast) |
| [National Weather Service (NWS)](https://www.weather.gov/otx/) | Fire weather watches, red-flag warnings, and other alerts, point-scoped |
| [WA DNR – Public Wildfire Data](https://gis.dnr.wa.gov/site3/rest/services/Public_Wildfire/WADNR_PUBLIC_WD_WildFire_Data/MapServer/1) | Active fire incident locations *(Washington jurisdiction only)* |
| [Nominatim / OpenStreetMap](https://nominatim.openstreetmap.org/) | Address geocoding |
| [CARTO Dark Matter](https://carto.com/basemaps/) | Base map tiles |
| [AWS Terrarium elevation tiles](https://registry.opendata.aws/terrain-tiles/) | Real terrain / hillshade / slope for the spread model |
| [ESA WorldCover](https://esa-worldcover.org/) via Terrascope WMS | Land cover, used only as a rough fuel-type *proxy*, clearly labeled as such |

> **Note:** WA DNR fire data covers Washington State jurisdiction only and may not include fires on federal or
> tribal land, or fires in other states. The app links out to InciWeb for full coverage.

## Feature notes

- **Risk badge** is a simple, explainable weighted score from AQI band, active fire-weather alerts, and
  distance/count of active fires in a 50-mile watch radius — every factor is shown, nothing hidden.
- **AI hypothesis** section is visually distinct (dashed border, persistent disclaimer) and only appears once a
  visitor pastes their own Anthropic API key. The prompt sent to Claude instructs it to reason only from the
  real fetched data and never phrase output as an official warning.
- **Spread projection** uses the elliptical fire-growth model (Anderson 1983 length-to-breadth ratio), oriented
  by wind direction and scaled by terrain slope sampled from the elevation tiles. It's rendered as a soft,
  fading gradient rather than a crisp polygon — intentional, since a hard edge would overstate the model's
  precision. This is an educational estimate, not a physics-based model like FARSITE/WFDSS.

## Local Development

This is a plain static site with no build step.

```bash
git clone https://github.com/shelbeeely/Spokane-Fire-Watch.git
cd Spokane-Fire-Watch
# Option A – open directly
open index.html
# Option B – serve locally (avoids browser CORS restrictions)
python3 -m http.server 8080
# then visit http://localhost:8080
```

## Deployment

The site is served via **GitHub Pages** from this repository. No API keys are ever committed to the repo. The one feature that requires a key (the Claude-grounded hypothesis of elevated-risk directions) reads it from the visitor's own browser storage, entered client-side.

## ⚠️ Disclaimer

This is a **personal hobby project** and is **not** an authoritative source for emergency information. For official, up-to-date information always consult:

- [InciWeb – Incident Information System](https://inciweb.wildfiresituation.us/)
- [WA DNR – Wildfire & Forest Resilience](https://www.dnr.wa.gov/programs-initiatives/wildfire-forest-resilience)
- [Spokane Regional Emergency Management](https://www.spokanecounty.gov/3388/Emergency-Management)

## License

[MIT](LICENSE)