(function () {
// js/city-config.js
// The city's spatial configuration, derived from the generated geodata (js/geodata/<id>.js, tools/build-geodata.mjs).
// This replaces Slop New York's Manhattan street database with a city-agnostic one built on OpenStreetMap: it exposes
// the same API the engine modules read (traffic, controllers, cameras, map), with the Manhattan-only parts (numbered
// streets & avenues, Central Park, the boroughs & bridges) left empty.
//
// World frame: 1 unit = 1 m, x = grid east, z = grid south (north = -z), origin at the locality's origin, axes turned
// GEO.frame.bearingDeg from true north like the street grid itself. Heading 0 faces south (+z), PI north.

const GEO = window.NYC.GEO;
const toPts = (flat) => {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
};
const NOWHERE = { minX: 1e7, maxX: 1e7 + 1, minZ: 1e7, maxZ: 1e7 + 1 };

// ---------------------------------------------------------------------------------------------------------------------
// Grid-only structures of the Manhattan engine: none here (every street is a centreline street, road-network.js 4b)
// ---------------------------------------------------------------------------------------------------------------------
const AVENUES = [];
const ALL_AVENUES = [];
const STREETS = [];
const ALL_STREETS = [];
const CENTRAL_PARK_BOUNDS = { ...NOWHERE };
const SPAWN = { ...GEO.spawn };
const streetZ = () => SPAWN.z;
const avenueX = () => SPAWN.x;
const avenueNameAt = (ave) => (ave && ave.short) || '';

// ---------------------------------------------------------------------------------------------------------------------
// Land: the ground inside the coastline (minus lagoons, plus breakwaters); west / east extent of the land at any z
// ---------------------------------------------------------------------------------------------------------------------
const LAND = GEO.land.map(([outer, holes]) => ({ outer: toPts(outer), holes: holes.map(toPts) }));
const MANHATTAN_COASTLINE = LAND.length ? LAND.reduce((a, l) => (l.outer.length > a.outer.length ? l : a), LAND[0]).outer : [];
const B = GEO.bounds;
const SHORE = (() => {
  const step = 4;
  const z0 = Math.floor(B.minZ / step) * step;
  const n = Math.ceil((B.maxZ - z0) / step) + 1;
  const west = new Float32Array(n).fill(B.minX);
  const east = new Float32Array(n).fill(B.maxX);
  const lo = new Float32Array(n).fill(Infinity);
  const hi = new Float32Array(n).fill(-Infinity);
  for (const l of LAND) {
    const P = l.outer;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[j];
      const b = P[i];
      if (a.z === b.z) continue;
      const zl = Math.min(a.z, b.z);
      const zh = Math.max(a.z, b.z);
      for (let k = Math.max(0, Math.ceil((zl - z0) / step)); k < n && z0 + k * step < zh; k++) {
        const z = z0 + k * step + 1e-3;
        if (z < zl || z >= zh) continue;
        const x = a.x + ((z - a.z) * (b.x - a.x)) / (b.z - a.z);
        if (x < lo[k]) lo[k] = x;
        if (x > hi[k]) hi[k] = x;
      }
    }
  }
  for (let k = 0; k < n; k++) {
    if (lo[k] < hi[k]) {
      west[k] = lo[k];
      east[k] = hi[k];
    }
  }
  return { z0, step, n, west, east };
})();
/** West / east edge of the land at a given z (the outermost shore crossings; the area's edges where land reaches them) */
function getIslandBoundsAtZ(z) {
  const f = (z - SHORE.z0) / SHORE.step;
  const k = Math.max(0, Math.min(SHORE.n - 2, Math.floor(f)));
  const t = Math.max(0, Math.min(1, f - k));
  // a little slack: the controllers keep 8 m inside these lines
  return {
    westX: SHORE.west[k] + (SHORE.west[k + 1] - SHORE.west[k]) * t - 12,
    eastX: SHORE.east[k] + (SHORE.east[k + 1] - SHORE.east[k]) * t + 12
  };
}
const ISLAND_BOUNDS = { minX: B.minX, maxX: B.maxX, minZ: B.minZ, maxZ: B.maxZ, sidewalkHeight: GEO.frame.sidewalkHeight || 0.22, waterLevel: -1.6 };
const CUT_Z = B.minZ;

// ---------------------------------------------------------------------------------------------------------------------
// Roads: every carriageway, footway & track with its curb-to-curb width; nearest-road lookups for labels
// ---------------------------------------------------------------------------------------------------------------------
const MOTOR = new Set(['motorway', 'trunk', 'motorway_link', 'trunk_link']);
const prettyName = (n) => n;
const ROADS = GEO.roads.map(([name, w, dir, lanes, cls, flags, flat]) => ({
  name: prettyName(name), raw: name, w, dir, lanes, cls, highway: MOTOR.has(cls), bridge: !!(flags & 1), roundabout: !!(flags & 2), pts: toPts(flat)
}));
const NAMED_ROADS = ROADS.filter((r) => r.name && !/^(footway|path|steps|cycleway|track)$/.test(r.cls));
const ROAD_CELL = 64;
const ROAD_GRID = new Map();
for (const r of NAMED_ROADS) {
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const a = r.pts[i];
    const b = r.pts[i + 1];
    const seg = { r, ax: a.x, az: a.z, bx: b.x, bz: b.z };
    const ix0 = Math.floor(Math.min(a.x, b.x) / ROAD_CELL), ix1 = Math.floor(Math.max(a.x, b.x) / ROAD_CELL);
    const iz0 = Math.floor(Math.min(a.z, b.z) / ROAD_CELL), iz1 = Math.floor(Math.max(a.z, b.z) / ROAD_CELL);
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
      const k = ix * 100000 + iz;
      if (!ROAD_GRID.has(k)) ROAD_GRID.set(k, []);
      ROAD_GRID.get(k).push(seg);
    }
  }
}
/** Nearest named roads to (x, z) within `radius`: [{ road, dist, horizontal }] sorted by distance (one per name) */
function nearestRoads(x, z, radius = 60) {
  const best = new Map();
  const ix0 = Math.floor((x - radius) / ROAD_CELL), ix1 = Math.floor((x + radius) / ROAD_CELL);
  const iz0 = Math.floor((z - radius) / ROAD_CELL), iz1 = Math.floor((z + radius) / ROAD_CELL);
  for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
    const list = ROAD_GRID.get(ix * 100000 + iz);
    if (!list) continue;
    for (const s of list) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / L2));
      const d = Math.hypot(s.ax + t * dx - x, s.az + t * dz - z);
      if (d > radius) continue;
      const prev = best.get(s.r.name);
      if (!prev || d < prev.dist) best.set(s.r.name, { road: s.r, dist: d, horizontal: Math.abs(dx) > Math.abs(dz) });
    }
  }
  return [...best.values()].sort((a, b) => a.dist - b.dist);
}

