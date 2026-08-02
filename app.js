'use strict';

/* ==========================================================================
   Constants
   ========================================================================== */

const DEFAULT_LOCATION = { lat: 47.6588, lon: -117.4260, label: 'Spokane, WA' };
const WATCH_RADIUS_MILES = 50;
const WATCH_RADIUS_METERS = WATCH_RADIUS_MILES * 1609.34;
const MILES_PER_METER = 1 / 1609.34;

const LS_KEYS = {
  address: 'fw_last_address',
  apiKey: 'fw_anthropic_key',
  model: 'fw_anthropic_model',
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const SPREAD_CYCLE_MS = 16000;
const SPREAD_MAX_HOURS = 24;

/* ==========================================================================
   State
   ========================================================================== */

const state = {
  point: { ...DEFAULT_LOCATION },
  aqi: null,
  alerts: [],
  fires: [],
  wind: null,
  risk: null,
  map: null,
  mapReady: false,
  homeMarker: null,
  fireMarkers: [],
  terrainOn: true,
  ffwiOn: false,
  landcoverOn: false,
  spreadOn: true,
  spreadRAF: null,
  spreadLastUpdate: 0,
};

/* ==========================================================================
   Small utilities
   ========================================================================== */

function $(sel) { return document.querySelector(sel); }

function metersToMiles(m) { return m * MILES_PER_METER; }

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dPhi = (lat2 - lat1) * Math.PI / 180, dLambda = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDegrees(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dLambda = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function destinationPoint(lat, lon, bearingDeg, distanceMeters) {
  const R = 6371000;
  const brng = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180, lon1 = lon * Math.PI / 180;
  const dR = distanceMeters / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(dR) * Math.cos(lat1),
    Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
}

function compassLabel(deg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return dirs[idx];
}

function circleLineString(lat, lon, radiusMeters, points = 96) {
  const coords = [];
  for (let i = 0; i <= points; i++) {
    const brng = (i / points) * 360;
    const dp = destinationPoint(lat, lon, brng, radiusMeters);
    coords.push([dp.lon, dp.lat]);
  }
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };
}

/* ==========================================================================
   Toast / status
   ========================================================================== */

let toastTimer = null;
function showToast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'visible' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

function setStatusDot(s) { $('#status-dot').className = 'status-dot ' + s; }

/* ==========================================================================
   Geocoding (Nominatim / OSM)
   ========================================================================== */

let lastGeocodeAt = 0;
async function geocodeAddress(query) {
  const now = Date.now();
  if (now - lastGeocodeAt < 1000) {
    throw new Error('Please wait a moment before searching again.');
  }
  lastGeocodeAt = now;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('Geocoding request failed');
  const data = await res.json();
  if (!data.length) throw new Error('Address not found');
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), label: data[0].display_name };
}

/* ==========================================================================
   Data fetchers
   ========================================================================== */

