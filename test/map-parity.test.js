import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMap } from '../js/lib/map.js';

test('MapView adapts a mini-program GCJ-02 ground overlay to MapLibre coordinates', () => {
  const oldWindow = globalThis.window;
  const layers = [];
  const sources = new Map();
  const layoutChanges = [];
  let mapOptions;

  class FakeMap {
    constructor(options) { this.options = options; mapOptions = options; }
    addControl() {}
    loaded() { return true; }
    addSource(id, source) { sources.set(id, source); }
    addLayer(layer) { layers.push(layer); }
    setLayoutProperty(...args) { layoutChanges.push(args); }
    on() {}
    getContainer() { return { getBoundingClientRect: () => ({ width: 0 }) }; }
    remove() {}
  }

  globalThis.window = {
    maplibregl: {
      Map: FakeMap,
      AttributionControl: class {}
    }
  };

  try {
    const overlay = {
      src: '/assets/campus-map-fixture.jpg',
      opacity: 0.8,
      bounds: {
        southwest: { longitude: 110.273850, latitude: 25.088910 },
        northeast: { longitude: 110.281229, latitude: 25.098995 }
      }
    };
    const view = createMap({}, { groundOverlay: overlay });
    const backdropLayer = layers.findIndex(layer => layer.id === 'campus-backdrop-layer');
    const campusLayer = layers.find(layer => layer.id === 'campus-map-layer');

    assert.ok(backdropLayer >= 0, 'a light local backdrop must remain under the campus image');
    assert.ok(backdropLayer < layers.findIndex(layer => layer.id === 'campus-map-layer'),
      'the campus image must render above the backdrop');
    assert.equal(sources.has('basemap'), false,
      'the default campus view must not depend on external street tiles');
    assert.equal(sources.get('campus-map')?.url, overlay.src,
      'the adapter must keep using the source supplied by the mini-program-style overlay');
    assert.deepEqual(sources.get('campus-map')?.coordinates, [
      [110.269299, 25.101855],
      [110.276669, 25.101848],
      [110.276669, 25.091764],
      [110.269300, 25.091771]
    ], 'GCJ-02 southwest/northeast bounds must be converted into MapLibre NW/NE/SE/SW corners');
    assert.deepEqual(mapOptions.center, [108.1912479, 23.1598575],
      'the initial center must stay at the Nanning campus center');
    assert.equal(mapOptions.zoom, 16.1,
      'the initial zoom must match the mini-program scale');
    assert.equal(mapOptions.minZoom, 16,
      'the map must preserve the mini-program minimum scale');
    assert.deepEqual(mapOptions.maxBounds, [
      [108.1832, 23.1548],
      [108.1964, 23.1656]
    ], 'the camera must stay near the calibrated Nanning campus image');
    assert.equal(campusLayer?.paint?.['raster-opacity'], overlay.opacity,
      'the adapter must preserve the mini-program overlay opacity');
    const visibleState = id => layoutChanges.filter(([layerId, property]) => layerId === id && property === 'visibility').at(-1)?.[2];
    assert.equal(visibleState('satellite-layer'), 'visible',
      'the campus view must retain satellite imagery beneath the campus overlay');
    assert.equal(visibleState('campus-map-layer'), 'visible',
      'the campus image must be visible over the satellite imagery by default');
    assert.ok(layoutChanges.some(([id, property, value]) => id === 'campus-map-layer' && property === 'visibility' && value === 'visible'),
      'the campus overlay must be visible by default');
    view.setSatellite(true);
    assert.equal(visibleState('satellite-layer'), 'visible', 'satellite mode must show the satellite layer');
    assert.equal(visibleState('campus-map-layer'), 'none', 'satellite mode must hide the campus overlay');
    view.setSatellite(false);
    assert.equal(visibleState('satellite-layer'), 'visible', 'returning to campus mode must keep satellite imagery underneath');
    assert.equal(visibleState('campus-map-layer'), 'visible', 'returning to campus mode must restore the campus overlay');
    view.destroy();

    const defaultView = createMap({});
    const defaultImage = sources.get('campus-map');
    const defaultLayer = layers.filter(layer => layer.id === 'campus-map-layer').at(-1);
    assert.equal(defaultImage?.url, new URL('../assets/campus-map.jpg', import.meta.url).href);
    assert.deepEqual(defaultImage?.coordinates, [
      [108.187129, 23.1645811],
      [108.195453, 23.1607256],
      [108.1936792, 23.15581],
      [108.1841647, 23.1592434]
    ], 'the bundled campus image must use the calibrated WGS-84 corners');
    assert.equal(defaultLayer?.paint?.['raster-opacity'], 1,
      'the bundled campus image must retain the calibrated opacity');
    defaultView.destroy();
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});
