import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import {
  Circle,
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  Pane,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';
import districtInfoDataUrl from './assets/data/districtInfo.geojson?url';
import evStationsDataUrl from './assets/data/evStations.geojson?url';

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
const BUFFER_RADIUS_KM = 3;
const PLANNER_MIN_SPACING_KM = 0.5;
const COVERAGE_SAMPLE_GRID = 5;

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatInteger(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toLocaleString() : 'N/A';
}

function formatCoverage(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(2) : 'N/A';
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

function pointInRing(latlng, ring) {
  let inside = false;
  const { lat, lng } = latlng;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [lngI, latI] = ring[i];
    const [lngJ, latJ] = ring[j];
    const intersects =
      latI > lat !== latJ > lat &&
      lng < ((lngJ - lngI) * (lat - latI)) / ((latJ - latI) || Number.EPSILON) + lngI;

    if (intersects) inside = !inside;
  }

  return inside;
}

function pointInGeometry(latlng, geometry) {
  if (!geometry) return false;

  if (geometry.type === 'Polygon') {
    const [outerRing, ...holes] = geometry.coordinates;
    if (!pointInRing(latlng, outerRing)) return false;
    return !holes.some((ring) => pointInRing(latlng, ring));
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some(([outerRing, ...holes]) => {
      if (!pointInRing(latlng, outerRing)) return false;
      return !holes.some((ring) => pointInRing(latlng, ring));
    });
  }

  return false;
}

function isPointInDistrictScope(latlng, districtData) {
  return (districtData?.features ?? []).some((feature) => pointInGeometry(latlng, feature.geometry));
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

// ─── Recommendation scoring ───────────────────────────────────────────────────

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

function getStrongestNeedDriver(district) {
  const drivers = [
    {
      score: district.popScore,
      label: 'Large population',
      description: 'Population pressure is the strongest reason for adding chargers here.',
    },
    {
      score: district.serviceScore,
      label: 'Low charger service',
      description: 'This district has fewer chargers per 10,000 people than most areas in scope.',
    },
    {
      score: district.bufferScore,
      label: 'Far from existing stations',
      description: 'The nearest existing charger is relatively far from this district.',
    },
  ];

  return drivers.sort((a, b) => b.score - a.score)[0];
}

function formatDistanceKm(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} km` : 'N/A';
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

function geometryBounds(geometry) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  const visit = (coords) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const [lng, lat] = coords;
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      return;
    }
    coords.forEach(visit);
  };

  visit(geometry?.coordinates);

  if (![minLat, maxLat, minLng, maxLng].every(Number.isFinite)) return null;
  return { minLat, maxLat, minLng, maxLng };
}

function findNearestStation(point, stations) {
  let nearestStation = null;
  let minDistance = Infinity;

  for (const station of stations) {
    const distance = haversineKm(point[0], point[1], station.lat, station.lng);
    if (distance < minDistance) {
      minDistance = distance;
      nearestStation = station;
    }
  }

  if (!nearestStation) {
    return {
      distanceKm: 999,
      station: null,
    };
  }

  return {
    distanceKm: minDistance,
    station: nearestStation,
  };
}

function computeCentroid(geometry) {
  let latSum = 0, lngSum = 0, count = 0;
  const processRing = (ring) => {
    for (const [lng, lat] of ring) { latSum += lat; lngSum += lng; count++; }
  };
  if (geometry.type === 'Polygon') {
    processRing(geometry.coordinates[0]);
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) processRing(poly[0]);
  }
  return count > 0 ? [latSum / count, lngSum / count] : [13.75, 100.5];
}

function computeDistrictScores(districtData, stations) {
  if (!districtData || !districtData.features?.length || !stations.length) return [];

  const raw = districtData.features.map((feature) => {
    const props = feature.properties;
    const population = Number(props.final_population_english_Population) || 0;
    const stationsInDistrict = stations.filter((station) =>
      pointInGeometry({ lat: station.lat, lng: station.lng }, feature.geometry)
    );
    const noOfCounted = stationsInDistrict.length;
    const centroid = computeCentroid(feature.geometry);
    const nearestStationResult = findNearestStation(centroid, stations);
    
    // FIX 1: The km² Trap is removed. 
    // Now calculating "Chargers per 10,000 people" to measure actual human demand
    const chargersPer10k = population > 0 ? (noOfCounted / population) * 10000 : 0;

    return {
      feature,
      name: getDistrictName(props),
      population,
      noOfCounted,
      centroid,
      nearestStation: nearestStationResult.station,
      nearestStationKm: nearestStationResult.distanceKm,
      chargersPer10k,
    };
  });

  const maxPop = Math.max(...raw.map((d) => d.population));
  const minPop = Math.min(...raw.map((d) => d.population));
  // We now find the maximum Service Ratio instead of Maximum Density
  const maxService = Math.max(...raw.map((d) => d.chargersPer10k));

  return raw
    .map((d) => {
      // 1. Demand Score (0-100) -> Higher population gets higher priority score
      const popScore =
        maxPop > minPop ? ((d.population - minPop) / (maxPop - minPop)) * 100 : 50;
        
      // 2. Service Score (0-100) -> Fewer chargers per 10k gets higher priority score
      const serviceScore =
        maxService > 0 ? (1 - d.chargersPer10k / maxService) * 100 : 100;
        
      // 3. Buffer Score (0-100) from district center to nearest existing station
      const nearestDist = d.nearestStationKm;
      const bufferScore =
        nearestDist >= BUFFER_RADIUS_KM ? 100 : (nearestDist / BUFFER_RADIUS_KM) * 100;
      
      // FIX 3: The 30/40/30 Weights
      // 30% Population Demand, 40% Accessibility/Buffer, 30% Service Ratio
      const needScore = Math.min(
        100,
        Math.round(popScore * 0.3 + serviceScore * 0.3 + bufferScore * 0.4)
      );
      
      return {
        ...d,
        popScore: Math.round(popScore),
        serviceScore: Math.round(serviceScore), // Renamed from coverageScore
        bufferScore: Math.round(bufferScore),
        needScore,
      };
    })
    .sort((a, b) => b.needScore - a.needScore);
}

function buildCoverageSamplePoints(districtData) {
  if (!districtData) return [];

  return districtData.features.flatMap((feature) => {
    const bounds = geometryBounds(feature.geometry);
    if (!bounds) return [];

    const latSpan = bounds.maxLat - bounds.minLat;
    const lngSpan = bounds.maxLng - bounds.minLng;
    const latStep = latSpan / COVERAGE_SAMPLE_GRID;
    const lngStep = lngSpan / COVERAGE_SAMPLE_GRID;
    const districtId = feature.properties?.fid;
    const samples = [];

    for (let row = 0; row < COVERAGE_SAMPLE_GRID; row += 1) {
      for (let col = 0; col < COVERAGE_SAMPLE_GRID; col += 1) {
        const lat = bounds.minLat + (row + 0.5) * (latStep || 0.01);
        const lng = bounds.minLng + (col + 0.5) * (lngStep || 0.01);
        const point = { lat, lng };
        if (pointInGeometry(point, feature.geometry)) {
          samples.push({ ...point, districtId });
        }
      }
    }

    if (samples.length > 0) return samples;

    const centroid = computeCentroid(feature.geometry);
    return [{ lat: centroid[0], lng: centroid[1], districtId }];
  });
}

function computeCoveragePercent(samplePoints, stations) {
  if (!samplePoints.length) return 0;

  let coveredCount = 0;
  for (const point of samplePoints) {
    const isCovered = stations.some(
      (station) => haversineKm(point.lat, point.lng, station.lat, station.lng) <= BUFFER_RADIUS_KM
    );
    if (isCovered) coveredCount += 1;
  }

  return (coveredCount / samplePoints.length) * 100;
}

function getPlannerVerdictColor(verdict) {
  if (verdict === 'Suitable') return '#16a34a';
  if (verdict === 'Maybe') return '#f59e0b';
  return '#dc2626';
}

function evaluatePlannerPlacement({
  district,
  latlng,
  existingStations,
  plannedStations,
  coverageSamples,
}) {
  const point = [latlng.lat, latlng.lng];
  const existingNearest = findNearestStation(point, existingStations);
  const networkBefore = [...existingStations, ...plannedStations];
  const nearestNetwork = findNearestStation(point, networkBefore);
  const districtSamples = coverageSamples.filter(
    (sample) => sample.districtId === district.feature.properties.fid
  );
  const coverageBefore = computeCoveragePercent(coverageSamples, networkBefore);
  const districtCoverageBefore = computeCoveragePercent(districtSamples, networkBefore);
  const candidateStation = {
    id: `planned-${Date.now()}-${Math.round(latlng.lat * 10000)}-${Math.round(latlng.lng * 10000)}`,
    lat: latlng.lat,
    lng: latlng.lng,
    name: `Planned charger ${plannedStations.length + 1}`,
    address: district.name,
  };
  const networkAfter = [...networkBefore, candidateStation];
  const coverageAfter = computeCoveragePercent(coverageSamples, networkAfter);
  const districtCoverageAfter = computeCoveragePercent(districtSamples, networkAfter);
  const coverageGain = coverageAfter - coverageBefore;
  const districtCoverageGain = districtCoverageAfter - districtCoverageBefore;
  const spacingScore = Math.min(nearestNetwork.distanceKm / BUFFER_RADIUS_KM, 1) * 45;
  const districtGainScore = Math.min(districtCoverageGain / 10, 1) * 35;
  const needScoreBoost = (district.needScore / 100) * 20;
  const suitabilityScore = Math.round(spacingScore + districtGainScore + needScoreBoost);

  let verdict = 'Not suitable';
  let reason = 'This point adds limited new coverage compared with the current network.';

  if (nearestNetwork.distanceKm < PLANNER_MIN_SPACING_KM) {
    verdict = 'Not suitable';
    reason = 'Too close to an existing or already planned charger.';
  } else if (districtCoverageGain >= 6 || coverageGain >= 0.8 || nearestNetwork.distanceKm >= 2) {
    verdict = 'Suitable';
    reason = 'Strong spacing and clear coverage gain for the selected district.';
  } else if (districtCoverageGain >= 2 || coverageGain >= 0.2) {
    verdict = 'Maybe';
    reason = 'The point helps, but the gain is moderate rather than decisive.';
  }

  return {
    ...candidateStation,
    verdict,
    reason,
    suitabilityScore,
    coverageBefore,
    coverageAfter,
    coverageGain,
    districtCoverageBefore,
    districtCoverageAfter,
    districtCoverageGain,
    nearestExistingKm: existingNearest.distanceKm,
    nearestExistingName: existingNearest.station?.name ?? 'N/A',
    nearestNetworkKm: nearestNetwork.distanceKm,
    districtId: district.feature.properties.fid,
    districtName: district.name,
  };
}

function createPulsingIcon(rank) {
  return L.divIcon({
    className: 'pulsing-pin-wrapper',
    html: `<div class="pulsing-pin"><span class="pulsing-pin-rank">#${rank}</span></div>`,
    iconAnchor: [20, 20],
    iconSize: [40, 40],
    popupAnchor: [0, -64],
  });
}