async function fetchAQI(lat, lon) {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10,us_aqi`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('AQI fetch failed');
  const data = await res.json();
  return data.current || null;
}

async function fetchAlerts(lat, lon) {
  const url = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/geo+json' } });
  if (!res.ok) throw new Error('Alerts fetch failed');
  const data = await res.json();
  const relevant = (data.features || []).filter((f) => /fire|smoke|red flag|air quality/i.test(f.properties.event || ''));
  return relevant.map((f) => ({
    id: f.id,
    event: f.properties.event,
    headline: f.properties.headline,
    severity: f.properties.severity,
    description: f.properties.description,
    effective: f.properties.effective,
    expires: f.properties.expires,
    isFireWeather: /red flag|fire weather/i.test(f.properties.event || ''),
  }));
}

function pickField(attrs, patterns) {
  const keys = Object.keys(attrs);
  for (const pat of patterns) {
    const k = keys.find((key) => pat.test(key));
    if (k && attrs[k] != null && attrs[k] !== '') return attrs[k];
  }
  return null;
}

function normalizeFireFeature(feat) {
  const a = feat.attributes || {};
  const geom = feat.geometry || {};
  let lat = geom.y, lon = geom.x;
  if (lat == null || lon == null) {
    lat = a.LAT_COORD ?? pickField(a, [/^lat/i]);
    lon = a.LON_COORD ?? pickField(a, [/^lon/i]);
  }
  if (lat == null || lon == null) return null;
  // WA DNR's Public_Wildfire layer uses these exact field names (confirmed against the live service).
  const name = a.INCIDENT_NM || pickField(a, [/incident.*nm/i, /fire.*name/i, /^name$/i]) || 'Unnamed fire';
  const acresRaw = a.ACRES_BURNED != null ? a.ACRES_BURNED : pickField(a, [/acre/i]);
  const discoveredRaw = a.DSCVR_DT != null ? a.DSCVR_DT : pickField(a, [/dscvr/i, /discover/i]);
  const outRaw = a.FIRE_OUT_DT !== undefined ? a.FIRE_OUT_DT : pickField(a, [/out.*dt/i, /out.*date/i]);
  const isOut = outRaw != null;
  return {
    id: a.OBJECTID ?? a.objectid ?? `${lat},${lon},${name}`,
    name: String(name),
    acres: acresRaw != null ? Number(acresRaw) : null,
    discovered: discoveredRaw ? new Date(Number(discoveredRaw) || discoveredRaw) : null,
    status: isOut ? 'Out' : 'Active',
    active: !isOut,
    lat: Number(lat),
    lon: Number(lon),
  };
}

async function fetchFires(lat, lon) {
  const bufDeg = WATCH_RADIUS_MILES / 69;
  const lonBuf = bufDeg / Math.max(Math.cos(lat * Math.PI / 180), 0.15);
  const xmin = lon - lonBuf, xmax = lon + lonBuf;
  const ymin = lat - bufDeg, ymax = lat + bufDeg;
  const params = new URLSearchParams({
    f: 'json',
    outFields: '*',
    geometry: `${xmin},${ymin},${xmax},${ymax}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outSR: '4326',
    returnGeometry: 'true',
  });
  const url = `https://gis.dnr.wa.gov/site3/rest/services/Public_Wildfire/WADNR_PUBLIC_WD_WildFire_Data/MapServer/1/query?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Fire data fetch failed');
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Fire data error');
  return (data.features || [])
    .map(normalizeFireFeature)
    .filter(Boolean)
    .map((f) => {
      f.distanceMeters = haversineMeters(lat, lon, f.lat, f.lon);
      f.bearingDeg = bearingDegrees(lat, lon, f.lat, f.lon);
      return f;
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

async function fetchWind(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,relative_humidity_2m` +
    `&current=wind_speed_10m,wind_direction_10m,temperature_2m,relative_humidity_2m` +
    `&forecast_days=3&wind_speed_unit=mph&temperature_unit=fahrenheit`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Wind fetch failed');
  return res.json();
}

function getCurrentWind() {
  if (!state.wind || !state.wind.current) return null;
  const c = state.wind.current;
  if (c.wind_speed_10m == null || c.wind_direction_10m == null) return null;
  return { speedMph: c.wind_speed_10m, directionDeg: c.wind_direction_10m };
}

function sampleWindForecast(wind) {
  if (!wind || !wind.hourly || !wind.hourly.time) return [];
  const out = [];
  for (let i = 0; i < wind.hourly.time.length; i += 6) {
    out.push({
      time: wind.hourly.time[i],
      speed_mph: wind.hourly.wind_speed_10m[i],
      direction_deg: wind.hourly.wind_direction_10m[i],
    });
  }
  return out;
}

/* ==========================================================================
   Risk score (composite, explainable)
   ========================================================================== */

function usAqiBand(aqi) {
  if (aqi == null) return { label: 'Unknown', score: 0 };
  if (aqi <= 50) return { label: 'Good', score: 0 };
  if (aqi <= 100) return { label: 'Moderate', score: 1 };
  if (aqi <= 150) return { label: 'Unhealthy (sensitive groups)', score: 2 };
  if (aqi <= 200) return { label: 'Unhealthy', score: 3 };
  if (aqi <= 300) return { label: 'Very unhealthy', score: 4 };
  return { label: 'Hazardous', score: 5 };
}

function computeRisk({ aqi, alerts, fires }) {
  const factors = [];
  let score = 0;

  const aqiVal = aqi ? aqi.us_aqi : null;
  const band = usAqiBand(aqiVal);
  score += band.score * 2;
  factors.push({ label: 'Air quality (US AQI)', value: aqiVal != null ? `${Math.round(aqiVal)} — ${band.label}` : 'Unavailable' });

  const fireWx = alerts.filter((a) => a.isFireWeather);
  score += fireWx.length ? 6 : 0;
  factors.push({ label: 'Active fire weather alert', value: fireWx.length ? fireWx.map((a) => a.event).join(', ') : 'None' });

  const otherAlerts = alerts.filter((a) => !a.isFireWeather);
  if (otherAlerts.length) {
    score += 2;
    factors.push({ label: 'Other active alerts', value: otherAlerts.map((a) => a.event).join(', ') });
  }

  const activeFires = fires.filter((f) => f.active);
  const withinRadius = activeFires.filter((f) => f.distanceMeters <= WATCH_RADIUS_METERS);
  factors.push({ label: `Active fires within ${WATCH_RADIUS_MILES} mi`, value: String(withinRadius.length) });

  if (withinRadius.length) {
    const nearest = withinRadius[0];
    const distMi = metersToMiles(nearest.distanceMeters);
    factors.push({ label: 'Nearest active fire', value: `${nearest.name} — ${distMi.toFixed(1)} mi` });
    if (distMi < 5) score += 8;
    else if (distMi < 15) score += 5;
    else if (distMi < 30) score += 3;
    else score += 1;
    score += Math.min(withinRadius.length - 1, 4);
  } else {
    factors.push({ label: 'Nearest active fire', value: `None within ${WATCH_RADIUS_MILES} mi` });
  }

  let level;
  if (score >= 16) level = 'extreme';
  else if (score >= 10) level = 'high';
  else if (score >= 4) level = 'moderate';
  else level = 'low';

  return { level, score, factors };
}

