import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
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
import outerBorderDataUrl from './assets/data/outerBorder.geojson?url';

const MAP_MODES = {
  DISTRICTS: 'districts',
  STATIONS: 'stations',
  RECOMMENDATION: 'recommendation',
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

// ─── Major Bangkok POIs for landmark labelling and bonus scoring ──────────────

const BANGKOK_POIS = [
  { name: 'Siam Paragon',              lat: 13.7463, lng: 100.5347, type: 'mall' },
  { name: 'CentralWorld',              lat: 13.7466, lng: 100.5394, type: 'mall' },
  { name: 'MBK Center',                lat: 13.7448, lng: 100.5298, type: 'mall' },
  { name: 'Terminal 21 Asok',          lat: 13.7374, lng: 100.5608, type: 'mall' },
  { name: 'Emporium',                  lat: 13.7305, lng: 100.5693, type: 'mall' },
  { name: 'Future Park Rangsit',       lat: 14.0244, lng: 100.6147, type: 'mall' },
  { name: 'Seacon Square',             lat: 13.7161, lng: 100.6382, type: 'mall' },
  { name: 'CentralPlaza Bangna',       lat: 13.6806, lng: 100.6048, type: 'mall' },
  { name: 'CentralPlaza Ladprao',      lat: 13.8150, lng: 100.5604, type: 'mall' },
  { name: 'The Mall Bangkapi',         lat: 13.7681, lng: 100.6419, type: 'mall' },
  { name: 'Mega Bangna',               lat: 13.6569, lng: 100.6374, type: 'mall' },
  { name: 'Icon Siam',                 lat: 13.7267, lng: 100.5097, type: 'mall' },
  { name: 'The Platinum Fashion Mall', lat: 13.7496, lng: 100.5390, type: 'mall' },
  { name: 'Mo Chit BTS Station',       lat: 13.8025, lng: 100.5531, type: 'transit' },
  { name: 'Chatuchak Park MRT',        lat: 13.7993, lng: 100.5499, type: 'transit' },
  { name: 'Bang Sue Grand Station',    lat: 13.8022, lng: 100.5326, type: 'transit' },
  { name: 'On Nut BTS Station',        lat: 13.7011, lng: 100.5986, type: 'transit' },
  { name: 'Bearing BTS Station',       lat: 13.6719, lng: 100.5961, type: 'transit' },
  { name: 'Minburi MRT Station',       lat: 13.8120, lng: 100.7283, type: 'transit' },
  { name: 'Tao Poon MRT Station',      lat: 13.8031, lng: 100.5256, type: 'transit' },
  { name: 'Siriraj Hospital',          lat: 13.7588, lng: 100.4855, type: 'hospital' },
  { name: 'Bumrungrad Hospital',       lat: 13.7453, lng: 100.5524, type: 'hospital' },
  { name: 'Ramathibodi Hospital',      lat: 13.7685, lng: 100.5316, type: 'hospital' },
  { name: 'Samitivej Sukhumvit',       lat: 13.7201, lng: 100.5938, type: 'hospital' },
  { name: 'Bangkok Hospital',          lat: 13.7257, lng: 100.5649, type: 'hospital' },
  { name: 'Paolo Kaset Hospital',      lat: 13.8487, lng: 100.5715, type: 'hospital' },
  { name: 'Don Mueang Airport',        lat: 13.9126, lng: 100.6067, type: 'landmark' },
  { name: 'Suvarnabhumi Airport',      lat: 13.6811, lng: 100.7474, type: 'landmark' },
  { name: 'Chatuchak Weekend Market',  lat: 13.7999, lng: 100.5501, type: 'landmark' },
  { name: 'IKEA Bang Yai',             lat: 13.8556, lng: 100.3980, type: 'landmark' },
];

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : 'N/A';
}

function formatCoverage(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : 'N/A';
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

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
  const v = Number(coverage);
  if (!Number.isFinite(v)) return '#d9e2ec';
  if (v >= 12) return '#005f73';
  if (v >= 8)  return '#0a9396';
  if (v >= 4)  return '#94d2bd';
  if (v > 0)   return '#e9d8a6';
  return '#f7f7f7';
}

// ─── Recommendation scoring ───────────────────────────────────────────────────

function getNeedScoreColor(score) {
  if (score >= 80) return '#ef4444';
  if (score >= 60) return '#f97316';
  if (score >= 40) return '#eab308';
  return '#22c55e';
}

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

function computeCentroid(geometry) {
  let latSum = 0, lngSum = 0, count = 0;
  const processRing = (ring) => {
    for (const [lng, lat] of ring) { latSum += lat; lngSum += lng; count++; }
  };
  if (geometry.type === 'Polygon') processRing(geometry.coordinates[0]);
  else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) processRing(poly[0]);
  }
  return count > 0 ? [latSum / count, lngSum / count] : [13.75, 100.5];
}

function computeAreaKm2(geometry) {
  const latRad = (13.75 * Math.PI) / 180;
  const ringArea = (ring) => {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return (Math.abs(a) / 2) * 111 * 111 * Math.cos(latRad);
  };
  if (geometry.type === 'Polygon') return ringArea(geometry.coordinates[0]);
  if (geometry.type === 'MultiPolygon')
    return geometry.coordinates.reduce((sum, poly) => sum + ringArea(poly[0]), 0);
  return 1;
}