// ─── Map sub-components ───────────────────────────────────────────────────────

function InitializeMapBounds({ districts, stations }) {
  const map = useMap();
  const hasInitializedBounds = useRef(false);

  useEffect(() => {
    if (hasInitializedBounds.current || !districts || !stations.length) return;

    const bounds = L.latLngBounds([]);
    bounds.extend(L.geoJSON(districts).getBounds());
    bounds.extend(stations.map((station) => [station.lat, station.lng]));

    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.06));
      map.setMaxBounds(bounds.pad(0.2));
      hasInitializedBounds.current = true;
    }
  }, [districts, map, stations]);

  return null;
}

function MapFlyController({ target, markerRefs }) {
  const map = useMap();

  useEffect(() => {
    if (!target) return;
    if (target.bounds) {
      map.flyToBounds(target.bounds, { duration: 1.0, padding: [36, 36] });
    } else {
      map.flyTo(target.latlng, target.zoom ?? 13, { duration: 1.0 });
    }

    if (target.popupIndex !== undefined) {
      const onMoveEnd = () => {
        const marker = markerRefs.current[target.popupIndex];
        if (marker) marker.openPopup();
        map.off('moveend', onMoveEnd);
      };
      map.on('moveend', onMoveEnd);
      return () => map.off('moveend', onMoveEnd);
    }
  }, [map, target, markerRefs]);

  return null;
}

