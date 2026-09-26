// MapLibre 封装：全应用唯一 MapLibre 使用点（home 框选 / game 主地图 / result 回放）
// 注意：addSource/addLayer 必须等 map 'load' 事件，未就绪的图层操作走缓存，load 后统一应用
// 底图瓦片（两个都免 key、WGS-84 与 GPS 对齐）：
//   默认卫星图 Esri World_Imagery —— 国内网络可直连；
//   街道图 OSM —— 作为可切换样式，国内可能不可达，连续加载失败自动回退卫星图
//   （CARTO 免 key 瓦片 2026-09 起强制 API key，返回 "API KEY REQUIRED" 占位图，已弃用）
const BASE_TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
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
    this._satelliteCache = true; // 默认卫星图：street 图（OSM）在国内网络常不可达
    this.onBasemapFallback = null; // 街道图加载失败自动回退时通知视图层提示用户
  }

  static create(container, { center = [110.284419, 25.238236], zoom = 16 } = {}) {
    const ml = window.maplibregl;
    const map = new ml.Map({
      container,
      center,
      zoom,
      // 必须提供 style：MapLibre 对无 style 的地图不会调度任何渲染帧，
      // load 事件永不触发，后续 addSource/addLayer（含瓦片底图）永远挂不上
      style: { version: 8, sources: {}, layers: [] },
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false
    });
    map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-right');

    const view = new MapView(map);
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
    map.addSource('basemap', {
      type: 'raster',
      tiles: [BASE_TILE],
      tileSize: 256,
      attribution: '©OpenStreetMap contributors'
    });
    map.addLayer({ id: 'basemap-layer', type: 'raster', source: 'basemap' });
    map.addSource('satellite', {
      type: 'raster',
      tiles: [SAT_TILE],
      tileSize: 256,
      attribution: 'Esri, Maxar'
    });
    map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite' }, 'basemap-layer');
    // 默认显示卫星图，街道图（OSM）隐藏为可切换样式；隐藏图层不请求瓦片
    map.getLayer('basemap-layer').setLayoutProperty('visibility', 'none');
    // 街道图瓦片在部分网络（国内）不可达：连续失败自动回退卫星图
    this._basemapErrors = 0;
    this._basemapFallbackFired = false;
    map.on('error', e => this._handleBasemapError(e));

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

  _handleBasemapError(e) {
    if (this._basemapFallbackFired) return;
    const src = e && (e.sourceId || (e.source && e.source.id));
    if (src !== 'basemap' || this._satelliteCache) return; // 卫星图状态下街道层不可见、不加载
    this._basemapErrors++;
    if (this._basemapErrors < 3) return; // 容忍偶发失败
    this._basemapFallbackFired = true;
    this.setSatellite(true);
    if (typeof this.onBasemapFallback === 'function') this.onBasemapFallback();
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
