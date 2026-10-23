#!/usr/bin/env node
// tools/build-geodata.mjs — writes js/<id>-geodata.js (window.NYC.GEO), the city the engine builds at start-up.
//
// usage: node --max-old-space-size=6144 tools/build-geodata.mjs <locality-id> [out.js]
//
// From raw OpenStreetMap (Overpass JSON in the config's rawDirs) to the simulation's world frame: 1 unit = 1 m,
// x = grid east, z = grid south, origin at the config's origin, axes turned to the street grid's measured bearing.
//
//   roads      named & unnamed carriageways with curb-to-curb widths (tagged, or from the road class)
//   roadGraph  the drivable network split at its junctions, for traffic (js/road-network.js's centreline streets)
//   land       the ground inside the coastline, minus lagoons, plus breakwaters and piers
//   blocks     curb islands: land minus the carriageways (raised sidewalk slabs, like Manhattan's blocks), with the
//              back of their sidewalk (`inner`) and grass / sand patches inside them
//   buildings  oriented boxes (most footprints are near-rectangles) and extruded outlines for the rest, with heights
//              (tagged, from levels, or estimated per type and land use, seeded by OSM id) and a facade style
//   pois, places, sights, trees, lamps, signals, rail
//
// The curb islands come from a distance field: carriageways, coast and lagoons carved into a 2 m grid, contoured at
// 0 (the curb) and at the sidewalk width (tools/lib/raster.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFrame, estimateGridBearing, rdp, rdpRing, ringArea, pointInRing, bboxOf, q1 } from './lib/geo.mjs';
import { parseHeight, parseLevels, chainRings, extractBuildings, extractAreas, extractPois, extractFurniture, dedupeElements } from './lib/osm.mjs';
import { Grid, FAR, stampRoad, coastField, polygonField, minField, contours, polygons } from './lib/raster.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------------------------------------------------
// Curb-to-curb width (m) by class: [two-way, one-way carriageway]. Starting points for Ghana's roads where OSM has no
// width or lane count; tune per city in the config (roadWidths).
export const ROAD_WIDTHS = {
  motorway: [22, 11.5], trunk: [16, 9], primary: [13, 8.5], secondary: [11, 7.5], tertiary: [9, 7],
  unclassified: [7, 5.5], residential: [7, 5.5], living_street: [6, 5], service: [5, 4.2],
  motorway_link: [8, 7], trunk_link: [8, 7], primary_link: [8, 7], secondary_link: [7.5, 6.5], tertiary_link: [7, 6]
};
const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const CARVED = new Set([...DRIVABLE, 'service']);
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link']);
const GRID_CLASSES = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified']);

export function roadWidth(t, widths = ROAD_WIDTHS) {
  const oneway = isOneway(t) !== 0;
  const tagged = parseHeight(t.width);
  if (tagged && tagged >= 3 && tagged <= 40) return tagged;
  const lanes = parseLevels(t.lanes);
  if (lanes && lanes <= 10) return Math.round((lanes * 3.3 + (oneway ? 0.8 : 1.2)) * 10) / 10;
  const w = widths[t.highway] || widths.residential;
  return oneway ? w[1] : w[0];
}

export function isOneway(t) {
  const o = t.oneway;
  if (o === 'yes' || o === '1' || o === 'true') return 1;
  if (o === '-1' || o === 'reverse') return -1;
  if (o === 'no') return 0;
  if (t.junction === 'roundabout' || t.junction === 'circular' || t.highway === 'motorway') return 1;
  return 0;
}

function extractRoadWays(elements, P) {
  const out = [];
  for (const e of elements) {
    const t = e.tags;
    if (e.type !== 'way' || !t || !t.highway || t.area === 'yes') continue;
    if (!CARVED.has(t.highway) && !['pedestrian', 'footway', 'path', 'steps', 'cycleway', 'track'].includes(t.highway)) continue;
    if (t.highway === 'service' && /^(parking_aisle|driveway|drive-through)$/.test(t.service || '')) continue;
    const geom = e.geometry || [];
    if (geom.length < 2 || geom.some((g) => !g)) continue;
    const pts = geom.map((g) => P(g.lon, g.lat));
    const ids = Array.isArray(e.nodes) && e.nodes.length === geom.length ? e.nodes : null;
    out.push({
      id: e.id, cls: t.highway, name: t.name || t.ref || '', ref: t.ref || '', pts, ids,
      w: roadWidth(t), dir: isOneway(t), lanes: parseLevels(t.lanes) || 0,
      bridge: !!(t.bridge && t.bridge !== 'no'), tunnel: !!(t.tunnel && t.tunnel !== 'no'), layer: parseInt(t.layer || '0', 10) || 0,
      roundabout: t.junction === 'roundabout'
    });
  }
  return out;
}

