import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import * as turf from '@turf/turf';
import {
  Circle,
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  Pane,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';
import districtInfoDataUrl from './assets/data/districtInfo.geojson?url';
import evStationsDataUrl from './assets/data/evStations.geojson?url';
import stationsHeatmapUrl from './assets/data/stationsHeatmap.geojson?url';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAP_MODES = {
  DISTRICTS: 'districts',
  STATIONS: 'stations',
  RECOMMENDATION: 'recommendation',
};
const REC_SUB_MODES = {
  SPOTS: 'spots',
  HEATMAP: 'heatmap',
};
const BASEMAPS = {
  STREET: 'street',
  SATELLITE: 'satellite',
};
const DISTRICT_LABEL_MIN_ZOOM = 11.5;
const DISTRICT_COVERAGE_LEGEND = [
  { color: '#005f73', label: '12.00 and above' },
  { color: '#0a9396', label: '8.00 to 11.99' },
  { color: '#94d2bd', label: '4.00 to 7.99' },
  { color: '#e9d8a6', label: '0.01 to 3.99' },
  { color: '#f7f7f7', label: '0.00' },
];
const NEED_SCORE_LEGEND = [
  { color: '#ef4444', label: 'Critical (80–100)' },
  { color: '#f97316', label: 'High need (60–79)' },
  { color: '#eab308', label: 'Moderate (40–59)' },
  { color: '#22c55e', label: 'Well covered (0–39)' },
];

// ── Formatters ────────────────────────────────────────────────────────────────

function formatInteger(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toLocaleString() : 'N/A';
}

function formatCoverage(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(2) : 'N/A';
}

function formatDistanceKm(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} km` : 'N/A';
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function normalizeStations(rawData) {
  return (rawData?.features ?? [])
    .map((feature) => {
      const { Address, Google_Rating, Latitude, Longitude, Name, Total_Reviews } =
        feature.properties ?? {};
      const lat = Number(Latitude);
      const lng = Number(Longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        id: feature.properties?.fid ?? `${Name}-${lat}-${lng}`,
        address: Address || 'No address available',
        lat,
        lng,
        name: Name || 'EV Station',
        rating: Google_Rating,
        reviews: Total_Reviews,
      };
    })
    .filter(Boolean);
}

function getDistrictName(properties) {
  return properties.NAME_2 || properties.final_population_english_District_Name || 'Unknown district';
}

function getDistrictThaiName(properties) {
  return properties.final_population_english_District_Name || 'ไม่มีข้อมูล';
}

function getProvinceName(properties) {
  return properties.NAME_1_2 || properties.NAME_1 || 'Unknown province';
}

function getCoverageColor(coverage) {
  const value = Number(coverage);
  if (!Number.isFinite(value)) return '#d9e2ec';
  if (value >= 12) return '#005f73';
  if (value >= 8) return '#0a9396';
  if (value >= 4) return '#94d2bd';
  if (value > 0) return '#e9d8a6';
  return '#f7f7f7';
}

// ── Need Score helpers ────────────────────────────────────────────────────────

function getNeedScoreColor(score) {
  if (score >= 80) return '#ef4444';
  if (score >= 60) return '#f97316';
  if (score >= 40) return '#eab308';
  return '#22c55e';
}

function getNeedLevel(score) {
  if (score >= 80) return 'Critical need';
  if (score >= 60) return 'High need';
  if (score >= 40) return 'Moderate need';
  return 'Lower priority';
}

/** Human-readable label for buffer distance (used in heatmap sub-mode) */
function getBufferLabel(km) {
  if (km < 1) return 'Charger nearby';
  if (km < 2) return 'Close enough';
  if (km < 3) return 'Moderate gap';
  if (km < 4) return 'Far from coverage';
  if (km < 5) return 'Very far';
  return 'No charger within 3 km';
}

/** Gradient colour for buffer distance (mirrors heatmap palette) */
function getBufferColor(km) {
  if (km < 1) return '#22c55e';
  if (km < 2) return '#84cc16';
  if (km < 3) return '#eab308';
  if (km < 4) return '#f97316';
  if (km < 5) return '#ef4444';
  return '#7f1d1d';
}

// ── Distance & geometry helpers ───────────────────────────────────────────────

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestStationDist(centroid, stations) {
  let min = Infinity;
  for (const s of stations) {
    const d = haversineKm(centroid[0], centroid[1], s.lat, s.lng);
    if (d < min) min = d;
  }
  return min === Infinity ? 999 : min;
}

function findNearestStation(centroid, stations) {
  let nearestStation = null;
  let min = Infinity;
  for (const s of stations) {
    const d = haversineKm(centroid[0], centroid[1], s.lat, s.lng);
    if (d < min) {
      min = d;
      nearestStation = s;
    }
  }
  return {
    distanceKm: min === Infinity ? 999 : min,
    station: nearestStation,
  };
}

/** Area of a ring in square-degree units (sufficient for comparison). */
function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}

/**
 * Returns [lat, lng] of the visual center of a district polygon.
 *
 * For MultiPolygon features (some districts have 10–30 tiny satellite parts),
 * we first isolate the LARGEST polygon part so the pin always lands in the main
 * body of the district, not in a small outlying fragment near another district.
 *
 * We then run a 20×20 grid over that part's bbox and pick the interior point
 * farthest from any edge (pole-of-inaccessibility approximation).
 */
function computeCentroid(feature) {
  try {
    // ── Step 1: extract the largest polygon part ─────────────────────────────
    let workingPolygon; // a GeoJSON Feature<Polygon>
    if (feature.geometry.type === 'Polygon') {
      workingPolygon = feature;
    } else {
      // MultiPolygon — find the part with the largest outer ring
      let largestArea = -1;
      let largestCoords = null;
      for (const polyCoords of feature.geometry.coordinates) {
        const a = ringArea(polyCoords[0]);
        if (a > largestArea) { largestArea = a; largestCoords = polyCoords; }
      }
      workingPolygon = turf.polygon(largestCoords);
    }

    // ── Step 2: grid over largest part's bbox ────────────────────────────────
    const [minLng, minLat, maxLng, maxLat] = turf.bbox(workingPolygon);
    const GRID = 20;
    const lngStep = (maxLng - minLng) / GRID;
    const latStep = (maxLat - minLat) / GRID;

    // Collect outer ring edges for edge-distance scoring
    const edges = [];
    workingPolygon.geometry.coordinates[0].forEach((_, i, ring) => {
      if (i < ring.length - 1) edges.push([ring[i], ring[i + 1]]);
    });

    const minDistToEdge = (lng, lat) => {
      let minD = Infinity;
      for (const [[x1, y1], [x2, y2]] of edges) {
        const dx = x2 - x1, dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        const t = lenSq > 0 ? Math.max(0, Math.min(1, ((lng - x1) * dx + (lat - y1) * dy) / lenSq)) : 0;
        const d = (x1 + t * dx - lng) ** 2 + (y1 + t * dy - lat) ** 2;
        if (d < minD) minD = d;
      }
      return minD;
    };

    let best = null;
    let bestScore = -Infinity;
    for (let row = 0; row <= GRID; row++) {
      for (let col = 0; col <= GRID; col++) {
        const lng = minLng + col * lngStep;
        const lat = minLat + row * latStep;
        const pt = turf.point([lng, lat]);
        if (!turf.booleanPointInPolygon(pt, workingPolygon)) continue;
        const score = minDistToEdge(lng, lat);
        if (score > bestScore) { bestScore = score; best = [lat, lng]; }
      }
    }

    if (!best) {
      const c = turf.centroid(workingPolygon);
      best = [c.geometry.coordinates[1], c.geometry.coordinates[0]];
    }
    return best;
  } catch {
    return [13.75, 100.5];
  }
}

// ── Need Score computation ────────────────────────────────────────────────────

/**
 * Computes Need Score for each district using the official formula:
 *   NeedScore = (PopScore × 0.3) + (ServiceScore × 0.3) + (BufferScore × 0.4)
 *
 * Normalization:
 *   PopScore     = ((districtPop − minPop) / (maxPop − minPop)) × 100
 *   ServiceScore = (1 − chargersPer10k / maxChargersPer10k) × 100
 *   BufferScore  = distance ≥ 3 km ? 100 : (distance / 3) × 100
 */
function computeDistrictScores(districtData, stations) {
  if (!districtData || !stations.length) return [];

  const raw = districtData.features.map((feature) => {
    const props = feature.properties;
    const population = Number(props.final_population_english_Population) || 0;
    const noOfCounted = Number(props.noOfCounted) || 0;
    const centroid = computeCentroid(feature);
    // Chargers per 10,000 people (service metric)
    const chargersPer10k = population > 0 ? (noOfCounted / population) * 10000 : 0;

    return { feature, name: getDistrictName(props), population, noOfCounted, centroid, chargersPer10k };
  });

  // Find max values for normalization
  const maxPop = Math.max(...raw.map((d) => d.population));
  const minPop = Math.min(...raw.map((d) => d.population));
  const maxService = Math.max(...raw.map((d) => d.chargersPer10k));

  return raw
    .map((d) => {
      // 1. PopScore: ((districtPop − minPop) / (maxPop − minPop)) × 100
      const popScore =
        maxPop > minPop ? ((d.population - minPop) / (maxPop - minPop)) * 100 : 50;

      // 2. ServiceScore: (1 − chargersPer10k / maxChargersPer10k) × 100
      const serviceScore = maxService > 0 ? (1 - d.chargersPer10k / maxService) * 100 : 100;

      // 3. BufferScore: 3 km threshold
      const nearestStationResult = findNearestStation(d.centroid, stations);
      const nearestDist = nearestStationResult.distanceKm;
      const bufferScore = nearestDist >= 3 ? 100 : (nearestDist / 3) * 100;

      // Final NeedScore, clamped to 0–100
      const needScore = Math.min(
        100,
        Math.max(0, Math.round(popScore * 0.3 + serviceScore * 0.3 + bufferScore * 0.4))
      );

      // Debug: log each district's score breakdown to console
      console.log(d.name, {
        popScore: Math.round(popScore),
        serviceScore: Math.round(serviceScore),
        bufferScore: Math.round(bufferScore),
        needScore,
      });

      return {
        ...d,
        popScore: Math.round(popScore),
        serviceScore: Math.round(serviceScore),
        bufferScore: Math.round(bufferScore),
        nearestStationKm: nearestDist,
        nearestStation: nearestStationResult.station,
        needScore,
      };
    })
    .sort((a, b) => b.needScore - a.needScore);
}

/**
 * Computes the top 3 best new charger locations for a district using grid sampling.
 *
 * Step 1 — Grid sampling:
 *   Generate 10×10 grid inside district bounding box, filter to points inside the polygon,
 *   discard any point within 500 m of an existing charger.
 *
 * Step 2 — Score each valid candidate:
 *   candidateScore = (distToNearestCharger × 0.7) + (distToNearestChosen × 0.3)
 *
 * Step 3 — Anti-clustering:
 *   Each subsequent pick must be at least 800 m from all already-chosen points.
 *
 * Step 4 — Suggest charger type by gap distance.
 */
function computeTop3Spots(feature, stations) {
  if (!stations.length) return [];

  // Bounding box: [minLng, minLat, maxLng, maxLat]
  const [minLng, minLat, maxLng, maxLat] = turf.bbox(feature);
  const lngStep = (maxLng - minLng) / 10;
  const latStep = (maxLat - minLat) / 10;

  const candidates = [];

  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 10; col++) {
      const lat = minLat + (row + 0.5) * latStep;
      const lng = minLng + (col + 0.5) * lngStep;
      const pt = turf.point([lng, lat]);

      // Step 1a: keep only points inside the district polygon
      if (!turf.booleanPointInPolygon(pt, feature)) continue;

      // Step 1b: discard points within 500 m of any existing charger
      let nearestChargerKm = Infinity;
      let nearestCharger = null;
      for (const s of stations) {
        const d = haversineKm(lat, lng, s.lat, s.lng);
        if (d < nearestChargerKm) {
          nearestChargerKm = d;
          nearestCharger = s;
        }
      }
      if (nearestChargerKm * 1000 < 500) continue; // within 500 m → discard

      candidates.push({ lat, lng, distToNearestCharger: nearestChargerKm, nearestCharger });
    }
  }

  if (candidates.length === 0) return [];

  // Max charger distance across all candidates (for normalizing candidateScore to 0–100)
  const maxChargerDist = Math.max(...candidates.map((c) => c.distToNearestCharger));

  const chosen = [];

  for (let rank = 1; rank <= 3; rank++) {
    let bestRawScore = -Infinity;
    let bestCandidate = null;

    for (const candidate of candidates) {
      // Step 3: anti-clustering — must be ≥ 800 m from every already-chosen point
      const tooClose = chosen.some(
        (c) => haversineKm(candidate.lat, candidate.lng, c.lat, c.lng) < 0.8
      );
      if (tooClose) continue;

      // Step 2: score = distToNearestCharger × 0.7 + distToNearestChosen × 0.3
      const distToChosen =
        chosen.length === 0
          ? 0
          : Math.min(...chosen.map((c) => haversineKm(candidate.lat, candidate.lng, c.lat, c.lng)));

      const rawScore = candidate.distToNearestCharger * 0.7 + distToChosen * 0.3;

      if (rawScore > bestRawScore) {
        bestRawScore = rawScore;
        bestCandidate = { ...candidate, rawScore };
      }
    }

    if (bestCandidate) {
      const gapKm = bestCandidate.distToNearestCharger;

      // Step 4: suggest charger type by gap
      const chargerType =
        gapKm > 3
          ? 'DC Fast Charger recommended'
          : gapKm >= 1
          ? 'AC Type 2 recommended'
          : 'Top-up AC charger sufficient';

      // Normalize candidateScore to 0–100 (clamp in case distToChosen inflates it)
      const candidateScore = Math.min(
        100,
        maxChargerDist > 0 ? Math.round((bestCandidate.rawScore / maxChargerDist) * 100) : 0
      );

      chosen.push({ ...bestCandidate, rank, candidateScore, gapKm, chargerType });
    } else {
      // No valid point found for this rank
      chosen.push({ rank, insufficient: true });
    }
  }

  return chosen;
}

// ── Icon factories ────────────────────────────────────────────────────────────

function createTop5PinIcon(rank) {
  return L.divIcon({
    className: 'pulsing-pin-wrapper',
    html: `<div class="pulsing-pin"><span class="pulsing-pin-rank">#${rank}</span></div>`,
    iconAnchor: [20, 20],
    iconSize: [40, 40],
    popupAnchor: [0, -64],
  });
}

