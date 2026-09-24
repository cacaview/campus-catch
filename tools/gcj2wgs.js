// tools/gcj2wgs.js — GCJ-02 → WGS-84 转换（仅用于 tools/ 与测试，游戏运行时不使用）
// 标准单步反向算法，精度 ~1m，满足「默认地图中心常量换算」需求
const A = 6378245.0;
const EE = 0.00669342162296594323;

function tLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return r;
}

function tLng(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return r;
}

function wgs2gcjOffset(wgsLng, wgsLat) {
  // 与 coordtransform (Wandergis) 参考实现完全一致的缩放公式
  let dLat = tLat(wgsLng - 105.0, wgsLat - 35.0);
  let dLng = tLng(wgsLng - 105.0, wgsLat - 35.0);
  const radLat = wgsLat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { dLat, dLng };
}

export function gcj2wgs(gcjLat, gcjLng) {
  const { dLat, dLng } = wgs2gcjOffset(gcjLng, gcjLat);
  return { latitude: gcjLat - dLat, longitude: gcjLng - dLng };
}

// CLI：把原小程序默认中心（GCJ-02）换算为 WGS-84，输出硬编码进 js/main.js
// 自检基准：coordtransform (Wandergis) 参考实现输出 25.238236, 110.284419（误差应 < 10m）
if (process.argv[1] && process.argv[1].endsWith('gcj2wgs.js')) {
  const r = gcj2wgs(25.2354, 110.2890);
  const errM = Math.hypot((r.latitude - 25.238236) * 111320, (r.longitude - 110.284419) * 111320 * Math.cos(25.24 * Math.PI / 180));
  console.log(`DEFAULT_CENTER = { latitude: ${r.latitude.toFixed(6)}, longitude: ${r.longitude.toFixed(6)} };`);
  console.log(`self-check: err vs reference = ${errM.toFixed(1)}m`);
  if (errM > 10) process.exit(1);
}