function RecommendationResetController({ districtData, isEnabled, onReset }) {
  useMapEvents({
    click: (event) => {
      if (!isEnabled || !districtData) return;
      if (isPointInDistrictScope(event.latlng, districtData)) return;
      onReset();
    },
  });

  return null;
}

function PlannerClickController({
  coverageSamples,
  existingStations,
  isEnabled,
  onPlaceCandidate,
  plannedStations,
  selectedDistrict,
}) {
  useMapEvents({
    click: (event) => {
      if (!isEnabled || !selectedDistrict) return;
      if (!pointInGeometry(event.latlng, selectedDistrict.feature.geometry)) return;

      const plannedStation = evaluatePlannerPlacement({
        district: selectedDistrict,
        latlng: event.latlng,
        existingStations,
        plannedStations,
        coverageSamples,
      });

      onPlaceCandidate(plannedStation);
    },
  });

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
        <div>
          <dt>Province</dt>
          <dd>${getProvinceName(properties)}</dd>
        </div>
        <div>
          <dt>Population</dt>
          <dd>${formatInteger(properties.final_population_english_Population)}</dd>
        </div>
        <div>
          <dt>Counted EV stations</dt>
          <dd>${formatInteger(properties.noOfCounted)}</dd>
        </div>
        <div>
          <dt>Stations per 10,000 people</dt>
          <dd>${formatCoverage(properties.coverage)}</dd>
        </div>
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
    mouseout: () => {
      layer.setStyle(districtStyle(feature, isDistrictMode));
    },
    click: (event) => {
      if (isDistrictMode) layer.openPopup(event.latlng);
    },
  });
}

function DistrictLayer({ districtData, isDistrictMode }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());

  useMapEvents({
    zoomend: () => setZoom(map.getZoom()),
  });

  return (
    <GeoJSON
      key={`district-layer-${zoom}-${isDistrictMode ? 'interactive' : 'passive'}`}
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
            <div>
              <dt>Rating</dt>
              <dd>{station.rating ?? 'N/A'}</dd>
            </div>
            <div>
              <dt>Reviews</dt>
              <dd>{formatInteger(station.reviews)}</dd>
            </div>
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
      pathOptions={{
        color: '#fffaf0',
        fillColor: '#ee6c4d',
        fillOpacity: 0.95,
        opacity: 1,
        weight: 1,
      }}
      radius={4}
    />
  ));
}

