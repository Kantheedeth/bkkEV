import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
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
import outerBorderDataUrl from './assets/data/outerBorder.geojson?url';

const MAP_MODES = {
  DISTRICTS: 'districts',
  STATIONS: 'stations',
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

function formatInteger(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toLocaleString() : 'N/A';
}

function formatCoverage(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(2) : 'N/A';
}

function normalizeStations(rawData) {
  return (rawData?.features ?? [])
    .map((feature) => {
      const { Address, Google_Rating, Latitude, Longitude, Name, Total_Reviews } =
        feature.properties ?? {};
      const lat = Number(Latitude);
      const lng = Number(Longitude);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }

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

function InitializeMapBounds({ districts, stations }) {
  const map = useMap();
  const hasInitializedBounds = useRef(false);

  useEffect(() => {
    if (hasInitializedBounds.current || !districts || !stations.length) {
      return;
    }

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
      if (!isDistrictMode) {
        return;
      }
      layer.setStyle({
        color: '#081c15',
        weight: 2.4,
        fillOpacity: 0.5,
      });
      layer.bringToFront();
    },
    mouseout: () => {
      layer.setStyle(districtStyle(feature, isDistrictMode));
    },
    click: (event) => {
      if (isDistrictMode) {
        layer.openPopup(event.latlng);
      }
    },
  });
}

function DistrictLayer({ districtData, isDistrictMode }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());

  useMapEvents({
    zoomend: () => {
      setZoom(map.getZoom());
    },
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

function App() {
  const [districtData, setDistrictData] = useState(null);
  const [outerBorderData, setOuterBorderData] = useState(null);
  const [rawStations, setRawStations] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [mapMode, setMapMode] = useState(MAP_MODES.STATIONS);
  const [basemap, setBasemap] = useState(BASEMAPS.STREET);

  useEffect(() => {
    async function loadMapData() {
      try {
        const [districtResponse, stationResponse, outerBorderResponse] = await Promise.all([
          fetch(districtInfoDataUrl),
          fetch(evStationsDataUrl),
          fetch(outerBorderDataUrl),
        ]);

        if (!districtResponse.ok || !stationResponse.ok || !outerBorderResponse.ok) {
          throw new Error('Failed to load district, station, or scope GeoJSON.');
        }

        const [districtJson, stationJson, outerBorderJson] = await Promise.all([
          districtResponse.json(),
          stationResponse.json(),
          outerBorderResponse.json(),
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

  const stations = useMemo(() => normalizeStations(rawStations), [rawStations]);
  const isDistrictMode = mapMode === MAP_MODES.DISTRICTS;
  const isStationMode = mapMode === MAP_MODES.STATIONS;
  const isStreetBasemap = basemap === BASEMAPS.STREET;

  return (
    <main className="app-shell">
      <section className="map-frame">
        <header className="map-intro">
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
          <div className="mode-switch" role="tablist" aria-label="Map display mode">
            <button
              type="button"
              className={isStationMode ? 'mode-button active' : 'mode-button'}
              onClick={() => setMapMode(MAP_MODES.STATIONS)}
            >
              Station mode
            </button>
            <button
              type="button"
              className={isDistrictMode ? 'mode-button active' : 'mode-button'}
              onClick={() => setMapMode(MAP_MODES.DISTRICTS)}
            >
              District mode
            </button>
          </div>
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
          {loadError ? <p className="status-message error">{loadError}</p> : null}
          {!loadError && (!districtData || !stations.length) ? (
            <p className="status-message">Loading district borders and EV stations...</p>
          ) : null}
          {districtData && stations.length ? (
            <p className="status-message">
              {formatInteger(districtData.features.length)} districts in scope and{' '}
              {formatInteger(stations.length)} charging stations loaded.{' '}
              {isStationMode
                ? 'Station mode is for site review and network inspection.'
                : 'District mode is for area comparison and coverage review.'}
            </p>
          ) : null}
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
          {isDistrictMode ? (
            <div className="coverage-legend">
              <p className="coverage-legend-title">District coverage scale</p>
              <p className="coverage-legend-subtitle">Stations per 10,000 people</p>
              <ul className="coverage-legend-list">
                {DISTRICT_COVERAGE_LEGEND.map((item) => (
                  <li key={item.label}>
                    <i
                      className="coverage-legend-swatch"
                      style={{ backgroundColor: item.color }}
                    />
                    <span>{item.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
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
          {districtData ? <InitializeMapBounds districts={districtData} stations={stations} /> : null}
          <Pane name="districts" style={{ zIndex: 350 }}>
            {districtData && isDistrictMode ? (
              <DistrictLayer districtData={districtData} isDistrictMode={isDistrictMode} />
            ) : null}
            {outerBorderData && isStationMode ? (
              <GeoJSON
                data={outerBorderData}
                interactive={false}
                style={() => scopeBoundaryStyle(isStreetBasemap)}
              />
            ) : null}
          </Pane>
          <Pane name="stations" style={{ zIndex: 450 }}>
            {isStationMode ? (
              <StationLayer isStreetBasemap={isStreetBasemap} stations={stations} />
            ) : (
              <PassiveStationLayer stations={stations} />
            )}
          </Pane>
        </MapContainer>
      </section>
    </main>
  );
}

export default App;
