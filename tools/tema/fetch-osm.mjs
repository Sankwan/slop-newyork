#!/usr/bin/env node
// tools/fetch-osm.mjs
// Downloads OpenStreetMap data for a locality from Overpass into data/raw/<id>/, in chunks, cached.
//
// usage: node tools/fetch-osm.mjs <locality-id> [--force] [--only buildings|world]   (or --ping)
//
// Two requests per chunk: buildings, and everything else ('world'). Finished chunks are skipped on re-run, so an
// interrupted fetch resumes. Chunk files are named by their south-west corner.
// Public Overpass servers are shared: this runs sequentially with a pause between requests. Do not parallelise it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { overpass, probe, DEFAULT_ENDPOINTS } from './lib/overpass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Overpass QL for each layer; {{b}} is replaced with "south,west,north,east". */
export const LAYERS = {
  buildings: '(way["building"]({{b}});relation["building"]({{b}}););out geom;',
  roads: 'way["highway"]({{b}});out geom;',
  areas: [
    '(',
    'way["landuse"]({{b}});',
    'way["natural"~"^(water|wood|scrub|grassland|heath|sand|beach|wetland)$"]({{b}});',
    'way["leisure"~"^(park|garden|pitch|playground|stadium|sports_centre|golf_course|recreation_ground|nature_reserve)$"]({{b}});',
    'way["amenity"~"^(school|university|college|hospital|marketplace)$"]({{b}});',
    'way["aeroway"="aerodrome"]({{b}});',
    'way["man_made"~"^(pier|breakwater|groyne)$"]({{b}});',
    'way["waterway"="riverbank"]({{b}});',
    'relation["landuse"]({{b}});',
    'relation["natural"~"^(water|wood|wetland)$"]({{b}});',
    'relation["leisure"~"^(park|garden|nature_reserve)$"]({{b}});',
    ');out geom;'
  ].join(''),
  lines: '(way["natural"="coastline"]({{b}});way["waterway"~"^(river|stream|canal|drain|ditch)$"]({{b}});way["railway"~"^(rail|light_rail|narrow_gauge)$"]({{b}}););out geom;',
  pois: '(nwr["name"]["amenity"]({{b}});nwr["name"]["tourism"]({{b}});nwr["historic"]({{b}});nwr["name"]["shop"]({{b}});nwr["name"]["leisure"]({{b}});nwr["wikidata"]({{b}});node["place"]({{b}});nwr["man_made"~"^(lighthouse|tower|water_tower|chimney|crane|silo|storage_tank)$"]({{b}}););out center;',
  furniture: '(node["natural"="tree"]({{b}});node["highway"~"^(street_lamp|traffic_signals|crossing|bus_stop)$"]({{b}}););out;'
};

/** Splits [south, west, north, east] into chunk boxes of about `step` degrees. */
export function chunkBoxes(bbox, step) {
  const [s, w, n, e] = bbox;
  const rows = Math.max(1, Math.ceil((n - s) / step - 1e-9));
  const cols = Math.max(1, Math.ceil((e - w) / step - 1e-9));
  const out = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      out.push({ i, j, bbox: [s + (i * (n - s)) / rows, w + (j * (e - w)) / cols, s + ((i + 1) * (n - s)) / rows, w + ((j + 1) * (e - w)) / cols] });
    }
  }
  return out;
}

export function layerQuery(layer, bbox, timeoutS = 180) {
  const b = bbox.map((v) => +v.toFixed(6)).join(',');
  return `[out:json][timeout:${timeoutS}];${LAYERS[layer].replace(/\{\{b\}\}/g, b)}`;
}

/** File name of a chunk: by its south-west corner, so a bigger bbox on the same lattice reuses what is on disk. */
export function chunkFile(layer, c) {
  return `${layer}_${c.bbox[0].toFixed(4)}_${c.bbox[1].toFixed(4)}.json`;
}

/** Everything but the buildings, in one request per chunk (fewer requests = fewer chances to hit a busy server). */
export const WORLD_PARTS = ['roads', 'areas', 'lines', 'pois', 'furniture'];
export function worldQuery(bbox, timeoutS = 120) {
  const b = bbox.map((v) => +v.toFixed(6)).join(',');
  // each part ends in its own out statement; Overpass returns them all in one elements array
  return `[out:json][timeout:${timeoutS}];` + WORLD_PARTS.map((l) => LAYERS[l].replace(/\{\{b\}\}/g, b)).join('');
}

/**
 * Older runs named chunks by their row/column in the bbox of the time (buildings_0_1.json). Renames them to the
 * corner-based names when `cfg.legacy` gives that bbox. Returns the number of files renamed.
 */