function createSpotIcon(rank) {
  const dotSize = rank === 1 ? 16 : rank === 2 ? 14 : 12;
  const pulseClass = rank === 1 ? 'spot-pulse-strong' : rank === 2 ? 'spot-pulse-medium' : 'spot-pulse-light';
  // The icon wrapper is zero-size; the dot is absolutely positioned relative to the anchor
  return L.divIcon({
    className: 'rec-spot-icon-wrapper',
    html: `
      <div class="rec-spot-label-above">#${rank}</div>
      <div class="rec-spot-dot ${pulseClass}" style="width:${dotSize}px;height:${dotSize}px;"></div>
    `,
    iconAnchor: [dotSize / 2, dotSize + 18],
    iconSize: [dotSize, dotSize + 18],
    popupAnchor: [0, -(dotSize + 18)],
  });
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportDistrictCSV(district, stationsInDistrict, top3Spots) {
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [
    ['Section', 'Field', 'Value'],
    ['Need Score', 'District', district.name],
    ['Need Score', 'Total Need Score', district.needScore],
    ['Need Score', 'Population Score (×0.3)', district.popScore],
    ['Need Score', 'Service Gap Score (×0.3)', district.serviceScore],
    ['Need Score', 'Buffer Zone Score (×0.4)', district.bufferScore],
    ['District Info', 'Population', district.population],
    ['District Info', 'Existing Stations', district.noOfCounted],
    ['District Info', 'Stations per 10,000 people', district.chargersPer10k.toFixed(2)],
    ['District Info', 'Distance to nearest station', formatDistanceKm(district.nearestStationKm)],
    ...stationsInDistrict.map((s, i) => ['Existing Station', `Station ${i + 1}`, s.name]),
    ...top3Spots
      .filter((s) => !s.insufficient)
      .map((s) => [
        'Recommended Spot',
        `Spot #${s.rank}`,
        `${s.lat.toFixed(5)},${s.lng.toFixed(5)} | Gap: ${s.gapKm.toFixed(2)} km | ${s.chargerType} | Score: ${s.candidateScore}/100`,
      ]),
  ];
  const csv = rows.map((r) => r.map(escape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${district.name.replace(/\s+/g, '_')}_EV_recommendation.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Map sub-components ────────────────────────────────────────────────────────

function InitializeMapBounds({ districts, stations }) {
  const map = useMap();
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (hasInitialized.current || !districts || !stations.length) return;
    const bounds = L.latLngBounds([]);
    bounds.extend(L.geoJSON(districts).getBounds());
    bounds.extend(stations.map((s) => [s.lat, s.lng]));
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.06));
      map.setMaxBounds(bounds.pad(0.2));
      hasInitialized.current = true;
    }
  }, [districts, map, stations]);

  return null;
}

