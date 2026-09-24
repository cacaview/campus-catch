// MapLibre 封装：全应用唯一 MapLibre 使用点（home 框选 / game 主地图 / result 回放）
const BASE_TILE = 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png';
const SAT_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const EMPTY_GJ = { type: 'FeatureCollection', features: [] };

class MapView {
  constructor(map, markerLayer) {
    this.map = map;
    this.markerLayer = markerLayer; // DOM 容器（绝对定位覆盖在 map 上）
    this.markers = new Map(); // id → maplibregl.Marker
    this.tapCb = null;
    this.userMarker = null;
  }

  static create(container, { center = [110.2955, 25.2286], zoom = 16 } = {}) {
    const ml = window.maplibregl;
    const map = new ml.Map({
      container,
      center,
      zoom,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false
    });
    map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-right');
    map.addSource('basemap', {
      type: 'raster',
      tiles: [BASE_TILE],
      tileSize: 256,
      attribution: '©OpenStreetMap contributors ©CARTO'
    });
    map.addLayer({ id: 'basemap-layer', type: 'raster', source: 'basemap' });
    map.addSource('satellite', {
      type: 'raster',
      tiles: [SAT_TILE],
      tileSize: 256,
      attribution: 'Esri, Maxar'
    });
    map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite' }, 'basemap-layer');
    map.getLayer('satellite-layer').setLayoutProperty('visibility', 'none');

    map.addSource('polygon-src', { type: 'geojson', data: EMPTY_GJ });
    map.addLayer({
      id: 'polygon-fill',
      type: 'fill',
      source: 'polygon-src',
      paint: { 'fill-color': '#ffd700', 'fill-opacity': 0.15 }
    });
    map.addLayer({
      id: 'polygon-line',
      type: 'line',
      source: 'polygon-src',
      paint: { 'line-color': '#ffd700', 'line-width': 3 }
    });
    map.addSource('line-src', { type: 'geojson', data: EMPTY_GJ });
    map.addLayer({
      id: 'line-layer',
      type: 'line',
      source: 'line-src',
      paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] }
    });

    // DOM 标记容器：随地图覆盖层定位（maplibre Marker 自带跟随）
    const markerLayer = document.createElement('div');
    markerLayer.className = 'map-marker-layer';
    container.appendChild(markerLayer);

    const view = new MapView(map, markerLayer);
    map.on('click', e => {
      if (view.tapCb) view.tapCb({ latitude: e.lngLat.lat, longitude: e.lngLat.lng });
    });
    return view;
  }

  setMarkers(list) {
    const seen = new Set();
    for (const m of list) {
      seen.add(m.id);
      let mk = this.markers.get(m.id);
      const el = mk ? mk.getElement() : this._makeMarkerEl(m);
      if (!mk) {
        mk = new window.maplibregl.Marker({ element: el, anchor: 'bottom' })
          .setLngLat([m.longitude, m.latitude])
          .addTo(this.map);
        this.markers.set(m.id, mk);
      } else {
        mk.setLngLat([m.longitude, m.latitude]);
        this._styleMarkerEl(el, m);
      }
    }
    for (const [id, mk] of this.markers) {
      if (!seen.has(id)) {
        mk.remove();
        this.markers.delete(id);
      }
    }
  }

  _makeMarkerEl(m) {
    const el = document.createElement('div');
    el.className = 'map-marker' + (m.self ? ' self' : '') + (m.highlight ? ' highlight' : '');
    const icon = document.createElement('span');
    icon.className = 'mm-icon';
    icon.textContent = m.icon || '';
    el.appendChild(icon);
    const badge = document.createElement('div');
    badge.className = 'mm-badge';
    badge.textContent = m.label || '';
    if (m.sub) {
      const sub = document.createElement('span');
      sub.className = 'mm-sub';
      sub.textContent = m.sub;
      badge.appendChild(sub);
    }
    el.appendChild(badge);
    this._styleMarkerEl(el, m);
    return el;
  }

  _styleMarkerEl(el, m) {
    el.style.setProperty('--mm-color', m.color || (m.self ? '#33ccff' : '#ff3366'));
    el.classList.toggle('highlight', !!m.highlight);
    const badge = el.querySelector('.mm-badge');
    if (badge) {
      badge.childNodes[0].nodeValue = m.label || '';
      const sub = badge.querySelector('.mm-sub');
      if (sub) sub.textContent = m.sub || '';
    }
    const icon = el.querySelector('.mm-icon');
    if (icon) icon.textContent = m.icon || '';
  }

  setPolygon(points) {
    const ring = points && points.length >= 3
      ? points.map(p => [p.longitude, p.latitude])
      : [];
    if (ring.length) ring.push(ring[0]); // 闭合
    const gj = {
      type: 'FeatureCollection',
      features: ring.length ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} }] : []
    };
    this.map.getSource('polygon-src').setData(gj);
  }

  setPolylines(lines) {
    const features = (lines || []).map(l => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: (l.points || []).map(p => [p.longitude, p.latitude]) },
      properties: { color: l.color || '#ffd700', width: l.width || 4 }
    }));
    this.map.getSource('line-src').setData({ type: 'FeatureCollection', features });
  }

  setSatellite(on) {
    this.map.setLayoutProperty('satellite-layer', 'visibility', on ? 'visible' : 'none');
    this.map.setLayoutProperty('basemap-layer', 'visibility', on ? 'none' : 'visible');
  }

  fitBounds(points, pad = 40) {
    if (!points || points.length < 2) return;
    const b = new window.maplibregl.LngLatBounds();
    points.forEach(p => b.extend([p.longitude, p.latitude]));
    this.map.fitBounds(b, { padding: pad, duration: 0, maxZoom: 17 });
  }

  moveTo(latitude, longitude) {
    this.map.flyTo({ center: [longitude, latitude], zoom: this.map.getZoom(), duration: 800 });
  }

  setCenter(latitude, longitude, zoom) {
    if (zoom !== undefined) this.map.jumpTo({ center: [longitude, latitude], zoom });
    else this.map.jumpTo({ center: [longitude, latitude] });
  }

  getCenter() {
    const c = this.map.getCenter();
    return { latitude: c.lat, longitude: c.lng };
  }

  onTap(cb) { this.tapCb = cb; }

  setUserLocation(latitude, longitude) {
    if (!this.userMarker) {
      const el = document.createElement('div');
      el.className = 'map-user-dot';
      this.userMarker = new window.maplibregl.Marker({ element: el, anchor: 'center' }).addTo(this.map);
    }
    this.userMarker.setLngLat([longitude, latitude]);
  }

  destroy() {
    for (const mk of this.markers.values()) mk.remove();
    this.markers.clear();
    this.map.remove();
  }
}

export function createMap(container, opts) {
  return MapView.create(container, opts);
}
