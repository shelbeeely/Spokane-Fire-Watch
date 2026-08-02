# Spokane Fire Watch

A live wildfire, smoke, and fire-weather dashboard for the Spokane, WA area. The interface is map-first and mobile-optimized, pulling together real-time air quality, National Weather Service alerts, and active fire incident data into a single static site deployed on GitHub Pages — no server, no build step, just open it.

## Status

🚧 **Under active development**

- [ ] Live AQI, fire weather alerts, nearby active fires
- [ ] Address search (recenter everything on any address)
- [ ] Transparent composite risk score
- [ ] Claude-grounded hypothesis of elevated-risk directions
- [ ] Topographical terrain rendering
- [ ] Weather-driven risk coloring (Fosberg Fire Weather Index)
- [ ] Simplified wind/terrain-driven spread projection
- [ ] Optional: WindNinja terrain-corrected wind

## Data Sources

| Source | What it provides |
|--------|-----------------|
| [Open-Meteo](https://open-meteo.com/) | Air quality index + weather forecast |
| [National Weather Service (NWS)](https://www.weather.gov/otx/) | Fire weather watches, red-flag warnings, and other alerts |
| [WA DNR – Active Fire Incidents](https://wadnr.maps.arcgis.com/) | Active fire incident locations *(Washington jurisdiction only)* |
| [Nominatim / OpenStreetMap](https://nominatim.openstreetmap.org/) | Address geocoding |
| [CARTO](https://carto.com/basemaps/) | Base map tiles |

> **Note:** WA DNR fire data covers Washington State jurisdiction only and may not include fires on federal land.

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