// Coordinate conversion and overlay-shape compatibility for the mini-program map.
const A = 6378245.0;
const EE = 0.00669342162296594323;

function transformLatitude(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return r;
}

function transformLongitude(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return r;
}

function wgs84ToGcj02Offset(longitude, latitude) {
  let dLat = transformLatitude(longitude - 105.0, latitude - 35.0);
  let dLng = transformLongitude(longitude - 105.0, latitude - 35.0);
  const radLat = latitude / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { latitude: dLat, longitude: dLng };
}

/** Convert a Tencent/WeChat GCJ-02 point into a WGS-84 point for MapLibre. */
export function gcj02ToWgs84({ latitude, longitude }) {
  const offset = wgs84ToGcj02Offset(longitude, latitude);
  return { latitude: latitude - offset.latitude, longitude: longitude - offset.longitude };
}

/** Adapt wx MapContext.addGroundOverlay bounds into a MapLibre image source. */
export function miniProgramGroundOverlayToMapLibre(overlay) {
  if (Array.isArray(overlay.coordinates) && overlay.coordinates.length === 4) {
    return {
      url: overlay.src,
      coordinates: overlay.coordinates.map(point => [Number(point[0]), Number(point[1])]),
      opacity: overlay.opacity
    };
  }
  const { southwest, northeast } = overlay.bounds;
  const gcjCorners = [
    { latitude: northeast.latitude, longitude: southwest.longitude },
    northeast,
    { latitude: southwest.latitude, longitude: northeast.longitude },
    southwest
  ];
  return {
    url: overlay.src,
    coordinates: gcjCorners.map(point => {
      const wgs = gcj02ToWgs84(point);
      return [Number(wgs.longitude.toFixed(6)), Number(wgs.latitude.toFixed(6))];
    }),
    opacity: overlay.opacity
  };
}