function computeDistrictScores(districtData, stations) {
  if (!districtData || !stations.length) return [];

  const raw = districtData.features.map((feature) => {
    const props = feature.properties;
    const population = Number(props.final_population_english_Population) || 0;
    const noOfCounted = Number(props.noOfCounted) || 0;
    const centroid = computeCentroid(feature.geometry);
    const areaKm2 = Math.max(computeAreaKm2(feature.geometry), 0.1);
    return {
      feature,
      name: getDistrictName(props),
      population,
      noOfCounted,
      centroid,
      areaKm2,
      chargersPerKm2: noOfCounted / areaKm2,
    };
  });

  const maxPop = Math.max(...raw.map((d) => d.population));
  const minPop = Math.min(...raw.map((d) => d.population));
  const maxDensity = Math.max(...raw.map((d) => d.chargersPerKm2));

  return raw
    .map((d) => {
      const popScore =
        maxPop > minPop ? ((d.population - minPop) / (maxPop - minPop)) * 100 : 50;
      const coverageScore =
        maxDensity > 0 ? (1 - d.chargersPerKm2 / maxDensity) * 100 : 100;
      const nearestDist = findNearestStationDist(d.centroid, stations);
      const bufferScore = nearestDist >= 1.5 ? 100 : (nearestDist / 1.5) * 100;
      const needScore = Math.min(
        100,
        Math.round(popScore * 0.4 + coverageScore * 0.4 + bufferScore * 0.2)
      );
      return {
        ...d,
        popScore: Math.round(popScore),
        coverageScore: Math.round(coverageScore),
        bufferScore: Math.round(bufferScore),
        needScore,
      };
    })
    .sort((a, b) => b.needScore - a.needScore);
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function getBoundingBox(geometry) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  const processRing = (ring) => {
    for (const [lng, lat] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  };
  if (geometry.type === 'Polygon') processRing(geometry.coordinates[0]);
  else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) processRing(poly[0]);
  }
  return { minLat, maxLat, minLng, maxLng };
}

/** Ray-casting point-in-polygon for a GeoJSON ring ([lng, lat] pairs). */
function raycastInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function isPointInGeometry(lat, lng, geometry) {
  if (geometry.type === 'Polygon')
    return raycastInRing(lat, lng, geometry.coordinates[0]);
  if (geometry.type === 'MultiPolygon')
    return geometry.coordinates.some((poly) => raycastInRing(lat, lng, poly[0]));
  return false;
}

/** Generates a rows×cols grid inside a geometry's bounding box, filtered to points inside. */
function generateGridPoints(geometry, rows = 10, cols = 10) {
  const { minLat, maxLat, minLng, maxLng } = getBoundingBox(geometry);
  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lat = minLat + (maxLat - minLat) * (r + 0.5) / rows;
      const lng = minLng + (maxLng - minLng) * (c + 0.5) / cols;
      if (isPointInGeometry(lat, lng, geometry)) points.push([lat, lng]);
    }
  }
  return points;
}

// ─── Exact-site helpers ───────────────────────────────────────────────────────

function isNearPOI(lat, lng) {
  return BANGKOK_POIS.some((p) => haversineKm(lat, lng, p.lat, p.lng) < 1.5);
}

function findNearestPOI(lat, lng) {
  let minDist = Infinity, nearest = null;
  for (const poi of BANGKOK_POIS) {
    const d = haversineKm(lat, lng, poi.lat, poi.lng);
    if (d < minDist) { minDist = d; nearest = poi; }
  }
  return { poi: nearest, dist: minDist };
}

function getSuggestedType(gapKm) {
  if (gapKm > 3) return 'DC Fast Charger';
  if (gapKm >= 1) return 'AC Type 2';
  return 'Top-up AC Charger';
}

/** Single-best coverage point for the global top-5 cards. */
function findOptimalSite(districtFeature, stations) {
  const gridPoints = generateGridPoints(districtFeature.geometry);
  if (gridPoints.length === 0) {
    const [lat, lng] = computeCentroid(districtFeature.geometry);
    return { lat, lng, gapKm: 0, nearestCharger: null };
  }
  let bestLat = gridPoints[0][0], bestLng = gridPoints[0][1];
  let bestScore = -Infinity, bestGap = 0, bestCharger = null;
  for (const [lat, lng] of gridPoints) {
    let minDist = Infinity, nearestCharger = null;
    for (const s of stations) {
      const d = haversineKm(lat, lng, s.lat, s.lng);
      if (d < minDist) { minDist = d; nearestCharger = s; }
    }
    const score = minDist * 100 + (isNearPOI(lat, lng) ? 10 : 0);
    if (score > bestScore) {
      bestScore = score; bestLat = lat; bestLng = lng;
      bestGap = minDist; bestCharger = nearestCharger;
    }
  }
  return { lat: bestLat, lng: bestLng, gapKm: bestGap, nearestCharger: bestCharger };
}

