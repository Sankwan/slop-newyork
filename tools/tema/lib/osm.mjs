// tools/lib/osm.mjs
// Turns raw Overpass `out geom` elements into simple feature records in the local frame.
// `project(lon, lat) -> [x, z]` is supplied by the caller (see src/world/geo.js makeFrame).

import { rdp } from './geo.mjs';

/** "12", "12.5 m", "40 ft", "12,5" -> metres, or null if it is not a plausible height. */
export function parseHeight(v) {
  if (v == null) return null;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(m|meters?|metres?|ft|feet|')?\s*$/i.exec(String(v));
  if (!m) return null;
  let h = parseFloat(m[1].replace(',', '.'));
  if (m[2] && /^(ft|feet|')$/i.test(m[2])) h *= 0.3048;
  return h > 0 && h <= 600 ? Math.round(h * 10) / 10 : null;
}

export function parseLevels(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n <= 150 ? n : null;
}

/** Joins open ways into closed rings (relations come as several outer ways). Unclosable chains are dropped. */
export function chainRings(parts, eps = 0.5) {
  const rings = [];
  const rest = parts.filter((p) => p.length >= 2).map((p) => p.slice());
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;
  while (rest.length) {
    let ring = rest.shift();
    for (let guard = 0; guard < 2000 && !close(ring[0], ring[ring.length - 1]); guard++) {
      const end = ring[ring.length - 1];
      const i = rest.findIndex((p) => close(p[0], end) || close(p[p.length - 1], end));
      if (i < 0) break;
      const p = rest.splice(i, 1)[0];
      ring = ring.concat(close(p[0], end) ? p.slice(1) : p.slice().reverse().slice(1));
    }
    if (ring.length >= 4 && close(ring[0], ring[ring.length - 1])) rings.push(ring.slice(0, -1));
  }
  return rings;
}

const wayPts = (e, project) => (e.geometry || []).map((g) => project(g.lon, g.lat));
const outerParts = (e, project) =>
  (e.members || []).filter((m) => m.type === 'way' && m.role === 'outer' && m.geometry).map((m) => m.geometry.map((g) => project(g.lon, g.lat)));

/** Closed rings for a way or a multipolygon relation (outer members only; inner rings are ignored in v1). */
export function elementRings(e, project) {
  if (e.type === 'way') return chainRings([wayPts(e, project)]);
  if (e.type === 'relation') return chainRings(outerParts(e, project));
  return [];
}

function cleanRing(ring) {
  const out = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.05) out.push(p);
  }
  return out;
}

export function extractBuildings(elements, project) {
  const out = [];
  for (const e of elements) {
    const t = e.tags;
    if (!t || !t.building || t.building === 'no') continue;
    elementRings(e, project).forEach((raw, k) => {
      const ring = cleanRing(raw);
      if (ring.length < 3) return;
      out.push({
        id: `${e.type[0]}${e.id}${k ? `_${k}` : ''}`,
        ring,
        h: parseHeight(t.height),
        l: parseLevels(t['building:levels']),
        t: t.building,
        n: t.name || null
      });
    });
  }
  return out;
}

const ROAD_CLASSES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
  'pedestrian', 'footway', 'path', 'steps', 'cycleway', 'track'
]);

export function extractRoads(elements, project) {
  const out = [];
  for (const e of elements) {
    const t = e.tags;
    if (e.type !== 'way' || !t || !ROAD_CLASSES.has(t.highway) || t.area === 'yes') continue;
    const pts = wayPts(e, project);
    if (pts.length < 2) continue;
    const ow = t.oneway;
    out.push({
      id: `w${e.id}`,
      cls: t.highway,
      n: t.name || null,
      w: parseHeight(t.width),
      lanes: parseLevels(t.lanes),
      ow: ow === 'yes' || ow === '1' || ow === 'true' ? 1 : ow === '-1' ? -1 : 0,
      br: t.bridge && t.bridge !== 'no' ? 1 : 0,
      tn: t.tunnel && t.tunnel !== 'no' ? 1 : 0,
      pts: rdp(pts, 0.4)
    });
  }
  return out;
}