// ---------------------------------------------------------------------------------------------------------------------
// Blocks: the curb islands (raised sidewalk slabs between the carriageways), with their holes
// ---------------------------------------------------------------------------------------------------------------------
function ringStats(poly) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, a = 0, cx = 0, cz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[i], q = poly[j];
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    const c = q.x * p.z - p.x * q.z;
    a += c; cx += (q.x + p.x) * c; cz += (q.z + p.z) * c;
  }
  a *= 0.5;
  return { minX, maxX, minZ, maxZ, area: Math.abs(a), cx: a ? cx / (6 * a) : (minX + maxX) / 2, cz: a ? cz / (6 * a) : (minZ + maxZ) / 2 };
}
const BLOCKS = GEO.blocks.map(([outer, holes], id) => {
  const poly = toPts(outer);
  return { id, poly, holes: holes.map(toPts), rects: [], frames: null, park: 0, parkName: '', rect: false, median: false, ...ringStats(poly) };
});
const BLOCK_CELL = 64;
const BLOCK_GRID = new Map();
for (const b of BLOCKS) {
  for (let ix = Math.floor(b.minX / BLOCK_CELL); ix <= Math.floor(b.maxX / BLOCK_CELL); ix++) {
    for (let iz = Math.floor(b.minZ / BLOCK_CELL); iz <= Math.floor(b.maxZ / BLOCK_CELL); iz++) {
      const k = ix * 100000 + iz;
      if (!BLOCK_GRID.has(k)) BLOCK_GRID.set(k, []);
      BLOCK_GRID.get(k).push(b);
    }
  }
}
function pointInPoly(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
/** The curb island under (x, z), or null on a carriageway / in the water */
function blockAt(x, z) {
  const list = BLOCK_GRID.get(Math.floor(x / BLOCK_CELL) * 100000 + Math.floor(z / BLOCK_CELL));
  if (!list) return null;
  for (const b of list) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (!pointInPoly(b.poly, x, z)) continue;
    if (b.holes.some((h) => pointInPoly(h, x, z))) continue;
    return b;
  }
  return null;
}
function blocksInRect(minX, maxX, minZ, maxZ) {
  const out = new Set();
  for (let ix = Math.floor(minX / BLOCK_CELL); ix <= Math.floor(maxX / BLOCK_CELL); ix++) {
    for (let iz = Math.floor(minZ / BLOCK_CELL); iz <= Math.floor(maxZ / BLOCK_CELL); iz++) {
      const list = BLOCK_GRID.get(ix * 100000 + iz);
      if (list) for (const b of list) if (b.maxX > minX && b.minX < maxX && b.maxZ > minZ && b.minZ < maxZ) out.add(b);
    }
  }
  return [...out];
}
const getBlockBounds = () => null;
const LANDMARK_BLOCKS = new Set();

