// tools/lib/raster.mjs
// Distance fields on a regular grid and their iso-contours, for the curb islands ("blocks") of the city.
//
// The city's ground is described by one scalar field F over a grid of vertices (cell size `h` metres):
//   F > 0 on a curb island, F < 0 on a roadway, in the sea or in a lagoon. |F| is the distance to the nearest edge
//   (a road's curb line, the coastline, a lagoon's shore) wherever that edge is within `reach` metres.
// Contours of F (marching squares, linear interpolation) give the curb lines at F = 0 and the back of the sidewalk at
// F = sidewalk width. Because the field is a true distance near the edges, straight curbs come out straight however
// coarse the grid, and corners come out rounded with a radius of about one cell: like real curb radii.

export const FAR = 1e4;

export class Grid {
  constructor({ minX, minZ, maxX, maxZ, h = 2, reach = 8 }) {
    this.h = h;
    this.reach = reach;
    this.x0 = Math.floor(minX / h) * h;
    this.z0 = Math.floor(minZ / h) * h;
    this.nx = Math.ceil((maxX - this.x0) / h) + 1;
    this.nz = Math.ceil((maxZ - this.z0) / h) + 1;
    this.n = this.nx * this.nz;
  }

  field(fill = FAR) {
    return new Float32Array(this.n).fill(fill);
  }

  x(i) {
    return this.x0 + i * this.h;
  }

  z(j) {
    return this.z0 + j * this.h;
  }

  /** Calls fn(index, x, z) for every vertex within `pad` of the segment's bounding box */
  forBox(minX, maxX, minZ, maxZ, pad, fn) {
    const { h, nx, nz } = this;
    const i0 = Math.max(0, Math.floor((minX - pad - this.x0) / h));
    const i1 = Math.min(nx - 1, Math.ceil((maxX + pad - this.x0) / h));
    const j0 = Math.max(0, Math.floor((minZ - pad - this.z0) / h));
    const j1 = Math.min(nz - 1, Math.ceil((maxZ + pad - this.z0) / h));
    for (let j = j0; j <= j1; j++) {
      const z = this.z0 + j * h;
      const row = j * nx;
      for (let i = i0; i <= i1; i++) fn(row + i, this.x0 + i * h, z);
    }
  }

  /** The value of field F at (x, z), bilinear */
  sample(F, x, z) {
    const fx = (x - this.x0) / this.h;
    const fz = (z - this.z0) / this.h;
    const i = Math.max(0, Math.min(this.nx - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(this.nz - 2, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i));
    const tz = Math.min(1, Math.max(0, fz - j));
    const k = j * this.nx + i;
    const a = F[k] + (F[k + 1] - F[k]) * tx;
    const b = F[k + this.nx] + (F[k + this.nx + 1] - F[k + this.nx]) * tx;
    return a + (b - a) * tz;
  }
}

/** Distance from (px, pz) to segment a-b, and which side: cross > 0 means (px, pz) is left of a->b (x right, z down) */
export function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  const qx = ax + t * dx - px;
  const qz = az + t * dz - pz;
  return Math.sqrt(qx * qx + qz * qz);
}

/** Carves a road into F: F = min(F, distance to the centreline - half width) near the road */
export function stampRoad(grid, F, pts, half) {
  const pad = half + grid.reach;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k];
    const [bx, bz] = pts[k + 1];
    grid.forBox(Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz), pad, (idx, x, z) => {
      const d = segDist(x, z, ax, az, bx, bz) - half;
      if (d < F[idx]) F[idx] = d;
    });
  }
}

/**
 * Signed distance to the coastline (OSM convention: land on the left of the way's direction). Near the line the sign
 * comes from the nearest segment's side; far from it from a flood fill of the sea started just right of every
 * segment, walled in by the line itself. Returns a field: + on land, - at sea, magnitude capped by `reach`.
 */
