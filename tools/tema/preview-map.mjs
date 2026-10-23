#!/usr/bin/env node
// tools/preview-map.mjs — draws a generated geodata file as an SVG, to check the data build without the 3D viewer.
// usage: node tools/preview-map.mjs <locality-id> [out.svg] [x0,z0,x1,z1 window in metres]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const id = process.argv[2] || 'demo';
const out = process.argv[3] || path.join(ROOT, 'data', `${id}-preview.svg`);
const src = fs.readFileSync(path.join(ROOT, 'js', 'geodata', `${id}.js`), 'utf8');
const GEO = JSON.parse(src.slice(src.indexOf('window.NYC.GEO = ') + 17, src.lastIndexOf('};') + 1));
const b = GEO.bounds;
const win = process.argv[4] ? process.argv[4].split(',').map(Number) : [b.minX, b.minZ, b.maxX, b.maxZ];
const [x0, z0, x1, z1] = win;
const W = 1600;
const s = W / (x1 - x0);
const H = Math.round((z1 - z0) * s);
const X = (x) => ((x - x0) * s).toFixed(1);
const Z = (z) => ((z - z0) * s).toFixed(1);
const ring = (f) => {
  let d = '';
  for (let i = 0; i < f.length; i += 2) d += `${i ? 'L' : 'M'}${X(f[i])},${Z(f[i + 1])}`;
  return `${d}Z`;
};
const line = (f) => {
  let d = '';
  for (let i = 0; i < f.length; i += 2) d += `${i ? 'L' : 'M'}${X(f[i])},${Z(f[i + 1])}`;
  return d;
};
const poly = (list, fill, stroke = 'none') =>
  list.map(([o, holes]) => `<path d="${ring(o)}${holes.map(ring).join('')}" fill="${fill}" fill-rule="evenodd" stroke="${stroke}" stroke-width="0.6"/>`).join('');
const parts = [];
parts.push(`<rect width="${W}" height="${H}" fill="#0a1118"/>`);
parts.push(poly(GEO.land, '#363f4b')); // roadway deck (asphalt)
parts.push(poly(GEO.blocks, '#20262e', '#5b6878')); // curb islands
parts.push(poly(GEO.inner, '#1a1f26'));
parts.push(poly(GEO.green, '#19301f'));
parts.push(poly(GEO.sand, '#4a4130'));
for (const r of GEO.rail) parts.push(`<path d="${line(r)}" fill="none" stroke="#8a6d4b" stroke-width="1.2" stroke-dasharray="4 3"/>`);
const B = GEO.buildings;
const colors = ['#c9b79c', '#d9a77a', '#e0c95c', '#7fb2e0', '#9aa1ab', '#e07b6a', '#b5d18a', '#c48ad9'];
for (let i = 0; i < B.boxes.length; i += B.stride) {
  const [cx, cz, w, d, ryDeg, , , style] = B.boxes.slice(i, i + 8);
  const ry = (ryDeg * Math.PI) / 180;
  // local x maps to (cos ry, -sin ry), local z to (sin ry, cos ry)
  const ux = Math.cos(ry), uz = -Math.sin(ry), vx = Math.sin(ry), vz = Math.cos(ry);
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => [cx + (ux * a * w + vx * c * d) / 2, cz + (uz * a * w + vz * c * d) / 2]);
  parts.push(`<path d="M${pts.map(([x, z]) => `${X(x)},${Z(z)}`).join('L')}Z" fill="${colors[style]}" opacity="0.85"/>`);
}
for (const [f, , , style] of B.polys) parts.push(`<path d="${ring(f)}" fill="${colors[style]}" opacity="0.85"/>`);
// road graph links
const RG = GEO.roadGraph;
for (const [a, bb, , , , dir, inner] of RG.links) {
  const f = [RG.nodes[2 * a], RG.nodes[2 * a + 1], ...inner, RG.nodes[2 * bb], RG.nodes[2 * bb + 1]];
  parts.push(`<path d="${line(f)}" fill="none" stroke="${dir ? '#f0b429' : '#6fd3ff'}" stroke-width="0.7" opacity="0.7"/>`);
}
for (let i = 0; i < GEO.lamps.length; i += 3) parts.push(`<circle cx="${X(GEO.lamps[i])}" cy="${Z(GEO.lamps[i + 1])}" r="1.2" fill="#ffe7a0"/>`);
for (let i = 0; i < GEO.trees.length; i += 3) parts.push(`<circle cx="${X(GEO.trees[i])}" cy="${Z(GEO.trees[i + 1])}" r="1.6" fill="#3f8f4a"/>`);
for (const st of GEO.sights) parts.push(`<circle cx="${X(st.x)}" cy="${Z(st.z)}" r="5" fill="#fff"/><text x="${+X(st.x) + 8}" y="${+Z(st.z) + 4}" fill="#fff" font-size="13" font-family="sans-serif">${st.name}</text>`);
for (const [n, , x, z] of GEO.places) parts.push(`<text x="${X(x)}" y="${Z(z)}" fill="#9fb3c8" font-size="14" font-family="sans-serif" text-anchor="middle">${n}</text>`);
parts.push(`<circle cx="${X(GEO.spawn.x)}" cy="${Z(GEO.spawn.z)}" r="6" fill="none" stroke="#3ad17a" stroke-width="2"/>`);
fs.writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`);
console.log(`wrote ${out} (${W}x${H}, ${(x1 - x0).toFixed(0)} m wide)`);