/* ==========================================================================
   Fosberg Fire Weather Index (FFWI) — Fosberg, 1978
   ========================================================================== */

function fosbergFFWI(tempF, rhPct, windMph) {
  const T = tempF, H = rhPct;
  let m;
  if (H < 10) m = 0.03229 + 0.281073 * H - 0.000578 * H * T;
  else if (H < 50) m = 2.22749 + 0.160107 * H - 0.01478 * T;
  else m = 21.0606 + 0.005565 * H * H - 0.00035 * H * T - 0.483199 * H;
  const mRatio = m / 30;
  const eta = m >= 30 ? 0 : (1 - 2 * mRatio + 1.5 * mRatio * mRatio - 0.5 * mRatio * mRatio * mRatio);
  const ffwi = eta * Math.sqrt(1 + windMph * windMph) / 0.3002;
  return { m, ffwi };
}

function ffwiColor(ffwi) {
  if (ffwi < 15) return '#5fb87a';
  if (ffwi < 30) return '#e8b93d';
  if (ffwi < 50) return '#e8843d';
  if (ffwi < 75) return '#d9483d';
  return '#a020f0';
}

async function computeFFWIGrid(map) {
  const bounds = map.getBounds();
  const n = 6;
  const pts = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const lat = bounds.getSouth() + (bounds.getNorth() - bounds.getSouth()) * (i + 0.5) / n;
      const lon = bounds.getWest() + (bounds.getEast() - bounds.getWest()) * (j + 0.5) / n;
      pts.push([lat, lon]);
    }
  }
  const latStr = pts.map((p) => p[0].toFixed(4)).join(',');
  const lonStr = pts.map((p) => p[1].toFixed(4)).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latStr}&longitude=${lonStr}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('FFWI grid fetch failed');
  const data = await res.json();
  const arr = Array.isArray(data) ? data : [data];
  const cellW = (bounds.getEast() - bounds.getWest()) / n;
  const cellH = (bounds.getNorth() - bounds.getSouth()) / n;
  const features = arr.map((d, idx) => {
    const i = Math.floor(idx / n), j = idx % n;
    const c = d.current || {};
    const { ffwi } = fosbergFFWI(c.temperature_2m, c.relative_humidity_2m, c.wind_speed_10m);
    const west = bounds.getWest() + cellW * j, east = west + cellW;
    const south = bounds.getSouth() + cellH * i, north = south + cellH;
    return {
      type: 'Feature',
      properties: { ffwi: Number.isFinite(ffwi) ? ffwi : 0, color: ffwiColor(ffwi) },
      geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
    };
  });
  return { type: 'FeatureCollection', features };
}

async function recomputeFFWIGrid() {
  if (!state.map || !state.mapReady) return;
  try {
    const fc = await computeFFWIGrid(state.map);
    state.map.getSource('ffwi-src').setData(fc);
  } catch (err) {
    console.error(err);
  }
}

/* ==========================================================================
   Simplified elliptical fire spread projection (Anderson 1983 geometry)
   Educational estimate only — see disclaimer in the UI.
   ========================================================================== */

function computeSlopePercent(map, lat, lon, bearingDeg) {
  if (!map || typeof map.queryTerrainElevation !== 'function' || !map.getTerrain()) return 0;
  try {
    const back = destinationPoint(lat, lon, (bearingDeg + 180) % 360, 100);
    const fwd = destinationPoint(lat, lon, bearingDeg, 100);
    const e1 = map.queryTerrainElevation([back.lon, back.lat]);
    const e2 = map.queryTerrainElevation([fwd.lon, fwd.lat]);
    if (e1 == null || e2 == null) return 0;
    return ((e2 - e1) / 200) * 100;
  } catch (err) {
    return 0;
  }
}