function MapFlyController({ target, overviewRefs, spotRefs, allDistrictsBounds }) {
  const map = useMap();

  useEffect(() => {
    if (!target) return;

    if (target.fitAll && allDistrictsBounds?.isValid()) {
      // Zoom back out to show all districts (overview / "big picture")
      map.flyToBounds(allDistrictsBounds, { padding: [48, 48], duration: 0.9 });
      return;
    }

    if (target.feature) {
      const bounds = L.geoJSON(target.feature).getBounds();
      if (bounds.isValid()) map.flyToBounds(bounds, { padding: [48, 48], duration: 1.0 });
    } else if (target.latlng) {
      map.flyTo(target.latlng, target.zoom ?? 13, { duration: 1.0 });
    }

    if (target.popupIndex !== undefined) {
      const refs = target.useSpotRefs ? spotRefs : overviewRefs;
      const onMoveEnd = () => {
        const marker = refs?.current?.[target.popupIndex];
        if (marker) marker.openPopup();
        map.off('moveend', onMoveEnd);
      };
      map.on('moveend', onMoveEnd);
      return () => map.off('moveend', onMoveEnd);
    }
  }, [map, target, overviewRefs, spotRefs, allDistrictsBounds]);

  return null;
}

// ── District / station mode layers ────────────────────────────────────────────

function districtStyle(feature, isDistrictMode) {
  return {
    color: '#1f3c48',
    weight: isDistrictMode ? 1.4 : 1,
    fillColor: getCoverageColor(feature.properties.coverage),
    fillOpacity: isDistrictMode ? 0.32 : 0.16,
  };
}

function scopeBoundaryStyle(isStreetBasemap) {
  return {
    color: isStreetBasemap ? '#4f6d7a' : '#f8fafc',
    weight: isStreetBasemap ? 1 : 2.4,
    fillOpacity: 0,
    opacity: isStreetBasemap ? 0.8 : 0.95,
    dashArray: isStreetBasemap ? undefined : '8 6',
  };
}

function createDistrictPopup(properties) {
  return `
    <div class="district-popup">
      <h3>${getDistrictName(properties)}</h3>
      <p>${getDistrictThaiName(properties)}</p>
      <dl>
        <div><dt>Province</dt><dd>${getProvinceName(properties)}</dd></div>
        <div><dt>Population</dt><dd>${formatInteger(properties.final_population_english_Population)}</dd></div>
        <div><dt>Counted EV stations</dt><dd>${formatInteger(properties.noOfCounted)}</dd></div>
        <div><dt>Stations per 10,000 people</dt><dd>${formatCoverage(properties.coverage)}</dd></div>
      </dl>
    </div>
  `;
}

function getDistrictLabelClass(zoom) {
  if (zoom >= 14) return 'district-label district-label-large';
  if (zoom >= 13) return 'district-label district-label-medium';
  return 'district-label district-label-small';
}

function onEachDistrict(feature, layer, zoom, isDistrictMode) {
  if (isDistrictMode && zoom >= DISTRICT_LABEL_MIN_ZOOM) {
    layer.bindTooltip(getDistrictName(feature.properties), {
      className: getDistrictLabelClass(zoom),
      direction: 'center',
      permanent: true,
    });
  }
  layer.bindPopup(createDistrictPopup(feature.properties));
  layer.on({
    mouseover: () => {
      if (!isDistrictMode) return;
      layer.setStyle({ color: '#081c15', weight: 2.4, fillOpacity: 0.5 });
      layer.bringToFront();
    },
    mouseout: () => layer.setStyle(districtStyle(feature, isDistrictMode)),
    click: (e) => { if (isDistrictMode) layer.openPopup(e.latlng); },
  });
}

function DistrictLayer({ districtData, isDistrictMode }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });

  return (
    <GeoJSON
      key={`district-layer-${zoom}-${isDistrictMode}`}
      data={districtData}
      interactive={isDistrictMode}
      style={(f) => districtStyle(f, isDistrictMode)}
      onEachFeature={(f, layer) => onEachDistrict(f, layer, zoom, isDistrictMode)}
    />
  );
}

function StationLayer({ isStreetBasemap, stations }) {
  return stations.map((station) => (
    <CircleMarker
      key={`station-${station.id}`}
      center={[station.lat, station.lng]}
      bubblingMouseEvents
      interactive
      pathOptions={{
        color: isStreetBasemap ? '#fffaf0' : '#0f172a',
        fillColor: '#ee6c4d',
        fillOpacity: 0.95,
        opacity: 1,
        weight: isStreetBasemap ? 1 : 2,
      }}
      radius={isStreetBasemap ? 4 : 5}
    >
      <Popup>
        <div className="station-popup">
          <h3>{station.name}</h3>
          <p>{station.address}</p>
          <dl>
            <div><dt>Rating</dt><dd>{station.rating ?? 'N/A'}</dd></div>
            <div><dt>Reviews</dt><dd>{formatInteger(station.reviews)}</dd></div>
          </dl>
        </div>
      </Popup>
    </CircleMarker>
  ));
}

function PassiveStationLayer({ stations }) {
  return stations.map((station) => (
    <CircleMarker
      key={`passive-${station.id}`}
      center={[station.lat, station.lng]}
      bubblingMouseEvents={false}
      interactive={false}
      pathOptions={{ color: '#fffaf0', fillColor: '#ee6c4d', fillOpacity: 0.95, opacity: 1, weight: 1 }}
      radius={4}
    />
  ));
}

// ── Recommendation mode layers ────────────────────────────────────────────────

/**
 * Transparent district boundary outlines that sit under the heatmap.
 * The heatmap canvas has pointer-events:none so these polygons still receive
 * hover/click events normally.
 */
function RecBoundaryLayer({ districtData, scoredDistricts, onDistrictClick, selectedFid, isHeatmapSubMode }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });

  const scoreMap = useMemo(() => {
    const m = new Map();
    for (const d of scoredDistricts) m.set(d.feature.properties.fid, d);
    return m;
  }, [scoredDistricts]);

  return (
    <GeoJSON
      key={`rec-boundary-${zoom}-${selectedFid ?? 'none'}-${isHeatmapSubMode ? 'heat' : 'spots'}`}
      data={districtData}
      interactive
      style={(feature) => {
        const d = scoreMap.get(feature.properties.fid);
        const score = d?.needScore ?? 0;
        const isSelected = feature.properties.fid === selectedFid;

        if (isHeatmapSubMode) {
          // Heatmap sub-mode: transparent fill so the heatmap canvas shows through
          return {
            fillOpacity: 0,
            color: isSelected ? '#ffffff' : 'rgba(255,255,255,0.25)',
            weight: isSelected ? 2 : 1,
            opacity: isSelected ? 1 : 0.8,
          };
        }

        // Spots sub-mode: coloured district fill (same as before)
        return {
          fillColor: getNeedScoreColor(score),
          fillOpacity: isSelected ? 0.7 : 0.45,
          color: isSelected ? '#93c5fd' : '#1f3c48',
          weight: isSelected ? 3 : 1,
          opacity: isSelected ? 1 : 0.7,
        };
      }}
      onEachFeature={(feature, layer) => {
        const d = scoreMap.get(feature.properties.fid);
        const score = d?.needScore ?? 0;
        const name = getDistrictName(feature.properties);
        const population = Number(feature.properties.final_population_english_Population) || 0;
        const noOfCounted = Number(feature.properties.noOfCounted) || 0;
        const nearestKm = d?.nearestStationKm ?? 0;
        const bufferIntensity = Math.min(nearestKm / 3.0, 1.0);

        // Tooltip differs per sub-mode
        const tooltipHtml = isHeatmapSubMode
          ? `<strong>${name}</strong><br>` +
            `Distance to nearest charger: ${nearestKm.toFixed(1)} km<br>` +
            `Buffer score: ${bufferIntensity.toFixed(2)} / 1.0<br>` +
            `${getBufferLabel(nearestKm)}`
          : `<strong>${name}</strong><br>` +
            `Need Score: ${score}/100<br>` +
            `Population: ${formatInteger(population)}<br>` +
            `Stations: ${noOfCounted}<br>` +
            `Buffer: ${nearestKm.toFixed(1)} km from nearest charger`;

        layer.bindTooltip(tooltipHtml, { className: 'rec-district-tooltip', sticky: true });

        const baseStyle = (isSelected) => isHeatmapSubMode
          ? { fillOpacity: 0, color: isSelected ? '#ffffff' : 'rgba(255,255,255,0.25)', weight: isSelected ? 2 : 1, opacity: isSelected ? 1 : 0.8 }
          : { fillColor: getNeedScoreColor(score), fillOpacity: isSelected ? 0.7 : 0.45, color: isSelected ? '#93c5fd' : '#1f3c48', weight: isSelected ? 3 : 1, opacity: isSelected ? 1 : 0.7 };

        layer.on({
          mouseover: () => {
            if (isHeatmapSubMode) {
              layer.setStyle({ fillOpacity: 0, color: '#ffffff', weight: 2, opacity: 1 });
            } else {
              layer.setStyle({ fillOpacity: 0.82, weight: 2, color: '#081c15', opacity: 1 });
            }
            layer.bringToFront();
          },
          mouseout: () => {
            const sel = feature.properties.fid === selectedFid;
            layer.setStyle(baseStyle(sel));
          },
          click: () => { if (d) onDistrictClick(d); },
        });
      }}
    />
  );
}