/**
 * Drivable network split at junctions: nodes [x, z, ...], links [a, b, name index, width, lanes, dir, inner pts].
 * Junctions are shared OSM nodes (or, without node ids, points within 0.3 m).
 */
export function buildRoadGraph(ways) {
  const drive = ways.filter((w) => DRIVABLE.has(w.cls) && !w.tunnel);
  const keyOf = (w, k) => (w.ids ? `n${w.ids[k]}` : `p${Math.round(w.pts[k][0] / 0.3)},${Math.round(w.pts[k][1] / 0.3)}`);
  const uses = new Map();
  for (const w of drive) for (let k = 0; k < w.pts.length; k++) {
    const key = keyOf(w, k);
    uses.set(key, (uses.get(key) || 0) + (k === 0 || k === w.pts.length - 1 ? 2 : 1));
  }
  const nodeIndex = new Map();
  const nodes = [];
  const nodeOf = (key, p) => {
    if (!nodeIndex.has(key)) {
      nodeIndex.set(key, nodes.length / 2);
      nodes.push(q1(p[0]), q1(p[1]));
    }
    return nodeIndex.get(key);
  };
  const names = [];
  const nameIds = new Map();
  const nameId = (n) => {
    if (!nameIds.has(n)) {
      nameIds.set(n, names.length);
      names.push(n);
    }
    return nameIds.get(n);
  };
  const links = [];
  for (const w of drive) {
    let start = 0;
    for (let k = 1; k < w.pts.length; k++) {
      const end = k === w.pts.length - 1;
      if (!end && uses.get(keyOf(w, k)) < 2) continue;
      const a = nodeOf(keyOf(w, start), w.pts[start]);
      const b = nodeOf(keyOf(w, k), w.pts[k]);
      if (a !== b) {
        const line = rdp(w.pts.slice(start, k + 1), 0.4);
        const inner = line.slice(1, -1).flatMap(([x, z]) => [q1(x), q1(z)]);
        links.push([a, b, nameId(w.name), q1(w.w), w.lanes, w.dir, inner]);
      }
      start = k;
    }
  }
  return { nodes, links, names };
}

/** Joins polylines end to start (keeping their direction: coastlines carry meaning in theirs) */
export function chainLines(lines, eps = 0.5) {
  const rest = lines.map((l) => l.slice());
  const out = [];
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;
  while (rest.length) {
    let line = rest.shift();
    for (let grew = true; grew;) {
      grew = false;
      for (let i = 0; i < rest.length; i++) {
        if (close(rest[i][0], line[line.length - 1])) {
          line = line.concat(rest.splice(i, 1)[0].slice(1));
          grew = true;
          break;
        }
        if (close(rest[i][rest[i].length - 1], line[0])) {
          line = rest.splice(i, 1)[0].concat(line.slice(1));
          grew = true;
          break;
        }
      }
    }
    out.push(line);
  }
  return out;
}