/** The kind of ground cover or land use a tag set describes, or null if we do not draw it. */
export function areaKind(t) {
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin') return 'water';
  if (t.natural === 'wetland') return 'wetland';
  if (t.natural === 'wood' || t.landuse === 'forest') return 'wood';
  if (t.natural === 'scrub' || t.natural === 'grassland' || t.natural === 'heath') return 'scrub';
  if (t.natural === 'sand' || t.natural === 'beach') return 'sand';
  if (['park', 'garden', 'playground', 'recreation_ground', 'nature_reserve', 'golf_course'].includes(t.leisure) || t.landuse === 'recreation_ground') return 'park';
  if (t.leisure === 'pitch' || t.leisure === 'stadium' || t.leisure === 'sports_centre') return 'pitch';
  if (t.landuse === 'grass' || t.landuse === 'village_green' || t.landuse === 'meadow') return 'grass';
  if (t.landuse === 'cemetery') return 'cemetery';
  if (t.landuse === 'residential') return 'residential';
  if (t.landuse === 'commercial') return 'commercial';
  if (t.landuse === 'retail' || t.amenity === 'marketplace') return 'retail';
  if (t.landuse === 'industrial') return 'industrial';
  if (t.landuse === 'port' || t.industrial === 'port' || t.harbour === 'yes') return 'port';
  if (t.landuse === 'institutional' || ['school', 'university', 'college', 'hospital'].includes(t.amenity)) return 'institutional';
  if (t.landuse === 'construction' || t.landuse === 'brownfield') return 'construction';
  if (t.landuse === 'military') return 'military';
  if (t.aeroway === 'aerodrome') return 'airport';
  if (t.man_made === 'pier' || t.man_made === 'breakwater' || t.man_made === 'groyne') return 'pier';
  return null;
}

export function extractAreas(elements, project) {
  const out = [];
  for (const e of elements) {
    const t = e.tags;
    if (!t || t.building) continue;
    const kind = areaKind(t);
    if (!kind) continue;
    elementRings(e, project).forEach((raw, k) => {
      const ring = cleanRing(raw);
      if (ring.length < 3) return;
      out.push({ id: `${e.type[0]}${e.id}${k ? `_${k}` : ''}`, kind, n: t.name || null, ring });
    });
  }
  return out;
}

/** Coastline, waterways and railways as polylines. */
export function extractLines(elements, project) {
  const out = [];
  for (const e of elements) {
    const t = e.tags;
    if (e.type !== 'way' || !t) continue;
    let kind = null;
    let w = 0;
    if (t.natural === 'coastline') kind = 'coast';
    else if (['river', 'stream', 'canal', 'drain', 'ditch'].includes(t.waterway)) {
      kind = 'waterway';
      w = t.waterway === 'river' ? 12 : t.waterway === 'canal' ? 8 : 3;
    } else if (['rail', 'light_rail', 'narrow_gauge'].includes(t.railway)) kind = 'rail';
    if (!kind) continue;
    const pts = wayPts(e, project);
    if (pts.length >= 2) out.push({ id: `w${e.id}`, kind, w, n: t.name || null, pts: rdp(pts, 0.8) });
  }
  return out;
}

export function extractPois(elements, project) {
  const out = [];
  for (const e of elements) {
    const t = e.tags;
    if (!t) continue;
    const kind = t.amenity || t.tourism || t.historic || t.shop || t.leisure || (t.wikidata ? 'wikidata' : null);
    if (!kind || (!t.name && !t.wikidata)) continue;
    const ll = e.type === 'node' ? [e.lon, e.lat] : e.center ? [e.center.lon, e.center.lat] : null;
    if (!ll) continue;
    const [x, z] = project(ll[0], ll[1]);
    out.push({ id: `${e.type[0]}${e.id}`, x, z, k: kind, n: t.name || null, wd: t.wikidata || null });
  }
  return out;
}

/** Point furniture, as arrays of [x, z] per kind. */
export function extractFurniture(elements, project) {
  const out = { trees: [], lamps: [], signals: [], crossings: [], bus: [] };
  for (const e of elements) {
    const t = e.tags;
    if (e.type !== 'node' || !t || e.lat == null) continue;
    let list = null;
    if (t.natural === 'tree') list = out.trees;
    else if (t.highway === 'street_lamp') list = out.lamps;
    else if (t.highway === 'traffic_signals') list = out.signals;
    else if (t.highway === 'crossing') list = out.crossings;
    else if (t.highway === 'bus_stop') list = out.bus;
    if (list) list.push(project(e.lon, e.lat));
  }
  return out;
}

/** Same element can come back from several chunk queries; keep one per type+id. */
export function dedupeElements(elements) {
  const seen = new Set();
  const out = [];
  for (const e of elements) {
    const key = `${e.type}${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
