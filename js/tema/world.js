(function () {
// js/world.js
// Builds the city from the generated geodata (js/geodata/<id>.js) in Slop New York's style, with its own TSL
// materials (tsl-materials.js): the sea, the asphalt deck inside the coastline, raised curb islands with sidewalk
// flags and granite curbs, yards, grass & sand inside them, the buildings as box-local facade boxes (windows fitted to
// every wall, shopfronts on the street side), trees (trees.js) and streetlights with clustered light pools.
//
// Replaces the Manhattan world builders (city-grid, boroughs, buildings, landmarks, street-details) and returns what
// main.js expects from them: buildCityGrid, buildBoroughs, buildLandmarks, buildCityBlocks, buildStreetDetails.

const { THREE } = window.NYC;
const { mergeGeometries } = window.NYC.Addons;
const { color, mix, smoothstep, uniform, positionWorld, float, vec2, vec3, fract, sin, dot, floor, abs, length, cameraPosition } = window.NYC.TSL;
const {
  GEO, ISLAND_BOUNDS, LAND, cityUniforms,
  createRoadSurfaceMaterial, createSidewalkMaterial, createCurbMaterial, createParkLawnMaterial, createWaterMaterial,
  createPreWarBuildingMaterial, createCurtainWallMaterial, createFacadeBoxes, createTreeField
} = window.NYC;

const SW = GEO.frame.sidewalkHeight || 0.22;
const TILE = 800; // ground meshes are cut into tiles so the view frustum culls them (fewer, bigger tiles: fewer draws)
// ?layers=ground,buildings,details picks what to build (all by default), to measure what each part costs
const LAYERS = new Set(((typeof location !== 'undefined' && new URLSearchParams(location.search).get('layers')) || 'ground,buildings,details').split(','));

// ---------------------------------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------------------------------
const pairs = (flat) => {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};

/** Growable position/normal buffers */
function makeAcc() {
  return { pos: [], nrm: [] };
}
function accGeometry(acc) {
  if (!acc.pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nrm, 3));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** Flat polygon (outer ring + holes, [[x, z], ...]) at height y, facing up */
function addFlat(acc, outer, holes, y) {
  if (outer.length < 3) return;
  const contour = outer.map(([x, z]) => new THREE.Vector2(x, z));
  const hs = holes.filter((h) => h.length >= 3).map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
  let tris;
  try {
    tris = THREE.ShapeUtils.triangulateShape(contour, hs);
  } catch (e) {
    return;
  }
  const all = contour.concat(...hs);
  for (const [a, b, c] of tris) {
    const A = all[a], Bv = all[b], C = all[c];
    // up-facing: (B - A) x (C - A) has a positive y component (y = dz1*dx2 - dx1*dz2)
    const up = (Bv.y - A.y) * (C.x - A.x) - (Bv.x - A.x) * (C.y - A.y) > 0;
    const [p, q] = up ? [Bv, C] : [C, Bv];
    acc.pos.push(A.x, y, A.y, p.x, y, p.y, q.x, y, q.y);
    acc.nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
  }
}

/**
 * Vertical walls along a ring from y0 to y1. Rings keep their region on the left (x right, z down), so the outward
 * normal of edge (dx, dz) is (-dz, dx) for outer rings and holes alike.
 */
function addWalls(acc, ring, y0, y1, flip = false) {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    let [ax, az] = ring[j];
    let [bx, bz] = ring[i];
    if (flip) [ax, az, bx, bz] = [bx, bz, ax, az];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-4) continue;
    const nx = -(bz - az) / L;
    const nz = (bx - ax) / L;
    // triangles (a0, b0, b1), (a0, b1, a1) face (-dz, 0, dx)
    acc.pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
    for (let k = 0; k < 6; k++) acc.nrm.push(nx, 0, nz);
  }
}