/** Computes one optimal site per top-5 district for the overview panel. */
function computeExactSites(top5, stations) {
  return top5.map((d, i) => {
    const site = findOptimalSite(d.feature, stations);
    const { poi, dist: poiDist } = findNearestPOI(site.lat, site.lng);
    const density = d.population / Math.max(d.areaKm2, 0.1);
    return {
      rank: i + 1,
      districtName: d.name,
      lat: site.lat,
      lng: site.lng,
      gapKm: Math.round(site.gapKm * 10) / 10,
      nearestCharger: site.nearestCharger,
      landmark: poiDist < 2.0 && poi ? `Near ${poi.name}` : 'Remote area',
      suggestedType: getSuggestedType(site.gapKm),
      populationEst: Math.round(density * Math.PI),
      needScore: d.needScore,
    };
  });
}

// ─── Top-3 per-district algorithm ─────────────────────────────────────────────
//
// Score = (dist_to_nearest_charger × 0.7) + (dist_to_nearest_rec × 0.3)
// Constraints:
//   • Each candidate must be ≥ 500 m from any existing charger
//   • Each candidate must be ≥ 800 m from all already-selected recommended spots
// Selection is greedy: pick the highest-scoring valid point, then repeat.

function computeTop3ForDistrict(scoredDistrict, allStations) {
  const { feature, population, areaKm2 } = scoredDistrict;
  const gridPoints = generateGridPoints(feature.geometry);

  // Pre-filter: ≥ 500 m from every existing charger
  const candidates = [];
  for (const [lat, lng] of gridPoints) {
    let minDist = Infinity, nearestCharger = null;
    for (const s of allStations) {
      const d = haversineKm(lat, lng, s.lat, s.lng);
      if (d < minDist) { minDist = d; nearestCharger = s; }
    }
    if (minDist >= 0.5) candidates.push({ lat, lng, distToCharger: minDist, nearestCharger });
  }

  if (candidates.length === 0) return [];

  const selected = [];
  const pool = [...candidates];

  for (let rank = 1; rank <= 3; rank++) {
    let bestScore = -Infinity, bestIdx = -1;

    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];

      // Enforce ≥ 800 m separation from already-chosen spots
      if (selected.some((r) => haversineKm(c.lat, c.lng, r.lat, r.lng) < 0.8)) continue;

      // Spread-out scoring: penalise clustering with already-chosen spots
      let distToNearestRec = Infinity;
      for (const r of selected) {
        const d = haversineKm(c.lat, c.lng, r.lat, r.lng);
        if (d < distToNearestRec) distToNearestRec = d;
      }
      const score =
        selected.length === 0
          ? c.distToCharger
          : c.distToCharger * 0.7 + distToNearestRec * 0.3;

      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    if (bestIdx === -1) break; // no valid point left for this rank

    const winner = pool.splice(bestIdx, 1)[0];
    selected.push({ ...winner, rank, score: bestScore });
  }

  if (selected.length === 0) return [];

  // Normalise scores for display bars (best ≈ 94/100, proportional below)
  const refScore = selected[0].score * 1.06; // ensures top score lands ~94
  const density = population / Math.max(areaKm2, 0.1);
  const populationEst = Math.round(density * Math.PI);

  return selected.map((s) => ({
    ...s,
    normalizedScore: Math.min(100, Math.max(5, Math.round((s.score / refScore) * 94))),
    suggestedType: getSuggestedType(s.distToCharger),
    populationEst,
  }));
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportSitesCSV(exactSites) {
  const header = 'site_id,district,lat,lng,gap_km,suggested_type,reason\n';
  const rows = exactSites
    .map((s) =>
      `${s.rank},"${s.districtName}",${s.lat.toFixed(6)},${s.lng.toFixed(6)},${s.gapKm},"${s.suggestedType}","Highest uncovered area in district"`
    )
    .join('\n');
  triggerCSVDownload(header + rows, 'recommended_ev_sites.csv');
}

function exportDistrictCSV(district, top3, chargers) {
  const header = 'type,rank,district,lat,lng,gap_km,suggested_type,reason\n';
  const recRows = top3.map((s) =>
    `recommended,${s.rank},"${district.name}",${s.lat.toFixed(6)},${s.lng.toFixed(6)},${s.distToCharger.toFixed(2)},"${s.suggestedType}","Largest uncovered zone"`
  );
  const existRows = chargers.map((s) =>
    `existing,,"${district.name}",${s.lat.toFixed(6)},${s.lng.toFixed(6)},,"Existing station",""`
  );
  triggerCSVDownload(
    header + [...recRows, ...existRows].join('\n'),
    `${district.name.replace(/\s+/g, '_')}_ev_sites.csv`
  );
}

function triggerCSVDownload(content, filename) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

// ─── Icon factories ───────────────────────────────────────────────────────────

function createExactSiteIcon(rank) {
  return L.divIcon({
    className: 'exact-site-wrapper',
    html: `<div class="exact-site-ripple"><span class="exact-site-rank">#${rank}</span></div>`,
    iconAnchor: [22, 22],
    iconSize: [44, 44],
    popupAnchor: [0, -28],
  });
}