export function migrateLegacy(dir, cfg, log = console.log) {
  if (!cfg.legacy || !fs.existsSync(dir)) return 0;
  const old = chunkBoxes(cfg.legacy.bbox, cfg.legacy.chunkDeg || 0.02);
  let n = 0;
  for (const layer of Object.keys(LAYERS)) {
    for (const c of old) {
      const from = path.join(dir, `${layer}_${c.i}_${c.j}.json`);
      const to = path.join(dir, chunkFile(layer, c));
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.renameSync(from, to);
        n++;
      }
    }
  }
  if (n) log(`renamed ${n} chunk file(s) in ${dir} to the new naming`);
  return n;
}

const has = (dirs, name) => dirs.find((d) => fs.existsSync(path.join(d, name))) || null;
const countIn = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).elements.length;

async function main() {
  if (process.argv.includes('--ping')) {
    for (const r of await probe(DEFAULT_ENDPOINTS)) console.log(`${r.ok ? 'up  ' : 'DOWN'} ${r.endpoint} (${r.ms} ms) ${r.note}`);
    return;
  }
  const id = process.argv[2];
  if (!id || id.startsWith('--')) {
    console.error('usage: node tools/fetch-osm.mjs <locality-id> [--force] [--only buildings|world]');
    process.exit(1);
  }
  const force = process.argv.includes('--force');
  const oi = process.argv.indexOf('--only');
  const kinds = oi > -1 ? [process.argv[oi + 1]] : ['world', 'buildings'];

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', `${id}.json`), 'utf8'));
  if (cfg.synthetic) throw new Error(`${id} is synthetic: nothing to fetch (use: npm run demo)`);
  const outDir = path.join(ROOT, 'data', 'raw', id);
  fs.mkdirSync(outDir, { recursive: true });
  // other folders that may already hold chunks of this locality (another checkout of the project)
  const dirs = [outDir, ...(cfg.rawDirs || []).map((d) => path.resolve(ROOT, d)).filter((d) => d !== outDir && fs.existsSync(d))];
  for (const d of dirs) migrateLegacy(d, cfg);

  const boxes = chunkBoxes(cfg.bbox, cfg.fetchChunkDeg || 0.02);
  const total = boxes.length * kinds.length;
  console.log(`${cfg.name}: ${boxes.length} chunks x ${kinds.length} (${kinds.join(' + ')}) = ${total} requests at most`);

  let done = 0;
  const failed = [];
  const totals = {};
  for (const kind of kinds) {
    for (const c of boxes) {
      done++;
      const tag = `[${done}/${total}] ${kind} ${c.bbox[0].toFixed(3)},${c.bbox[1].toFixed(3)}`;
      const name = chunkFile(kind, c);
      const at = !force && has(dirs, name);
      // a world chunk is also covered by the five per-layer files an older run wrote
      const legacyParts = kind === 'world' && !force ? WORLD_PARTS.map((l) => has(dirs, chunkFile(l, c))) : [];
      if (at || (legacyParts.length && legacyParts.every(Boolean))) {
        const n = at ? countIn(path.join(at, name)) : WORLD_PARTS.reduce((t, l, k) => t + countIn(path.join(legacyParts[k], chunkFile(l, c))), 0);
        totals[kind] = (totals[kind] || 0) + n;
        console.log(`${tag}: cached (${n})`);
        continue;
      }
      console.log(`${tag}: requesting...`);
      let json;
      try {
        json = await overpass(kind === 'world' ? worldQuery(c.bbox) : layerQuery('buildings', c.bbox, 120), cfg.endpoints || DEFAULT_ENDPOINTS);
      } catch {
        failed.push(tag.replace(/^\[[^\]]*\] /, ''));
        console.log(`${tag}: GAVE UP for now (retried on the next run)`);
        continue;
      }
      const file = path.join(outDir, name);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(json));
      fs.renameSync(`${file}.tmp`, file);
      totals[kind] = (totals[kind] || 0) + json.elements.length;
      console.log(`${tag}: ${json.elements.length} elements`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.log('\nTotals (before de-duplication across chunk edges):');
  for (const [k, v] of Object.entries(totals)) console.log(`  ${k}: ${v}`);
  if (failed.length) {
    console.error(`\n${failed.length} request(s) did not complete: ${failed.join('; ')}`);
    console.error('The public Overpass servers are busy. Finished chunks are saved: run the same command again later and only these are fetched.');
    process.exit(2);
  }
  console.log(`\nNext: npm run tiles -- ${id}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