// ---------------------------------------------------------------------------------------------------------------------
// Places, landmarks & sights
// ---------------------------------------------------------------------------------------------------------------------
const PLACE_KINDS = new Set(['suburb', 'neighbourhood', 'quarter', 'village', 'town', 'city_block', 'hamlet', 'locality']);
const PLACES = GEO.places.filter(([, k]) => PLACE_KINDS.has(k)).map(([name, kind, x, z]) => ({ name, kind, x, z }));
/** The neighbourhood (OSM place) nearest to (x, z), or the locality's name */
function districtAt(x, z) {
  let best = null;
  let bd = 1800;
  for (const p of PLACES) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best ? best.name : GEO.name;
}
// Named buildings: footprints for the map, the HUD & the landmark code
const LANDMARK_SITES = {};
{
  const BX = GEO.buildings.boxes;
  const st = GEO.buildings.stride;
  for (const [kind, i, name] of GEO.buildings.names) {
    if (kind === 'b') {
      const o = i * st;
      LANDMARK_SITES[name] = { x: BX[o], z: BX[o + 1], w: BX[o + 2], d: BX[o + 3], h: BX[o + 5] };
    } else {
      const f = GEO.buildings.polys[i][0];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < f.length; k += 2) {
        x0 = Math.min(x0, f[k]); x1 = Math.max(x1, f[k]); z0 = Math.min(z0, f[k + 1]); z1 = Math.max(z1, f[k + 1]);
      }
      LANDMARK_SITES[name] = { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, h: GEO.buildings.polys[i][1] };
    }
  }
}
const SIGHTS = GEO.sights.map((s) => ({ ...s, district: districtAt(s.target[0], s.target[1]) }));
const NYC_LANDMARKS = SIGHTS.map((s) => ({ id: s.id, name: s.name, short: s.name, x: s.target[0], z: s.target[1], district: s.district }));
const TELEPORT_LOCATIONS = Object.fromEntries(SIGHTS.map((s) => [s.id, { x: s.x, z: s.z, heading: s.heading }]));
TELEPORT_LOCATIONS.start = { x: SPAWN.x, z: SPAWN.z, heading: SPAWN.heading || 0 };