// Sizes: rank-1 is largest (most prominent), rank-3 is smallest
const RANKED_SIZES = [52, 44, 38];

function createRankedSiteIcon(rank) {
  const size = RANKED_SIZES[rank - 1] ?? 38;
  return L.divIcon({
    className: 'dist-rec-wrapper',
    html: `<div class="dist-rec-ripple rank-${rank}"><span class="dist-rec-rank">#${rank}</span></div>`,
    iconAnchor: [size / 2, size / 2],
    iconSize: [size, size],
    popupAnchor: [0, -(size / 2 + 6)],
  });
}

// ─── Map sub-components ───────────────────────────────────────────────────────

function InitializeMapBounds({ districts, stations }) {
  const map = useMap();
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current || !districts || !stations.length) return;
    const bounds = L.latLngBounds([]);
    bounds.extend(L.geoJSON(districts).getBounds());
    bounds.extend(stations.map((s) => [s.lat, s.lng]));
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.06));
      map.setMaxBounds(bounds.pad(0.2));
      initialized.current = true;
    }
  }, [districts, map, stations]);

  return null;
}

/** Handles both flyTo (point) and flyToBounds (district polygon). */
function MapFlyController({ target, markerRefs }) {
  const map = useMap();

  useEffect(() => {
    if (!target) return;

    if (target.bounds) {
      map.flyToBounds(target.bounds, { padding: [50, 50], maxZoom: 14, duration: 1.0 });
      return;
    }

    map.flyTo(target.latlng, target.zoom ?? 13, { duration: 1.0 });

    if (target.popupIndex !== undefined) {
      const onMoveEnd = () => {
        markerRefs.current[target.popupIndex]?.openPopup();
        map.off('moveend', onMoveEnd);
      };
      map.on('moveend', onMoveEnd);
      return () => map.off('moveend', onMoveEnd);
    }
  }, [map, target, markerRefs]);

  return null;
}

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
    click: (event) => { if (isDistrictMode) layer.openPopup(event.latlng); },
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
      style={(feature) => districtStyle(feature, isDistrictMode)}
      onEachFeature={(feature, layer) => onEachDistrict(feature, layer, zoom, isDistrictMode)}
    />
  );
}

function StationLayer({ isStreetBasemap, stations }) {
  return stations.map((station) => (
    <CircleMarker
      key={`station-interactive-${station.id}`}
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
      key={`station-passive-${station.id}`}
      center={[station.lat, station.lng]}
      bubblingMouseEvents={false}
      interactive={false}
      pathOptions={{ color: '#fffaf0', fillColor: '#ee6c4d', fillOpacity: 0.95, opacity: 1, weight: 1 }}
      radius={4}
    />
  ));
}

/**
 * Heat-map layer for recommendation mode.
 * Calls onDistrictClick (stable via useCallback) when a district polygon is clicked.
 */
function RecommendationDistrictLayer({ districtData, scoredDistricts, onDistrictClick }) {
  // Map fid → full scored district object so click handler gets the complete record
  const districtMap = useMemo(() => {
    const m = new Map();
    for (const d of scoredDistricts) m.set(d.feature.properties.fid, d);
    return m;
  }, [scoredDistricts]);

  // Use a ref so the Leaflet closure always reads the latest callback without
  // requiring the GeoJSON to remount when the handler reference changes.
  const onClickRef = useRef(onDistrictClick);
  useEffect(() => { onClickRef.current = onDistrictClick; }, [onDistrictClick]);

  return (
    <GeoJSON
      key="rec-districts"
      data={districtData}
      interactive
      style={(feature) => {
        const score = districtMap.get(feature.properties.fid)?.needScore ?? 0;
        return { color: '#1f3c48', weight: 1.2, fillColor: getNeedScoreColor(score), fillOpacity: 0.6 };
      }}
      onEachFeature={(feature, layer) => {
        const d = districtMap.get(feature.properties.fid);
        const score = d?.needScore ?? 0;
        layer.bindTooltip(`${getDistrictName(feature.properties)} — Score: ${score}/100`, {
          className: 'district-label district-label-small',
          sticky: true,
        });
        layer.on({
          mouseover: () => { layer.setStyle({ weight: 2.4, fillOpacity: 0.85 }); layer.bringToFront(); },
          mouseout: () => {
            layer.setStyle({ color: '#1f3c48', weight: 1.2, fillColor: getNeedScoreColor(score), fillOpacity: 0.6 });
          },
          click: () => { if (d) onClickRef.current?.(d); },
        });
      }}
    />
  );
}