function computeFireEllipse(fire, wind, terrainSlopeFn, hoursElapsed) {
  const windSpeedMph = wind.speedMph;
  const windSpeedKmh = windSpeedMph * 1.60934;
  const LB = 0.936 * Math.exp(0.2566 * windSpeedKmh) + 0.461 * Math.exp(-0.1548 * windSpeedKmh) - 0.397;
  const lbSafe = Math.max(LB, 1.01);
  const e = Math.sqrt(lbSafe * lbSafe - 1) / lbSafe;
  const spreadBearing = (wind.directionDeg + 180) % 360;

  const baselineRosMPerMin = 2.5; // illustrative grass/shrub-mix reference rate — not fuel-mapped per incident
  const windMult = Math.min(1 + 0.55 * windSpeedMph, 9);
  const slopePct = terrainSlopeFn ? terrainSlopeFn(fire.lat, fire.lon, spreadBearing) : 0;
  const slopeMult = Math.min(Math.max(1 + slopePct / 20, 0.5), 3);
  const rosHead = baselineRosMPerMin * windMult * slopeMult;

  const minutes = hoursElapsed * 60;
  const Dh = rosHead * minutes;
  const a = Dh / (1 + e);
  const b = a / lbSafe;
  const c = a * e;
  const center = destinationPoint(fire.lat, fire.lon, spreadBearing, c);
  return { center, a, b, bearing: spreadBearing };
}

function ellipsePolygonRingCoords(centerLat, centerLon, semiMajorM, semiMinorM, bearingDeg, points = 48) {
  const coords = [];
  const bRad = bearingDeg * Math.PI / 180;
  const majorDirE = Math.sin(bRad), majorDirN = Math.cos(bRad);
  const minorDirE = Math.sin(bRad + Math.PI / 2), minorDirN = Math.cos(bRad + Math.PI / 2);
  for (let i = 0; i <= points; i++) {
    const theta = (i / points) * 2 * Math.PI;
    const xMajor = semiMajorM * Math.cos(theta);
    const yMinor = semiMinorM * Math.sin(theta);
    const dE = xMajor * majorDirE + yMinor * minorDirE;
    const dN = xMajor * majorDirN + yMinor * minorDirN;
    const dist = Math.hypot(dE, dN);
    const brng = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
    const p = destinationPoint(centerLat, centerLon, brng, dist);
    coords.push([p.lon, p.lat]);
  }
  return coords;
}

const SPREAD_RING_STOPS = [
  { scale: 1.0, opacity: 0.08 },
  { scale: 0.78, opacity: 0.15 },
  { scale: 0.55, opacity: 0.24 },
  { scale: 0.3, opacity: 0.34 },
];

function updateSpreadLayers(hours) {
  if (!state.map || !state.mapReady || !state.spreadOn) return;
  const src = state.map.getSource('spread-src');
  if (!src) return;
  const wind = getCurrentWind();
  const activeFires = state.fires.filter((f) => f.active);
  if (!wind || !activeFires.length) {
    src.setData(emptyFC());
    return;
  }
  const features = [];
  activeFires.forEach((fire) => {
    const ell = computeFireEllipse(fire, wind, (lat, lon, bearing) => computeSlopePercent(state.map, lat, lon, bearing), hours);
    if (ell.a <= 1) return;
    SPREAD_RING_STOPS.forEach((stop) => {
      const coords = ellipsePolygonRingCoords(ell.center.lat, ell.center.lon, ell.a * stop.scale, ell.b * stop.scale, ell.bearing);
      features.push({ type: 'Feature', properties: { opacity: stop.opacity }, geometry: { type: 'Polygon', coordinates: [coords] } });
    });
  });
  src.setData({ type: 'FeatureCollection', features });
}

function startSpreadAnimation() {
  const startTime = performance.now();
  function tick(now) {
    if (now - state.spreadLastUpdate > 120) {
      state.spreadLastUpdate = now;
      const elapsedMs = (now - startTime) % SPREAD_CYCLE_MS;
      const hours = (elapsedMs / SPREAD_CYCLE_MS) * SPREAD_MAX_HOURS;
      updateSpreadLayers(hours);
    }
    state.spreadRAF = requestAnimationFrame(tick);
  }
  state.spreadRAF = requestAnimationFrame(tick);
}

/* ==========================================================================
   Map
   ========================================================================== */

function buildBaseStyle() {
  return {
    version: 8,
    sources: {
      'carto-dark': {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
          'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
          'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
          'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        ],
        tileSize: 256,
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      },
      'terrain-dem': {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: 15,
      },
    },
    layers: [
      { id: 'carto-dark-layer', type: 'raster', source: 'carto-dark' },
      {
        id: 'hillshade-layer', type: 'hillshade', source: 'terrain-dem',
        paint: { 'hillshade-shadow-color': '#0b0c10', 'hillshade-highlight-color': '#3a3d48', 'hillshade-exaggeration': 0.5 },
      },
    ],
  };
}