/** The place's name and its street corner at (x, z): "Community 1 · Harbour Rd & Meridian Rd" */
function getLocationLabel(x, z) {
  for (const lm of NYC_LANDMARKS) {
    if (Math.hypot(x - lm.x, z - lm.z) < 90) {
      const near = nearestRoads(x, z, 120);
      return `${lm.name}${near.length ? ` · ${near.slice(0, 2).map((r) => r.road.name).join(' & ')}` : ''}`;
    }
  }
  const district = districtAt(x, z);
  if (!blockAt(x, z) && !nearestRoads(x, z, 40).length) {
    let onLand = false;
    for (const l of LAND) if (pointInPoly(l.outer, x, z) && !l.holes.some((h) => pointInPoly(h, x, z))) onLand = true;
    if (!onLand) return `${GEO.name} · Gulf of Guinea`;
  }
  const near = nearestRoads(x, z, 140);
  if (!near.length) return district;
  // a corner when the two nearest roads cross close by
  if (near.length > 1 && near[1].dist < 30) return `${district} · ${near[0].road.name} & ${near[1].road.name}`;
  return `${district} · ${near[0].road.name}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Empty Manhattan geography (the map & water shaders look these up)
// ---------------------------------------------------------------------------------------------------------------------
const WATERFRONT_PIERS = [];
const EMPTY = [];
const EAST_RIVER_BRIDGES = [];
const OUTER_BRIDGES = [];
const getBroadwayX = () => SPAWN.x;
const BROADWAY_LINE = [];
const fromOldFrame = (x, z) => ({ x, z });

function isTypingInField(e) {
  const t = e && e.target;
  if (!t || !(t instanceof Element)) return false;
  return !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

// Traffic signals: a fixed 60 s cycle (the road with right of way first)
const SIGNAL_TIMING = { cycle: 60, avenueAmber: 26, avenueRed: 30, streetAmber: 56, walk: 7 };
function signalPhase(time, isAvenue) {
  const { cycle, avenueAmber, avenueRed, streetAmber } = SIGNAL_TIMING;
  const t = ((time % cycle) + cycle) % cycle;
  if (isAvenue) return t < avenueAmber ? 'green' : t < avenueRed ? 'amber' : 'red';
  return t < avenueRed ? 'red' : t < streetAmber ? 'green' : 'amber';
}
function walkSignal(time, isAvenue) {
  const { cycle, avenueRed, walk } = SIGNAL_TIMING;
  const t = (((time - (isAvenue ? 0 : avenueRed)) % cycle) + cycle) % cycle;
  return t < walk;
}

Object.assign(window.NYC, {
  CITY: { id: GEO.id, name: GEO.name, synthetic: !!GEO.synthetic, bearingDeg: GEO.frame.bearingDeg },
  SPAWN,
  PLACES,
  SIGHTS,
  LAND,
  AVENUES,
  ALL_AVENUES,
  CENTRAL_PARK_BOUNDS,
  getIslandBoundsAtZ,
  MANHATTAN_COASTLINE,
  getBroadwayX,
  BROADWAY_LINE,
  WATERFRONT_PIERS,
  ROOSEVELT_ISLAND_POLYGON: EMPTY,
  GOVERNORS_ISLAND_POLYGON: EMPTY,
  NJ_SHORELINE_POLYGON: EMPTY,
  LONG_ISLAND_POLYGON: EMPTY,
  LONG_ISLAND_POLYGONS: [],
  BROOKLYN_POLYGONS: [],
  QUEENS_POLYGONS: [],
  BRONX_POLYGONS: [],
  WESTCHESTER_POLYGON: EMPTY,
  NASSAU_POLYGON: EMPTY,
  UPPER_MANHATTAN_POLYGON: EMPTY,
  BRONX_POLYGON: EMPTY,
  STATEN_ISLAND_POLYGON: EMPTY,
  RANDALLS_ISLAND_POLYGON: EMPTY,
  LIBERTY_ISLAND_POLYGON: EMPTY,
  LIBERTY_STATUE_POS: { x: NOWHERE.minX, z: NOWHERE.minZ },
  ELLIS_ISLAND_POLYGON: EMPTY,
  MILL_ROCK_POLYGON: EMPTY,
  EAST_RIVER_BRIDGES,
  OUTER_BRIDGES,
  STREETS,
  ALL_STREETS,
  ROADS,
  NYC_LANDMARKS,
  LANDMARK_SITES,
  TELEPORT_LOCATIONS,
  ISLAND_BOUNDS,
  LANDMARK_BLOCKS,
  BLOCKS,
  CUT_Z,
  SIGNAL_TIMING,
  streetZ,
  avenueX,
  avenueNameAt,
  districtAt,
  blockAt,
  blocksInRect,
  nearestRoads,
  getBlockBounds,
  getLocationLabel,
  fromOldFrame,
  isTypingInField,
  signalPhase,
  walkSignal,
  pointInPoly
});
})();