/** An open polyline carried on straight past both ends by `len` metres (closed rings are left alone) */
export function extendEnds(line, len) {
  if (line.length < 2) return line;
  const [a, b] = [line[0], line[line.length - 1]];
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5) return line;
  const out = line.slice();
  const p1 = line[1];
  const L1 = Math.hypot(a[0] - p1[0], a[1] - p1[1]) || 1;
  out.unshift([a[0] + ((a[0] - p1[0]) / L1) * len, a[1] + ((a[1] - p1[1]) / L1) * len]);
  const q1p = line[line.length - 2];
  const L2 = Math.hypot(b[0] - q1p[0], b[1] - q1p[1]) || 1;
  out.push([b[0] + ((b[0] - q1p[0]) / L2) * len, b[1] + ((b[1] - q1p[1]) / L2) * len]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------------------------------------------------
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Minimum-area enclosing rectangle (rotating calipers over the hull): { cx, cz, w, d, ux, uz } with w along (ux, uz) */
export function minRect(ring) {
  const H = hull(ring);
  let best = null;
  for (let i = 0; i < H.length; i++) {
    const a = H[i];
    const b = H[(i + 1) % H.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L;
    const uz = (b[1] - a[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of H) {
      const u = x * ux + z * uz;
      const v = -x * uz + z * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const cu = (u0 + u1) / 2;
      const cv = (v0 + v1) / 2;
      best = { area, cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, w: u1 - u0, d: v1 - v0, ux, uz };
    }
  }
  return best;
}

// Facade styles: what js/tema-world.js dresses each building with
export const STYLES = ['house', 'apartments', 'shop', 'office', 'industrial', 'worship', 'civic', 'hotel'];
const S = Object.fromEntries(STYLES.map((s, i) => [s, i]));
const TYPE_STYLE = {
  house: 'house', detached: 'house', semidetached_house: 'house', terrace: 'house', bungalow: 'house', residential: 'house',
  hut: 'house', cabin: 'house', farm: 'house', apartments: 'apartments', dormitory: 'apartments',
  commercial: 'shop', retail: 'shop', kiosk: 'shop', supermarket: 'shop', office: 'office', bank: 'office',
  industrial: 'industrial', warehouse: 'industrial', factory: 'industrial', manufacture: 'industrial', storage_tank: 'industrial',
  hangar: 'industrial', shed: 'industrial', garage: 'industrial', garages: 'industrial', service: 'industrial', transportation: 'industrial',
  church: 'worship', cathedral: 'worship', chapel: 'worship', mosque: 'worship', temple: 'worship', religious: 'worship',
  school: 'civic', university: 'civic', college: 'civic', hospital: 'civic', public: 'civic', government: 'civic', civic: 'civic',
  train_station: 'civic', stadium: 'civic', sports_hall: 'civic', hotel: 'hotel'
};
const ZONE_STYLE = { residential: 'house', commercial: 'shop', retail: 'shop', industrial: 'industrial', port: 'industrial', institutional: 'civic' };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashId = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export const FLOOR = 3.3; // storey height (m) of the facade materials for most of the city
const PARAPET = 0.7;

/** Height (m) and style of a building: tags first, then type and land use, then a seeded guess */
export function buildingSpec(b, zone, area) {
  const rnd = mulberry32(hashId(b.id));
  let style = TYPE_STYLE[b.t] || ZONE_STYLE[zone] || 'house';
  if (b.t === 'yes' && area > 1800 && zone !== 'residential') style = 'industrial';
  if (b.t === 'yes' && area > 700 && zone === 'commercial') style = 'office';
  if (b.t === 'roof') style = 'industrial';
  let levels = b.l;
  let h = b.h;
  if (!levels && !h) {
    const r = rnd();
    if (style === 'house') levels = r < 0.68 ? 1 : r < 0.94 ? 2 : 3;
    else if (style === 'apartments') levels = 3 + Math.floor(r * 3);
    else if (style === 'shop') levels = area > 400 ? 2 + Math.floor(r * 2) : r < 0.55 ? 1 : 2;
    else if (style === 'office') levels = 3 + Math.floor(r * 5);
    else if (style === 'hotel') levels = 3 + Math.floor(r * 4);
    else if (style === 'civic') levels = r < 0.5 ? 2 : 3;
    else if (style === 'worship') h = 9 + r * 6;
    else if (style === 'industrial') h = (area > 3000 ? 10 : 6.5) + r * 4;
  }
  if (!h) h = levels * FLOOR + PARAPET;
  if (!levels) levels = Math.max(1, Math.round(h / FLOOR));
  if (style === 'house' && levels >= 4) style = 'apartments';
  if ((style === 'shop' || style === 'apartments') && levels >= 7) style = 'office';
  return { h: Math.round(h * 10) / 10, levels, style: S[style], tone: Math.round(rnd() * 100) / 100 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Spatial lookup for road segments (nearest road, for building fronts, sights, lamps)
// ---------------------------------------------------------------------------------------------------------------------
function roadIndex(ways, cell = 64) {
  const grid = new Map();
  for (const w of ways) {
    for (let k = 0; k + 1 < w.pts.length; k++) {
      const [ax, az] = w.pts[k];
      const [bx, bz] = w.pts[k + 1];
      for (let ix = Math.floor(Math.min(ax, bx) / cell); ix <= Math.floor(Math.max(ax, bx) / cell); ix++) {
        for (let iz = Math.floor(Math.min(az, bz) / cell); iz <= Math.floor(Math.max(az, bz) / cell); iz++) {
          const key = ix * 100003 + iz;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push({ w, ax, az, bx, bz });
        }
      }
    }
  }
  return function nearest(x, z, radius = 60, filter = null) {
    let best = null;
    for (let ix = Math.floor((x - radius) / cell); ix <= Math.floor((x + radius) / cell); ix++) {
      for (let iz = Math.floor((z - radius) / cell); iz <= Math.floor((z + radius) / cell); iz++) {
        for (const s of grid.get(ix * 100003 + iz) || []) {
          if (filter && !filter(s.w)) continue;
          const dx = s.bx - s.ax;
          const dz = s.bz - s.az;
          const L2 = dx * dx + dz * dz || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / L2));
          const px = s.ax + t * dx;
          const pz = s.az + t * dz;
          const d = Math.hypot(px - x, pz - z);
          if (d <= radius && (!best || d < best.d)) best = { d, x: px, z: pz, w: s.w, dx: dx / Math.sqrt(L2), dz: dz / Math.sqrt(L2) };
        }
      }
    }
    return best;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------------------------------
export function loadConfig(id) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', `${id}.json`), 'utf8'));
}

export function loadRaw(cfg) {
  const all = [];
  const dirs = (cfg.rawDirs || [`data/raw/${cfg.id}`]).map((d) => path.resolve(ROOT, d)).filter((d) => fs.existsSync(d));
  if (!dirs.length) throw new Error(`no raw data for ${cfg.id}: looked in ${(cfg.rawDirs || []).join(', ')}`);
  let files = 0;
  for (const d of dirs) {
    for (const f of fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort()) {
      const json = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      for (const e of json.elements || []) all.push(e);
      files++;
    }
  }
  log(`${files} raw files from ${dirs.length} folder(s)`);
  return dedupeElements(all);
}

const flatQ = (pts) => {
  const out = new Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    out[2 * i] = q1(pts[i][0]);
    out[2 * i + 1] = q1(pts[i][1]);
  }
  return out;
};

export function buildGeo(cfg, elements, { h = cfg.gridSize || 2, sidewalk = cfg.sidewalk || 3.2 } = {}) {
  const [lat0, lon0] = cfg.origin;
  // 1. Frame: the street grid's bearing from the main roads
  const pre = makeFrame({ lat0, lon0, bearingDeg: 0 });
  const preWays = extractRoadWays(elements, pre.toLocal);
  const measured = estimateGridBearing(preWays.filter((w) => GRID_CLASSES.has(w.cls)).map((w) => w.pts));
  const bearingDeg = cfg.bearingDeg === 'auto' || cfg.bearingDeg == null ? Math.round(measured.bearingDeg * 100) / 100 : cfg.bearingDeg;
  log(`grid bearing ${bearingDeg.toFixed(2)}° (measured ${measured.bearingDeg.toFixed(2)}°, strength ${measured.strength.toFixed(2)})`);
  const frame = makeFrame({ lat0, lon0, bearingDeg });
  const P = frame.toLocal;
  const [S0, W0, N0, E0] = cfg.bbox;
  const corners = [P(W0, S0), P(E0, S0), P(E0, N0), P(W0, N0)];
  const bb = bboxOf(corners);
  const inBox = ([x, z]) => pointInRing(x, z, corners);

  // 2. Features
  const ways = extractRoadWays(elements, P);
  const carved = ways.filter((w) => CARVED.has(w.cls) && !w.tunnel);
  const areas = extractAreas(elements, P);
  const coast = [];
  const waterways = [];
  const breakwaters = [];
  const rail = [];
  for (const e of elements) {
    const t = e.tags;
    if (e.type !== 'way' || !t || !e.geometry) continue;
    const pts = e.geometry.filter(Boolean).map((g) => P(g.lon, g.lat));
    if (pts.length < 2) continue;
    if (t.natural === 'coastline') coast.push(pts);
    else if (['river', 'stream', 'canal'].includes(t.waterway)) waterways.push({ pts, half: (parseHeight(t.width) || (t.waterway === 'river' ? 14 : t.waterway === 'canal' ? 8 : 4)) / 2 });
    else if (/^(breakwater|groyne)$/.test(t.man_made) && !(pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.5)) breakwaters.push(pts);
    else if (['rail', 'light_rail', 'narrow_gauge'].includes(t.railway) && !(t.service && /^(yard|siding|spur)$/.test(t.service))) rail.push(pts);
  }
  // coastline ways chain into longer lines (direction kept); open ends inside the area are carried on straight out
  // of it, so the sea's flood fill can't run round the end of a line cut off by the download's bbox
  const coastLines = chainLines(coast).map((l) => extendEnds(l, 20000));
  log(`${ways.length} road ways (${carved.length} carved), ${areas.length} areas, ${coast.length} coastline ways, ${breakwaters.length} breakwaters`);

  // 3. Distance fields
  const pad = 20;
  const grid = new Grid({ minX: bb.x0 - pad, minZ: bb.z0 - pad, maxX: bb.x1 + pad, maxZ: bb.z1 + pad, h, reach: Math.max(8, sidewalk + 4) });
  log(`grid ${grid.nx} x ${grid.nz} at ${h} m (${(grid.n / 1e6).toFixed(1)} M vertices)`);
  const water = areas.filter((a) => a.kind === 'water').map((a) => a.ring);
  const piers = areas.filter((a) => a.kind === 'pier').map((a) => a.ring);
  const Fland = coastField(grid, coastLines);
  if (water.length) {
    const Fw = polygonField(grid, water, -FAR);
    for (let i = 0; i < grid.n; i++) Fland[i] = Math.min(Fland[i], -Fw[i]);
  }
  if (waterways.length) {
    const Fr = grid.field(FAR);
    for (const w of waterways) stampRoad(grid, Fr, w.pts, w.half);
    minField(Fland, Fr);
  }
  // breakwaters and piers are land
  if (breakwaters.length || piers.length) {
    const Fb = grid.field(FAR);
    for (const b of breakwaters) stampRoad(grid, Fb, b, 6);
    const Fp = piers.length ? polygonField(grid, piers, -FAR) : null;
    for (let i = 0; i < grid.n; i++) {
      let v = -Fb[i];
      if (Fp && Fp[i] > v) v = Fp[i];
      if (v > Fland[i]) Fland[i] = v;
    }
  }
  const Fblock = Float32Array.from(Fland);
  for (const w of carved) stampRoad(grid, Fblock, w.pts, w.w / 2);

  const simplify = (polys, eps) => polys.map((p) => ({ ...p, outer: rdpRing(p.outer, eps), holes: p.holes.map((r) => rdpRing(r, eps)) }));
  const land = simplify(polygons(contours(grid, Fland, 0), 200), 0.6);
  const blocks = simplify(polygons(contours(grid, Fblock, 0), 25), 0.25);
  const inner = simplify(polygons(contours(grid, Fblock, sidewalk), 12), 0.3);
  // grass & sand patches inside the blocks' interiors
  const patch = (kinds) => {
    const rings = areas.filter((a) => kinds.includes(a.kind)).map((a) => a.ring);
    if (!rings.length) return [];
    const Fg = polygonField(grid, rings, -FAR);
    for (let i = 0; i < grid.n; i++) Fg[i] = Math.min(Fg[i], Fblock[i] - sidewalk - 0.4);
    return simplify(polygons(contours(grid, Fg, 0), 30), 0.4);
  };
  const green = patch(['park', 'grass', 'pitch', 'wood', 'scrub', 'cemetery', 'wetland']);
  const sand = patch(['sand']);
  log(`${land.length} land polygons, ${blocks.length} curb islands, ${inner.length} interiors, ${green.length} green & ${sand.length} sand patches`);

  // 4. Zones (land use) for buildings
  const ZONES = new Set(['residential', 'commercial', 'retail', 'industrial', 'port', 'institutional']);
  const zoneList = areas.filter((a) => ZONES.has(a.kind)).map((a) => ({ kind: a.kind, ring: a.ring, bb: bboxOf(a.ring), area: Math.abs(ringArea(a.ring)) })).sort((a, b) => a.area - b.area);
  const zoneAt = (x, z) => {
    for (const zn of zoneList) if (x >= zn.bb.x0 && x <= zn.bb.x1 && z >= zn.bb.z0 && z <= zn.bb.z1 && pointInRing(x, z, zn.ring)) return zn.kind;
    return 'default';
  };

  // 5. Buildings
  const nearestRoad = roadIndex(carved);
  const rawBuildings = extractBuildings(elements, P);
  const boxes = [];
  const polys = [];
  const bnames = [];
  let skipped = 0;
  const WALL = { shop: 0, entry: 1, rear: 2, lotLine: 3, blankStone: 4 };
  for (const b of rawBuildings) {
    const area = Math.abs(ringArea(b.ring));
    if (area < 6 || area > 120000) {
      skipped++;
      continue;
    }
    const r = minRect(b.ring);
    if (!r || !inBox([r.cx, r.cz])) {
      skipped++;
      continue;
    }
    const zone = zoneAt(r.cx, r.cz);
    const spec = buildingSpec(b, zone, area);
    const base = grid.sample(Fblock, r.cx, r.cz) > 0 ? 1 : 0;
    // ry turns local +x onto (ux, uz): R_y(ry) maps (1, 0, 0) to (cos ry, 0, -sin ry)
    const ry = Math.atan2(-r.uz, r.ux);
    // which wall faces the street: the nearest road's direction in the box's frame
    const road = nearestRoad(r.cx, r.cz, 70);
    let front = 3; // +z
    if (road) {
      const vx = road.x - r.cx;
      const vz = road.z - r.cz;
      const lx = vx * r.ux + vz * r.uz; // along local x
      const lz = -vx * r.uz + vz * r.ux; // along local z (R_y: local +z is (sin ry, 0, cos ry) = (-uz, ux))
      front = Math.abs(lx) > Math.abs(lz) ? (lx < 0 ? 0 : 1) : lz < 0 ? 2 : 3;
    }
    const st = STYLES[spec.style];
    const kinds = [0, 1, 2, 3].map((k) => {
      if (k === front) return st === 'shop' || st === 'hotel' ? WALL.shop : st === 'industrial' ? WALL.rear : WALL.entry;
      if (st === 'industrial') return WALL.blankStone;
      return WALL.rear;
    });
    const faces = kinds[0] + 5 * kinds[1] + 25 * kinds[2] + 125 * kinds[3];
    const rect = area / (r.w * r.d);
    if (rect >= 0.8 || b.ring.length <= 5) {
      boxes.push(q1(r.cx), q1(r.cz), q1(r.w), q1(r.d), Math.round((ry * 180) / Math.PI * 10) / 10, spec.h, base, spec.style, spec.tone, faces);
      if (b.n) bnames.push(['b', boxes.length / 10 - 1, b.n]);
    } else {
      polys.push([flatQ(rdpRing(b.ring, 0.15)), spec.h, base, spec.style, spec.tone]);
      if (b.n) bnames.push(['p', polys.length - 1, b.n]);
    }
  }
  log(`${rawBuildings.length} buildings: ${boxes.length / 10} boxes, ${polys.length} outlines, ${skipped} skipped`);

  // 6. Points: POIs, places, furniture
  const rawPois = extractPois(elements, P).filter((p) => inBox([p.x, p.z]));
  const places = [];
  for (const e of elements) {
    const t = e.tags;
    if (e.type !== 'node' || !t || !t.place || !t.name) continue;
    const [x, z] = P(e.lon, e.lat);
    if (inBox([x, z])) places.push([t.name, t.place, q1(x), q1(z)]);
  }
  // Numbered neighbourhoods (Tema's Communities 1-25) that OSM has no place node for: the median position of the
  // things named after them (markets, bus stops, post offices, schools), as an approximate centre
  if (cfg.numberedPlaces) {
    const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
    const re = new RegExp(`\\b${cfg.numberedPlaces}\\s+(\\d{1,2}|${Object.keys(WORDS).join('|')})\\b`, 'i');
    const found = new Map();
    for (const e of elements) {
      const n = e.tags && e.tags.name;
      const m = n && re.exec(n);
      if (!m) continue;
      const k = /^\d/.test(m[1]) ? +m[1] : WORDS[m[1].toLowerCase()];
      let ll = null;
      if (e.type === 'node') ll = [e.lon, e.lat];
      else if (e.center) ll = [e.center.lon, e.center.lat];
      else if (e.geometry && e.geometry.length) {
        const g = e.geometry.filter(Boolean);
        ll = [g.reduce((a, q) => a + q.lon, 0) / g.length, g.reduce((a, q) => a + q.lat, 0) / g.length];
      }
      if (!ll) continue;
      const [x, z] = P(ll[0], ll[1]);
      if (!inBox([x, z])) continue;
      if (!found.has(k)) found.set(k, []);
      found.get(k).push([x, z]);
    }
    const med = (v) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
    for (const [k, pts] of [...found].sort((a, b) => a[0] - b[0])) {
      places.push([`${cfg.numberedPlaces} ${k}`, 'suburb', q1(med(pts.map((p) => p[0]))), q1(med(pts.map((p) => p[1])))]);
    }
    log(`numbered places from names: ${[...found.keys()].sort((a, b) => a - b).join(', ')}`);
  }
  const pois = rawPois.filter((p) => p.n && p.k !== 'place').map((p) => [p.n, p.k, q1(p.x), q1(p.z)]);
  const fur = extractFurniture(elements, P);
  const rnd = mulberry32(20261023);
  const blockAtField = (x, z) => grid.sample(Fblock, x, z);
  // trees: mapped ones, scattered in green patches, and along residential streets on the sidewalk
  const trees = [];
  for (const [x, z] of fur.trees) if (inBox([x, z])) trees.push(q1(x), q1(z), 0);
  for (const g of green) {
    const n = Math.min(400, Math.floor(g.area / 260));
    const gb = bboxOf(g.outer);
    for (let k = 0, tries = 0; k < n && tries < n * 6; tries++) {
      const x = gb.x0 + rnd() * (gb.x1 - gb.x0);
      const z = gb.z0 + rnd() * (gb.z1 - gb.z0);
      if (!pointInRing(x, z, g.outer)) continue;
      trees.push(q1(x), q1(z), 1);
      k++;
    }
  }
  const lamps = [];
  for (const w of carved) {
    if (w.cls === 'service' || w.bridge) continue;
    const major = MAJOR.has(w.cls) || w.cls === 'tertiary';
    const spacing = major ? 34 : 30;
    let s0 = 6 + rnd() * 10;
    let acc = 0;
    for (let k = 0; k + 1 < w.pts.length; k++) {
      const [ax, az] = w.pts[k];
      const [bx, bz] = w.pts[k + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      const ux = (bx - ax) / L;
      const uz = (bz - az) / L;
      for (let s = s0 - acc; s < L; s += spacing) {
        const x = ax + ux * s;
        const z = az + uz * s;
        for (const side of major ? [1, -1] : [rnd() < 0.5 ? 1 : -1]) {
          const ox = x - uz * side * (w.w / 2 + 0.8);
          const oz = z + ux * side * (w.w / 2 + 0.8);
          // on a sidewalk, clear of the junctions' carriageways
          if (blockAtField(ox, oz) < 0.4 || blockAtField(ox, oz) > sidewalk - 0.4) continue;
          if (major) lamps.push(q1(ox), q1(oz), Math.round(Math.atan2(uz * side, -ux * side) * 100) / 100);
          else if (rnd() < 0.55) {
            const tx = x - uz * side * (w.w / 2 + 2.0);
            const tz = z + ux * side * (w.w / 2 + 2.0);
            if (blockAtField(tx, tz) > 1.2 && blockAtField(tx, tz) < sidewalk) trees.push(q1(tx), q1(tz), 2);
          }
        }
      }
      acc = (acc + L) % spacing;
      s0 = spacing;
    }
  }
  const signals = [];
  for (const [x, z] of fur.signals) if (inBox([x, z])) signals.push(q1(x), q1(z));
  const bus = [];
  for (const [x, z] of fur.bus) if (inBox([x, z])) bus.push(q1(x), q1(z));
  log(`${pois.length} POIs, ${places.length} places, ${trees.length / 3} trees, ${lamps.length / 3} lamps, ${signals.length / 2} signals`);

  // 7. Roads for the maps and labels (drawn & carved ones; footways for the map only)
  const roads = ways.filter((w) => !w.tunnel).map((w) => [w.name, q1(w.w), w.dir, w.lanes, w.cls, (w.bridge ? 1 : 0) | (w.roundabout ? 2 : 0), flatQ(w.pts)]);
  const roadGraph = buildRoadGraph(ways);
  log(`road graph: ${roadGraph.nodes.length / 2} nodes, ${roadGraph.links.length} links`);

  // 8. Sights: the curated list from the config, found by name in the data or placed from their coordinates, and
  //    the start point. Each stands on the nearest drivable road, facing along it.
  const drivable = (w) => DRIVABLE.has(w.cls);
  const snap = (x, z) => {
    const r = nearestRoad(x, z, 400, drivable) || nearestRoad(x, z, 1500, drivable);
    if (!r) return { x: q1(x), z: q1(z), heading: 0 };
    // heading: the controllers' convention (0 = facing -z, PI = facing +z); along the road
    return { x: q1(r.x), z: q1(r.z), heading: Math.round(Math.atan2(r.dx, r.dz) * 100) / 100, road: r.w.name };
  };
  const named = [
    ...pois.map(([n, k, x, z]) => ({ n, k, x, z })),
    ...bnames.map(([kind, i, n]) => (kind === 'b' ? { n, k: 'building', x: boxes[i * 10], z: boxes[i * 10 + 1] } : { n, k: 'building', x: polys[i][0][0], z: polys[i][0][1] })),
    ...places.map(([n, k, x, z]) => ({ n, k, x, z })),
    ...ways.filter((w) => w.name).map((w) => ({ n: w.name, k: 'road', x: w.pts[Math.floor(w.pts.length / 2)][0], z: w.pts[Math.floor(w.pts.length / 2)][1] })),
    ...areas.filter((a) => a.n).map((a) => {
      const c = bboxOf(a.ring);
      return { n: a.n, k: a.kind, x: (c.x0 + c.x1) / 2, z: (c.z0 + c.z1) / 2 };
    })
  ];
  const sights = [];
  for (const s of cfg.sights || []) {
    const re = s.match ? new RegExp(s.match, 'i') : null;
    const hit = re && named.find((p) => re.test(p.n));
    let x, z, found;
    if (hit) {
      x = hit.x;
      z = hit.z;
      found = 'osm';
    } else if (s.at) {
      [x, z] = P(s.at[1], s.at[0]);
      found = 'coords';
    } else continue;
    if (!inBox([x, z])) continue;
    const p = snap(x, z);
    sights.push({ id: s.id, name: s.name, sub: s.sub || p.road || '', x: p.x, z: p.z, heading: p.heading, target: [q1(x), q1(z)], from: found });
  }
  const [sLat, sLon] = cfg.spawn || cfg.origin;
  const spawnSight = cfg.spawnSight && sights.find((s) => s.id === cfg.spawnSight);
  const spawn = spawnSight ? { x: spawnSight.x, z: spawnSight.z, heading: spawnSight.heading, road: spawnSight.sub } : snap(...P(sLon, sLat));
  log(`${sights.length} sights (${sights.filter((s) => s.from === 'osm').length} found by name), spawn on ${spawn.road || 'no road'}`);

  return {
    version: 1,
    id: cfg.id,
    name: cfg.name,
    synthetic: !!cfg.synthetic,
    frame: { bearingDeg, strength: Math.round(measured.strength * 100) / 100, origin: [lat0, lon0], units: 'm', sidewalk, sidewalkHeight: 0.22, floor: FLOOR },
    bounds: { minX: q1(bb.x0), maxX: q1(bb.x1), minZ: q1(bb.z0), maxZ: q1(bb.z1) },
    box: corners.map(([x, z]) => [q1(x), q1(z)]),
    land: land.map((p) => [flatQ(p.outer), p.holes.map(flatQ)]),
    blocks: blocks.map((p) => [flatQ(p.outer), p.holes.map(flatQ)]),
    inner: inner.map((p) => [flatQ(p.outer), p.holes.map(flatQ)]),
    green: green.map((p) => [flatQ(p.outer), p.holes.map(flatQ)]),
    sand: sand.map((p) => [flatQ(p.outer), p.holes.map(flatQ)]),
    coast: coast.map(flatQ),
    rail: rail.map(flatQ),
    roads,
    roadGraph,
    buildings: { stride: 10, boxes, polys, names: bnames, styles: STYLES },
    pois,
    places,
    trees,
    lamps,
    signals,
    bus,
    sights,
    spawn
  };
}

function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('usage: node tools/build-geodata.mjs <locality-id> [out.js]');
    process.exit(1);
  }
  const cfg = loadConfig(id);
  const t0 = Date.now();
  const elements = loadRaw(cfg);
  log(`${elements.length} unique OSM elements`);
  const GEO = buildGeo(cfg, elements);
  const out = process.argv[3] || path.join(ROOT, 'js', 'geodata', `${id}.js`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const json = JSON.stringify(GEO);
  const header = `// ${path.relative(ROOT, out)} — GENERATED by tools/build-geodata.mjs ${id}, do not edit by hand.
// ${GEO.synthetic ? 'SYNTHETIC test district (tools/make-fixture.mjs): not a real place.' : `${GEO.name} in the simulation's world frame: 1 unit = 1 m, x = grid east, z = grid south, origin ${GEO.frame.origin.join(', ')}, axes turned ${GEO.frame.bearingDeg}° from true north.`}
// Polygons & polylines are flat [x0, z0, x1, z1, ...] arrays.
// Map data © OpenStreetMap contributors (ODbL), https://www.openstreetmap.org/copyright
`;
  fs.writeFileSync(out, `${header}(function () {\nwindow.NYC = window.NYC || {};\nwindow.NYC.GEO = ${json};\n})();\n`);
  log(`wrote ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