function addDynamicLayers(map) {
  map.addSource('watch-circle', { type: 'geojson', data: circleLineString(state.point.lat, state.point.lon, WATCH_RADIUS_METERS) });
  map.addLayer({
    id: 'watch-circle-layer', type: 'line', source: 'watch-circle',
    paint: { 'line-color': '#5fb87a', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.85 },
  });

  map.addSource('ffwi-src', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'ffwi-layer', type: 'fill', source: 'ffwi-src', layout: { visibility: 'none' },
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.38 },
  });

  map.addSource('landcover-src', {
    type: 'raster',
    tiles: ['https://services.terrascope.be/wms/v2?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true&LAYERS=WORLDCOVER_2021_MAP&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}'],
    tileSize: 256,
  });
  map.addLayer({
    id: 'landcover-layer', type: 'raster', source: 'landcover-src', layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.55 },
  });

  map.addSource('spread-src', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'spread-layer', type: 'fill', source: 'spread-src',
    paint: { 'fill-color': '#ff5c1a', 'fill-opacity': ['get', 'opacity'], 'fill-antialias': true },
  });
}

function createDotEl(color, glow) {
  const el = document.createElement('div');
  el.style.width = '14px';
  el.style.height = '14px';
  el.style.borderRadius = '50%';
  el.style.background = color;
  el.style.border = '2px solid rgba(255,255,255,0.85)';
  if (glow) el.style.boxShadow = `0 0 10px 3px ${color}`;
  return el;
}

function popupHtmlForFire(f) {
  return `
    <div class="popup-title">${escapeHtml(f.name)}</div>
    <div class="popup-row">Status <b>${escapeHtml(f.status)}</b></div>
    ${f.acres != null ? `<div class="popup-row">Acres <b>${Number(f.acres).toLocaleString()}</b></div>` : ''}
    <div class="popup-row">Distance <b>${metersToMiles(f.distanceMeters).toFixed(1)} mi ${compassLabel(f.bearingDeg)}</b></div>
    ${f.discovered ? `<div class="popup-row">Discovered <b>${f.discovered.toLocaleDateString()}</b></div>` : ''}
  `;
}

function initMap() {
  const map = new maplibregl.Map({
    container: 'map',
    style: buildBaseStyle(),
    center: [state.point.lon, state.point.lat],
    zoom: 9,
    pitch: 45,
    maxPitch: 75,
    attributionControl: { compact: true },
  });
  state.map = map;
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

  map.on('load', () => {
    state.mapReady = true;
    try { map.setTerrain({ source: 'terrain-dem', exaggeration: 1.3 }); } catch (err) { /* terrain optional */ }
    addDynamicLayers(map);
    renderMapData();
    startSpreadAnimation();
  });

  map.on('moveend', debounce(() => {
    if (state.ffwiOn) recomputeFFWIGrid();
  }, 1500));
}

function renderMapData() {
  if (!state.mapReady) return;
  const map = state.map;

  if (!state.homeMarker) {
    state.homeMarker = new maplibregl.Marker({ element: createDotEl('#5fb87a', true) })
      .setLngLat([state.point.lon, state.point.lat]).addTo(map);
  } else {
    state.homeMarker.setLngLat([state.point.lon, state.point.lat]);
  }

  const circleSrc = map.getSource('watch-circle');
  if (circleSrc) circleSrc.setData(circleLineString(state.point.lat, state.point.lon, WATCH_RADIUS_METERS));

  state.fireMarkers.forEach((m) => m.remove());
  state.fireMarkers = state.fires.map((f) => {
    const el = createDotEl(f.active ? '#ff5c1a' : '#8a8a8a', f.active);
    const marker = new maplibregl.Marker({ element: el }).setLngLat([f.lon, f.lat]);
    marker.setPopup(new maplibregl.Popup({ offset: 14 }).setHTML(popupHtmlForFire(f)));
    marker.addTo(map);
    return marker;
  });

  if (state.ffwiOn) recomputeFFWIGrid();
}

/* ==========================================================================
   AI hypothesis (bring-your-own Anthropic key, browser-direct)
   ========================================================================== */

