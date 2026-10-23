// src/world/geo.js
// Pure geometry and the local world frame. Shared by the Node tools and the browser, so no DOM or three.js in here.
//
// Frame: 1 unit = 1 m. x = grid east, z = grid south (north is -z, which is "forward" in three.js).
// bearingDeg is the compass bearing (clockwise from true north) of the streets that should end up running along the
// z axis. For Manhattan that is 29 deg; for Tema it is measured from the road data (see estimateGridBearing).

const A = 6378137.0; // WGS84 semi-major axis
const E2 = 6.69437999014e-3; // WGS84 first eccentricity squared
const RAD = Math.PI / 180;

export function makeFrame({ lat0, lon0, bearingDeg = 0 }) {
  const phi0 = lat0 * RAD;
  const s0 = Math.sin(phi0);
  const w = 1 - E2 * s0 * s0;
  const kx = RAD * (A / Math.sqrt(w)) * Math.cos(phi0); // metres per degree of longitude
  const ky = RAD * ((A * (1 - E2)) / Math.pow(w, 1.5)); // metres per degree of latitude
  const th = bearingDeg * RAD;
  const c = Math.cos(th);
  const s = Math.sin(th);
  return {
    lat0,
    lon0,
    bearingDeg,
    toLocal(lon, lat) {
      const e = (lon - lon0) * kx;
      const n = (lat - lat0) * ky;
      return [e * c - n * s, -(e * s + n * c)];
    },
    toLonLat(x, z) {
      const e = x * c - z * s;
      const n = -x * s - z * c;
      return [lon0 + e / kx, lat0 + n / ky];
    }
  };
}

/** Signed shoelace area of a ring of [x, z] points. */
export function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

export function bboxOf(pts) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const [x, z] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}

export function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Ramer-Douglas-Peucker on an open polyline of [x, z]. */
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1e-9;
    let best = -1;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / len;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > eps) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** RDP on a closed ring (not repeating the first point): split at the two farthest-apart vertices. */
export function rdpRing(ring, eps) {
  if (ring.length < 5) return ring.slice();
  let far = 0;
  let i1 = 0;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > far) {
      far = d;
      i1 = i;
    }
  }
  const a = rdp(ring.slice(0, i1 + 1), eps);
  const b = rdp([...ring.slice(i1), ring[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Mean of the bounding box corners: cheap and good enough for assigning things to tiles. */
export function bboxCentre(pts) {
  const b = bboxOf(pts);
  return [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2];
}

/**
 * Dominant street direction. Takes polylines of [x, z] in a frame with bearing 0 (x = east, z = -north), weights each
 * segment by length, and averages the heading modulo 90 degrees (by quadrupling the angle, so 89 and 1 degrees agree).
 * Returns { bearingDeg in (-45, 45], strength 0..1 }. Strength near 1 means a clean grid; near 0, no dominant direction.
 */
export function estimateGridBearing(lines) {
  let S = 0;
  let C = 0;
  let total = 0;
  for (const pts of lines) {
    for (let i = 1; i < pts.length; i++) {
      const de = pts[i][0] - pts[i - 1][0];
      const dn = -(pts[i][1] - pts[i - 1][1]);
      const len = Math.hypot(de, dn);
      if (len < 1e-6) continue;
      const h = Math.atan2(de, dn);
      S += len * Math.sin(4 * h);
      C += len * Math.cos(4 * h);
      total += len;
    }
  }
  if (!total) return { bearingDeg: 0, strength: 0 };
  return { bearingDeg: (Math.atan2(S, C) / 4) / RAD, strength: Math.hypot(S, C) / total };
}

export const q1 = (v) => Math.round(v * 10) / 10;

/** [[x, z], ...] -> [x0, z0, x1, z1, ...] rounded to 0.1 m. */
export const flat = (pts) => pts.flatMap(([x, z]) => [q1(x), q1(z)]);
