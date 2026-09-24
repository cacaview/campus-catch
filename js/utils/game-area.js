const EARTH_RADIUS = 6371000;

function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const lat1 = Number(a.latitude) * Math.PI / 180;
  const lat2 = Number(b.latitude) * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLng = (Number(b.longitude) - Number(a.longitude)) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function isValidArea(area) {
  return !!(area && area.type === 'polygon' && Array.isArray(area.points) && area.points.length >= 3 &&
    area.points.every(p => Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude))));
}

function contains(area, point) {
  if (!isValidArea(area) || !point) return false;
  const x = Number(point.longitude);
  const y = Number(point.latitude);
  let inside = false;
  const points = area.points;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = Number(points[i].longitude), yi = Number(points[i].latitude);
    const xj = Number(points[j].longitude), yj = Number(points[j].latitude);
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function center(area) {
  if (!isValidArea(area)) return null;
  const sum = area.points.reduce((acc, p) => ({
    latitude: acc.latitude + Number(p.latitude),
    longitude: acc.longitude + Number(p.longitude)
  }), { latitude: 0, longitude: 0 });
  return { latitude: sum.latitude / area.points.length, longitude: sum.longitude / area.points.length };
}

// 将无序点击的边界点按中心极角排列，避免地图 polygon 出现交叉连线。
function orderBoundaryPoints(points) {
  if (!Array.isArray(points) || points.length < 3) return Array.isArray(points) ? points.slice() : [];
  const c = points.reduce((acc, p) => ({
    latitude: acc.latitude + Number(p.latitude) / points.length,
    longitude: acc.longitude + Number(p.longitude) / points.length
  }), { latitude: 0, longitude: 0 });
  return points.slice().sort((a, b) => {
    const angleA = Math.atan2(Number(a.latitude) - c.latitude, Number(a.longitude) - c.longitude);
    const angleB = Math.atan2(Number(b.latitude) - c.latitude, Number(b.longitude) - c.longitude);
    return angleA - angleB;
  });
}

export default { distanceMeters, isValidArea, contains, center, orderBoundaryPoints };