/** Global top-5 overview markers (shown when no district is selected). */
function ExactSiteLayer({ exactSites, markerRefs }) {
  const icons = useMemo(() => exactSites.map((_, i) => createExactSiteIcon(i + 1)), [exactSites]);

  return exactSites.map((site, i) => (
    <Fragment key={`exact-site-${i}`}>
      <Circle
        center={[site.lat, site.lng]}
        radius={1000}
        pathOptions={{ color: '#2563eb', weight: 1.8, dashArray: '6 4', fillColor: '#2563eb', fillOpacity: 0.06 }}
      />
      {site.nearestCharger && (
        <Polyline
          positions={[[site.lat, site.lng], [site.nearestCharger.lat, site.nearestCharger.lng]]}
          pathOptions={{ color: '#ef4444', weight: 2, dashArray: '5 5', opacity: 0.65 }}
        />
      )}
      <Marker
        position={[site.lat, site.lng]}
        icon={icons[i]}
        ref={(el) => { markerRefs.current[i] = el; }}
      >
        <Popup>
          <div className="station-popup exact-site-popup">
            <h3>📍 Recommended Site #{site.rank}</h3>
            <p>{site.districtName}</p>
            <dl>
              <div><dt>Coordinates</dt><dd>{site.lat.toFixed(4)}, {site.lng.toFixed(4)}</dd></div>
              <div><dt>Gap distance</dt><dd>{site.gapKm} km</dd></div>
              <div><dt>Coverage gain</dt><dd>+{site.populationEst.toLocaleString()} residents</dd></div>
              <div><dt>Nearest landmark</dt><dd>{site.landmark}</dd></div>
              <div><dt>Suggested type</dt><dd>{site.suggestedType}</dd></div>
            </dl>
          </div>
        </Popup>
      </Marker>
    </Fragment>
  ));
}

/**
 * Interactive red dots for existing chargers inside the selected district.
 * Shows "nearest recommended gap" when top-3 are available.
 */
function DistrictStationLayer({ stations, districtTop3 }) {
  return stations.map((station) => {
    const nearestRecDist =
      districtTop3.length > 0
        ? Math.min(...districtTop3.map((r) => haversineKm(station.lat, station.lng, r.lat, r.lng)))
        : null;

    return (
      <CircleMarker
        key={`dist-station-${station.id}`}
        center={[station.lat, station.lng]}
        interactive
        pathOptions={{ color: '#fffaf0', fillColor: '#ee6c4d', fillOpacity: 0.95, opacity: 1, weight: 1.5 }}
        radius={8}
      >
        <Popup>
          <div className="station-popup">
            <h3>🔴 Existing Station</h3>
            <p>{station.name}</p>
            <dl>
              <div><dt>Address</dt><dd>{station.address}</dd></div>
              <div><dt>Rating</dt><dd>{station.rating ?? 'N/A'}</dd></div>
              {nearestRecDist !== null && (
                <div>
                  <dt>Nearest rec. gap</dt>
                  <dd>{nearestRecDist.toFixed(1)} km away</dd>
                </div>
              )}
            </dl>
          </div>
        </Popup>
      </CircleMarker>
    );
  });
}

/**
 * Ranked pulsing blue markers for the top-3 spots in the selected district.
 * Includes 500 m coverage circles and red gap lines to the nearest existing charger.
 */
function DistrictRecommendedLayer({ sites, districtName, markerRefs }) {
  const icons = useMemo(() => sites.map((s) => createRankedSiteIcon(s.rank)), [sites]);

  return sites.map((site, i) => (
    <Fragment key={`dist-rec-${i}`}>
      {/* 500 m dashed coverage circle */}
      <Circle
        center={[site.lat, site.lng]}
        radius={500}
        pathOptions={{ color: '#2563eb', weight: 1.8, dashArray: '6 4', fillColor: '#2563eb', fillOpacity: 0.1 }}
      />
      {/* Red gap line to nearest existing charger */}
      {site.nearestCharger && (
        <Polyline
          positions={[[site.lat, site.lng], [site.nearestCharger.lat, site.nearestCharger.lng]]}
          pathOptions={{ color: '#ef4444', weight: 2, dashArray: '5 5', opacity: 0.7 }}
        />
      )}
      {/* Pulsing ranked marker */}
      <Marker
        position={[site.lat, site.lng]}
        icon={icons[i]}
        ref={(el) => { markerRefs.current[i] = el; }}
      >
        <Popup>
          <div className="station-popup exact-site-popup">
            <h3>🔵 Recommended Spot #{site.rank}</h3>
            <p>District: {districtName}</p>
            <dl>
              <div><dt>Coordinates</dt><dd>{site.lat.toFixed(4)}, {site.lng.toFixed(4)}</dd></div>
              <div><dt>Gap from nearest charger</dt><dd>{site.distToCharger.toFixed(1)} km</dd></div>
              <div><dt>Estimated coverage</dt><dd>~{site.populationEst.toLocaleString()} residents</dd></div>
              <div><dt>Suggested type</dt><dd>{site.suggestedType}</dd></div>
              <div><dt>Reason</dt><dd>Largest uncovered zone</dd></div>
            </dl>
          </div>
        </Popup>
      </Marker>
    </Fragment>
  ));
}

// ─── District detail side panel ───────────────────────────────────────────────