/** Tiles a list of polygons by their bounding-box centre; calls build(acc, poly) per polygon, returns meshes */
function tiledMeshes(list, material, build, name, { castShadow = false, receiveShadow = true } = {}) {
  const tiles = new Map();
  for (const poly of list) {
    const f = poly[0];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < f.length; i += 2) {
      if (f[i] < x0) x0 = f[i];
      if (f[i] > x1) x1 = f[i];
      if (f[i + 1] < z0) z0 = f[i + 1];
      if (f[i + 1] > z1) z1 = f[i + 1];
    }
    // very large polygons (the land, big open blocks) go in a tile of their own
    const big = x1 - x0 > TILE * 1.5 || z1 - z0 > TILE * 1.5;
    const key = big ? `big${tiles.size}` : `${Math.floor((x0 + x1) / 2 / TILE)},${Math.floor((z0 + z1) / 2 / TILE)}`;
    if (!tiles.has(key)) tiles.set(key, makeAcc());
    build(tiles.get(key), poly);
  }
  const meshes = [];
  for (const [key, acc] of tiles) {
    const g = accGeometry(acc);
    if (!g) continue;
    const m = new THREE.Mesh(g, material);
    m.name = `${name}_${key}`;
    m.castShadow = castShadow;
    m.receiveShadow = receiveShadow;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    meshes.push(m);
  }
  return meshes;
}

// ---------------------------------------------------------------------------------------------------------------------
// Materials of our own (the rest come from tsl-materials.js)
// ---------------------------------------------------------------------------------------------------------------------
// Value noise in TSL (world-space ground variation)
const hash21 = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
function vnoise(p) {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  const a = hash21(i);
  const b = hash21(i.add(vec2(1.0, 0.0)));
  const c = hash21(i.add(vec2(0.0, 1.0)));
  const d = hash21(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Compound yards & open ground inside the curb islands: laterite red earth, worn paths, concrete & grass patches */
function createYardMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0.0 });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -2;
  const p = positionWorld.xz;
  const big = vnoise(p.mul(0.035));
  const mid = vnoise(p.mul(0.16).add(17.3));
  const fine = vnoise(p.mul(1.3).add(5.1));
  const earth = mix(color(0x8a5a3c), color(0xa8724c), mid.mul(0.7).add(fine.mul(0.3)));
  const dry = mix(earth, color(0xb49a72), smoothstep(0.55, 0.8, big)); // sun-bleached dust
  const grass = mix(color(0x55682f), color(0x6f7a3a), fine);
  const concrete = mix(color(0x9c968a), color(0xb2ac9f), fine);
  const g = smoothstep(0.62, 0.74, vnoise(p.mul(0.06).add(41.0)));
  const c = smoothstep(0.7, 0.8, vnoise(p.mul(0.045).sub(9.0)));
  mat.colorNode = mix(mix(dry, grass, g.mul(0.85)), concrete, c);
  return mat;
}

function createSandMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0.0 });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -4;
  const p = positionWorld.xz;
  mat.colorNode = mix(color(0xcdb68a), color(0xe2cfa2), vnoise(p.mul(0.3)).mul(0.6).add(vnoise(p.mul(2.1)).mul(0.4)));
  return mat;
}

function createSeawallMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0.05 });
  const p = positionWorld.xz.add(vec2(positionWorld.y.mul(3.0), 0.0));
  mat.colorNode = mix(color(0x55524c), color(0x76726a), vnoise(p.mul(0.9)));
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Ground: sea, asphalt deck, seawall, curb islands, yards, grass & sand
// ---------------------------------------------------------------------------------------------------------------------
function buildCityGrid(scene) {
  const group = new THREE.Group();
  group.name = 'CityGround';

  // The sea (Gulf of Guinea), a little below the quays
  const waterMat = createWaterMaterial();
  const seaGeo = new THREE.PlaneGeometry(60000, 60000, 1, 1);
  seaGeo.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(seaGeo, waterMat);
  sea.position.set((GEO.bounds.minX + GEO.bounds.maxX) / 2, ISLAND_BOUNDS.waterLevel, (GEO.bounds.minZ + GEO.bounds.maxZ) / 2);
  sea.name = 'Sea';
  group.add(sea);

  // The asphalt deck inside the coastline (every carriageway is the deck showing between the curb islands)
  const landPolys = GEO.land.map(([o, h]) => [o, h]);
  const roadMat = createRoadSurfaceMaterial();
  for (const m of tiledMeshes(landPolys, roadMat, (acc, [o, h]) => addFlat(acc, pairs(o), h.map(pairs), 0.0), 'RoadDeck')) group.add(m);
  // Quays & seawall down to the water
  const wallMat = createSeawallMaterial();
  for (const m of tiledMeshes(landPolys, wallMat, (acc, [o, h]) => {
    addWalls(acc, pairs(o), ISLAND_BOUNDS.waterLevel - 1.2, 0.0);
    for (const r of h) addWalls(acc, pairs(r), ISLAND_BOUNDS.waterLevel - 1.2, 0.0);
  }, 'Seawall', { castShadow: false })) group.add(m);

  if (!LAYERS.has('ground')) {
    scene.add(group);
    return { group, sidewalks: [], footprints: [], colliders: [], highwayLanes: [] };
  }
  // Curb islands: sidewalk slab on top, granite curb faces round the edge
  const sidewalkMat = createSidewalkMaterial();
  const curbMat = createCurbMaterial();
  for (const m of tiledMeshes(GEO.blocks, sidewalkMat, (acc, [o, h]) => addFlat(acc, pairs(o), h.map(pairs), SW), 'Sidewalks')) group.add(m);
  for (const m of tiledMeshes(GEO.blocks, curbMat, (acc, [o, h]) => {
    addWalls(acc, pairs(o), 0.0, SW);
    for (const r of h) addWalls(acc, pairs(r), 0.0, SW);
  }, 'Curbs')) group.add(m);

  // Behind the sidewalk: yards, grass & sand
  const yardMat = createYardMaterial();
  for (const m of tiledMeshes(GEO.inner, yardMat, (acc, [o, h]) => addFlat(acc, pairs(o), h.map(pairs), SW), 'Yards')) group.add(m);
  if (GEO.green.length) {
    const lawnMat = createParkLawnMaterial(false);
    lawnMat.polygonOffset = true;
    lawnMat.polygonOffsetFactor = -2;
    lawnMat.polygonOffsetUnits = -4;
    for (const m of tiledMeshes(GEO.green, lawnMat, (acc, [o, h]) => addFlat(acc, pairs(o), h.map(pairs), SW), 'Grass')) group.add(m);
  }
  if (GEO.sand.length) {
    const sandMat = createSandMaterial();
    for (const m of tiledMeshes(GEO.sand, sandMat, (acc, [o, h]) => addFlat(acc, pairs(o), h.map(pairs), SW), 'Sand')) group.add(m);
  }

  scene.add(group);
  return { group, sidewalks: [], footprints: [], colliders: [], highwayLanes: [] };
}

// Nothing beyond the locality's own land yet (the surrounding towns would go here)
function buildBoroughs() {
  return { colliders: [] };
}