function buildPrompt(ctx) {
  const system = 'You are assisting a hobbyist wildfire-smoke conditions dashboard. Reason ONLY from the data in ' +
    'the user message. Do not speculate beyond it, do not invent fires, wind values, or alerts not given. ' +
    'Do not use language that reads as an official warning, evacuation order, or emergency guidance — this is a ' +
    'clearly-labeled AI-generated hypothesis on a hobby dashboard, not an authoritative source. Respond with ONLY ' +
    'a JSON object, no prose outside it, matching exactly this shape: {"hypotheses": [{"direction": ' +
    '"N|NE|E|SE|S|SW|W|NW", "distance_band": "string, e.g. \'0-5 mi\'", "rationale": "1-2 sentences", ' +
    '"confidence": "low|medium|high"}]}';

  const user = JSON.stringify({
    searched_address: ctx.label,
    coordinates: { lat: ctx.lat, lon: ctx.lon },
    active_fires: ctx.fires.map((f) => ({
      name: f.name,
      distance_miles: Number(metersToMiles(f.distanceMeters).toFixed(1)),
      bearing_from_address: compassLabel(f.bearingDeg),
      acres: f.acres,
      discovered: f.discovered ? f.discovered.toISOString().slice(0, 10) : null,
    })),
    current_wind: ctx.wind && ctx.wind.current ? {
      speed_mph: ctx.wind.current.wind_speed_10m,
      direction_deg: ctx.wind.current.wind_direction_10m,
    } : null,
    wind_forecast_3day_sampled_every_6h: ctx.windSample,
    current_aqi_us: ctx.aqi ? ctx.aqi.us_aqi : null,
    current_pm2_5: ctx.aqi ? ctx.aqi.pm2_5 : null,
    active_fire_weather_alerts: ctx.alerts.filter((a) => a.isFireWeather).map((a) => ({
      event: a.event, headline: a.headline, text: (a.description || '').slice(0, 600),
    })),
  }, null, 2);

  return { system, user };
}

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse model output');
  return JSON.parse(match[0]);
}

function setAIStatus(msg) { $('#ai-status').textContent = msg; }

function renderAIResults(hyps) {
  const el = $('#ai-results');
  if (!hyps || !hyps.length) {
    el.innerHTML = '<div class="empty-note">No structured hypothesis returned.</div>';
    return;
  }
  el.innerHTML = hyps.map((h) => `
    <div class="ai-hypothesis-item">
      <div class="dir-row"><span>${escapeHtml(h.direction || '?')}</span><span>${escapeHtml(h.distance_band || '')}</span></div>
      <div class="rationale">${escapeHtml(h.rationale || '')}</div>
      <div class="confidence">Confidence: ${escapeHtml(h.confidence || 'unknown')}</div>
    </div>
  `).join('');
}