function getRecommendationBounds(feature) {
  const bounds = L.geoJSON(feature).getBounds();
  return bounds.isValid() ? bounds : null;
}

function SelectedDistrictStationsLayer({ selectedDistrict, stations, isStreetBasemap }) {
  if (!selectedDistrict) return null;

  const districtStations = stations.filter((station) =>
    pointInGeometry({ lat: station.lat, lng: station.lng }, selectedDistrict.feature.geometry)
  );

  return districtStations.map((station) => (
    <CircleMarker
      key={`selected-district-station-${station.id}`}
      center={[station.lat, station.lng]}
      bubblingMouseEvents
      interactive
      pathOptions={{
        color: isStreetBasemap ? '#ffffff' : '#0f172a',
        fillColor: '#2563eb',
        fillOpacity: 0.95,
        opacity: 1,
        weight: isStreetBasemap ? 1.2 : 2,
      }}
      radius={isStreetBasemap ? 5 : 6}
    >
      <Popup>
        <div className="station-popup">
          <h3>{station.name}</h3>
          <p>{station.address}</p>
          <dl>
            <div>
              <dt>Rating</dt>
              <dd>{station.rating ?? 'N/A'}</dd>
            </div>
            <div>
              <dt>Reviews</dt>
              <dd>{formatInteger(station.reviews)}</dd>
            </div>
          </dl>
        </div>
      </Popup>
    </CircleMarker>
  ));
}

function RecommendationDistrictLayer({
  districtData,
  onSelectDistrict,
  scoredDistricts,
  selectedDistrictId,
}) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  const scoreMap = useMemo(() => {
    const m = new Map();
    for (const d of scoredDistricts) {
      m.set(d.feature.properties.fid, d.needScore);
    }
    return m;
  }, [scoredDistricts]);

  useMapEvents({
    zoomend: () => setZoom(map.getZoom()),
  });

  return (
    <GeoJSON
      key={`rec-districts-${zoom}`}
      data={districtData}
      interactive
      style={(feature) => {
        const score = scoreMap.get(feature.properties.fid) ?? 0;
        return {
          color: feature.properties.fid === selectedDistrictId ? '#7c2d12' : '#1f3c48',
          weight: feature.properties.fid === selectedDistrictId ? 2.8 : 1.2,
          fillColor: getNeedScoreColor(score),
          fillOpacity: feature.properties.fid === selectedDistrictId ? 0.78 : 0.6,
        };
      }}
      onEachFeature={(feature, layer) => {
        const district = scoredDistricts.find((item) => item.feature.properties.fid === feature.properties.fid);
        const score = scoreMap.get(feature.properties.fid) ?? 0;
        const name = getDistrictName(feature.properties);

        if (zoom >= DISTRICT_LABEL_MIN_ZOOM) {
          layer.bindTooltip(name, {
            className: getDistrictLabelClass(zoom),
            direction: 'center',
            sticky: true,
          });
        } else {
          layer.bindTooltip(name, {
            className: 'district-label district-label-small',
            sticky: true,
          });
        }
        layer.on({
          mouseover: () => {
            layer.setStyle({ weight: 2.4, fillOpacity: 0.8 });
            layer.bringToFront();
          },
          mouseout: () => {
            const s = scoreMap.get(feature.properties.fid) ?? 0;
            layer.setStyle({
              color: feature.properties.fid === selectedDistrictId ? '#7c2d12' : '#1f3c48',
              weight: feature.properties.fid === selectedDistrictId ? 2.8 : 1.2,
              fillColor: getNeedScoreColor(s),
              fillOpacity: feature.properties.fid === selectedDistrictId ? 0.78 : 0.6,
            });
          },
          click: () => {
            if (district) onSelectDistrict(district);
          },
        });
      }}
    />
  );
}

function RecommendedPinsLayer({ recommendations, markerRefs }) {
  const icons = useMemo(
    () => recommendations.map((_, i) => createPulsingIcon(i + 1)),
    [recommendations]
  );

  return recommendations.map((d, i) => (
    <Marker
      key={`rec-pin-${i}`}
      position={d.centroid}
      icon={icons[i]}
      ref={(el) => { markerRefs.current[i] = el; }}
    >
      <Tooltip direction="top" offset={[0, -18]} opacity={1}>
        <div className="rec-mini-popup">
          <strong>{d.name}</strong>
          <span>Gap: {formatDistanceKm(d.nearestStationKm)}</span>
        </div>
      </Tooltip>
    </Marker>
  ));
}

