import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  Pane,
  Popup,
  TileLayer,
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
      score: district.coverageScore,
      label: 'Low charger coverage',
      description: 'This district has fewer chargers per km² than most areas in scope.',
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
        nearestStationKm: nearestDist,
        needScore,
      };
    })
    .sort((a, b) => b.needScore - a.needScore);
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
    map.flyTo(target.latlng, target.zoom ?? 13, { duration: 1.0 });

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

function RecommendationDistrictLayer({ districtData, scoredDistricts }) {
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
          color: '#1f3c48',
          weight: 1.2,
          fillColor: getNeedScoreColor(score),
          fillOpacity: 0.6,
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
            permanent: true,
          });
        } else {
          layer.bindTooltip(`${name} • ${getNeedLevel(score)} (${score}/100)`, {
            className: 'district-label district-label-small',
            sticky: true,
          });
        }

        if (district) {
          const strongestDriver = getStrongestNeedDriver(district);
          layer.bindPopup(`
            <div class="district-popup">
              <h3>${name}</h3>
              <p>${getNeedLevel(score)} for additional charging stations</p>
              <dl>
                <div><dt>Need score</dt><dd>${district.needScore}/100</dd></div>
                <div><dt>Main reason</dt><dd>${strongestDriver.label}</dd></div>
                <div><dt>Nearest station</dt><dd>${formatDistanceKm(district.nearestStationKm)}</dd></div>
                <div><dt>Existing stations</dt><dd>${formatInteger(district.noOfCounted)}</dd></div>
              </dl>
            </div>
          `);
        }
        layer.on({
          mouseover: () => {
            layer.setStyle({ weight: 2.4, fillOpacity: 0.8 });
            layer.bringToFront();
          },
          mouseout: () => {
            const s = scoreMap.get(feature.properties.fid) ?? 0;
            layer.setStyle({
              color: '#1f3c48',
              weight: 1.2,
              fillColor: getNeedScoreColor(s),
              fillOpacity: 0.6,
            });
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
      <Popup offset={[0, -56]}>
        <div className="station-popup">
          <h3>Recommended #{i + 1}</h3>
          <p>
            {d.name}
            <br />
            {getNeedLevel(d.needScore)}
          </p>
          <dl>
            <div><dt>Need score</dt><dd>{d.needScore}/100</dd></div>
            <div><dt>Main reason</dt><dd>{getStrongestNeedDriver(d).label}</dd></div>
            <div><dt>Population</dt><dd>{d.population.toLocaleString()}</dd></div>
            <div><dt>Existing stations</dt><dd>{d.noOfCounted}</dd></div>
            <div><dt>Nearest station</dt><dd>{formatDistanceKm(d.nearestStationKm)}</dd></div>
            <div><dt>Area</dt><dd>{d.areaKm2.toFixed(1)} km²</dd></div>
          </dl>
        </div>
      </Popup>
    </Marker>
  ));
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [districtData, setDistrictData] = useState(null);
  const [rawStations, setRawStations] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [mapMode, setMapMode] = useState(MAP_MODES.STATIONS);
  const [basemap, setBasemap] = useState(BASEMAPS.STREET);
  const [flyTarget, setFlyTarget] = useState(null);
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
  const scoredDistricts = useMemo(
    () => computeDistrictScores(districtData, stations),
    [districtData, stations]
  );
  const criticalRecommendations = useMemo(
    () => scoredDistricts.filter((district) => district.needScore >= 80),
    [scoredDistricts]
  );
  const criticalCount = useMemo(
    () => scoredDistricts.filter((district) => district.needScore >= 80).length,
    [scoredDistricts]
  );

  const isDistrictMode = mapMode === MAP_MODES.DISTRICTS;
  const isStationMode = mapMode === MAP_MODES.STATIONS;
  const isRecommendationMode = mapMode === MAP_MODES.RECOMMENDATION;
  const isStreetBasemap = basemap === BASEMAPS.STREET;

  function handleListItemClick(d, i) {
    setFlyTarget({ latlng: d.centroid, zoom: 13, popupIndex: i, _ts: Date.now() });
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
                scoredDistricts={scoredDistricts}
              />
            )}
          </Pane>

          <Pane name="stations" style={{ zIndex: 450 }}>
            {isStationMode && (
              <StationLayer isStreetBasemap={isStreetBasemap} stations={stations} />
            )}
            {isDistrictMode && <PassiveStationLayer stations={stations} />}
            {isRecommendationMode && (
              <RecommendedPinsLayer
                recommendations={criticalRecommendations}
                markerRefs={markerRefs}
              />
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
                  <li><strong>Population (40%)</strong>: more residents increase priority.</li>
                  <li><strong>Coverage gap (40%)</strong>: fewer chargers per km² increase priority.</li>
                  <li><strong>Buffer zone (20%)</strong>: districts farther than 1.5 km from the nearest station rank higher.</li>
                </ul>
                <code className="rec-info-code">
                  Need Score = (Population x 0.4) + (Coverage x 0.4) + (Buffer x 0.2)
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
                        onClick={() => handleListItemClick(d, i)}
                        onKeyDown={(e) => e.key === 'Enter' && handleListItemClick(d, i)}
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
                          <span className="rec-pill">Coverage {d.coverageScore}</span>
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
          </div>
        )}

      </section>
    </main>
  );
}

export default App;