/**
 * Buffer-zone heatmap layer (shown only in heatmap sub-mode).
 * Intensity = min(distToNearestCharger / 3.0, 1.0) — purely geographic.
 * Uses dynamic import so leaflet.heat can access window.L after Leaflet is set.
 * Canvas gets pointer-events:none so district boundary polygons remain clickable.
 */
/**
 * Station-density heatmap.
 *
 * Inverted palette: dark red = few/no chargers (area needs new station),
 * green = high station density (well served).
 *
 * To make areas with NO stations render dark (not transparent), a sparse
 * background grid of very-low-weight points (0.02) covers the study area.
 * Real station points (weight 1.0) lift the intensity above the background,
 * producing green hotspots. Untouched grid cells stay near-zero → dark red.
 *
 * When selectedFeature is provided the layer filters to that district's
 * stations and generates a finer grid over the district bounding box,
 * giving a per-district density view.
 */
function BufferHeatmapLayer({ stations, selectedFeature }) {
  const map = useMap();

  useEffect(() => {
    if (!stations.length) return;

    let cancelled = false;
    let heatLayer = null;

    // ── Filter stations to district when one is selected ────────────────────
    const localStations = selectedFeature
      ? stations.filter((s) => {
          try { return turf.booleanPointInPolygon(turf.point([s.lng, s.lat]), selectedFeature); }
          catch { return false; }
        })
      : stations;

    // ── Background grid: fills area so empty cells render as dark red ───────
    // Global bounds cover the Bangkok study area; district bounds are tighter.
    const [bMinLng, bMinLat, bMaxLng, bMaxLat] = selectedFeature
      ? turf.bbox(selectedFeature)
      : [100.25, 13.45, 100.95, 14.10];
    const step = selectedFeature
      ? Math.max((bMaxLng - bMinLng) / 10, 0.003)  // finer grid per district
      : 0.022;                                       // ~2.4 km global grid
    const bgPoints = [];
    for (let lat = bMinLat; lat <= bMaxLat; lat += step) {
      for (let lng = bMinLng; lng <= bMaxLng; lng += step) {
        bgPoints.push([lat, lng, 0.02]); // very low weight → near-zero intensity
      }
    }

    // ── Combine background + real stations ──────────────────────────────────
    const heatData = [
      ...bgPoints,
      ...localStations.map((s) => {
        console.log(s.name, { lat: s.lat, lng: s.lng, weight: 1.0 });
        return [s.lat, s.lng, 1.0];
      }),
    ];

    window.L = L;
    import('leaflet.heat').then(() => {
      if (cancelled) return;

      heatLayer = L.heatLayer(heatData, {
        radius: selectedFeature ? 22 : 55,
        blur: selectedFeature ? 18 : 45,
        maxZoom: 16,
        max: 1.0,
        // INVERTED: low intensity (few/no stations) → dark red → "needs charger"
        //           high intensity (many stations)  → green  → "well served"
        gradient: {
          0.00: '#7f1d1d',  // deep red/brown — no stations at all
          0.06: '#b91c1c',  // red            — very sparse
          0.15: '#f97316',  // orange         — sparse
          0.30: '#fbbf24',  // amber          — low–moderate
          0.50: '#a3e635',  // lime           — moderate
          0.70: '#4ade80',  // light green    — good
          1.00: '#06b6d4',  // cyan           — hotspot / very well covered
        },
      });

      heatLayer.addTo(map);

      if (heatLayer._canvas) {
        const canvas = heatLayer._canvas;
        canvas.style.pointerEvents = 'none';
        canvas.style.opacity = '0';
        canvas.style.transition = 'opacity 0.4s ease';
        canvas.getBoundingClientRect();
        canvas.style.opacity = '1';
      }
    });

    return () => {
      cancelled = true;
      if (heatLayer) {
        const canvas = heatLayer._canvas;
        if (canvas) {
          canvas.style.transition = 'opacity 0.4s ease';
          canvas.style.opacity = '0';
          setTimeout(() => {
            try { map.removeLayer(heatLayer); } catch { /* already removed */ }
          }, 420);
        } else {
          try { map.removeLayer(heatLayer); } catch { /* already removed */ }
        }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, stations, selectedFeature]);

  return null;
}

/** Fixed bottom-left legend for the station density heatmap */
function BufferHeatmapLegend() {
  return (
    <div className="heatmap-legend" aria-label="Station density legend">
      <p className="heatmap-legend-title">EV station density</p>
      {[
        { color: '#7f1d1d', label: 'No stations — needs charger' },
        { color: '#ef4444', label: 'Very sparse' },
        { color: '#f97316', label: 'Sparse' },
        { color: '#eab308', label: 'Low–moderate' },
        { color: '#84cc16', label: 'Good coverage' },
        { color: '#22c55e', label: 'Well served' },
      ].map(({ color, label }) => (
        <div key={label} className="heatmap-legend-row">
          <span className="heatmap-legend-swatch" style={{ background: color }} />
          <span className="heatmap-legend-label">{label}</span>
        </div>
      ))}
    </div>
  );
}

/** Top 5 pulsing overview pins shown before a district is selected */
function Top5PinsLayer({ recommendations, overviewRefs, onPinClick }) {
  const icons = useMemo(() => recommendations.map((_, i) => createTop5PinIcon(i + 1)), [recommendations]);

  return recommendations.map((d, i) => (
    <Marker
      key={`top5-${i}`}
      position={d.centroid}
      icon={icons[i]}
      ref={(el) => { if (overviewRefs.current) overviewRefs.current[i] = el; }}
      eventHandlers={{ click: () => onPinClick(d, i) }}
    >
      <Popup offset={[0, -56]}>
        <div className="station-popup">
          <h3>#{i + 1} — {d.name}</h3>
          <p>{getNeedLevel(d.needScore)}</p>
          <dl>
            <div><dt>Need score</dt><dd>{d.needScore}/100</dd></div>
            <div><dt>Population</dt><dd>{formatInteger(d.population)}</dd></div>
            <div><dt>Existing stations</dt><dd>{d.noOfCounted}</dd></div>
            <div><dt>Nearest station</dt><dd>{formatDistanceKm(d.nearestStationKm)}</dd></div>
          </dl>
        </div>
      </Popup>
    </Marker>
  ));
}

/** Small red dots for existing stations inside the selected district */
function DistrictStationsLayer({ stations }) {
  return stations.map((station) => (
    <CircleMarker
      key={`dst-${station.id}`}
      center={[station.lat, station.lng]}
      interactive
      pathOptions={{
        color: '#991b1b',
        fillColor: '#ef4444',
        fillOpacity: 0.9,
        opacity: 1,
        weight: 1.5,
      }}
      radius={8}
    >
      <Popup>
        <div className="station-popup">
          <h3>🔴 Existing Station</h3>
          <dl>
            <div><dt>Name</dt><dd>{station.name}</dd></div>
            <div><dt>Type</dt><dd>N/A</dd></div>
            <div><dt>Ports</dt><dd>N/A</dd></div>
          </dl>
        </div>
      </Popup>
    </CircleMarker>
  ));
}

/** Top 3 pulsing blue recommended spots + 500 m circles + gap lines */
function Top3SpotsLayer({ spots, districtName, spotRefs }) {
  const validSpots = useMemo(() => spots.filter((s) => !s.insufficient), [spots]);
  const icons = useMemo(() => validSpots.map((s) => createSpotIcon(s.rank)), [validSpots]);

  return validSpots.flatMap((spot, i) => {
    const elements = [
      <Marker
        key={`spot-marker-${spot.rank}`}
        position={[spot.lat, spot.lng]}
        icon={icons[i]}
        ref={(el) => { if (spotRefs.current) spotRefs.current[spot.rank - 1] = el; }}
      >
        <Popup>
          <div className="station-popup">
            <h3>🔵 Recommended Spot #{spot.rank}</h3>
            <dl>
              <div><dt>District</dt><dd>{districtName}</dd></div>
              <div><dt>Coordinates</dt><dd>{spot.lat.toFixed(5)}, {spot.lng.toFixed(5)}</dd></div>
              <div><dt>Gap from nearest charger</dt><dd>{formatDistanceKm(spot.gapKm)}</dd></div>
              <div><dt>Suggested type</dt><dd>{spot.chargerType}</dd></div>
              <div><dt>Candidate score</dt><dd>{spot.candidateScore}/100</dd></div>
            </dl>
          </div>
        </Popup>
      </Marker>,
      // Dashed blue 500 m coverage circle
      <Circle
        key={`spot-circle-${spot.rank}`}
        center={[spot.lat, spot.lng]}
        radius={500}
        pathOptions={{
          color: '#3b82f6',
          weight: 2,
          fillColor: '#3b82f6',
          fillOpacity: 0.06,
          dashArray: '8 6',
        }}
      />,
    ];

    // Red dotted line to nearest existing charger
    if (spot.nearestCharger) {
      elements.push(
        <Polyline
          key={`spot-line-${spot.rank}`}
          positions={[
            [spot.lat, spot.lng],
            [spot.nearestCharger.lat, spot.nearestCharger.lng],
          ]}
          pathOptions={{
            color: '#ef4444',
            weight: 1.5,
            dashArray: '4 4',
            opacity: 0.7,
          }}
        />
      );
    }

    return elements;
  });
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [districtData, setDistrictData] = useState(null);
  const [rawStations, setRawStations] = useState(null);
  const [rawHeatmap, setRawHeatmap] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [mapMode, setMapMode] = useState(MAP_MODES.STATIONS);
  const [basemap, setBasemap] = useState(BASEMAPS.STREET);
  const [flyTarget, setFlyTarget] = useState(null);

  // Recommendation mode state
  const [recSubMode, setRecSubMode] = useState(REC_SUB_MODES.SPOTS);
  const [selectedDistrict, setSelectedDistrict] = useState(null);
  const [showExistingLayer, setShowExistingLayer] = useState(true);
  const [showRecommendedLayer, setShowRecommendedLayer] = useState(true);
  const [showExplanation, setShowExplanation] = useState(false);
  const [heatmapSelectedDistrict, setHeatmapSelectedDistrict] = useState(null);
  const [showHeatmapExplanation, setShowHeatmapExplanation] = useState(false);

  const overviewRefs = useRef([]);
  const spotRefs = useRef([]);

  // ── Load data ──────────────────────────────────────────────────────────────
  useEffect(() => {
    async function loadMapData() {
      try {
        const [districtRes, stationRes, heatmapRes] = await Promise.all([
          fetch(districtInfoDataUrl),
          fetch(evStationsDataUrl),
          fetch(stationsHeatmapUrl),
        ]);
        if (!districtRes.ok || !stationRes.ok || !heatmapRes.ok) throw new Error('Failed to load GeoJSON data.');
        const [districtJson, stationJson, heatmapJson] = await Promise.all([districtRes.json(), stationRes.json(), heatmapRes.json()]);
        setDistrictData(districtJson);
        setRawStations(stationJson);
        setRawHeatmap(heatmapJson);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'Failed to load map data.');
      }
    }
    loadMapData();
  }, []);

  // ── Derived data ───────────────────────────────────────────────────────────
  const stations = useMemo(() => normalizeStations(rawStations), [rawStations]);
  const scoredDistricts = useMemo(() => computeDistrictScores(districtData, stations), [districtData, stations]);
  const top5 = useMemo(() => scoredDistricts.slice(0, 5), [scoredDistricts]);

  // Pre-compute the full study-area bounds so overview can always zoom back out
  const allDistrictsBounds = useMemo(() => {
    if (!districtData) return null;
    const b = L.geoJSON(districtData).getBounds();
    return b.isValid() ? b.pad(0.06) : null;
  }, [districtData]);

  // Heatmap point array derived from stationsHeatmap.geojson
  const heatmapPoints = useMemo(() => {
    if (!rawHeatmap) return [];
    return (rawHeatmap.features ?? [])
      .filter((f) => f.geometry?.type === 'Point')
      .map((f) => ({
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
        name: f.properties?.Name ?? 'Station',
      }));
  }, [rawHeatmap]);

  // Top 5 most isolated districts (sorted by nearest station distance, desc)
  const top5Isolated = useMemo(
    () => [...scoredDistricts].sort((a, b) => b.nearestStationKm - a.nearestStationKm).slice(0, 5),
    [scoredDistricts]
  );

  // Stations inside the heatmap-selected district (for side panel list)
  const heatmapStationsInDistrict = useMemo(() => {
    if (!heatmapSelectedDistrict) return [];
    return stations.filter((s) => {
      try { return turf.booleanPointInPolygon(turf.point([s.lng, s.lat]), heatmapSelectedDistrict.feature); }
      catch { return false; }
    });
  }, [heatmapSelectedDistrict, stations]);

  // Stations that fall inside the selected district polygon
  const stationsInDistrict = useMemo(() => {
    if (!selectedDistrict) return [];
    return stations.filter((s) => {
      try {
        return turf.booleanPointInPolygon(turf.point([s.lng, s.lat]), selectedDistrict.feature);
      } catch {
        return false;
      }
    });
  }, [selectedDistrict, stations]);

  // Top 3 recommended spots for the selected district
  const top3Spots = useMemo(() => {
    if (!selectedDistrict) return [];
    return computeTop3Spots(selectedDistrict.feature, stations);
  }, [selectedDistrict, stations]);

  // ── Mode flags ─────────────────────────────────────────────────────────────
  const isDistrictMode = mapMode === MAP_MODES.DISTRICTS;
  const isStationMode = mapMode === MAP_MODES.STATIONS;
  const isRecommendationMode = mapMode === MAP_MODES.RECOMMENDATION;
  const isStreetBasemap = basemap === BASEMAPS.STREET;
  const isHeatmapSubMode = isRecommendationMode && recSubMode === REC_SUB_MODES.HEATMAP;
  const isSpotsSubMode = isRecommendationMode && recSubMode === REC_SUB_MODES.SPOTS;

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleDistrictClick = useCallback((district) => {
    setSelectedDistrict(district);
    setShowExistingLayer(true);
    setShowRecommendedLayer(true);
    setFlyTarget({ feature: district.feature, _ts: Date.now() });
  }, []);

  function handleOverviewItemClick(d, i) {
    handleDistrictClick(d);
    // After flyToBounds, open overview pin popup (i → overviewRefs)
    setFlyTarget({ feature: d.feature, popupIndex: i, useSpotRefs: false, _ts: Date.now() });
  }

  function handleSpotItemClick(spot, index) {
    setFlyTarget({ latlng: [spot.lat, spot.lng], zoom: 15, popupIndex: index, useSpotRefs: true, _ts: Date.now() });
  }

  function handleBackToOverview() {
    setSelectedDistrict(null);
    overviewRefs.current = [];
    spotRefs.current = [];
    // Zoom back out to the full Bangkok "big picture" so all 5 pins are visible
    setFlyTarget({ fitAll: true, _ts: Date.now() });
  }

  // Unified district-click handler — routes to heatmap or spots detail
  const handleRecDistrictClick = useCallback((district) => {
    if (recSubMode === REC_SUB_MODES.HEATMAP) {
      setHeatmapSelectedDistrict(district);
      setFlyTarget({ feature: district.feature, _ts: Date.now() });
    } else {
      handleDistrictClick(district);
    }
  }, [recSubMode, handleDistrictClick]);

  // Reset sub-mode state when leaving rec mode
  useEffect(() => {
    if (!isRecommendationMode) {
      setSelectedDistrict(null);
      setHeatmapSelectedDistrict(null);
      setRecSubMode(REC_SUB_MODES.SPOTS);
    }
  }, [isRecommendationMode]);

  // Reset to big picture when switching sub-modes
  useEffect(() => {
    setHeatmapSelectedDistrict(null);
    setSelectedDistrict(null);
    overviewRefs.current = [];
    spotRefs.current = [];
    setFlyTarget({ fitAll: true, _ts: Date.now() });
  }, [recSubMode]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <main className="app-shell">
      <section className="map-frame">

        {/* ── Left header panel ──────────────────────────────────────────── */}
        <header className={`map-intro${isRecommendationMode ? ' rec-mode' : ''}`}>
          <span className="eyebrow">EV deployment decision support</span>
          <h1>Bangkok metropolitan charging station planning tool</h1>

          <p>
            This map supports charging station deployment decisions across Bangkok and nearby
            provinces. Use district mode to compare coverage, station mode to inspect the network,
            or recommendation mode for AI-assisted site selection.
          </p>
          <p className="scope-note">Covered area: Bangkok, Pathum Thani, Samut Prakan, and Nonthaburi.</p>

          {/* Mode tabs */}
          <div className="mode-switch" role="tablist" aria-label="Map display mode">
            {[
              { id: MAP_MODES.STATIONS, label: 'Station mode' },
              { id: MAP_MODES.DISTRICTS, label: 'District mode' },
              { id: MAP_MODES.RECOMMENDATION, label: 'Recommendation', extra: 'rec-tab' },
            ].map(({ id, label, extra }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={mapMode === id}
                className={`mode-button${mapMode === id ? ' active' : ''}${extra ? ` ${extra}` : ''}`}
                onClick={() => setMapMode(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Basemap switch */}
          <div className="mode-switch basemap-switch" role="tablist" aria-label="Basemap style">
            <button
              type="button"
              className={`mode-button${isStreetBasemap ? ' active' : ''}`}
              onClick={() => setBasemap(BASEMAPS.STREET)}
            >
              Street map
            </button>
            <button
              type="button"
              className={`mode-button${!isStreetBasemap ? ' active' : ''}`}
              onClick={() => setBasemap(BASEMAPS.SATELLITE)}
            >
              Satellite
            </button>
          </div>

          {/* Status messages */}
          {loadError && <p className="status-message error">{loadError}</p>}
          {!loadError && (!districtData || !stations.length) && (
            <p className="status-message">Loading district borders and EV stations…</p>
          )}
          {districtData && stations.length > 0 && !isRecommendationMode && (
            <p className="status-message">
              {formatInteger(districtData.features.length)} districts and{' '}
              {formatInteger(stations.length)} stations loaded.{' '}
              {isStationMode
                ? 'Station mode: site review and network inspection.'
                : 'District mode: area comparison and coverage review.'}
            </p>
          )}

          {/* Standard legend */}
          {!isRecommendationMode && (
            <div className="legend">
              <span><i className="legend-swatch district-swatch" /> District coverage</span>
              <span><i className="legend-swatch station-swatch" /> Existing charging stations</span>
            </div>
          )}

          {/* District coverage scale */}
          {isDistrictMode && (
            <div className="coverage-legend">
              <p className="coverage-legend-title">District coverage scale</p>
              <p className="coverage-legend-subtitle">Stations per 10,000 people</p>
              <ul className="coverage-legend-list">
                {DISTRICT_COVERAGE_LEGEND.map((item) => (
                  <li key={item.label}>
                    <i className="coverage-legend-swatch" style={{ backgroundColor: item.color }} />
                    <span>{item.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Recommendation mode — sub-toggle + left panel summary */}
          {isRecommendationMode && (
            <div className="rec-panel">
              <p className="rec-panel-kicker">Recommendation mode</p>

              {/* Sub-mode toggle row */}
              <div className="mode-switch rec-sub-toggle" role="tablist" aria-label="Recommendation view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={isSpotsSubMode}
                  className={`mode-button${isSpotsSubMode ? ' active' : ''}`}
                  onClick={() => setRecSubMode(REC_SUB_MODES.SPOTS)}
                >
                  Recommended Spots
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isHeatmapSubMode}
                  className={`mode-button${isHeatmapSubMode ? ' active rec-heat-tab' : ''}`}
                  onClick={() => setRecSubMode(REC_SUB_MODES.HEATMAP)}
                >
                  🌡 Heatmap
                </button>
              </div>

              {/* Spots sub-mode summary */}
              {isSpotsSubMode && (
                selectedDistrict ? (
                  <>
                    <p className="rec-panel-title">📍 {selectedDistrict.name}</p>
                    <button className="rec-back-btn" onClick={handleBackToOverview}>
                      ← Back to overview
                    </button>
                  </>
                ) : (
                  <>
                    <h2 className="rec-panel-title">Charging gap analysis</h2>
                    <p className="rec-panel-intro">
                      Districts coloured by Need Score. Click any district or pin for exact recommended spots.
                    </p>
                    {scoredDistricts.length > 0 && (
                      <div className="rec-summary-strip">
                        <div className="rec-summary-chip rec-summary-chip-strong">
                          <span className="rec-summary-label">Critical districts</span>
                          <strong>{scoredDistricts.filter((d) => d.needScore >= 80).length}</strong>
                          <span>Score 80+</span>
                        </div>
                        <div className="rec-summary-chip">
                          <span className="rec-summary-label">High need</span>
                          <strong>{scoredDistricts.filter((d) => d.needScore >= 60).length}</strong>
                          <span>Score 60+</span>
                        </div>
                      </div>
                    )}
                  </>
                )
              )}

              {/* Heatmap sub-mode summary */}
              {isHeatmapSubMode && (
                heatmapSelectedDistrict ? (
                  <>
                    <p className="rec-panel-title">📍 {heatmapSelectedDistrict.name}</p>
                    <button className="rec-back-btn" onClick={() => setHeatmapSelectedDistrict(null)}>
                      ← Back to top 5 list
                    </button>
                  </>
                ) : (
                  <>
                    <h2 className="rec-panel-title">EV station density</h2>
                    <p className="rec-panel-intro">
                      Red hotspots = clusters of chargers. Blue areas = few or no stations nearby.
                    </p>
                  </>
                )
              )}
            </div>
          )}
        </header>

        {/* ── Map ────────────────────────────────────────────────────────── */}
        <MapContainer
          center={[13.7563, 100.5018]}
          className="map"
          maxBoundsViscosity={1}
          minZoom={10}
          zoom={11}
          zoomControl={false}
        >
          <TileLayer
            attribution={
              isStreetBasemap
                ? '&copy; OpenStreetMap contributors &copy; CARTO'
                : 'Tiles &copy; Esri'
            }
            url={
              isStreetBasemap
                ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
                : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
            }
          />

          {districtData && <InitializeMapBounds districts={districtData} stations={stations} />}

          <MapFlyController target={flyTarget} overviewRefs={overviewRefs} spotRefs={spotRefs} allDistrictsBounds={allDistrictsBounds} />

          {/* District / scope boundary layers */}
          <Pane name="districts" style={{ zIndex: 350 }}>
            {districtData && isDistrictMode && (
              <DistrictLayer districtData={districtData} isDistrictMode />
            )}
            {districtData && isStationMode && (
              <GeoJSON
                data={districtData}
                interactive={false}
                style={() => scopeBoundaryStyle(isStreetBasemap)}
              />
            )}
            {districtData && isRecommendationMode && (
              <RecBoundaryLayer
                districtData={districtData}
                scoredDistricts={scoredDistricts}
                onDistrictClick={handleRecDistrictClick}
                selectedFid={
                  isHeatmapSubMode
                    ? heatmapSelectedDistrict?.feature.properties.fid
                    : selectedDistrict?.feature.properties.fid
                }
                isHeatmapSubMode={isHeatmapSubMode}
              />
            )}
          </Pane>

          {/* Buffer heatmap — sits at z-index 400 (Leaflet overlayPane), between
              district outlines (350) and station markers (450).
              Only visible in heatmap sub-mode. */}
          {isHeatmapSubMode && heatmapPoints.length > 0 && (
            <BufferHeatmapLayer
              stations={heatmapPoints}
              selectedFeature={heatmapSelectedDistrict?.feature ?? null}
            />
          )}

          {/* Station / recommendation marker layers */}
          <Pane name="stations" style={{ zIndex: 450 }}>
            {isStationMode && <StationLayer isStreetBasemap={isStreetBasemap} stations={stations} />}
            {isDistrictMode && <PassiveStationLayer stations={stations} />}

            {/* Spots sub-mode: overview pins */}
            {isSpotsSubMode && !selectedDistrict && (
              <Top5PinsLayer
                recommendations={top5}
                overviewRefs={overviewRefs}
                onPinClick={handleOverviewItemClick}
              />
            )}
            {/* Spots sub-mode: district detail layers */}
            {isSpotsSubMode && selectedDistrict && showExistingLayer && (
              <DistrictStationsLayer stations={stationsInDistrict} />
            )}
            {isSpotsSubMode && selectedDistrict && showRecommendedLayer && (
              <Top3SpotsLayer
                spots={top3Spots}
                districtName={selectedDistrict.name}
                spotRefs={spotRefs}
              />
            )}

            {/* Heatmap sub-mode: show all existing chargers as small red dots (toggleable) */}
            {isHeatmapSubMode && showExistingLayer && (
              <PassiveStationLayer stations={stations} />
            )}
          </Pane>
        </MapContainer>

        {/* ── Buffer heatmap legend (bottom-left, only in heatmap sub-mode) ── */}
        {isHeatmapSubMode && <BufferHeatmapLegend />}

        {/* ── Right overlay ───────────────────────────────────────────────── */}
        {isRecommendationMode && (
          <div className="rec-overlay-stack">

            {/* ══ HEATMAP SUB-MODE ═══════════════════════════════════════════ */}
            {isHeatmapSubMode && (
              heatmapSelectedDistrict ? (
                /* Heatmap — district detail */
                <aside className="rec-side-card rec-district-detail" aria-label="Buffer district detail">
                  <div className="rec-list-scroll">
                    <div className="rdd-header">
                      <div className="rdd-title-row">
                        <span className="rdd-district-name">📍 {heatmapSelectedDistrict.name}</span>
                        <span
                          className="rec-score-badge"
                          style={{ backgroundColor: getBufferColor(heatmapSelectedDistrict.nearestStationKm) }}
                        >
                          {heatmapSelectedDistrict.nearestStationKm.toFixed(1)} km
                        </span>
                      </div>
                      <div className="rdd-stats-grid">
                        <div className="rdd-stat">
                          <span className="rdd-stat-label">Distance to nearest</span>
                          <span className="rdd-stat-value">{formatDistanceKm(heatmapSelectedDistrict.nearestStationKm)}</span>
                        </div>
                        <div className="rdd-stat">
                          <span className="rdd-stat-label">Buffer intensity</span>
                          <span className="rdd-stat-value">{Math.min(heatmapSelectedDistrict.nearestStationKm / 3.0, 1.0).toFixed(2)}</span>
                        </div>
                        <div className="rdd-stat" style={{ gridColumn: '1 / -1' }}>
                          <span className="rdd-stat-label">Coverage status</span>
                          <span className="rdd-stat-value" style={{ color: getBufferColor(heatmapSelectedDistrict.nearestStationKm) }}>
                            {getBufferLabel(heatmapSelectedDistrict.nearestStationKm)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="rdd-divider" />
                    <div className="rdd-section-header" style={{ marginBottom: 6 }}>
                      <span className="rdd-section-title">
                        ✅ Stations in district ({heatmapStationsInDistrict.length})
                      </span>
                    </div>
                    {heatmapStationsInDistrict.length === 0 ? (
                      <p className="rdd-empty" style={{ marginBottom: 6 }}>No stations inside this district — prime candidate for new charger.</p>
                    ) : (
                      <ul className="rdd-station-list" style={{ marginBottom: 6 }}>
                        {heatmapStationsInDistrict.map((s) => (
                          <li key={s.id} className="rdd-station-item">🔴 {s.name}</li>
                        ))}
                      </ul>
                    )}
                    <div className="rdd-divider" />
                    <button className="rec-back-btn" style={{ marginTop: 4 }} onClick={() => setHeatmapSelectedDistrict(null)}>
                      ← Back to top 5 list
                    </button>
                  </div>
                </aside>
              ) : (
                /* Heatmap — overview: top 5 most isolated */
                <aside className="rec-side-card rec-list-overlay" aria-label="Most isolated districts">
                  <h3 className="rec-side-title">🌡 EV Station Density Heatmap</h3>
                  <p className="rec-info-text" style={{ marginBottom: 8 }}>
                    Each existing charging station is one heat point. Red hotspots show where stations
                    cluster. Blue areas have few or no nearby chargers.
                  </p>
                  <div className="rdd-divider" />
                  <p className="rec-side-title" style={{ marginBottom: 6 }}>Top 5 most isolated districts</p>
                  {top5Isolated.length === 0 ? (
                    <p className="rec-side-empty">Calculating…</p>
                  ) : (
                    <div className="rec-list-scroll">
                      <ol className="rec-list">
                        {top5Isolated.map((d, i) => {
                          const maxDist = top5Isolated[0].nearestStationKm;
                          const barPct = maxDist > 0 ? (d.nearestStationKm / maxDist) * 100 : 0;
                          return (
                            <li
                              key={d.feature.properties.fid}
                              className="rec-item"
                              role="button"
                              tabIndex={0}
                              onClick={() => {
                                setHeatmapSelectedDistrict(d);
                                setFlyTarget({ feature: d.feature, _ts: Date.now() });
                              }}
                              onKeyDown={(e) => e.key === 'Enter' && (() => {
                                setHeatmapSelectedDistrict(d);
                                setFlyTarget({ feature: d.feature, _ts: Date.now() });
                              })()}
                            >
                              <div className="rec-item-header">
                                <span className="rec-rank">#{i + 1}</span>
                                <div className="rec-title-block">
                                  <span className="rec-name">{d.name}</span>
                                  <span className="rec-subtitle">{getBufferLabel(d.nearestStationKm)}</span>
                                </div>
                                <span
                                  className="rec-score-badge"
                                  style={{ backgroundColor: getBufferColor(d.nearestStationKm) }}
                                >
                                  {d.nearestStationKm.toFixed(1)} km
                                </span>
                              </div>
                              <div className="rec-bar-track">
                                <div
                                  className="rec-bar-fill"
                                  style={{ width: `${barPct}%`, backgroundColor: getBufferColor(d.nearestStationKm) }}
                                />
                              </div>
                              <div className="rec-metrics">
                                <span className="rec-pill">Intensity {Math.min(d.nearestStationKm / 3.0, 1.0).toFixed(2)}</span>
                                <span className="rec-action-hint">Click to explore</span>
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  )}
                  <div className="rdd-divider" />
                  {/* Collapsible explanation */}
                  <button className="rdd-explain-toggle" onClick={() => setShowHeatmapExplanation((v) => !v)}>
                    {showHeatmapExplanation ? '▲' : '▼'} ℹ️ How is this calculated?
                  </button>
                  {showHeatmapExplanation && (
                    <div className="rdd-explain-body">
                      <p>Each EV charging station is plotted as a point with weight 1.0. Leaflet.heat accumulates overlapping points — areas where many stations are close together appear red. Isolated stations appear blue.</p>
                      <ul>
                        <li>Red = high station density (many chargers nearby)</li>
                        <li>Blue = sparse or no chargers in the area</li>
                        <li>No population or need score — pure station density only</li>
                      </ul>
                      <code className="rec-info-code">heatPoint = [station.lat, station.lng, 1.0]</code>
                    </div>
                  )}
                </aside>
              )
            )}

            {/* ══ SPOTS SUB-MODE ═════════════════════════════════════════════ */}
            {isSpotsSubMode && !selectedDistrict && (
              /* ── Spots overview state ── */
              <>
                {/* How rating works */}
                <aside className="rec-info-box rec-info-overlay" aria-label="How recommendation rating works">
                  <div className="rec-info-section">
                    <h3 className="rec-info-title">How rating works</h3>
                    <p className="rec-info-text">
                      Each district receives a <strong>Need Score</strong> from 0 to 100 combining
                      population pressure, service gap, and coverage buffer.
                    </p>
                    <ul className="rec-info-list">
                      <li><strong>Population (30%)</strong>: more residents = higher priority</li>
                      <li><strong>Service gap (30%)</strong>: fewer chargers per 10,000 people = higher priority</li>
                      <li><strong>Buffer zone (40%)</strong>: farther than 3 km from nearest station = highest priority</li>
                    </ul>
                    <code className="rec-info-code">
                      NeedScore = (Pop × 0.3) + (Service × 0.3) + (Buffer × 0.4)
                    </code>
                  </div>
                  <div className="rec-info-section">
                    <h3 className="rec-info-title">Color meaning</h3>
                    <ul className="rec-color-list">
                      {NEED_SCORE_LEGEND.map((item) => (
                        <li key={item.label}>
                          <i className="rec-color-swatch" style={{ backgroundColor: item.color }} />
                          <span>{item.label}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </aside>

                {/* Top 5 list */}
                <aside className="rec-side-card rec-list-overlay" aria-label="Top 5 districts">
                  <h3 className="rec-side-title">Top 5 priority districts</h3>
                  {top5.length === 0 ? (
                    <p className="rec-side-empty">Calculating scores…</p>
                  ) : (
                    <div className="rec-list-scroll">
                      <ol className="rec-list">
                        {top5.map((d, i) => (
                          <li
                            key={d.feature.properties.fid}
                            className="rec-item"
                            role="button"
                            tabIndex={0}
                            onClick={() => handleOverviewItemClick(d, i)}
                            onKeyDown={(e) => e.key === 'Enter' && handleOverviewItemClick(d, i)}
                          >
                            <div className="rec-item-header">
                              <span className="rec-rank">#{i + 1}</span>
                              <div className="rec-title-block">
                                <span className="rec-name">{d.name}</span>
                                <span className="rec-subtitle">{getNeedLevel(d.needScore)}</span>
                              </div>
                              <span
                                className="rec-score-badge"
                                style={{ backgroundColor: getNeedScoreColor(d.needScore) }}
                              >
                                {d.needScore}/100
                              </span>
                            </div>
                            <div className="rec-bar-track">
                              <div
                                className="rec-bar-fill"
                                style={{ width: `${d.needScore}%`, backgroundColor: getNeedScoreColor(d.needScore) }}
                              />
                            </div>
                            <div className="rec-metrics">
                              <span className="rec-pill">Pop {d.popScore}</span>
                              <span className="rec-pill">Service {d.serviceScore}</span>
                              <span className="rec-pill">Buffer {d.bufferScore}</span>
                              <span className="rec-pill">{formatDistanceKm(d.nearestStationKm)}</span>
                              <span className="rec-action-hint">Click to explore</span>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </aside>
              </>
            )}

            {/* ── Spots sub-mode: district detail ── */}
            {isSpotsSubMode && selectedDistrict && (
              /* ── District detail state ── */
              <aside className="rec-side-card rec-district-detail" aria-label="District detail">
                <div className="rec-list-scroll">

                  {/* Header */}
                  <div className="rdd-header">
                    <div className="rdd-title-row">
                      <span className="rdd-district-name">📍 {selectedDistrict.name}</span>
                      <span
                        className="rec-score-badge"
                        style={{ backgroundColor: getNeedScoreColor(selectedDistrict.needScore) }}
                      >
                        {selectedDistrict.needScore}/100
                      </span>
                    </div>

                    {/* Overall need score bar */}
                    <div className="rdd-need-row">
                      <span className="rdd-label">Need Score</span>
                      <div className="rdd-bar-track">
                        <div
                          className="rdd-bar-fill"
                          style={{
                            width: `${selectedDistrict.needScore}%`,
                            backgroundColor: getNeedScoreColor(selectedDistrict.needScore),
                          }}
                        />
                      </div>
                    </div>

                    {/* Sub-score rows */}
                    {[
                      { emoji: '👥', label: 'Population score', score: selectedDistrict.popScore, weight: '×0.3' },
                      { emoji: '📡', label: 'Service gap score', score: selectedDistrict.serviceScore, weight: '×0.3' },
                      { emoji: '🔵', label: 'Buffer zone score', score: selectedDistrict.bufferScore, weight: '×0.4' },
                    ].map(({ emoji, label, score, weight }) => (
                      <div className="rdd-sub-row" key={label}>
                        <span className="rdd-sub-label">{emoji} {label}</span>
                        <div className="rdd-sub-bar-track">
                          <div className="rdd-sub-bar-fill" style={{ width: `${score}%` }} />
                        </div>
                        <span className="rdd-sub-value">{score}/100</span>
                        <span className="rdd-sub-weight">{weight}</span>
                      </div>
                    ))}

                    {/* Key stats */}
                    <div className="rdd-stats-grid">
                      <div className="rdd-stat">
                        <span className="rdd-stat-label">Population</span>
                        <span className="rdd-stat-value">{formatInteger(selectedDistrict.population)}</span>
                      </div>
                      <div className="rdd-stat">
                        <span className="rdd-stat-label">Existing stations</span>
                        <span className="rdd-stat-value">{selectedDistrict.noOfCounted}</span>
                      </div>
                      <div className="rdd-stat">
                        <span className="rdd-stat-label">Stations / 10k people</span>
                        <span className="rdd-stat-value">{selectedDistrict.chargersPer10k.toFixed(2)}</span>
                      </div>
                      <div className="rdd-stat">
                        <span className="rdd-stat-label">Distance to nearest</span>
                        <span className="rdd-stat-value">{formatDistanceKm(selectedDistrict.nearestStationKm)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="rdd-divider" />

                  {/* Existing stations section */}
                  <div className="rdd-section">
                    <div className="rdd-section-header">
                      <span className="rdd-section-title">✅ Existing Stations ({stationsInDistrict.length})</span>
                      <button
                        className="rdd-toggle-btn"
                        onClick={() => setShowExistingLayer((v) => !v)}
                      >
                        {showExistingLayer ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    {stationsInDistrict.length === 0 ? (
                      <p className="rdd-empty">No stations found inside this district boundary.</p>
                    ) : (
                      <ul className="rdd-station-list">
                        {stationsInDistrict.map((s) => (
                          <li key={s.id} className="rdd-station-item">
                            🔴 {s.name}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="rdd-divider" />

                  {/* Top 3 recommended spots */}
                  <div className="rdd-section">
                    <div className="rdd-section-header">
                      <span className="rdd-section-title">💡 Top 3 Recommended New Spots</span>
                      <button
                        className="rdd-toggle-btn"
                        onClick={() => setShowRecommendedLayer((v) => !v)}
                      >
                        {showRecommendedLayer ? 'Hide' : 'Show'}
                      </button>
                    </div>

                    {top3Spots.length === 0 && (
                      <p className="rdd-empty">Calculating recommended spots…</p>
                    )}

                    <div className="rdd-spots-list">
                      {top3Spots.map((spot) =>
                        spot.insufficient ? (
                          <div key={`spot-${spot.rank}`} className="rdd-spot-item rdd-spot-insufficient">
                            <span className="rdd-spot-rank">#{spot.rank}</span>
                            <span className="rdd-spot-label">Insufficient gap — no valid location found</span>
                          </div>
                        ) : (
                          <div
                            key={`spot-${spot.rank}`}
                            className="rdd-spot-item"
                            role="button"
                            tabIndex={0}
                            onClick={() => handleSpotItemClick(spot, spot.rank - 1)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSpotItemClick(spot, spot.rank - 1)}
                          >
                            <div className="rdd-spot-header">
                              <span className="rdd-spot-rank rdd-spot-rank-blue">#{spot.rank}</span>
                              <div className="rdd-bar-track rdd-spot-bar">
                                <div
                                  className="rdd-bar-fill"
                                  style={{ width: `${spot.candidateScore}%`, backgroundColor: '#3b82f6' }}
                                />
                              </div>
                              <span className="rdd-spot-score">{spot.candidateScore}/100</span>
                            </div>
                            <div className="rdd-spot-coords">
                              📌 {spot.lat.toFixed(5)}, {spot.lng.toFixed(5)}
                            </div>
                            <div className="rdd-spot-meta">
                              Gap: {formatDistanceKm(spot.gapKm)} · {spot.chargerType}
                            </div>
                            <div className="rdd-spot-hint">Tap to fly to location</div>
                          </div>
                        )
                      )}
                    </div>
                  </div>

                  <div className="rdd-divider" />

                  {/* Export CSV */}
                  <button
                    className="rdd-export-btn"
                    onClick={() => exportDistrictCSV(selectedDistrict, stationsInDistrict, top3Spots)}
                  >
                    📋 Export this district CSV
                  </button>

                  <div className="rdd-divider" />

                  {/* Collapsible explanation */}
                  <div className="rdd-section">
                    <button
                      className="rdd-explain-toggle"
                      onClick={() => setShowExplanation((v) => !v)}
                    >
                      {showExplanation ? '▲' : '▼'} How is this calculated?
                    </button>
                    {showExplanation && (
                      <div className="rdd-explain-body">
                        <p>
                          Need Score combines three factors:
                        </p>
                        <ul>
                          <li><strong>Population (30%)</strong>: districts with more residents score higher</li>
                          <li><strong>Service gap (30%)</strong>: districts with fewer chargers per 10,000 people score higher</li>
                          <li><strong>Buffer zone (40%)</strong>: districts where the nearest charger is more than 3 km away score highest — this is the most important factor</li>
                        </ul>
                        <code className="rec-info-code">
                          NeedScore = (PopScore × 0.3) + (ServiceScore × 0.3) + (BufferScore × 0.4)
                        </code>
                      </div>
                    )}
                  </div>

                </div>
              </aside>
            )}

          </div>
        )}

      </section>
    </main>
  );
}

export default App;
