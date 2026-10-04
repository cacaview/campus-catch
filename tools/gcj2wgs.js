// tools/gcj2wgs.js — command-line wrapper around the shared runtime conversion.
import { gcj02ToWgs84 } from '../js/utils/map-coordinates.js';

export function gcj2wgs(gcjLat, gcjLng) {
  return gcj02ToWgs84({ latitude: gcjLat, longitude: gcjLng });
}

// CLI: print the WGS-84 campus center derived from the mini-program GCJ-02 center.
if (process.argv[1] && process.argv[1].endsWith('gcj2wgs.js')) {
  const r = gcj2wgs(25.093668, 110.277685);
  const errM = Math.hypot(
    (r.latitude - 25.096525) * 111320,
    (r.longitude - 110.273130) * 111320 * Math.cos(25.10 * Math.PI / 180)
  );
  console.log(`DEFAULT_CENTER = { latitude: ${r.latitude.toFixed(6)}, longitude: ${r.longitude.toFixed(6)} };`);
  console.log(`self-check: err vs reference = ${errM.toFixed(1)}m`);
  if (errM > 10) process.exit(1);
}
