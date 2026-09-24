// MapLibre 封装：全应用唯一 MapLibre 使用点（home 框选 / game 主地图 / result 回放）
// 注意：addSource/addLayer 必须等 map 'load' 事件，未就绪的图层操作走缓存，load 后统一应用
const BASE_TILE = 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png';
const SAT_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const EMPTY_GJ = { type: 'FeatureCollection', features: [] };

class MapView {
  constructor(map) {
    this.map = map;
    this.markers = new Map(); // id → maplibregl.Marker
    this.tapCb = null;
    this.userMarker = null;
    this._ready = false;
    this._polygonCache = null;
    this._linesCache = null;
    this._satelliteCache = null;
  }

  static create(container, { center = [110.284419, 25.238236], zoom = 16 } = {}) {
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

    const view = new MapView(map);
    const finish = () => {
      view._setupLayers();
      view._ready = true;
      if (view._polygonCache) view._applyPolygon(view._polygonCache);
      if (view._linesCache) view._applyLines(view._linesCache);
      if (view._satelliteCache !== null) view._applySatellite(view._satelliteCache);
    };
    if (map.loaded()) finish();
    else map.once('load', finish);

    map.on('click', e => {
      if (view.tapCb) view.tapCb({ latitude: e.lngLat.lat, longitude: e.lngLat.lng });
    });
    return view;
  }

  _setupLayers() {
    const map = this.map;
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
  }

  setMarkers(list) {
    // MapLibre Marker 是 DOM 标记，未 load 也可添加（下一帧自动定位）
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
      const sub = badge.querySelector('.mm-sub');
      if (sub) {
        // 有 sub 时 label 是 sub 前的文本节点，缺失则补建
        let labelNode = badge.childNodes[0];
        if (!labelNode || labelNode.nodeType !== 3) {
          labelNode = document.createTextNode('');
          badge.insertBefore(labelNode, sub);
        }
        if (labelNode.nodeValue !== (m.label || '')) labelNode.nodeValue = m.label || '';
        if (sub.textContent !== (m.sub || '')) sub.textContent = m.sub || '';
      } else if (badge.textContent !== (m.label || '')) {
        badge.textContent = m.label || '';
      }
    }
    const icon = el.querySelector('.mm-icon');
    if (icon && icon.textContent !== (m.icon || '')) icon.textContent = m.icon || '';
  }

  setPolygon(points) {
    const ring = points && points.length >= 3
      ? points.map(p => [p.longitude, p.latitude])
      : [];
    if (ring.length) ring.push(ring[0]); // 闭合
    this._polygonCache = {
      type: 'FeatureCollection',
      features: ring.length ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} }] : []
    };
    if (this._ready) this._applyPolygon(this._polygonCache);
  }

  _applyPolygon(gj) {
    const src = this.map.getSource('polygon-src');
    if (src) src.setData(gj);
  }

  setPolylines(lines) {
    const features = (lines || []).map(l => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: (l.points || []).map(p => [p.longitude, p.latitude]) },
      properties: { color: l.color || '#ffd700', width: l.width || 4 }
    }));
    this._linesCache = { type: 'FeatureCollection', features };
    if (this._ready) this._applyLines(this._linesCache);
  }

  _applyLines(fc) {
    const src = this.map.getSource('line-src');
    if (src) src.setData(fc);
  }

  setSatellite(on) {
    this._satelliteCache = !!on;
    if (this._ready) this._applySatellite(this._satelliteCache);
  }

  _applySatellite(on) {
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