export function coastField(grid, lines) {
  const { n, nx, nz, h, reach } = grid;
  const F = grid.field(FAR);
  if (!lines.length) return F;
  const near = new Float32Array(n).fill(FAR); // unsigned distance near the coast
  const sign = new Int8Array(n); // side of the nearest segment
  const wall = new Uint8Array(n);
  for (const pts of lines) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k];
      const [bx, bz] = pts[k + 1];
      grid.forBox(Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz), reach, (idx, x, z) => {
        const d = segDist(x, z, ax, az, bx, bz);
        if (d < near[idx]) {
          near[idx] = d;
          // left of a->b in a frame where x is right and z is down is a negative cross product
          const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
          sign[idx] = cross < 0 ? 1 : -1;
        }
        if (d < 0.75 * h) wall[idx] = 1;
      });
    }
  }
  // flood the sea from seeds a little right of each segment's midpoint
  const sea = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  const seed = (x, z) => {
    const i = Math.round((x - grid.x0) / h);
    const j = Math.round((z - grid.z0) / h);
    if (i < 0 || j < 0 || i >= nx || j >= nz) return;
    const idx = j * nx + i;
    if (wall[idx] || sea[idx] || sign[idx] > 0) return;
    sea[idx] = 1;
    queue[qt++] = idx;
  };
  for (const pts of lines) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k];
      const [bx, bz] = pts[k + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      // right of a->b (x right, z down): rotate the direction by +90 deg in that frame: (dx, dz) -> (-dz, dx)
      const rx = -(bz - az) / L;
      const rz = (bx - ax) / L;
      const off = 1.5 * h;
      seed((ax + bx) / 2 + rx * off, (az + bz) / 2 + rz * off);
    }
  }
  while (qh < qt) {
    const idx = queue[qh++];
    const i = idx % nx;
    const j = (idx - i) / nx;
    const visit = (k) => {
      if (!sea[k] && !wall[k]) {
        sea[k] = 1;
        queue[qt++] = k;
      }
    };
    if (i > 0) visit(idx - 1);
    if (i < nx - 1) visit(idx + 1);
    if (j > 0) visit(idx - nx);
    if (j < nz - 1) visit(idx + nx);
  }
  for (let idx = 0; idx < n; idx++) {
    if (near[idx] < reach) F[idx] = near[idx] * sign[idx];
    else F[idx] = sea[idx] ? -FAR : FAR;
  }
  return F;
}

function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Signed distance to a set of polygons: + inside (any ring), - outside. Vertices far from every edge keep `outside`
 * (default -FAR) unless they are inside a ring (then +FAR). Inside-ness by scanline, exact at the vertices.
 */
export function polygonField(grid, rings, outside = -FAR) {
  const { nx, h, reach } = grid;
  const F = grid.field(outside);
  const inside = new Uint8Array(grid.n);
  for (const r of rings) {
    if (r.length < 3) continue;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of r) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    // scanline fill of the vertex rows
    const j0 = Math.max(0, Math.ceil((minZ - grid.z0) / h));
    const j1 = Math.min(grid.nz - 1, Math.floor((maxZ - grid.z0) / h));
    for (let j = j0; j <= j1; j++) {
      const z = grid.z0 + j * h;
      const xs = [];
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const [xa, za] = r[a];
        const [xb, zb] = r[b];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - grid.x0) / h));
        const i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - grid.x0) / h));
        for (let i = i0; i <= i1; i++) inside[j * nx + i] ^= 1; // xor: overlapping rings of one polygon cancel
      }
    }
  }
  for (let idx = 0; idx < grid.n; idx++) if (inside[idx]) F[idx] = FAR;
  for (const r of rings) {
    for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
      const [ax, az] = r[b];
      const [bx, bz] = r[a];
      grid.forBox(Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz), reach, (idx, x, z) => {
        const d = segDist(x, z, ax, az, bx, bz);
        if (d < Math.abs(F[idx])) F[idx] = inside[idx] ? d : -d;
      });
    }
  }
  return F;
}

/** Element-wise minimum of fields (an intersection of the regions where each is positive) */
export function minField(out, ...fields) {
  for (const f of fields) for (let i = 0; i < out.length; i++) if (f[i] < out[i]) out[i] = f[i];
  return out;
}

/**
 * Iso-contours of F at level c: closed rings of [x, z] with the region F > c on their left as seen in the grid frame
 * (x right, z down), which makes outer boundaries come out with positive signed area (see ringArea) and holes negative.
 * Vertices on the grid border count as outside, so every ring closes.
 */