function DistrictDetailPanel({
  district,
  districtChargers,
  districtTop3,
  showExisting,
  showRecommended,
  onToggleExisting,
  onToggleRecommended,
  onBack,
  onSiteClick,
}) {
  return (
    <>
      <button className="back-btn" onClick={onBack}>← All districts</button>
      <h2 className="rec-panel-title">📍 {district.name}</h2>

      <div className="district-summary">
        <span>Existing chargers: <strong>{districtChargers.length}</strong></span>
        <span>
          Need score:{' '}
          <strong style={{ color: getNeedScoreColor(district.needScore) }}>
            {district.needScore}/100
          </strong>
        </span>
      </div>

      {/* ── Existing stations section ── */}
      <div className="detail-section">
        <div className="detail-section-header">
          <span>✅ Existing Stations</span>
          <button
            className={`toggle-btn${showExisting ? ' active' : ''}`}
            onClick={onToggleExisting}
          >
            {showExisting ? 'Hide' : 'Show'}
          </button>
        </div>
        {showExisting && (
          districtChargers.length === 0 ? (
            <p className="status-message" style={{ marginTop: 6 }}>No stations found in this district.</p>
          ) : (
            <ul className="station-mini-list">
              {districtChargers.slice(0, 6).map((s, i) => (
                <li key={i} className="station-mini-item">
                  <span className="station-mini-dot" />
                  <span className="station-mini-name">{s.name}</span>
                </li>
              ))}
              {districtChargers.length > 6 && (
                <li className="station-mini-more">+{districtChargers.length - 6} more</li>
              )}
            </ul>
          )
        )}
      </div>

      {/* ── Recommended new spots section ── */}
      <div className="detail-section">
        <div className="detail-section-header">
          <span>💡 Recommended New Spots</span>
          <button
            className={`toggle-btn${showRecommended ? ' active' : ''}`}
            onClick={onToggleRecommended}
          >
            {showRecommended ? 'Hide' : 'Show'}
          </button>
        </div>

        {showRecommended && (
          districtTop3.length === 0 ? (
            <p className="status-message" style={{ marginTop: 6 }}>
              Insufficient gap — no valid spots found (all points are within 500 m of an existing charger or 800 m of each other).
            </p>
          ) : (
            <div className="rec-spots">
              {districtTop3.map((site, i) => (
                <div
                  key={i}
                  className="rec-spot"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSiteClick(site, i)}
                  onKeyDown={(e) => e.key === 'Enter' && onSiteClick(site, i)}
                >
                  <div className="rec-spot-header">
                    <span className="rec-spot-rank">#{site.rank}</span>
                    <div className="rec-spot-bar-track">
                      <div
                        className="rec-spot-bar-fill"
                        style={{ width: `${site.normalizedScore}%` }}
                      />
                    </div>
                    <span className="rec-spot-score">{site.normalizedScore}/100</span>
                  </div>

                  <button
                    className="site-card-coords"
                    onClick={(e) => {
                      e.stopPropagation();
                      copyToClipboard(`${site.lat.toFixed(6)}, ${site.lng.toFixed(6)}`);
                    }}
                    title="Click to copy"
                  >
                    📌 {site.lat.toFixed(4)}, {site.lng.toFixed(4)}
                    <span className="copy-hint">copy</span>
                  </button>

                  <div className="rec-spot-meta">
                    Gap: {site.distToCharger.toFixed(1)} km · {site.suggestedType}
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      <button
        className="export-btn"
        onClick={() => exportDistrictCSV(district, districtTop3, districtChargers)}
      >
        📋 Export this district CSV
      </button>
    </>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [districtData, setDistrictData] = useState(null);
  const [outerBorderData, setOuterBorderData] = useState(null);
  const [rawStations, setRawStations] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [mapMode, setMapMode] = useState(MAP_MODES.STATIONS);
  const [basemap, setBasemap] = useState(BASEMAPS.STREET);
  const [flyTarget, setFlyTarget] = useState(null);

  // District drill-down state
  const [selectedDistrict, setSelectedDistrict] = useState(null);
  const [showExisting, setShowExisting] = useState(true);
  const [showRecommended, setShowRecommended] = useState(true);

  const markerRefs = useRef([]);

  useEffect(() => {
    async function loadMapData() {
      try {
        const [dr, sr, or_] = await Promise.all([
          fetch(districtInfoDataUrl),
          fetch(evStationsDataUrl),
          fetch(outerBorderDataUrl),
        ]);
        if (!dr.ok || !sr.ok || !or_.ok)
          throw new Error('Failed to load district, station, or scope GeoJSON.');
        const [districtJson, stationJson, outerBorderJson] = await Promise.all([
          dr.json(), sr.json(), or_.json(),
        ]);
        setDistrictData(districtJson);
        setOuterBorderData(outerBorderJson);
        setRawStations(stationJson);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'Failed to load map data.');
      }
    }
    loadMapData();
  }, []);

  // Clear district selection when leaving recommendation mode
  useEffect(() => {
    if (mapMode !== MAP_MODES.RECOMMENDATION) setSelectedDistrict(null);
  }, [mapMode]);

  const stations       = useMemo(() => normalizeStations(rawStations), [rawStations]);
  const scoredDistricts = useMemo(() => computeDistrictScores(districtData, stations), [districtData, stations]);
  const top5           = useMemo(() => scoredDistricts.slice(0, 5), [scoredDistricts]);
  const exactSites     = useMemo(
    () => top5.length && stations.length ? computeExactSites(top5, stations) : [],
    [top5, stations]
  );

  // Per-district drill-down computations (only run when a district is selected)
  const districtTop3 = useMemo(
    () => selectedDistrict && stations.length ? computeTop3ForDistrict(selectedDistrict, stations) : [],
    [selectedDistrict, stations]
  );
  const districtChargers = useMemo(
    () => selectedDistrict
      ? stations.filter((s) => isPointInGeometry(s.lat, s.lng, selectedDistrict.feature.geometry))
      : [],
    [selectedDistrict, stations]
  );

  // Stable click handler so RecommendationDistrictLayer's Leaflet closures always call the current version
  const handleDistrictClick = useCallback((scoredDistrict) => {
    setSelectedDistrict(scoredDistrict);
    setShowExisting(true);
    setShowRecommended(true);
    try {
      const geoBounds = L.geoJSON(scoredDistrict.feature).getBounds();
      if (geoBounds.isValid()) {
        setFlyTarget({ bounds: geoBounds, _ts: Date.now() });
        return;
      }
    } catch (_) { /* fallback below */ }
    setFlyTarget({ latlng: scoredDistrict.centroid, zoom: 13, _ts: Date.now() });
  }, []);

  function handleSiteClick(site, i) {
    setFlyTarget({ latlng: [site.lat, site.lng], zoom: 15, popupIndex: i, _ts: Date.now() });
  }

  const isDistrictMode      = mapMode === MAP_MODES.DISTRICTS;
  const isStationMode       = mapMode === MAP_MODES.STATIONS;
  const isRecommendationMode = mapMode === MAP_MODES.RECOMMENDATION;
  const isStreetBasemap     = basemap === BASEMAPS.STREET;

  return (
    <main className="app-shell">
      <section className="map-frame">
        <header className={`map-intro${isRecommendationMode ? ' rec-mode' : ''}`}>

          <span className="eyebrow">EV deployment decision support</span>
          <h1>Bangkok metropolitan charging station planning tool</h1>

          {!isRecommendationMode && (
            <p>
              This map is designed to support charging station deployment decisions across Bangkok,
              nearby provinces, and selected surrounding districts. Use district mode to compare
              demand coverage and station mode to inspect the current charging network.
            </p>
          )}

          <p className="scope-note">
            Covered area: Bangkok, Pathum Thani, Samut Prakan, and Nonthaburi.
          </p>

          {/* ── Mode tabs ── */}
          <div className="mode-switch" role="tablist" aria-label="Map display mode">
            {[
              { mode: MAP_MODES.STATIONS,       label: 'Station mode' },
              { mode: MAP_MODES.DISTRICTS,      label: 'District mode' },
              { mode: MAP_MODES.RECOMMENDATION, label: 'Recommendation', extra: 'rec-tab' },
            ].map(({ mode, label, extra }) => {
              const active = mapMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`mode-button${active ? ' active' : ''}${extra ? ` ${extra}` : ''}`}
                  onClick={() => setMapMode(mode)}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* ── Basemap switch ── */}
          <div className="mode-switch basemap-switch" role="tablist" aria-label="Basemap style">
            <button
              type="button"
              className={isStreetBasemap ? 'mode-button active' : 'mode-button'}
              onClick={() => setBasemap(BASEMAPS.STREET)}
            >
              Street map
            </button>
            <button
              type="button"
              className={!isStreetBasemap ? 'mode-button active' : 'mode-button'}
              onClick={() => setBasemap(BASEMAPS.SATELLITE)}
            >
              Satellite
            </button>
          </div>

          {/* ── Status / legend ── */}
          {loadError && <p className="status-message error">{loadError}</p>}
          {!loadError && (!districtData || !stations.length) && (
            <p className="status-message">Loading district borders and EV stations...</p>
          )}
          {districtData && stations.length && !isRecommendationMode && (
            <p className="status-message">
              {formatInteger(districtData.features.length)} districts · {formatInteger(stations.length)} stations.{' '}
              {isStationMode ? 'Station mode: site review and network inspection.' : 'District mode: area comparison and coverage review.'}
            </p>
          )}

          {!isRecommendationMode && (
            <div className="legend">
              <span><i className="legend-swatch district-swatch" /> District coverage</span>
              <span><i className="legend-swatch station-swatch" /> Existing charging stations</span>
            </div>
          )}

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

          {/* ── Recommendation panel ── */}
          {isRecommendationMode && (
            <div className="rec-panel">
              {selectedDistrict ? (
                /* ── District drill-down view ── */
                <DistrictDetailPanel
                  district={selectedDistrict}
                  districtChargers={districtChargers}
                  districtTop3={districtTop3}
                  showExisting={showExisting}
                  showRecommended={showRecommended}
                  onToggleExisting={() => setShowExisting((v) => !v)}
                  onToggleRecommended={() => setShowRecommended((v) => !v)}
                  onBack={() => setSelectedDistrict(null)}
                  onSiteClick={handleSiteClick}
                />
              ) : (
                /* ── Global top-5 overview ── */
                <>
                  <h2 className="rec-panel-title">📍 Optimal Charging Sites</h2>
                  {exactSites.length === 0 ? (
                    <p className="status-message">Calculating optimal sites…</p>
                  ) : (
                    <>
                      <p className="status-message" style={{ marginBottom: 10 }}>
                        Click any district on the map for a per-district breakdown with top 3 spots.
                      </p>
                      <div className="site-cards">
                        {exactSites.map((site, i) => (
                          <div
                            key={`site-card-${i}`}
                            className="site-card"
                            role="button"
                            tabIndex={0}
                            onClick={() => handleSiteClick(site, i)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSiteClick(site, i)}
                          >
                            <div className="site-card-header">
                              <span className="site-card-rank">#{site.rank}</span>
                              <span className="site-card-name">{site.districtName}</span>
                              <span className={`site-card-type-badge${site.gapKm > 3 ? ' dc' : site.gapKm >= 1 ? ' ac2' : ' ac1'}`}>
                                {site.gapKm > 3 ? 'DC Fast' : site.gapKm >= 1 ? 'AC Type 2' : 'AC Top-up'}
                              </span>
                            </div>
                            <button
                              className="site-card-coords"
                              onClick={(e) => {
                                e.stopPropagation();
                                copyToClipboard(`${site.lat.toFixed(6)}, ${site.lng.toFixed(6)}`);
                              }}
                              title="Click to copy coordinates"
                            >
                              📍 {site.lat.toFixed(4)}, {site.lng.toFixed(4)}
                              <span className="copy-hint">copy</span>
                            </button>
                            <div className="site-card-stats">
                              <span>📏 {site.gapKm} km gap</span>
                              <span>👥 ~{site.populationEst.toLocaleString()}</span>
                            </div>
                            <div className="site-card-type">{site.suggestedType}</div>
                            <div className="site-card-landmark">{site.landmark}</div>
                          </div>
                        ))}
                      </div>
                      <button className="export-btn" onClick={() => exportSitesCSV(exactSites)}>
                        📋 Export Sites CSV
                      </button>
                    </>
                  )}

                  <details className="rec-formula">
                    <summary>How is this calculated?</summary>
                    <div className="rec-formula-body">
                      <p>Each district gets a <strong>Need Score</strong> (0–100) from:</p>
                      <ul>
                        <li><strong>Population (40%)</strong> — more residents = higher priority</li>
                        <li><strong>Coverage gap (40%)</strong> — fewer chargers per km² = higher priority</li>
                        <li><strong>Buffer zone (20%)</strong> — nearest existing charger &gt;1.5 km away</li>
                      </ul>
                      <p>
                        Click a district to drill down. The top-3 spots are found by sampling a 10×10 grid
                        inside the polygon and selecting the three most spread-out uncovered points
                        (≥ 500 m from any charger, ≥ 800 m apart).
                      </p>
                      <code>Spot score = (charger gap × 0.7) + (spread × 0.3)</code>
                    </div>
                  </details>
                </>
              )}
            </div>
          )}
        </header>

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
                : 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
            }
            url={
              isStreetBasemap
                ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
                : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
            }
          />

          {districtData && <InitializeMapBounds districts={districtData} stations={stations} />}
          <MapFlyController target={flyTarget} markerRefs={markerRefs} />

          <Pane name="districts" style={{ zIndex: 350 }}>
            {districtData && isDistrictMode && (
              <DistrictLayer districtData={districtData} isDistrictMode />
            )}
            {outerBorderData && isStationMode && (
              <GeoJSON
                data={outerBorderData}
                interactive={false}
                style={() => scopeBoundaryStyle(isStreetBasemap)}
              />
            )}
            {districtData && isRecommendationMode && (
              <RecommendationDistrictLayer
                districtData={districtData}
                scoredDistricts={scoredDistricts}
                onDistrictClick={handleDistrictClick}
              />
            )}
          </Pane>

          <Pane name="stations" style={{ zIndex: 450 }}>
            {isStationMode && <StationLayer isStreetBasemap={isStreetBasemap} stations={stations} />}
            {isDistrictMode && <PassiveStationLayer stations={stations} />}

            {/* Overview: top-5 global sites when no district is selected */}
            {isRecommendationMode && !selectedDistrict && exactSites.length > 0 && (
              <ExactSiteLayer exactSites={exactSites} markerRefs={markerRefs} />
            )}

            {/* Drill-down: existing chargers in the selected district */}
            {isRecommendationMode && selectedDistrict && showExisting && (
              <DistrictStationLayer stations={districtChargers} districtTop3={districtTop3} />
            )}

            {/* Drill-down: top-3 recommended spots in the selected district */}
            {isRecommendationMode && selectedDistrict && showRecommended && districtTop3.length > 0 && (
              <DistrictRecommendedLayer
                sites={districtTop3}
                districtName={selectedDistrict.name}
                markerRefs={markerRefs}
              />
            )}
          </Pane>
        </MapContainer>

        {isRecommendationMode && (
          <div className="need-score-legend">
            <p className="need-score-legend-title">Need score</p>
            <ul className="need-score-legend-list">
              {NEED_SCORE_LEGEND.map((item) => (
                <li key={item.label}>
                  <i className="need-score-legend-swatch" style={{ backgroundColor: item.color }} />
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