function PlannedStationsLayer({ plannedStations }) {
  return plannedStations.flatMap((station, index) => {
    const color = getPlannerVerdictColor(station.verdict);

    return [
      <Circle
        key={`planned-ring-${station.id}`}
        center={[station.lat, station.lng]}
        radius={BUFFER_RADIUS_KM * 1000}
        pathOptions={{
          color,
          weight: 1.2,
          fillColor: color,
          fillOpacity: 0.08,
          opacity: 0.65,
          dashArray: '6 6',
        }}
      />,
      <CircleMarker
        key={`planned-marker-${station.id}`}
        center={[station.lat, station.lng]}
        radius={8}
        bubblingMouseEvents
        interactive
        pathOptions={{
          color: '#ffffff',
          fillColor: color,
          fillOpacity: 0.96,
          opacity: 1,
          weight: 2,
        }}
      >
        <Popup>
          <div className="station-popup">
            <h3>Planned charger #{index + 1}</h3>
            <p>{station.districtName}</p>
            <dl>
              <div>
                <dt>Verdict</dt>
                <dd>{station.verdict}</dd>
              </div>
              <div>
                <dt>Suitability</dt>
                <dd>{station.suitabilityScore}/100</dd>
              </div>
              <div>
                <dt>Coverage gain</dt>
                <dd>{station.coverageGain.toFixed(2)} pts</dd>
              </div>
              <div>
                <dt>Nearest charger</dt>
                <dd>{formatDistanceKm(station.nearestNetworkKm)}</dd>
              </div>
            </dl>
          </div>
        </Popup>
      </CircleMarker>,
    ];
  });
}

function RecommendationDetailCard({ district }) {
  const strongestDriver = getStrongestNeedDriver(district);

  return (
    <aside className="rec-side-card rec-list-overlay" aria-label="Selected district details">
      <h3 className="rec-side-title">Selected district</h3>
      <div className="rec-detail-card">
        <div className="rec-detail-header">
          <div className="rec-title-block">
            <span className="rec-name">{district.name}</span>
            <span className="rec-subtitle">{getNeedLevel(district.needScore)} • {strongestDriver.label}</span>
          </div>
          <span
            className="rec-score-badge"
            style={{ backgroundColor: getNeedScoreColor(district.needScore) }}
          >
            {district.needScore}/100
          </span>
        </div>

        <div className="rec-bar-track">
          <div
            className="rec-bar-fill"
            style={{
              width: `${district.needScore}%`,
              backgroundColor: getNeedScoreColor(district.needScore),
            }}
          />
        </div>

        <dl className="rec-detail-list">
          <div>
            <dt>Main gap</dt>
            <dd>{formatDistanceKm(district.nearestStationKm)}</dd>
          </div>
          <div>
            <dt>Nearest station</dt>
            <dd>{district.nearestStation?.name ?? 'N/A'}</dd>
          </div>
          <div>
            <dt>Population</dt>
            <dd>{formatInteger(district.population)}</dd>
          </div>
          <div>
            <dt>Stations in network</dt>
            <dd>{formatInteger(district.noOfCounted)}</dd>
          </div>
          <div>
            <dt>Chargers / 10k</dt>
            <dd>{district.chargersPer10k.toFixed(2)}</dd>
          </div>
        </dl>

        <div className="rec-metrics rec-detail-metrics">
          <span className="rec-pill">Pop {district.popScore}</span>
          <span className="rec-pill">Service {district.serviceScore}</span>
          <span className="rec-pill">Buffer {district.bufferScore}</span>
        </div>

        <p className="rec-detail-hint">Click outside the study area to clear this district and return to the full list.</p>
      </div>
    </aside>
  );
}