export function contours(grid, F, c = 0) {
  const { nx, nz } = grid;
  const val = (i, j) => (i <= 0 || j <= 0 || i >= nx - 1 || j >= nz - 1 ? Math.min(F[j * nx + i], c - 1) : F[j * nx + i]);
  const HV = nx * nz; // vertical edge keys follow the horizontal ones
  const next = new Map(); // start edge key -> end edge key
  const point = new Map(); // edge key -> [x, z]
  const edgePoint = (key, i0, j0, i1, j1) => {
    if (point.has(key)) return;
    const a = val(i0, j0);
    const b = val(i1, j1);
    const t = (c - a) / (b - a);
    point.set(key, [grid.x(i0) + (grid.x(i1) - grid.x(i0)) * t, grid.z(j0) + (grid.z(j1) - grid.z(j0)) * t]);
  };
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const v0 = val(i, j) > c; // (i, j)
      const v1 = val(i + 1, j) > c; // (i+1, j)
      const v2 = val(i + 1, j + 1) > c; // (i+1, j+1)
      const v3 = val(i, j + 1) > c; // (i, j+1)
      const cs = (v0 ? 1 : 0) | (v1 ? 2 : 0) | (v2 ? 4 : 0) | (v3 ? 8 : 0);
      if (cs === 0 || cs === 15) continue;
      // edges: e0 (i,j)-(i+1,j), e1 (i+1,j)-(i+1,j+1), e2 (i,j+1)-(i+1,j+1), e3 (i,j)-(i,j+1)
      const E = [j * nx + i, HV + j * nx + i + 1, (j + 1) * nx + i, HV + j * nx + i];
      const crossed = [v0 !== v1, v1 !== v2, v2 !== v3, v3 !== v0];
      const corners = [[i, j, v0], [i + 1, j, v1], [i + 1, j + 1, v2], [i, j + 1, v3]];
      const edgeEnds = [[0, 1], [1, 2], [3, 2], [0, 3]];
      for (let e = 0; e < 4; e++) {
        if (!crossed[e]) continue;
        const [p, q] = edgeEnds[e];
        edgePoint(E[e], corners[p][0], corners[p][1], corners[q][0], corners[q][1]);
      }
      // pairs of crossed edges joined by a segment, each with the corner it cuts off
      let pairs;
      if (cs === 5 || cs === 10) {
        const centre = (val(i, j) + val(i + 1, j) + val(i + 1, j + 1) + val(i, j + 1)) / 4 > c;
        // cs 5: v0 & v2 inside. Centre inside: cut off the outside corners v1 (e0,e1) and v3 (e2,e3); else isolate v0, v2.
        // cs 10: v1 & v3 inside. Centre inside: cut off v0 (e3,e0) and v2 (e1,e2); else isolate v1 (e0,e1), v3 (e2,e3).
        if (cs === 5) pairs = centre ? [[0, 1, 1], [2, 3, 3]] : [[3, 0, 0], [1, 2, 2]];
        else pairs = centre ? [[3, 0, 0], [1, 2, 2]] : [[0, 1, 1], [2, 3, 3]];
      } else {
        const es = [0, 1, 2, 3].filter((e) => crossed[e]);
        // reference corner: any inside corner
        const ref = corners.findIndex((k) => k[2]);
        pairs = [[es[0], es[1], ref]];
      }
      for (const [ea, eb, k] of pairs) {
        const A = point.get(E[ea]);
        const B = point.get(E[eb]);
        const [kx, kz, kin] = [grid.x(corners[k][0]), grid.z(corners[k][1]), corners[k][2]];
        // inside on the left of a->b (x right, z down) is a negative cross product of (b - a) x (k - a)
        const cross = (B[0] - A[0]) * (kz - A[1]) - (B[1] - A[1]) * (kx - A[0]);
        const kLeft = cross < 0;
        const forward = kLeft === kin;
        if (forward) next.set(E[ea], E[eb]);
        else next.set(E[eb], E[ea]);
      }
    }
  }
  const rings = [];
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring = [];
    let k = start;
    for (let guard = 0; guard < 5e6; guard++) {
      if (seen.has(k)) break;
      seen.add(k);
      ring.push(point.get(k));
      k = next.get(k);
      if (k === undefined) break;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Signed area with the same convention as `contours`: positive for a ring with its inside on the left (x right, z down) */
export function signedArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  // shoelace in (x, z) is positive counter-clockwise in a y-up frame; with z down that is clockwise on screen, which is
  // "inside on the right". Flip so outer rings from `contours` are positive.
  return -a / 2;
}

/**
 * Groups contour rings into polygons: [{ outer, holes }] with each hole placed in the smallest outer ring that
 * contains it. Rings smaller than minArea (m²) are dropped.
 */
export function polygons(rings, minArea = 0) {
  const outers = [];
  const holes = [];
  for (const r of rings) {
    const a = signedArea(r);
    if (Math.abs(a) < minArea) continue;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of r) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    (a > 0 ? outers : holes).push({ ring: r, area: Math.abs(a), minX, maxX, minZ, maxZ, holes: [] });
  }
  outers.sort((a, b) => a.area - b.area);
  for (const hRing of holes) {
    const [px, pz] = hRing.ring[0];
    const host = outers.find((o) => px > o.minX && px < o.maxX && pz > o.minZ && pz < o.maxZ && o.area > hRing.area && pointInRing(px, pz, o.ring));
    if (host) host.holes.push(hRing.ring);
  }
  return outers.map((o) => ({ outer: o.ring, holes: o.holes, area: o.area - 0, minX: o.minX, maxX: o.maxX, minZ: o.minZ, maxZ: o.maxZ }));
}

export { pointInRing };