async function runAIHypothesis() {
  const apiKey = localStorage.getItem(LS_KEYS.apiKey);
  if (!apiKey) return;
  const model = localStorage.getItem(LS_KEYS.model) || 'claude-sonnet-5';
  $('#ai-run-btn').disabled = true;
  setAIStatus('Contacting Claude…');
  try {
    const ctx = {
      label: state.point.label,
      lat: state.point.lat,
      lon: state.point.lon,
      fires: state.fires.filter((f) => f.active).slice(0, 12),
      wind: state.wind,
      windSample: sampleWindForecast(state.wind),
      aqi: state.aqi,
      alerts: state.alerts,
    };
    const { system, user } = buildPrompt(ctx);
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Claude API error ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || '').join('');
    const parsed = extractJSON(text);
    renderAIResults(parsed.hypotheses || []);
    setAIStatus(`Updated ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    setAIStatus(`Failed: ${err.message}`);
  } finally {
    $('#ai-run-btn').disabled = false;
  }
}

function refreshAIKeyUI() {
  const has = !!localStorage.getItem(LS_KEYS.apiKey);
  $('#ai-key-prompt').style.display = has ? 'none' : 'block';
  $('#ai-content').style.display = has ? 'block' : 'none';
}

function openKeyModal() {
  $('#key-input').value = localStorage.getItem(LS_KEYS.apiKey) || '';
  $('#model-input').value = localStorage.getItem(LS_KEYS.model) || 'claude-sonnet-5';
  $('#key-modal').classList.remove('hidden');
}
function closeKeyModal() { $('#key-modal').classList.add('hidden'); }
function saveKey() {
  const key = $('#key-input').value.trim();
  const model = $('#model-input').value.trim() || 'claude-sonnet-5';
  if (!key) { showToast('Enter a key first', true); return; }
  localStorage.setItem(LS_KEYS.apiKey, key);
  localStorage.setItem(LS_KEYS.model, model);
  closeKeyModal();
  refreshAIKeyUI();
}
function clearKey() {
  localStorage.removeItem(LS_KEYS.apiKey);
  localStorage.removeItem(LS_KEYS.model);
  refreshAIKeyUI();
}

/* ==========================================================================
   Rendering: top bar + bottom sheet
   ========================================================================== */

function aqiChipClass(v) {
  if (v <= 50) return 'good';
  if (v <= 100) return 'warn';
  if (v <= 200) return 'bad';
  return 'severe';
}

function renderTopbar() {
  const chip = $('#aqi-chip');
  if (state.aqi && state.aqi.us_aqi != null) {
    const v = Math.round(state.aqi.us_aqi);
    chip.textContent = `AQI ${v}`;
    chip.className = 'aqi-chip ' + aqiChipClass(v);
  } else {
    chip.textContent = '–';
    chip.className = 'aqi-chip';
  }
}

function renderAlertsList() {
  const el = $('#alerts-list');
  if (!state.alerts.length) {
    el.innerHTML = '<div class="empty-note">No active fire-weather alerts for this point.</div>';
    return;
  }
  el.innerHTML = state.alerts.map((a) => `
    <div class="card">
      <div class="card-title-row">
        <span class="card-title">${escapeHtml(a.event)}</span>
        <span class="card-meta">${a.expires ? 'until ' + new Date(a.expires).toLocaleString() : ''}</span>
      </div>
      <span class="card-tag ${a.severity === 'Severe' || a.severity === 'Extreme' ? 'severe' : 'warning'}">${escapeHtml(a.severity || '')}</span>
      <div class="card-body">${escapeHtml(a.headline || '')}</div>
    </div>
  `).join('');
}

function renderFiresList() {
  const el = $('#fires-list');
  if (!state.fires.length) {
    el.innerHTML = '<div class="empty-note">No WA DNR fire records within range. Fires outside Washington won’t show here — check InciWeb.</div>';
    return;
  }
  el.innerHTML = state.fires.slice(0, 30).map((f) => `
    <div class="card">
      <div class="card-title-row">
        <span class="card-title">${escapeHtml(f.name)}</span>
        <span class="card-meta">${metersToMiles(f.distanceMeters).toFixed(1)} mi ${compassLabel(f.bearingDeg)}</span>
      </div>
      <span class="card-tag ${f.active ? 'active' : 'out'}">${f.active ? 'Active' : 'Out'}</span>
      <div class="card-body">
        ${f.acres != null ? Number(f.acres).toLocaleString() + ' acres &middot; ' : ''}${f.discovered ? 'discovered ' + f.discovered.toLocaleDateString() : ''}
      </div>
    </div>
  `).join('');
}

function renderSheet() {
  $('#chip-alerts').textContent = state.alerts.length;
  $('#chip-fires').textContent = state.fires.filter((f) => f.active).length;
  $('#chip-pm25').textContent = state.aqi && state.aqi.pm2_5 != null ? state.aqi.pm2_5.toFixed(1) : '–';

  const riskChip = $('#chip-risk');
  riskChip.className = 'chip risk-' + (state.risk ? state.risk.level : 'low');
  riskChip.querySelector('.n').textContent = state.risk ? capitalize(state.risk.level) : '–';

  const badge = $('#risk-badge');
  badge.className = 'risk-badge ' + (state.risk ? state.risk.level : 'low');
  $('#risk-pill').textContent = state.risk ? capitalize(state.risk.level) : '–';
  $('#risk-summary').textContent = state.risk
    ? `Composite score ${state.risk.score} — based on the live factors below.`
    : 'Waiting for data…';
  $('#risk-factors').innerHTML = (state.risk ? state.risk.factors : [])
    .map((f) => `<li>${escapeHtml(f.label)}<span class="val">${escapeHtml(f.value)}</span></li>`).join('');

  renderAlertsList();
  renderFiresList();
}

/* ==========================================================================
   Orchestration
   ========================================================================== */

async function refreshAll() {
  setStatusDot('stale');
  $('#refresh-btn').classList.add('spinning');
  const { lat, lon } = state.point;
  try {
    const [aqiR, alertsR, firesR, windR] = await Promise.allSettled([
      fetchAQI(lat, lon), fetchAlerts(lat, lon), fetchFires(lat, lon), fetchWind(lat, lon),
    ]);

    state.aqi = aqiR.status === 'fulfilled' ? aqiR.value : null;
    state.alerts = alertsR.status === 'fulfilled' ? alertsR.value : [];
    state.fires = firesR.status === 'fulfilled' ? firesR.value : [];
    state.wind = windR.status === 'fulfilled' ? windR.value : null;

    [aqiR, alertsR, firesR, windR].forEach((r) => { if (r.status === 'rejected') console.error(r.reason); });

    state.risk = computeRisk({ aqi: state.aqi, alerts: state.alerts, fires: state.fires });

    renderTopbar();
    renderSheet();
    renderMapData();

    const anyFailed = [aqiR, alertsR, firesR, windR].some((r) => r.status === 'rejected');
    setStatusDot(anyFailed ? 'stale' : 'live');
    if (anyFailed) showToast('Some data sources failed to load — showing what is available.', true);
  } catch (err) {
    setStatusDot('error');
    showToast('Failed to refresh data: ' + err.message, true);
  } finally {
    $('#refresh-btn').classList.remove('spinning');
  }
}

async function onSearchSubmit(e) {
  e.preventDefault();
  const q = $('#address-input').value.trim();
  if (!q) return;
  setStatusDot('stale');
  showToast('Searching…');
  try {
    const loc = await geocodeAddress(q);
    state.point = loc;
    localStorage.setItem(LS_KEYS.address, JSON.stringify(loc));
    $('#address-input').value = loc.label;
    if (state.map) state.map.flyTo({ center: [loc.lon, loc.lat], zoom: 10 });
    await refreshAll();
    showToast('Updated: ' + loc.label);
  } catch (err) {
    showToast('Search failed: ' + err.message, true);
    setStatusDot('error');
  }
}

function loadStoredPoint() {
  try {
    const raw = localStorage.getItem(LS_KEYS.address);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.lat === 'number' && typeof parsed.lon === 'number') {
        state.point = parsed;
        return;
      }
    }
  } catch (err) { /* ignore malformed storage */ }
  state.point = { ...DEFAULT_LOCATION };
}

function onToggleTerrain() {
  state.terrainOn = !state.terrainOn;
  $('#toggle-terrain').classList.toggle('active', state.terrainOn);
  if (!state.map) return;
  if (state.terrainOn) {
    state.map.setTerrain({ source: 'terrain-dem', exaggeration: 1.3 });
    state.map.easeTo({ pitch: 45 });
  } else {
    state.map.setTerrain(null);
    state.map.easeTo({ pitch: 0 });
  }
}

function onToggleFFWI() {
  state.ffwiOn = !state.ffwiOn;
  $('#toggle-ffwi').classList.toggle('active', state.ffwiOn);
  $('#ffwi-legend').classList.toggle('visible', state.ffwiOn);
  if (state.map && state.mapReady) state.map.setLayoutProperty('ffwi-layer', 'visibility', state.ffwiOn ? 'visible' : 'none');
  if (state.ffwiOn) recomputeFFWIGrid();
}

function onToggleLandcover() {
  state.landcoverOn = !state.landcoverOn;
  $('#toggle-landcover').classList.toggle('active', state.landcoverOn);
  if (state.map && state.mapReady) state.map.setLayoutProperty('landcover-layer', 'visibility', state.landcoverOn ? 'visible' : 'none');
}

function onToggleSpread() {
  state.spreadOn = !state.spreadOn;
  $('#toggle-spread').classList.toggle('active', state.spreadOn);
  if (state.map && state.mapReady) {
    state.map.setLayoutProperty('spread-layer', 'visibility', state.spreadOn ? 'visible' : 'none');
    if (!state.spreadOn) state.map.getSource('spread-src').setData(emptyFC());
  }
}

function syncToggleButtons() {
  $('#toggle-terrain').classList.toggle('active', state.terrainOn);
  $('#toggle-ffwi').classList.toggle('active', state.ffwiOn);
  $('#toggle-landcover').classList.toggle('active', state.landcoverOn);
  $('#toggle-spread').classList.toggle('active', state.spreadOn);
  $('#ffwi-legend').classList.toggle('visible', state.ffwiOn);
}

function wireUI() {
  $('#search-form').addEventListener('submit', onSearchSubmit);
  $('#refresh-btn').addEventListener('click', () => refreshAll());
  $('#sheet-handle').addEventListener('click', () => $('#sheet').classList.toggle('expanded'));
  $('#toggle-terrain').addEventListener('click', onToggleTerrain);
  $('#toggle-ffwi').addEventListener('click', onToggleFFWI);
  $('#toggle-landcover').addEventListener('click', onToggleLandcover);
  $('#toggle-spread').addEventListener('click', onToggleSpread);
  $('#ai-open-key-modal').addEventListener('click', openKeyModal);
  $('#key-modal-close').addEventListener('click', closeKeyModal);
  $('#key-cancel').addEventListener('click', closeKeyModal);
  $('#key-save').addEventListener('click', saveKey);
  $('#ai-clear-key').addEventListener('click', clearKey);
  $('#ai-run-btn').addEventListener('click', runAIHypothesis);
  syncToggleButtons();
  refreshAIKeyUI();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}

async function init() {
  loadStoredPoint();
  $('#address-input').value = state.point.label;
  initMap();
  wireUI();
  await refreshAll();
  registerServiceWorker();
}

document.addEventListener('DOMContentLoaded', init);