function PlannerControlCard({
  district,
  networkCoverageAfter,
  networkCoverageBefore,
  onClearPlanner,
  onRemoveLastPlanned,
  plannedCount,
  plannedStations,
}) {
  const selectedDistrictPlans = plannedStations.filter(
    (station) => station.districtId === district.feature.properties.fid
  );
  const latestPlan = selectedDistrictPlans[selectedDistrictPlans.length - 1] ?? null;

  return (
    <aside className="rec-side-card rec-list-overlay" aria-label="Build your own network planner">
      <h3 className="rec-side-title">Build Your Own Network</h3>
      <div className="rec-detail-card">
        <p className="rec-info-text">
          Click anywhere inside <strong>{district.name}</strong> to place a planned charger. The app
          scores the point instantly and recalculates study-area coverage.
        </p>

        <div className="planner-summary-grid">
          <div className="planner-summary-tile">
            <span className="planner-summary-label">Current coverage</span>
            <strong>{networkCoverageAfter.toFixed(1)}%</strong>
            <span>
              {networkCoverageAfter >= networkCoverageBefore
                ? `+${(networkCoverageAfter - networkCoverageBefore).toFixed(1)} pts vs base`
                : 'No improvement yet'}
            </span>
          </div>
          <div className="planner-summary-tile">
            <span className="planner-summary-label">Planned chargers</span>
            <strong>{plannedCount}</strong>
            <span>{selectedDistrictPlans.length} in this district</span>
          </div>
        </div>

        {latestPlan ? (
          <div className="planner-eval-card">
            <div className="planner-eval-header">
              <span
                className="planner-verdict-badge"
                style={{ backgroundColor: getPlannerVerdictColor(latestPlan.verdict) }}
              >
                {latestPlan.verdict}
              </span>
              <strong>{latestPlan.suitabilityScore}/100</strong>
            </div>
            <p className="rec-info-text">{latestPlan.reason}</p>
            <dl className="rec-detail-list">
              <div>
                <dt>Coverage gain</dt>
                <dd>{latestPlan.coverageGain.toFixed(2)} pts</dd>
              </div>
              <div>
                <dt>District gain</dt>
                <dd>{latestPlan.districtCoverageGain.toFixed(2)} pts</dd>
              </div>
              <div>
                <dt>Nearest charger</dt>
                <dd>{formatDistanceKm(latestPlan.nearestNetworkKm)}</dd>
              </div>
              <div>
                <dt>Closest existing</dt>
                <dd>{formatDistanceKm(latestPlan.nearestExistingKm)}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="rec-side-empty">
            No planner point placed yet. Click inside the selected district to test a candidate site.
          </p>
        )}

        <div className="planner-actions">
          <button type="button" className="planner-button" onClick={onRemoveLastPlanned} disabled={!plannedCount}>
            Remove last pin
          </button>
          <button type="button" className="planner-button planner-button-strong" onClick={onClearPlanner} disabled={!plannedCount}>
            Clear planner
          </button>
        </div>
      </div>
    </aside>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [districtData, setDistrictData] = useState(null);
  const [rawStations, setRawStations] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [mapMode, setMapMode] = useState(MAP_MODES.STATIONS);
  const [basemap, setBasemap] = useState(BASEMAPS.STREET);
  const [selectedRecommendationId, setSelectedRecommendationId] = useState(null);
  const [flyTarget, setFlyTarget] = useState(null);
  const [plannedStations, setPlannedStations] = useState([]);
  const markerRefs = useRef([]);

  useEffect(() => {
    async function loadMapData() {
      try {
        const [districtResponse, stationResponse] = await Promise.all([
          fetch(districtInfoDataUrl),
          fetch(evStationsDataUrl),
        ]);

        if (!districtResponse.ok || !stationResponse.ok) {
          throw new Error('Failed to load district or station GeoJSON.');
        }

        const [districtJson, stationJson] = await Promise.all([
          districtResponse.json(),
          stationResponse.json(),
        ]);

        setDistrictData(districtJson);
        setRawStations(stationJson);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'Failed to load map data.');
      }
    }
    loadMapData();
  }, []);

  const stations = useMemo(() => normalizeStations(rawStations), [rawStations]);
  const coverageSamples = useMemo(() => buildCoverageSamplePoints(districtData), [districtData]);
  const plannedNetworkStations = useMemo(
    () => [...stations, ...plannedStations],
    [stations, plannedStations]
  );
  const scoredDistricts = useMemo(
    () => computeDistrictScores(districtData, plannedNetworkStations),
    [districtData, plannedNetworkStations]
  );
  const criticalRecommendations = useMemo(
    () => scoredDistricts.filter((district) => district.needScore >= 80),
    [scoredDistricts]
  );
  const criticalCount = useMemo(
    () => scoredDistricts.filter((district) => district.needScore >= 80).length,
    [scoredDistricts]
  );
  const baselineCoveragePercent = useMemo(
    () => computeCoveragePercent(coverageSamples, stations),
    [coverageSamples, stations]
  );
  const liveCoveragePercent = useMemo(
    () => computeCoveragePercent(coverageSamples, plannedNetworkStations),
    [coverageSamples, plannedNetworkStations]
  );
  const selectedRecommendation = useMemo(
    () =>
      selectedRecommendationId == null
        ? null
        : scoredDistricts.find((district) => district.feature.properties.fid === selectedRecommendationId) ?? null,
    [scoredDistricts, selectedRecommendationId]
  );

  const isDistrictMode = mapMode === MAP_MODES.DISTRICTS;
  const isStationMode = mapMode === MAP_MODES.STATIONS;
  const isRecommendationMode = mapMode === MAP_MODES.RECOMMENDATION;
  const isStreetBasemap = basemap === BASEMAPS.STREET;

  function handleRecommendationSelect(district) {
    const bounds = getRecommendationBounds(district.feature);
    setSelectedRecommendationId(district.feature.properties.fid);
    setFlyTarget({
      bounds,
      latlng: district.centroid,
      _ts: Date.now(),
    });
  }

  function handleRecommendationReset() {
    if (!districtData) return;
    setSelectedRecommendationId(null);
    setFlyTarget({
      bounds: L.geoJSON(districtData).getBounds().pad(0.06),
      _ts: Date.now(),
    });
  }

  function handleListItemClick(d) {
    handleRecommendationSelect(d);
  }

  function handlePlannerPlacement(plannedStation) {
    setPlannedStations((current) => [...current, plannedStation]);
  }

  function handleRemoveLastPlanned() {
    setPlannedStations((current) => current.slice(0, -1));
  }

  function handleClearPlanner() {
    setPlannedStations([]);
  }

  return (
    <main className="app-shell">
      <section className="map-frame">
        <header className={`map-intro${isRecommendationMode ? ' rec-mode' : ''}`}>

          {/* ── Always-visible header ── */}
          <span className="eyebrow">EV deployment decision support</span>
          <h1>Bangkok metropolitan charging station planning tool</h1>

          <p>
            This map is designed to support charging station deployment decisions across Bangkok,
            nearby provinces, and selected surrounding districts. Use district mode to compare
            demand coverage and station mode to inspect the current charging network.
          </p>

          <p className="scope-note">
            Covered area: Bangkok, Pathum Thani, Samut Prakan, and Nonthaburi.
          </p>

          {/* ── Mode tabs ── */}
          <div className="mode-switch" role="tablist" aria-label="Map display mode">
            <button
              type="button"
              role="tab"
              aria-selected={isStationMode}
              className={isStationMode ? 'mode-button active' : 'mode-button'}
              onClick={() => setMapMode(MAP_MODES.STATIONS)}
            >
              Station mode
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isDistrictMode}
              className={isDistrictMode ? 'mode-button active' : 'mode-button'}
              onClick={() => setMapMode(MAP_MODES.DISTRICTS)}
            >
              District mode
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isRecommendationMode}
              className={isRecommendationMode ? 'mode-button active rec-tab' : 'mode-button'}
              onClick={() => setMapMode(MAP_MODES.RECOMMENDATION)}
            >
              Recommendation
            </button>
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

          {/* ── Status messages ── */}
          {loadError ? <p className="status-message error">{loadError}</p> : null}
          {!loadError && (!districtData || !stations.length) ? (
            <p className="status-message">Loading district borders and EV stations...</p>
          ) : null}
          {districtData && stations.length && !isRecommendationMode ? (
            <p className="status-message">
              {formatInteger(districtData.features.length)} districts in scope and{' '}
              {formatInteger(stations.length)} charging stations loaded.{' '}
              {isStationMode
                ? 'Station mode is for site review and network inspection.'
                : 'District mode is for area comparison and coverage review.'}
            </p>
          ) : null}

          {/* ── Standard legend (station / district modes) ── */}
          {!isRecommendationMode && (
            <div className="legend">
              <span>
                <i className="legend-swatch district-swatch" />
                District coverage
              </span>
              <span>
                <i className="legend-swatch station-swatch" />
                Existing charging stations
              </span>
            </div>
          )}

          {/* ── District coverage scale ── */}
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
              <p className="rec-panel-kicker">Recommendation mode</p>
              <h2 className="rec-panel-title">Critical districts for new charging stations</h2>
              <p className="rec-panel-intro">
                The map shows need across all districts. The right-side cards focus only on
                critical districts.
              </p>
              <p className="rec-panel-intro">
                Click a district on the map or in the list to inspect its charger gap.
                Then click inside that district to place your own planned charger pins.
              </p>

              {scoredDistricts.length === 0 ? (
                <p className="status-message">Calculating scores…</p>
              ) : (
                <div className="rec-summary-strip">
                  <div className="rec-summary-chip rec-summary-chip-strong">
                    <span className="rec-summary-label">Critical districts</span>
                    <strong>{criticalCount}</strong>
                    <span>Need score 80+</span>
                  </div>
                  <div className="rec-summary-chip">
                    <span className="rec-summary-label">Shown on map</span>
                    <strong>{criticalRecommendations.length}</strong>
                    <span>All critical districts</span>
                  </div>
                  <div className="rec-summary-chip">
                    <span className="rec-summary-label">Coverage now</span>
                    <strong>{liveCoveragePercent.toFixed(1)}%</strong>
                    <span>
                      {plannedStations.length
                        ? `+${(liveCoveragePercent - baselineCoveragePercent).toFixed(1)} pts`
                        : 'Existing network only'}
                    </span>
                  </div>
                  <div className="rec-summary-chip">
                    <span className="rec-summary-label">Planner pins</span>
                    <strong>{plannedStations.length}</strong>
                    <span>User-placed test sites</span>
                  </div>
                </div>
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

          {districtData ? (
            <InitializeMapBounds districts={districtData} stations={stations} />
          ) : null}

          <MapFlyController target={flyTarget} markerRefs={markerRefs} />
          <RecommendationResetController
            districtData={districtData}
            isEnabled={isRecommendationMode}
            onReset={handleRecommendationReset}
          />
          <PlannerClickController
            coverageSamples={coverageSamples}
            existingStations={stations}
            isEnabled={isRecommendationMode}
            onPlaceCandidate={handlePlannerPlacement}
            plannedStations={plannedStations}
            selectedDistrict={selectedRecommendation}
          />

          <Pane name="districts" style={{ zIndex: 350 }}>
            {districtData && isDistrictMode && (
              <DistrictLayer districtData={districtData} isDistrictMode={isDistrictMode} />
            )}
            {districtData && isStationMode && (
              <GeoJSON
                data={districtData}
                interactive={false}
                style={() => scopeBoundaryStyle(isStreetBasemap)}
              />
            )}
            {districtData && isRecommendationMode && (
              <RecommendationDistrictLayer
                districtData={districtData}
                onSelectDistrict={handleRecommendationSelect}
                scoredDistricts={scoredDistricts}
                selectedDistrictId={selectedRecommendation?.feature.properties.fid}
              />
            )}
          </Pane>

          <Pane name="stations" style={{ zIndex: 450 }}>
            {isStationMode && (
              <StationLayer isStreetBasemap={isStreetBasemap} stations={stations} />
            )}
            {isDistrictMode && <PassiveStationLayer stations={stations} />}
            {isRecommendationMode && (
              <>
                {selectedRecommendation ? (
                  <SelectedDistrictStationsLayer
                    isStreetBasemap={isStreetBasemap}
                    selectedDistrict={selectedRecommendation}
                    stations={stations}
                  />
                ) : (
                  <RecommendedPinsLayer
                    recommendations={criticalRecommendations}
                    markerRefs={markerRefs}
                  />
                )}
                <PlannedStationsLayer plannedStations={plannedStations} />
              </>
            )}
          </Pane>
        </MapContainer>

        {isRecommendationMode && (
          <div className="rec-overlay-stack">
            <aside className="rec-info-box rec-info-overlay" aria-label="How recommendation rating works">
              <div className="rec-info-section">
                <h3 className="rec-info-title">How rating works</h3>
                <p className="rec-info-text">
                  Each district receives a <strong>Need Score</strong> from 0 to 100. Higher scores
                  indicate districts that are more likely to need additional charging stations.
                </p>
                <ul className="rec-info-list">
                  <li><strong>Population (30%)</strong>: more residents increase priority.</li>
                  <li><strong>Service gap (30%)</strong>: fewer chargers per 10,000 people increase priority.</li>
                  <li><strong>Buffer zone (40%)</strong>: districts farther than 3 km from the nearest station rank higher.</li>
                </ul>
                <code className="rec-info-code">
                  Need Score = (Population x 0.3) + (Service x 0.3) + (Buffer x 0.4)
                </code>
              </div>

              <div className="rec-info-section">
                <h3 className="rec-info-title">Planner logic</h3>
                <ul className="rec-info-list">
                  <li><strong>Suitable</strong>: the point creates a clear spacing gap and increases coverage.</li>
                  <li><strong>Maybe</strong>: the point helps, but the improvement is moderate.</li>
                  <li><strong>Not suitable</strong>: the point is too close to an existing or planned charger.</li>
                </ul>
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

            {selectedRecommendation ? (
              <>
                <RecommendationDetailCard district={selectedRecommendation} />
                <PlannerControlCard
                  district={selectedRecommendation}
                  networkCoverageAfter={liveCoveragePercent}
                  networkCoverageBefore={baselineCoveragePercent}
                  onClearPlanner={handleClearPlanner}
                  onRemoveLastPlanned={handleRemoveLastPlanned}
                  plannedCount={plannedStations.length}
                  plannedStations={plannedStations}
                />
              </>
            ) : (
              <aside className="rec-side-card rec-list-overlay" aria-label="Critical district list">
                <h3 className="rec-side-title">Critical districts</h3>
                {criticalRecommendations.length === 0 ? (
                  <p className="rec-side-empty">No districts are currently in the critical range.</p>
                ) : (
                  <div className="rec-list-scroll">
                    <ol className="rec-list">
                    {criticalRecommendations.map((d, i) => {
                      const strongestDriver = getStrongestNeedDriver(d);
                      return (
                        <li
                          key={d.feature.properties.fid}
                          className="rec-item"
                          role="button"
                          tabIndex={0}
                          onClick={() => handleListItemClick(d)}
                          onKeyDown={(e) => e.key === 'Enter' && handleListItemClick(d)}
                        >
                          <div className="rec-item-header">
                            <span className="rec-rank">#{i + 1}</span>
                            <div className="rec-title-block">
                              <span className="rec-name">{d.name}</span>
                              <span className="rec-subtitle">
                                {getNeedLevel(d.needScore)} • {strongestDriver.label}
                              </span>
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
                              style={{
                                width: `${d.needScore}%`,
                                backgroundColor: getNeedScoreColor(d.needScore),
                              }}
                            />
                          </div>
                          <div className="rec-metrics">
                            <span className="rec-pill">Pop {d.popScore}</span>
                            <span className="rec-pill">Service {d.serviceScore}</span>
                            <span className="rec-pill">Buffer {d.bufferScore}</span>
                            <span className="rec-pill">{formatDistanceKm(d.nearestStationKm)} away</span>
                            <span className="rec-action-hint">View on map</span>
                          </div>
                        </li>
                      );
                    })}
                    </ol>
                  </div>
                )}
              </aside>
            )}
          </div>
        )}

      </section>
    </main>
  );
}

export default App;