// Hand-built landmark models will go here (Phase 4); the landmark footprints are built as ordinary buildings for now
function buildLandmarks() {
  return { colliders: [] };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Buildings
// ---------------------------------------------------------------------------------------------------------------------
// Facade palettes per style: [stone (wall), trim] pairs. Painted render in the colours seen around Tema: cream,
// off-white, pale yellow, peach, terracotta, pale blue & mint for homes; brighter and plainer for shops; concrete and
// glass for offices; grey and cream sheds; white churches & mosques; the yellow-cream of schools and offices of state.
const PALETTES = {
  house: [[0xe8dcc4, 0x9a8a72], [0xf0ece2, 0x8e8778], [0xe9d8a6, 0x9b8358], [0xe8c4a0, 0x9a7356], [0xd59a7a, 0x8c5e48], [0xc9d2d6, 0x75828a], [0xcfe0c8, 0x74866c]],
  apartments: [[0xe6dfd0, 0x8f8676], [0xd9c9a8, 0x8a7656], [0xc7cdd0, 0x6f777c]],
  shop: [[0xf2e6c9, 0x8c7b5a], [0xe4d0a8, 0x8a734e], [0xece6dc, 0x7e7a72], [0xd9b38c, 0x7f5e44]],
  office: [[0xc8c6c0, 0x6f6e6a], [0xd8d2c4, 0x7d7666]],
  industrial: [[0xb8b6b0, 0x6e6c66], [0x9aa6ae, 0x5c666c], [0xd8d2c0, 0x8a8472]],
  worship: [[0xf3f0e8, 0xb8a888]],
  civic: [[0xe6d5a8, 0x8a7a52], [0xe9e2d2, 0x8c8272]],
  hotel: [[0xe9e4da, 0x8a8478]]
};

const _matCache = new Map();
function facadeMaterial(style, variant, boxLocal) {
  const key = `${style}_${variant}_${boxLocal}`;
  if (_matCache.has(key)) return _matCache.get(key);
  const pal = PALETTES[style] || PALETTES.house;
  const [stone, trim] = pal[variant % pal.length];
  let mat;
  if (style === 'office' && variant === 0) {
    mat = createCurtainWallMaterial({ glassTint: 0x1d3446, frameTint: 0x4a5258, windowWidth: 2.2, floorHeight: GEO.frame.floor || 3.3, litProbability: 0.3, seed: 7 + variant, boxLocal });
  } else {
    const house = style === 'house';
    mat = createPreWarBuildingMaterial({
      stoneColor: stone,
      trimColor: trim,
      windowGlassColor: 0x1b2832,
      windowWidth: house ? 2.9 : style === 'industrial' ? 4.2 : 2.6,
      floorHeight: GEO.frame.floor || 3.3,
      windowRatioX: house ? 0.38 : 0.46,
      windowRatioY: house ? 0.46 : 0.52,
      litProbability: style === 'industrial' ? 0.12 : 0.34,
      warmth: 0.82,
      seed: 11 + variant * 7 + style.length,
      boxLocal,
      cornerPier: house ? 0.5 : 0.7
    });
  }
  _matCache.set(key, mat);
  return mat;
}

function buildCityBlocks(scene) {
  const group = new THREE.Group();
  group.name = 'CityBuildings';
  const colliders = [];
  if (!LAYERS.has('buildings')) {
    scene.add(group);
    return { group, colliders, quadtree: null, update() {}, updateLights: null };
  }
  const B = GEO.buildings;
  const styles = B.styles;
  const st = B.stride;

  // Facade boxes, grouped by style & palette variant: one instanced mesh each
  const byMat = new Map();
  for (let o = 0; o < B.boxes.length; o += st) {
    const [cx, cz, w, d, ryDeg, h, base, s, tone, faces] = B.boxes.slice(o, o + st);
    const style = styles[s];
    const pal = PALETTES[style] || PALETTES.house;
    const variant = Math.min(pal.length - 1, Math.floor(tone * pal.length));
    const key = `${style}_${variant}`;
    if (!byMat.has(key)) byMat.set(key, { style, variant, boxes: [] });
    const ry = (ryDeg * Math.PI) / 180;
    const y0 = base ? SW : 0;
    byMat.get(key).boxes.push({
      x: cx, y: y0 + h / 2, z: cz, w, h, d, ry, tone,
      faces: [faces % 5, Math.floor(faces / 5) % 5, Math.floor(faces / 25) % 5, Math.floor(faces / 125) % 5]
    });
    const cs = Math.cos(ry);
    const sn = Math.sin(ry);
    const hx = w / 2;
    const hz = d / 2;
    const ex = Math.abs(cs) * hx + Math.abs(sn) * hz;
    const ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
    colliders.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, maxY: y0 + h, obb: { cx, cz, hx, hz, cs, sn } });
  }
  for (const { style, variant, boxes } of byMat.values()) {
    const mesh = createFacadeBoxes(facadeMaterial(style, variant, true), boxes);
    mesh.name = `Buildings_${style}_${variant}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Irregular outlines: extruded walls and a flat roof, world-space facades
  const polyByStyle = new Map();
  for (const [flat, h, base, s] of B.polys) {
    const style = styles[s];
    if (!polyByStyle.has(style)) polyByStyle.set(style, []);
    polyByStyle.get(style).push([flat, h, base]);
    const ring = pairs(flat);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const y0 = base ? SW : 0;
    colliders.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, maxY: y0 + h, obb: { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, cs: 1, sn: 0 } });
  }
  for (const [style, list] of polyByStyle) {
    const mat = facadeMaterial(style, 0, false);
    for (const m of tiledMeshes(list.map((p) => [p[0], p]), mat, (acc, [, [flat, h, base]]) => {
      const ring = pairs(flat);
      // building outlines from OSM come either way round: walls face out when the ring has the region on its left
      let a = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      const y0 = base ? SW : 0;
      addWalls(acc, ring, y0, y0 + h, a > 0);
      addFlat(acc, ring, [], y0 + h);
    }, `BuildingOutlines_${style}`, { castShadow: true })) group.add(m);
  }

  scene.add(group);
  return { group, colliders, quadtree: null, update() {}, updateLights: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Street details: trees, streetlights & their light pools
// ---------------------------------------------------------------------------------------------------------------------
function buildStreetDetails(scene) {
  const group = new THREE.Group();
  group.name = 'CityStreetDetails';
  const signalClock = uniform(0);
  const footprints = [];
  if (!LAYERS.has('details')) {
    scene.add(group);
    return { group, footprints, signalClock, update() {} };
  }

  // Trees: mapped ones, park & open-ground trees, street trees on the sidewalks
  const sites = [];
  const T = GEO.trees;
  for (let i = 0; i < T.length; i += 3) {
    const kind = T[i + 2];
    const r = Math.abs(Math.sin(T[i] * 12.9898 + T[i + 1] * 78.233) * 43758.5453) % 1;
    sites.push({ x: T[i], y: SW, z: T[i + 1], scale: kind === 2 ? 0.7 + r * 0.25 : 0.85 + r * 0.45, species: Math.floor(r * 3) % 3 });
  }
  if (sites.length) {
    const treeField = createTreeField(scene, sites);
    group.add(treeField.group);
  }

  // Streetlights: steel pole, outreach arm over the carriageway, LED head
  const poleMat = new THREE.MeshStandardNodeMaterial({ color: 0x8c9196, roughness: 0.42, metalness: 0.75 });
  const lensMat = new THREE.MeshBasicNodeMaterial();
  lensMat.colorNode = mix(color(0x8f918c), color(0xfff1d6).mul(2.1), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const poleGeo = new THREE.CylinderGeometry(0.07, 0.11, 8.0, 8).translate(0, 4.0, 0);
  const armGeo = new THREE.BoxGeometry(1, 1, 1);
  const headGeo = new THREE.BoxGeometry(0.62, 0.12, 0.28);
  const lensGeo = new THREE.PlaneGeometry(0.5, 0.2).rotateX(Math.PI / 2).translate(0, -0.062, 0);
  const L = GEO.lamps;
  const n = L.length / 3;
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, n);
  const arms = new THREE.InstancedMesh(armGeo, poleMat, n);
  const heads = new THREE.InstancedMesh(headGeo, poleMat, n);
  const lenses = new THREE.InstancedMesh(lensGeo, lensMat, n);
  const dummy = new THREE.Object3D();
  const lampSites = [];
  const ARM = 1.8;
  for (let k = 0; k < n; k++) {
    const x = L[3 * k];
    const z = L[3 * k + 1];
    const yaw = L[3 * k + 2]; // the arm points along (sin yaw, cos yaw), over the road
    const ax = Math.sin(yaw);
    const az = Math.cos(yaw);
    const ry = Math.atan2(-az, ax); // local +x onto (ax, az)
    dummy.position.set(x, SW, z);
    dummy.rotation.set(0, ry, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    poles.setMatrixAt(k, dummy.matrix);
    dummy.position.set(x + ax * ARM * 0.5, SW + 7.85, z + az * ARM * 0.5);
    dummy.scale.set(ARM, 0.08, 0.08);
    dummy.updateMatrix();
    arms.setMatrixAt(k, dummy.matrix);
    dummy.position.set(x + ax * ARM, SW + 7.8, z + az * ARM);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    heads.setMatrixAt(k, dummy.matrix);
    lenses.setMatrixAt(k, dummy.matrix);
    lampSites.push({ x: x + ax * ARM, y: SW + 7.7, z: z + az * ARM, tx: x + ax * (ARM + 3), tz: z + az * (ARM + 3) });
    footprints.push({ minX: x - 0.3, maxX: x + 0.3, minZ: z - 0.3, maxZ: z + 0.3 });
  }
  for (const m of [poles, arms, heads]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  poles.name = 'StreetlightPoles';
  arms.name = 'StreetlightArms';
  heads.name = 'StreetlightHeads';
  lenses.name = 'StreetlightLenses';
  if (n) group.add(poles, arms, heads, lenses);

  // Light pools: the nearest lamps get a spot light each after dusk
  const POOL = 36;
  const DIST = 115;
  const lightsGroup = new THREE.Group();
  lightsGroup.name = 'StreetClusteredLights';
  scene.add(lightsGroup);
  const spots = [];
  for (let i = 0; i < POOL; i++) {
    const spot = new THREE.SpotLight(0xffe8c2, 0, 26, 0.96, 0.82, 1.25);
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    lightsGroup.add(spot, spot.target);
    spots.push(spot);
  }
  const active = [];
  const smoothFade = (d, a, b) => {
    const t = Math.min(1, Math.max(0, (b - d) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  function update(camera) {
    if (!camera) return;
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    const lampScale = Math.min(1.25, Math.max(0.0, (glow - 0.36) * 1.15));
    if (lampScale <= 0.001) {
      for (const s of spots) {
        s.intensity = 0;
        s.position.set(0, -1000, 0);
      }
      return;
    }
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const me = camera.matrixWorld.elements;
    const fwdX = -me[8];
    const fwdZ = -me[10];
    let count = 0;
    for (const s of lampSites) {
      const dx = s.x - cx;
      const dz = s.z - cz;
      const d2 = dx * dx + dz * dz + cy * cy;
      if (d2 > DIST * DIST) continue;
      const eff = Math.sqrt(d2) + Math.max(0, 6.0 - (dx * fwdX + dz * fwdZ)) * 2.8;
      if (eff >= DIST) continue;
      s._eff = eff;
      active[count++] = s;
    }
    active.length = count;
    if (count > 1) active.sort((a, b) => a._eff - b._eff);
    const cutoff = count > POOL ? Math.min(DIST, active[POOL]._eff) : DIST;
    const used = Math.min(count, POOL);
    for (let i = 0; i < used; i++) {
      const s = active[i];
      const spot = spots[i];
      spot.position.set(s.x, s.y, s.z);
      spot.target.position.set(s.tx, 0.0, s.tz);
      spot.target.updateMatrixWorld();
      spot.intensity = 88.0 * lampScale * smoothFade(s._eff, cutoff * 0.62, cutoff);
    }
    for (let i = used; i < POOL; i++) {
      spots[i].intensity = 0;
      spots[i].position.set(0, -1000, 0);
    }
  }

  scene.add(group);
  return { group, footprints, signalClock, update };
}

Object.assign(window.NYC, { buildCityGrid, buildBoroughs, buildLandmarks, buildCityBlocks, buildStreetDetails, createYardMaterial });
})();
