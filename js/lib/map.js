// MapLibre 封装：全应用唯一 MapLibre 使用点（home 框选 / game 主地图 / result 回放）
// 注意：addSource/addLayer 必须等 map 'load' 事件，未就绪的图层操作走缓存，load 后统一应用
// 校园图片范围沿用小程序地图图层边界（GCJ-02），转换为 WGS-84 后用于 MapLibre。
// 默认在 Esri 卫星底图上叠加本地校园图；游戏中可切换到纯卫星图。
import { gcj02ToWgs84, miniProgramGroundOverlayToMapLibre } from '../utils/map-coordinates.js';
const SAT_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const CAMPUS_MAP_URL = new URL('../../assets/campus-map.jpg', import.meta.url).href;
const CAMPUS_GROUND_OVERLAY = {
  src: CAMPUS_MAP_URL,
  opacity: 0.8,
  bounds: {
    southwest: { longitude: 110.273850, latitude: 25.088910 },
    northeast: { longitude: 110.281229, latitude: 25.098995 }
  }
};
// 小程序 mapInfo.boundary uses GCJ-02. MapLibre and its raster tiles use WGS-84.
const CAMPUS_MAP_BOUNDARY = {
  southwest: { longitude: 110.272618, latitude: 25.088083 },
  northeast: { longitude: 110.281911, latitude: 25.099580 }
};
const CAMPUS_MAP_MAX_BOUNDS = [
  gcj02ToWgs84(CAMPUS_MAP_BOUNDARY.southwest),
  gcj02ToWgs84(CAMPUS_MAP_BOUNDARY.northeast)
].map(({ longitude, latitude }) => [
  Number(longitude.toFixed(6)), Number(latitude.toFixed(6))
]);
const EMPTY_GJ = { type: 'FeatureCollection', features: [] };

class MapView {
  constructor(map, groundOverlay) {
    this.map = map;
    this.groundOverlay = groundOverlay;
    this.markers = new Map(); // id → maplibregl.Marker
    this.tapCb = null;
    this.userMarker = null;
    this._ready = false;
    this._polygonCache = null;
    this._linesCache = null;
    this._satelliteCache = false; // 默认显示校园图叠加；卫星图作为底图
  }

  static create(container, {
    center = [110.273130, 25.096525],
    zoom = 16.1,
    minZoom = 16,
    maxBounds = CAMPUS_MAP_MAX_BOUNDS,
    groundOverlay = CAMPUS_GROUND_OVERLAY
  } = {}) {
    const ml = window.maplibregl;
    const map = new ml.Map({
      container,
      center,
      zoom,
      minZoom,
      maxBounds,
      // 必须提供 style：MapLibre 对无 style 的地图不会调度任何渲染帧，
      // load 事件永不触发，后续 addSource/addLayer（含瓦片底图）永远挂不上
      style: { version: 8, sources: {}, layers: [] },
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false
    });
    map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-right');

    const view = new MapView(map, groundOverlay);
    view._setupBadgeClamp();
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
    const campusOverlay = miniProgramGroundOverlayToMapLibre(this.groundOverlay);
    map.addLayer({
      id: 'campus-backdrop-layer',
      type: 'background',
      paint: { 'background-color': '#f2f1ed' }
    });
    map.addSource('satellite', {
      type: 'raster',
      tiles: [SAT_TILE],
      tileSize: 256,
      attribution: 'Esri, Maxar'
    });
    map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite' });
    map.addSource('campus-map', {
      type: 'image',
      url: campusOverlay.url,
      coordinates: campusOverlay.coordinates
    });
    map.addLayer({
      id: 'campus-map-layer',
      type: 'raster',
      source: 'campus-map',
      paint: { 'raster-fade-duration': 0, 'raster-opacity': campusOverlay.opacity }
    });

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
    // 等 maplibre 完成本帧定位后再做一次边缘收敛
    if (this._clampFn) setTimeout(this._clampFn, 0);
  }

  _setupBadgeClamp() {
    // 视口边缘标签防裁切：标记贴近地图容器边缘时，把文字 badge 平移回可见范围
    const clamp = () => {
      const cr = this.map.getContainer().getBoundingClientRect();
      if (!cr.width) return;
      const shift = el => {
        const badge = el.querySelector('.mm-badge');
        if (!badge) return;
        const br = badge.getBoundingClientRect();
        let dx = 0;
        if (br.left < cr.left) dx = cr.left - br.left + 4;
        else if (br.right > cr.right) dx = cr.right - br.right - 4;
        badge.style.transform = dx ? `translateX(${Math.round(dx)}px)` : '';
      };
      this.markers.forEach(mk => shift(mk.getElement()));
    };
    this.map.on('move', clamp);
    this._clampFn = clamp;
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
    // Keep satellite imagery as the geographic base in both modes. Campus mode
    // overlays the school illustration; satellite mode shows the imagery alone.
    this.map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
    this.map.setLayoutProperty('campus-map-layer', 'visibility', on ? 'none' : 'visible');
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
