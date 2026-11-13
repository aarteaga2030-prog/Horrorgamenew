// =============================================================================
//  BLINDSIGHT — asymmetric P2P survival horror
//  Three.js (rendering) + PeerJS (host-authoritative star topology networking)
// =============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// ----------------------------------------------------------------------------
//  CONFIG
// ----------------------------------------------------------------------------
const CFG = {
  DURATION: 300,          // seconds survivors must last
  GEN_TIME: 14,           // seconds of solo repair per generator
  SURV_R: 0.35,
  MON_R: 0.45,
  SPEED: { crouch: 1.8, walk: 3.4, sprint: 6.0, monster: 4.3, monsterSprint: 6.6 },
  NOISE: { crouch: 0.15, walk: 0.5, sprint: 1.0, repair: 0.55 },
  ATTACK_RANGE: 2.3,
  ATTACK_CD: 1.6,
  SONAR_CD: 14,
  SONAR_RANGE: 42,      // the shriek finds every unhidden survivor within this range
  HEARING: Infinity,      // a human monster hears any noise, anywhere on the map (silence is the only cover)
  BOT_HEARING: 24,        // the bot monster hears noise x this many metres, so bot matches stay winnable
  HIT_INVULN: 2.5,
  MAX_HP: 2,
  MAX_RIPPLES: 64,
  NET_HZ: 20,
  PEER_PREFIX: 'blindsight-room-',
};

// ----------------------------------------------------------------------------
//  UTILITIES
// ----------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
function angleDamp(a, b, rate, dt) {
  let d = b - a;
  d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * (1 - Math.exp(-rate * dt));
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r2 = (v) => Math.round(v * 100) / 100;
const fmtTime = (s) => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ----------------------------------------------------------------------------
//  FOREST MAP
// ----------------------------------------------------------------------------
// A fenced square of night forest, 0..AREA metres on x and z. Two cabins and a shed
// each hold a generator; a campfire clearing is the survivors' camp. The exit gate is
// in the south fence, and the road beyond it (EXIT_ZONE) is the escape.
const AREA = 120;
const FENCE = 2;                                   // fence line inset from the area edge
const GATE = { x: 60, z: AREA - FENCE, w: 4.4 };   // opening in the south fence
const EXIT_ZONE = { minX: 56.5, maxX: 63.5, minZ: AREA + 1, maxZ: AREA + 14 };
const CABINS = [
  // x/z = centre, w (x) by d (z) metres, door side(s), optional interior wall
  { x: 38, z: 40, w: 10, d: 8, door: 'south', split: true },
  { x: 88, z: 68, w: 8, d: 7, door: 'west' },
  { x: 28, z: 86, w: 5, d: 4.4, door: 'east' },
  { x: 84, z: 26, w: 9, d: 12, door: 'south', chapel: true },
  { x: 15, z: 49, w: 14, d: 11, door: 'east', door2: 'south', barn: true, h: 3.6, doorW: 2.6 }, // the old barn
];
// Open-sided sawmill shed (roof on posts, walls on the north and east sides only).
const SAWMILL = { x: 106, z: 79, w: 13, d: 9 };
// Ruined stone keep: broken walls you can see over (or not), a collapsed arch and a
// hollow tower stump. Wall segments: [x0, z0, x1, z1, height].
const RUINS = { x0: 40, z0: 13, x1: 59, z1: 31, tower: { x: 55.2, z: 27, r: 1.9 } };
const RUIN_WALLS = [
  [41, 14, 48, 14, 2.6], [51, 14, 58, 14, 1.3],             // north
  [41, 14, 41, 20.5, 2.9], [41, 23.5, 41, 30, 2.0],         // west (gap = doorway)
  [41, 30, 45.6, 30, 1.2], [50.4, 30, 52.6, 30, 2.4],       // south (the arch spans the gap)
  [58, 14, 58, 18, 3.1], [58, 21.5, 58, 23.5, 1.6],         // east
  [44, 22, 50, 22, 2.2], [53, 16.5, 53, 22.5, 2.6],         // inner walls
  [46.5, 25.5, 49.5, 25.5, 1.1],                            // a low wall to crouch behind
];
const TRANSFORMER = { x: 55.5, z: 114.5 };
const TOWER = { x: 96, z: 96 };              // ranger watchtower with a sweeping searchlight
const CIRCLE = { x: 20, z: 24, r: 5 };       // standing stones; the altar is at the centre
const TRUCK = { x: 66.8, z: 109 };           // wreck by the gate
const GRAVES = { x0: 66, x1: 78, z0: 22, z1: 36 };
const LAMPS = [[61.6, 108], [50.6, 84], [73, 84.6], [62, 41]];
// Hiding places: step inside (E) and you make no sound and can't be seen or heard, but
// only for as long as you can hold your breath. ry = the way the door faces.
// type sets the model and how low you sit inside (eye height, metres).
const HIDE_TYPES = { locker: 1.45, wardrobe: 1.45, outhouse: 1.45, crypt: 1.0, truck: 1.9, log: 0.42, crate: 0.85, tent: 0.55 };
const LOCKERS = [
  { x: 38.4, z: 36.6, ry: Math.PI, type: 'locker' },          // main cabin, east room
  { x: 91.4, z: 70.6, ry: Math.PI / 2, type: 'locker' },      // hunting cabin
  { x: 80.2, z: 22, ry: -Math.PI / 2, type: 'locker' },       // chapel
  { x: 87.8, z: 28.5, ry: Math.PI / 2, type: 'locker' },      // chapel
  { x: 96, z: 99.6, ry: 0, type: 'outhouse' },                // by the tower
  { x: 46.5, z: 100.5, ry: -Math.PI / 2, type: 'outhouse' },  // by the camp
  { x: 35.8, z: 43.3, ry: 0, type: 'wardrobe' },              // main cabin, west room
  { x: 29.6, z: 84.6, ry: Math.PI, type: 'wardrobe' },        // shed
  { x: 71, z: 37.2, ry: Math.PI, type: 'crypt' },             // graveyard
  { x: 67.3, z: 108, ry: -Math.PI / 2, type: 'truck' },       // the wrecked truck's cab
  { x: 14, z: 32, ry: Math.PI / 2, type: 'log' },             // near the stone circle
  { x: 102, z: 44, ry: 0, type: 'log' },                      // east woods, by the creek
  { x: 10, z: 74, ry: Math.PI / 2, type: 'crate' },           // west woods
  { x: 33, z: 14, ry: Math.PI, type: 'crate' },               // north woods
  { x: 110, z: 70, ry: -Math.PI / 2, type: 'crate' },         // east woods
  { x: 14, z: 108, ry: 0, type: 'crate' },                    // south-west woods
  { x: 21.1, z: 44.4, ry: Math.PI, type: 'wardrobe' },        // barn (tack cabinet)
  { x: 103.5, z: 75.3, ry: Math.PI, type: 'locker' },         // sawmill
  { x: 44.6, z: 16.2, ry: Math.PI, type: 'crypt' },           // ruins
  { x: 51, z: 103, ry: -Math.PI / 4, type: 'tent' },          // camp tents, opening to the fire
  { x: 65, z: 102.5, ry: 0.82, type: 'tent' },
  { x: 67, z: 95.5, ry: 1.63, type: 'tent' },
];
const HIDE_MAX = 15, HIDE_COOLDOWN = 8;
const GENS = [
  { x: 34.6, z: 38.4, ry: Math.PI / 2 },   // main cabin, west room
  { x: 90, z: 66.4, ry: 0 },               // hunting cabin
  { x: 26.8, z: 86, ry: Math.PI / 2 },     // shed
  { x: 9.1, z: 49, ry: Math.PI / 2 },      // barn, against the west wall
  { x: 110.6, z: 77.6, ry: -Math.PI / 2 }, // sawmill
];
const ESCAPE_NEED = 4;                     // generators that must run before the gate opens
// ---- Game modes ---------------------------------------------------------------------
const MODES = {
  escape: { name: 'Escape', desc: 'Restore 4 of the 5 generators (wire each one\'s circuits) to open the gate, then get out. Survivors also win at dawn.', duration: 330 },
  ritual: { name: 'Ritual', desc: 'Find 5 relics, then banish it at the stone circle before dawn.', duration: 360 },
  survive: { name: 'Last Light', desc: 'No way out. Stay alive until dawn. The moon exposes anyone not hidden.', duration: 200 },
};
const RELIC_SPOTS = [[84, 22.2], [73, 30], [96, 93.2], [64.2, 107], [40.5, 41], [86.5, 70], [29.3, 86.9], [12, 58], [104.5, 81.5], [49, 18], [20, 96], [104, 40], [17.6, 51.2]];
// The current match's objectives: { x, z, ry, kind: 'gen' | 'relic' | 'altar' }.
let OBJ = GENS.map((g) => ({ ...g, kind: 'gen' }));
function makeObjectives(mode) {
  if (mode === 'escape') return GENS.map((g) => ({ ...g, kind: 'gen' }));
  if (mode === 'ritual') {
    const spots = RELIC_SPOTS.slice().sort(() => Math.random() - 0.5).slice(0, 5);
    return spots.map(([x, z]) => ({ x, z, ry: 0, kind: 'relic' })).concat([{ x: CIRCLE.x, z: CIRCLE.z, ry: 0, kind: 'altar' }]);
  }
  return [];
}
// The altar only works once every relic has been found.
const objLocked = (i, state) => OBJ[i].kind === 'altar' && OBJ.some((o, k) => o.kind === 'relic' && !state[k].done);
const OBJ_NOISE = { gen: 0.55, relic: 0.2, altar: 0.8 };
const CAMPFIRE = { x: 58, z: 96 };
const SPAWN_SURV = [[54, 99], [62, 99], [58, 101.5], [55, 93], [61, 93], [58, 90.5]];
const SPAWN_MON = { x: 98, z: 18 };
const PATHS = [
  [[60, AREA + 14], [60, 112], [59, 104], [58, 96]],
  [[58, 96], [53, 80], [46, 62], [40, 50], [38, 45]],
  [[58, 96], [70, 86], [80, 74], [83.5, 68]],
  [[58, 96], [44, 92], [31, 86]],
  [[40, 47], [56, 53], [72, 60], [83.5, 68]],   // trail between the two cabins
  [[56, 53], [66, 44], [78, 38], [84, 33]],     // to the chapel
  [[36, 46], [27, 38], [21, 30]],               // to the stone circle
  [[70, 86], [84, 92], [93, 95.5]],             // to the watchtower
  [[36, 46], [27, 48], [22.5, 49]],             // to the barn
  [[80, 74], [93, 77.5], [99.5, 79]],           // to the sawmill
  [[43.5, 46.5], [47, 38], [48, 31]],           // to the ruins' arch
];
const doorPos = (c) => ({
  south: { x: c.x, z: c.z + c.d / 2 }, north: { x: c.x, z: c.z - c.d / 2 },
  east: { x: c.x + c.w / 2, z: c.z }, west: { x: c.x - c.w / 2, z: c.z },
}[c.door]);

// ---- Colliders: circles (trees, rocks) and boxes (walls, fence) in a 4 m spatial hash
const COLLIDERS = [];
const colHash = new Map();
const COL_CELL = 4;
const colKey = (cx, cz) => (cx + 64) * 1024 + (cz + 64);
function addCollider(c) {
  COLLIDERS.push(c);
  const [x0, z0, x1, z1] = c.t === 0 ? [c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r] : [c.minX, c.minZ, c.maxX, c.maxZ];
  for (let cx = Math.floor(x0 / COL_CELL); cx <= Math.floor(x1 / COL_CELL); cx++)
    for (let cz = Math.floor(z0 / COL_CELL); cz <= Math.floor(z1 / COL_CELL); cz++) {
      const k = colKey(cx, cz); if (!colHash.has(k)) colHash.set(k, []); colHash.get(k).push(c);
    }
}
const addCircle = (x, z, r, tag) => addCollider({ t: 0, x, z, r, tag });
const addBox = (minX, minZ, maxX, maxZ, tag) => addCollider({ t: 1, minX, minZ, maxX, maxZ, tag });
// Circle-vs-shape push-out, gives smooth sliding along walls and round trunks.
function resolveCollision(p, r) {
  for (let iter = 0; iter < 3; iter++) {
    const cx0 = Math.floor(p.x / COL_CELL), cz0 = Math.floor(p.z / COL_CELL);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const list = colHash.get(colKey(cx0 + dx, cz0 + dz));
      if (!list) continue;
      for (const c of list) {
        if (c.tag === 'gate' && game.gateOpen) continue;
        if (c.t === 0) {
          const ox = p.x - c.x, oz = p.z - c.z, d = Math.hypot(ox, oz), min = c.r + r;
          if (d >= min) continue;
          if (d > 1e-6) { p.x = c.x + (ox / d) * min; p.z = c.z + (oz / d) * min; } else p.x += min;
        } else {
          const qx = clamp(p.x, c.minX, c.maxX), qz = clamp(p.z, c.minZ, c.maxZ);
          const ox = p.x - qx, oz = p.z - qz, d2 = ox * ox + oz * oz;
          if (d2 >= r * r) continue;
          if (d2 > 1e-8) { const d = Math.sqrt(d2); p.x += (ox / d) * (r - d); p.z += (oz / d) * (r - d); }
          else {
            const l = p.x - c.minX, rr = c.maxX - p.x, t = p.z - c.minZ, bt = c.maxZ - p.z, m = Math.min(l, rr, t, bt);
            if (m === l) p.x = c.minX - r; else if (m === rr) p.x = c.maxX + r; else if (m === t) p.z = c.minZ - r; else p.z = c.maxZ + r;
          }
        }
      }
    }
  }
}
function moveWithCollision(p, dx, dz, r) {
  const len = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(len / (r * 0.7)));
  for (let i = 0; i < steps; i++) { p.x += dx / steps; p.z += dz / steps; resolveCollision(p, r); }
}
const inExit = (x, z) => x > EXIT_ZONE.minX && x < EXIT_ZONE.maxX && z > EXIT_ZONE.minZ;

// ---- Navigation grid (0.5 m cells) for bots ---------------------------------------
const NAV_RES = 2; // cells per metre
const NAV_W = AREA * NAV_RES, NAV_H = Math.ceil(EXIT_ZONE.maxZ * NAV_RES) + 1;
const navBlocked = new Uint8Array(NAV_W * NAV_H); // 0 free, 1 blocked, 2 gate, 3 exit road
const navIdx = (x, z) => z * NAV_W + x;
const tileOf = (x, z) => ({ x: clamp(Math.floor(x * NAV_RES), 0, NAV_W - 1), z: clamp(Math.floor(z * NAV_RES), 0, NAV_H - 1) });
const tileCenter = (x, z) => new THREE.Vector3((x + 0.5) / NAV_RES, 0, (z + 0.5) / NAV_RES);
function buildNav() {
  // Clearance covers the widest agent (the monster, 0.45 m) so every free cell is reachable.
  const AG = 0.55, AGB = 0.47;
  for (let z = 0; z < NAV_H; z++) for (let x = 0; x < NAV_W; x++) {
    const px = (x + 0.5) / NAV_RES, pz = (z + 0.5) / NAV_RES;
    let v = 0;
    const inside = px > FENCE && px < AREA - FENCE && pz > FENCE && pz < AREA - FENCE;
    const road = px > EXIT_ZONE.minX && px < EXIT_ZONE.maxX && pz >= AREA - FENCE - 1;
    if (!inside && !road) v = 1;
    if (road && pz > AREA - FENCE + 0.6) v = 3;
    if (!v && distToPolyline(px, pz, CREEK) < CREEK_W / 2 + 0.3 && !onBridge(px, pz)) v = 1; // bots cross by the bridges
    if (!v) {
      const near = [];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) near.push(...(colHash.get(colKey(Math.floor(px / COL_CELL) + dx, Math.floor(pz / COL_CELL) + dz)) || []));
      for (const c of near) {
        const hit = c.t === 0 ? Math.hypot(px - c.x, pz - c.z) < c.r + AG
          : px > c.minX - AGB && px < c.maxX + AGB && pz > c.minZ - AGB && pz < c.maxZ + AGB;
        if (hit) { v = c.tag === 'gate' ? 2 : 1; if (v === 1) break; }
      }
    }
    navBlocked[navIdx(x, z)] = v;
  }
}
const navOpen = (x, z, allowExit) => {
  if (x < 0 || z < 0 || x >= NAV_W || z >= NAV_H) return false;
  const v = navBlocked[navIdx(x, z)];
  return v === 0 || (allowExit && game.gateOpen && (v === 2 || v === 3));
};
const NAV_FREE = [];
// 8-way breadth-first search on the nav grid, then line-of-sight smoothing.
const _prev = new Int32Array(NAV_W * NAV_H), _queue = new Int32Array(NAV_W * NAV_H);
function bfsPath(from, to, allowExit = false) {
  if (!navOpen(to.x, to.z, allowExit)) to = nearestOpen(to, allowExit);
  if (!to) return [];
  _prev.fill(-2);
  let head = 0, tail = 0;
  const start = navIdx(from.x, from.z), goal = navIdx(to.x, to.z);
  _prev[start] = -1; _queue[tail++] = start;
  while (head < tail) {
    const c = _queue[head++];
    if (c === goal) break;
    const cx = c % NAV_W, cz = (c / NAV_W) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nx = cx + dx, nz = cz + dz;
      if (!navOpen(nx, nz, allowExit)) continue;
      if (dx && dz && (!navOpen(cx + dx, cz, allowExit) || !navOpen(cx, cz + dz, allowExit))) continue; // no corner cutting
      const n = navIdx(nx, nz);
      if (_prev[n] !== -2) continue;
      _prev[n] = c; _queue[tail++] = n;
    }
  }
  if (_prev[goal] === -2) return [];
  const raw = [];
  for (let k = goal; k !== -1; k = _prev[k]) raw.push({ x: k % NAV_W, z: (k / NAV_W) | 0 });
  raw.reverse();
  // Smooth: from each kept point, jump to the furthest point still in clear line of sight.
  const out = [raw[0]];
  let i = 0;
  while (i < raw.length - 1) {
    let j = Math.min(raw.length - 1, i + 30);
    while (j > i + 1 && !navLine(raw[i], raw[j], allowExit)) j--;
    out.push(raw[j]); i = j;
  }
  return out;
}
function navLine(a, b, allowExit) {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * 2);
  for (let k = 1; k < n; k++) {
    const t = k / n;
    if (!navOpen(Math.floor(a.x + 0.5 + (b.x - a.x) * t), Math.floor(a.z + 0.5 + (b.z - a.z) * t), allowExit)) return false;
  }
  return true;
}
function nearestOpen(t, allowExit) {
  for (let r = 1; r < 12; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++)
    if (navOpen(t.x + dx, t.z + dz, allowExit)) return { x: t.x + dx, z: t.z + dz };
  return null;
}
const randomFloorTile = () => NAV_FREE[Math.floor(Math.random() * NAV_FREE.length)];
const genPos = (i) => new THREE.Vector3(OBJ[i].x, 0, OBJ[i].z);
// A free nav cell beside each generator, on its working side.
const genApproach = (i) => { const o = OBJ[i], off = o.kind === 'relic' ? 0 : 1.2, t = tileOf(o.x + Math.sin(o.ry) * off, o.z + Math.cos(o.ry) * off); return navOpen(t.x, t.z, false) ? t : (nearestOpen(t, false) || t); };

// ----------------------------------------------------------------------------
//  RENDERER, SCENE, CAMERA
// ----------------------------------------------------------------------------
const canvas = $('#game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 400);
camera.rotation.order = 'YXZ';
scene.add(camera);
const survivorFog = new THREE.FogExp2(0x04060a, 0.045);
const clock = new THREE.Clock();
let time = 0;

// ----------------------------------------------------------------------------
//  MONSTER VISION: world-space grid + sonar ripple shader
// ----------------------------------------------------------------------------
// Shared uniforms: every sonar material references the SAME objects, so pushing
// one ripple updates the whole world in a single write.
const sonarShared = {
  uTime: { value: 0 },
  uCamPos: { value: new THREE.Vector3() },
  uRip: { value: Array.from({ length: CFG.MAX_RIPPLES }, () => new THREE.Vector4(0, 0, 0, -999)) },  // xyz origin, w start time
  uRipP: { value: Array.from({ length: CFG.MAX_RIPPLES }, () => new THREE.Vector3(0, 0, 1)) },       // x maxRadius, y strength, z speed
};
// Skinning chunks let animated (SkinnedMesh) characters deform in monster vision too.
const SONAR_VERT = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    vec4 wp = modelMatrix * vec4(transformed, 1.0);
    vWorld = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * objectNormal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
// ECHO VISION. The monster "sees" by a faint grid of light cast from its own eyes: the
// lines are laid out by viewing angle (yaw/pitch from the camera), not on each surface,
// so in silence they run unbroken across trees, ground and bodies alike and nothing has
// depth or shape. Sound is what gives the world form:
//  - the wavefront: a white-hot shell racing out from the noise;
//  - resonance: a surface keeps ringing for a moment after the front passes, then fades;
//  - while it rings, it shows contour rings around the source (lines of equal distance,
//    which bend over the shape of whatever they land on), and surfaces that face the
//    sound echo harder than ones turned away, so ridges, trunks and walls read as solid.
// Bodies get no glow, outline or colour of their own. A passing sound just draws its
// ripple rings over them tighter and brighter (uRingScale, uRingGain) and holds them a
// little longer, so the rings visibly wrap around a figure instead of crossing it in a
// couple of frames. A silent body is still just more grid.
const SONAR_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCamPos;
  uniform vec4 uRip[MAXR];
  uniform vec3 uRipP[MAXR];
  uniform float uBase;      // ambient visibility (barely visible)
  uniform float uGain;      // how strongly ripples light this surface
  uniform float uGrid;      // grid spacing in degrees of view angle
  uniform float uNearGain;  // faint "touch" sense right around the monster
  uniform float uHold;      // seconds a surface keeps ringing after a wavefront passes
  uniform float uRingScale; // contour ring spacing multiplier (bodies use tighter rings)
  uniform float uRingGain;  // contour ring brightness
  uniform float uRingFace;  // 1 = rings dim on surfaces turned away from the sound; 0 = even
  uniform vec3 uColor;
  varying vec3 vWorld;
  varying vec3 vNormalW;

  // Anti-aliased line for a coordinate measured in "line units" (one line per 1.0).
  float aaLine(float a, float a2, float px) {
    float w = min(fwidth(a), fwidth(a2));
    float g = abs(fract(a - 0.5) - 0.5) / max(w, 1e-4);
    return 1.0 - smoothstep(0.0, px, g);
  }
  float hash3(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }

  void main() {
    vec3 toCam = uCamPos - vWorld;
    vec3 dir = normalize(-toCam);
    float yaw = degrees(atan(dir.x, dir.z)) / uGrid;            // -180..180 degrees
    float yaw2 = degrees(atan(-dir.x, -dir.z)) / uGrid;         // same lines, seam on the other side
    float pitch = degrees(asin(clamp(dir.y, -1.0, 1.0))) / uGrid;
    float lines = max(aaLine(yaw, yaw2, 1.0), aaLine(pitch, pitch, 1.0));
    vec3 N = normalize(vNormalW);
    if (!gl_FrontFacing) N = -N;
    float dpx = length(fwidth(vWorld));            // world metres per pixel here (derivatives stay outside the loop)

    float energy = 0.0, hot = 0.0, contour = 0.0;
    for (int i = 0; i < MAXR; i++) {
      vec4 r = uRip[i];
      vec3 p = uRipP[i];
      float age = uTime - r.w;
      if (age < 0.0 || p.y <= 0.0) continue;
      float d = distance(vWorld, r.xyz);
      if (d > p.x) continue;                       // beyond this sound's reach
      float rad = age * p.z, x = d - rad;
      if (x > 1.6) continue;                       // the wave hasn't reached here yet
      float tp = max(-x, 0.0) / p.z;               // seconds since the front passed here
      if (tp > uHold * 4.0) continue;              // finished ringing
      float fade = 1.0 - d / p.x;
      fade *= fade * p.y;
      // the travelling front: a broad band plus a razor-thin leading edge
      float w = 0.3 + d * 0.05;
      float front = exp(-x * x / (w * w));
      float ew = 0.05 + d * 0.004;
      float edge = exp(-x * x / (ew * ew));
      // resonance left behind it
      float mem = exp(-tp / uHold) * smoothstep(0.4, -0.2, x);
      // contour rings of equal distance from the sound, drifting slowly outward
      float cs = (0.8 + d * 0.025) * uRingScale;
      float cv = (d - age * 0.9) / cs;
      float cl = 1.0 - smoothstep(0.0, 1.4, abs(fract(cv - 0.5) - 0.5) * cs / max(dpx, 1e-4));
      // surfaces turned toward the sound echo harder
      float face = 0.3 + 0.7 * max(dot(N, normalize(r.xyz - vWorld)), 0.0);
      energy += (front * 0.85 + mem * 0.09) * fade * mix(1.0, face, 0.7);
      contour += cl * mem * fade * mix(1.0, face, uRingFace);
      hot += edge * fade;
    }
    // glitter where the wavefront passes
    float spark = step(0.9, hash3(floor(vWorld * 7.0) + floor(uTime * 14.0)));
    hot *= 0.65 + spark * 1.7;
    float near = (1.0 - smoothstep(0.0, 5.0, length(toCam))) * uNearGain;
    float I = uBase + energy * uGain + near;
    float H = min(hot * uGain, 3.0);
    vec3 white = mix(uColor, vec3(0.78, 1.0, 0.96), 0.75);
    vec3 col = uColor * (lines * I * 1.8 + I * 0.05) + uColor * min(contour * uGain, 1.5) * uRingGain
             + white * H * (0.22 + lines * 1.2);
    col = mix(col, vec3(dot(col, vec3(0.33))) * vec3(0.82, 1.0, 1.0), clamp(I - 1.1, 0.0, 0.5)); // the loudest sounds bleach toward white
    gl_FragColor = vec4(col, 1.0);
  }`;
function makeSonarMaterial({ base, gain, grid, near, color, hold = 0.55, ringScale = 1, ringGain = 0.6, ringFace = 1 }) {
  return new THREE.ShaderMaterial({
    defines: { MAXR: CFG.MAX_RIPPLES },
    uniforms: Object.assign({}, sonarShared, {
      uBase: { value: base }, uGain: { value: gain }, uGrid: { value: grid },
      uNearGain: { value: near }, uColor: { value: new THREE.Color(color) },
      uHold: { value: hold }, uRingScale: { value: ringScale }, uRingGain: { value: ringGain }, uRingFace: { value: ringFace },
    }),
    vertexShader: SONAR_VERT,
    fragmentShader: SONAR_FRAG,
  });
}
const SONAR_MATS = {
  env: makeSonarMaterial({ base: 0.035, gain: 1.0, grid: 1.6, near: 0, color: 0x2bff7a }),
  gen: makeSonarMaterial({ base: 0.2, gain: 1.0, grid: 1.6, near: 0, color: 0xb4ff3b }),   // objectives faintly visible
  // Bodies: the same faint grid and colour as the world, with no glow or outline. A sound
  // passing over them draws its ripple rings tighter, brighter and evenly all the way round,
  // and holds them a little longer, so the rings visibly wrap around a figure.
  entity: makeSonarMaterial({ base: 0.035, gain: 1.0, grid: 1.6, near: 0, color: 0x2bff7a, hold: 0.8, ringScale: 0.35, ringGain: 1.8, ringFace: 0 }),
};
// A shell around the world, seen only in monster vision, carries the same grid past the
// treetops so nothing stands out as a silhouette against an empty sky.
const monsterSky = new THREE.Mesh(new THREE.SphereGeometry(190, 32, 16), makeSonarMaterial({ base: 0.035, gain: 0, grid: 1.6, near: 0, color: 0x2bff7a, hold: 0.01 }));
monsterSky.material.side = THREE.BackSide;
monsterSky.frustumCulled = false;

// Ripple ring buffer
let rippleIdx = 0;
const MAP_REACH = 170; // metres: corner to corner of the forest, so a ring always reaches the far edge
function addRipple(pos, maxR, strength, speed, local = false) {
  const i = rippleIdx; rippleIdx = (rippleIdx + 1) % CFG.MAX_RIPPLES;
  sonarShared.uRip.value[i].set(pos.x, pos.y + heightAt(pos.x, pos.z), pos.z, time); // y is height above the ground
  // Every sound travels all the way to the edges of the map, fading gradually as it
  // spreads; loudness is carried by strength. The only exception is the monster's own
  // footfalls (local), which just let it feel the walls around it.
  if (local) sonarShared.uRipP.value[i].set(maxR, strength, speed || 8);
  else sonarShared.uRipP.value[i].set(MAP_REACH, strength, Math.max(speed || 0, 24));
  if (strength >= 0.3 && game.phase === 'playing') { hudPings.push({ x: pos.x, z: pos.z, s: strength, t: time }); if (hudPings.length > 48) hudPings.shift(); }
}
function clearRipples() { for (const v of sonarShared.uRip.value) v.w = -999; hudPings.length = 0; }
// ---- Sound compass: arcs on a ring around the monster's view point toward each sound,
// so it can turn toward a noise behind it. Louder = brighter and thicker; nearer = wider.
const hudPings = [];
const sonarHud = $('#sonar-hud'), hudCtx = sonarHud.getContext('2d');
function drawSonarHud() {
  const show = me.isMonster && game.phase === 'playing' && me.status === 'alive' && viewMode === 'monster';
  sonarHud.classList.toggle('hidden', !show);
  if (!show) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = window.innerWidth, H = window.innerHeight;
  if (sonarHud.width !== Math.round(W * dpr) || sonarHud.height !== Math.round(H * dpr)) { sonarHud.width = Math.round(W * dpr); sonarHud.height = Math.round(H * dpr); }
  const g = hudCtx; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.38;
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(57,255,138,0.07)'; g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2 - Math.PI / 2, l = k % 6 === 0 ? 9 : 4;
    g.strokeStyle = `rgba(57,255,138,${k % 6 === 0 ? 0.2 : 0.08})`;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * (R - l), cy + Math.sin(a) * (R - l)); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke();
  }
  const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw), rx = Math.cos(me.yaw), rz = -Math.sin(me.yaw);
  for (const p of hudPings) {
    const age = time - p.t; if (age < 0 || age > 2.6) continue;
    const dx = p.x - me.pos.x, dz = p.z - me.pos.z, d = Math.hypot(dx, dz); if (d < 3) continue;
    const th = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) - Math.PI / 2;  // 0 = straight ahead, at the top
    const k = Math.pow(1 - age / 2.6, 1.5), loud = Math.min(1.4, p.s), w = clamp(0.42 - d / 140, 0.07, 0.42);
    const col = loud > 0.9 ? '210,255,240' : '57,255,138';
    g.strokeStyle = `rgba(${col},${0.85 * k * Math.min(1, loud + 0.2)})`; g.lineWidth = 2 + loud * 5;
    g.beginPath(); g.arc(cx, cy, R, th - w, th + w); g.stroke();
    g.strokeStyle = `rgba(${col},${0.35 * k})`; g.lineWidth = 1.5;                    // an echo of it rippling outward
    g.beginPath(); g.arc(cx, cy, R + 6 + age * 26, th - w * 0.8, th + w * 0.8); g.stroke();
  }
}

// Material swapping: each mesh owns a survivor material and a monster material.
const swappables = [];
let viewMode = 'monster';
function reg(obj, kind = 'env') {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const entry = { mesh: o, s: o.material, m: SONAR_MATS[kind] };
    swappables.push(entry);
    o.material = viewMode === 'monster' ? entry.m : entry.s;
  });
  return obj;
}
function unreg(obj) {
  obj.traverse((o) => { const i = swappables.findIndex((e) => e.mesh === o); if (i >= 0) swappables.splice(i, 1); });
}
const survivorOnly = []; // lights, sprites, etc. that only exist in the survivor's world
function setViewMode(mode) {
  viewMode = mode;
  const mon = mode === 'monster';
  for (const e of swappables) e.mesh.material = mon ? e.m : e.s;
  for (const o of survivorOnly) o.visible = !mon;
  monsterSky.visible = mon;
  scene.fog = mon ? null : survivorFog;
  scene.background = new THREE.Color(mon ? 0x000000 : 0x04060a);
  flashlight.visible = !mon && flashlightOn;
}

// ----------------------------------------------------------------------------
//  POST-PROCESSING
// ----------------------------------------------------------------------------
const SonarPostShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2() }, uPulse: { value: 0 },
    uShock: { value: 0 }, uGlitch: { value: 0 }, uBeat: { value: 0 }, uGal: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes; uniform float uPulse;
    uniform float uShock;   // shriek shockwave, 1 -> 0 as the ring leaves the screen
    uniform float uGlitch;  // the signal tearing when it strikes or kills
    uniform float uBeat;    // its own heartbeat
    uniform float uGal;     // galloping
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
    void main(){
      vec2 c0 = vUv - 0.5;
      float lc = length(c0);
      // Glitch: bands of the picture tear sideways
      float tick = floor(uTime * 20.0), band = floor(vUv.y * 26.0);
      float tear = (hash(vec2(band, tick)) - 0.5) * step(0.62, hash(vec2(band * 1.7, tick + 3.0))) * uGlitch * 0.13;
      // Shockwave: a ring of bent light racing out from the centre of vision
      float rs = (1.0 - uShock) * 0.95, ringS = exp(-pow((lc - rs) / 0.045, 2.0)) * uShock;
      vec2 uv0 = vUv + vec2(tear, 0.0) + (c0 / max(lc, 1e-4)) * ringS * 0.035;
      vec2 c = uv0 - 0.5;
      vec2 uv = 0.5 + c * (1.0 + 0.07 * dot(c, c));       // CRT barrel
      float ab = 0.0015 + uPulse * 0.004 + uGlitch * 0.014 + ringS * 0.012;  // chromatic split
      vec3 col;
      col.r = texture2D(tDiffuse, uv + vec2(ab, 0.0)).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - vec2(ab, 0.0)).b;
      // Galloping: the edges of vision smear back
      if (uGal > 0.01) {
        vec3 acc = vec3(0.0);
        for (int k = 1; k <= 3; k++) acc += texture2D(tDiffuse, uv - c * float(k) * 0.016 * uGal).rgb;
        col = mix(col, acc / 3.0, smoothstep(0.22, 0.55, lc) * uGal * 0.5);
      }
      float scan = 0.82 + 0.18 * sin(uv.y * uRes.y * 1.3 + uTime * 6.0);
      col *= scan;
      // A slow sweep line rolls down the view like a radar trace
      float sweep = exp(-pow((uv.y - (1.0 - fract(uTime * 0.17))) * 38.0, 2.0));
      col += col * sweep * 0.7 + vec3(0.0, 0.05, 0.035) * sweep;
      col += vec3(0.0, 0.035, 0.015) * hash(uv * (uTime + 1.0));
      col += vec3(0.25, 0.95, 0.75) * ringS * 0.22;
      // Veins at the rim of its vision, swelling with each heartbeat
      float n = vnoise(c * 6.0 + 3.1) * 0.6 + vnoise(c * 13.0 + 7.7) * 0.3 + vnoise(c * 27.0) * 0.1;
      float vein = (1.0 - smoothstep(0.0, 0.03 + uBeat * 0.012, abs(n - 0.5))) * smoothstep(0.33, 0.66, lc);
      float vig = smoothstep(0.85 - uBeat * 0.05 - uGal * 0.08, 0.2, lc);
      col *= vig;
      col = mix(col, vec3(0.16, 0.0, 0.015), vein * (0.55 + 0.4 * uBeat));
      col += vec3(0.0, 0.08, 0.04) * uPulse * (1.0 - vig * 0.5);
      col += vec3(0.06, 0.0, 0.0) * uBeat * (1.0 - vig);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);
      gl_FragColor = vec4(col, 1.0);
    }`,
};
const SurvivorPostShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uDamage: { value: 0 }, uLowHp: { value: 0 }, uFear: { value: 0 }, uFlash: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uDamage; uniform float uLowHp; uniform float uFear; uniform float uFlash;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      vec2 uv = vUv + c * uFear * 0.01 * sin(uTime * 7.0);
      // Lens fringing that grows with fear, toward the edges of the frame
      vec2 ca = c * (0.0025 + uFear * 0.012) * dot(c, c) * 4.0;
      vec3 col = vec3(texture2D(tDiffuse, uv + ca).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - ca).b);
      // Grade: cold shadows, warm highlights
      float l0 = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col * vec3(0.86, 0.98, 1.14), col * vec3(1.1, 1.0, 0.88), smoothstep(0.15, 0.8, l0));
      col *= 1.0 + uFlash * 0.6;
      float vig = smoothstep(0.9 - uFear * 0.2, 0.2, length(c));
      col *= mix(0.45, 1.0, vig);
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(lum), 0.3 + uFear * 0.3);
      col += (hash(vUv * (uTime + 3.0)) - 0.5) * 0.02;
      float red = uDamage + uLowHp * (0.5 + 0.5 * sin(uTime * 5.0)) * 0.4;
      col += vec3(0.55, 0.0, 0.0) * red * (1.0 - vig * 0.75);
      gl_FragColor = vec4(col, 1.0);
    }`,
};
function buildComposer(passShader, bloom) { // bloom: false, true (monster defaults) or [strength, radius, threshold]
  const comp = new EffectComposer(renderer);
  comp.addPass(new RenderPass(scene, camera));
  let bloomPass = null;
  if (bloom) { const [st, ra, th] = bloom === true ? [0.85, 0.5, 0.03] : bloom; bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), st, ra, th); comp.addPass(bloomPass); }
  const pass = new ShaderPass(passShader);
  comp.addPass(pass);
  comp.addPass(new OutputPass());
  return { comp, pass, bloomPass };
}
const monsterPost = buildComposer(SonarPostShader, true);
const survivorPost = buildComposer(SurvivorPostShader, [0.55, 0.7, 0.85]); // fire, windows, relics and eyes glow

// ----------------------------------------------------------------------------
//  PROCEDURAL TEXTURES (no external assets)
// ----------------------------------------------------------------------------
function canvasTex(size, draw, rx = 1, ry = rx) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); draw(g, size, mulberry32(size * 7 + rx * 13));
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
function grime(g, s, rng, n, alpha, rgb = '20,16,10') {
  for (let i = 0; i < n; i++) {
    const x = rng() * s, y = rng() * s, r = rng() * s * 0.08 + 2;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(${rgb},${alpha * rng()})`); grd.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
}
function speck(g, s, rng, n) {
  for (let i = 0; i < n; i++) { const v = 40 + rng() * 60; g.fillStyle = `rgba(${v},${v},${v},${rng() * 0.25})`; g.fillRect(rng() * s, rng() * s, 1 + rng() * 2, 1 + rng() * 2); }
}
const GROUND = AREA + 120; // ground plane size (reaches well past the fence)
const TEX = {
  ground: canvasTex(512, (g, s, rng) => {
    g.fillStyle = '#26271b'; g.fillRect(0, 0, s, s);
    grime(g, s, rng, 60, 0.5, '48,40,24');                       // soil patches
    grime(g, s, rng, 40, 0.45, '34,48,24');                      // moss
    for (let i = 0; i < 2600; i++) {                            // fallen needles and twigs
      const x = rng() * s, y = rng() * s, a = rng() * Math.PI, l = 3 + rng() * 9, v = 60 + rng() * 50;
      g.strokeStyle = `rgba(${v + 20},${v},${v * 0.55},${0.25 + rng() * 0.4})`; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    for (let i = 0; i < 500; i++) { const v = 50 + rng() * 40; g.fillStyle = `rgba(${v * 0.7},${v},${v * 0.5},0.5)`; g.fillRect(rng() * s, rng() * s, 1, 2 + rng() * 4); } // grass blades
  }, GROUND / 6),
  path: canvasTex(256, (g, s, rng) => {
    g.fillStyle = '#3d3424'; g.fillRect(0, 0, s, s);
    grime(g, s, rng, 30, 0.6, '28,22,14'); speck(g, s, rng, 1500);
  }),
  hay: canvasTex(256, (g, s, rng) => {
    g.fillStyle = '#6e5a2e'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2200; i++) {
      const x = rng() * s, y = rng() * s, a = (rng() - 0.5) * 0.5, l = 6 + rng() * 16, v = 120 + rng() * 90;
      g.strokeStyle = `rgba(${v},${v * 0.85},${v * 0.45},${0.35 + rng() * 0.5})`; g.lineWidth = 1 + rng();
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    g.fillStyle = 'rgba(30,22,10,0.5)'; g.fillRect(0, s * 0.3, s, 3); g.fillRect(0, s * 0.7, s, 3); // twine
  }),
  canvas: canvasTex(256, (g, s, rng) => {
    g.fillStyle = '#8a8a70'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < s; i += 2) { g.fillStyle = `rgba(0,0,0,${0.04 + rng() * 0.05})`; g.fillRect(i, 0, 1, s); g.fillRect(0, i, s, 1); }
    grime(g, s, rng, 26, 0.55, '40,36,24');
  }),
  bark: canvasTex(256, (g, s, rng) => {
    g.fillStyle = '#2e241b'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 70; i++) { const x = rng() * s, v = 20 + rng() * 40; g.fillStyle = `rgba(${v + 15},${v + 8},${v},0.7)`; g.fillRect(x, 0, 1 + rng() * 4, s); }
    for (let i = 0; i < 90; i++) { const v = 10 + rng() * 15; g.fillStyle = `rgba(${v},${v},${v},0.6)`; g.fillRect(rng() * s, rng() * s, 3 + rng() * 10, 1 + rng() * 3); }
  }),
  needles: canvasTex(256, (g, s, rng) => {
    g.fillStyle = '#16231a'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 3000; i++) {
      const x = rng() * s, y = rng() * s, a = Math.PI / 2 + (rng() - 0.5) * 1.2, l = 4 + rng() * 6, v = 25 + rng() * 45;
      g.strokeStyle = `rgba(${v * 0.6},${v},${v * 0.7},0.8)`; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
  }),
  logs: canvasTex(512, (g, s, rng) => {
    const n = 8, h = s / n;
    for (let i = 0; i < n; i++) {
      const v = 70 + rng() * 25, grd = g.createLinearGradient(0, i * h, 0, (i + 1) * h);
      grd.addColorStop(0, `rgb(${v * 0.45},${v * 0.33},${v * 0.22})`); grd.addColorStop(0.5, `rgb(${v},${v * 0.75},${v * 0.5})`); grd.addColorStop(1, `rgb(${v * 0.35},${v * 0.26},${v * 0.17})`);
      g.fillStyle = grd; g.fillRect(0, i * h, s, h);
      for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(30,20,10,${rng() * 0.3})`; g.fillRect(rng() * s, i * h + rng() * h, 10 + rng() * 60, 1); }
    }
    grime(g, s, rng, 30, 0.5);
  }),
  roof: canvasTex(256, (g, s, rng) => {
    g.fillStyle = '#2a2622'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 16) for (let x = (y / 16) % 2 ? -12 : 0; x < s; x += 24) { const v = 35 + rng() * 25; g.fillStyle = `rgb(${v},${v * 0.92},${v * 0.85})`; g.fillRect(x + 1, y + 1, 22, 14); }
    grime(g, s, rng, 25, 0.6, '30,40,20');
  }),
  planks: canvasTex(256, (g, s, rng) => {
    for (let x = 0; x < s; x += 32) { const v = 60 + rng() * 25; g.fillStyle = `rgb(${v},${v * 0.72},${v * 0.48})`; g.fillRect(x, 0, 31, s); g.fillStyle = '#1b130b'; g.fillRect(x + 31, 0, 1, s); }
    grime(g, s, rng, 25, 0.5); speck(g, s, rng, 600);
  }),
  rock: canvasTex(256, (g, s, rng) => {
    g.fillStyle = '#4a4a46'; g.fillRect(0, 0, s, s);
    grime(g, s, rng, 40, 0.6, '25,25,22'); grime(g, s, rng, 25, 0.5, '50,70,40'); speck(g, s, rng, 2000);
  }),
  crate: canvasTex(256, (g, s, rng) => {
    g.fillStyle = '#5a4026'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += s / 6) { const v = rng() * 20; g.fillStyle = `rgb(${90 + v},${62 + v},${36 + v})`; g.fillRect(4, y + 3, s - 8, s / 6 - 6); }
    g.strokeStyle = '#2b1d10'; g.lineWidth = 10; g.strokeRect(5, 5, s - 10, s - 10);
    speck(g, s, rng, 600);
  }),
  gate: canvasTex(256, (g, s, rng) => {
    g.fillStyle = 'rgba(0,0,0,0)'; g.clearRect(0, 0, s, s);
    g.strokeStyle = '#8a8f92'; g.lineWidth = 2;
    for (let i = -s; i < s * 2; i += 18) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + s, s); g.moveTo(i + s, 0); g.lineTo(i, s); g.stroke(); } // chain link
    g.fillStyle = '#6d7275'; g.fillRect(0, 0, s, 10); g.fillRect(0, s - 10, s, 10); g.fillRect(0, 0, 10, s); g.fillRect(s - 10, 0, 10, s);
    for (let i = -s; i < s * 2; i += 40) { g.fillStyle = '#c9a400'; g.beginPath(); g.moveTo(i, s * 0.86); g.lineTo(i + 20, s * 0.86); g.lineTo(i + 40, s); g.lineTo(i + 20, s); g.fill(); }
  }),
};

// ----------------------------------------------------------------------------
//  WORLD CONSTRUCTION
// ----------------------------------------------------------------------------
TEX.glow = canvasTex(64, (g, s) => { const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,255,255,0.7)'); grd.addColorStop(1, 'rgba(255,255,255,0)'); g.clearRect(0, 0, s, s); g.fillStyle = grd; g.fillRect(0, 0, s, s); });
const world = { gens: [], gate: null, flickers: [], exitLight: null, fire: null, relics: [] };
const fx = { lightning: 0, nextLightning: 20 };
const BUSHES = [];
const MAT = {};
function stdMat(opts) { return new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.9, metalness: 0 }, opts)); }
// Bucket static geometry into 30 m chunks so off-screen forest is frustum-culled.
const chunks = new Map();
function addToChunk(kind, geo, x, z) {
  const k = kind + ':' + Math.floor(x / 30) + ',' + Math.floor(z / 30);
  if (!chunks.has(k)) chunks.set(k, { kind, geos: [] });
  chunks.get(k).geos.push(geo);
}
function flushChunks() {
  for (const { kind, geos } of chunks.values()) {
    const m = new THREE.Mesh(mergeGeometries(geos.map((g) => g.index ? g.toNonIndexed() : g)), MAT[kind]);
    m.castShadow = kind !== 'bush'; m.receiveShadow = true;
    scene.add(reg(m));
  }
  chunks.clear();
}
function distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
function nearPath(x, z, m) { for (const p of PATHS) for (let i = 0; i < p.length - 1; i++) if (distToSegment(x, z, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]) < m) return true; return false; }
// ---- Creek and bridges -----------------------------------------------------------
// A creek winds across the forest from west to east. Wading is slow and loud (a big
// ripple for the monster); the plank bridges where paths cross it are the quiet way over.
const CREEK = [[-40, 64], [0, 66], [20, 70], [45, 72], [65, 64], [85, 54], [120, 50], [160, 50]];
const CREEK_W = 3.6;
function distToPolyline(x, z, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distToSegment(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  return best;
}
// Bridges sit wherever a path segment crosses the creek, aligned with the path.
const BRIDGES = [];
function findBridges() {
  for (const path of PATHS) for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i], [bx, bz] = path[i + 1];
    for (let j = 0; j < CREEK.length - 1; j++) {
      const [cx, cz] = CREEK[j], [dx, dz] = CREEK[j + 1];
      const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
      if (Math.abs(den) < 1e-9) continue;
      const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den, u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const len = Math.hypot(bx - ax, bz - az);
      BRIDGES.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, fx: (bx - ax) / len, fz: (bz - az) / len, half: 4.2, w: 1.0 });
    }
  }
}
function onBridge(x, z) {
  for (const b of BRIDGES) {
    const dx = x - b.x, dz = z - b.z, along = dx * b.fx + dz * b.fz, across = -dx * b.fz + dz * b.fx;
    if (Math.abs(along) < b.half && Math.abs(across) < b.w) return true;
  }
  return false;
}
// ---- Environmental sound masking --------------------------------------------------
// The forest is never silent. The creek, the campfire, running generators and wind
// gusts cover quiet sounds: a crouching survivor near any of them can't be heard at all.
// Returns 0 (silent surroundings) .. 1 (fully masked).
const ENV = { gust: 0 }; // gust strength, 0..1, synced from the host
function ambientMask(x, z) {
  let m = ENV.gust;
  const dc = distToPolyline(x, z, CREEK);
  m = Math.max(m, clamp(1 - (dc - 1.5) / 4.5, 0, 1));                           // babbling water
  m = Math.max(m, clamp(1 - (Math.hypot(x - CAMPFIRE.x, z - CAMPFIRE.z) - 2) / 4, 0, 1) * 0.8); // crackling fire
  OBJ.forEach((o, i) => { if (o.kind === 'gen' && game.gens[i]?.done) m = Math.max(m, clamp(1 - (Math.hypot(x - o.x, z - o.z) - 2) / 7, 0, 1)); });
  return m;
}
// How loud a survivor's noise really is once the surroundings are taken into account.
// Crouched footsteps are nearly inaudible and vanish entirely under any masking sound.
// Sounds are never hidden: the surroundings don't mask anything. Crouching is just quiet.
function heardNoise(n, crouched) {
  if (n <= 0.01) return 0;
  return crouched ? n * 0.45 : n;
}
const inWater = (x, z) => distToPolyline(x, z, CREEK) < CREEK_W / 2 && !onBridge(x, z);

// ---- Terrain ----------------------------------------------------------------------
// The forest floor rolls in low rises and hollows, and beyond the fence the land climbs
// into ridges. Everything built (buildings, paths, the creek, hiding places, objectives,
// the fence and the road out) sits on level ground that blends into the hills.
// heightAt() is a bilinear lookup in a 1 m grid covering the whole ground plane.
const HG_MIN = -60, HG_N = 241;
const HGT = new Float32Array(HG_N * HG_N);
function heightAt(x, z) {
  const fx = clamp(x - HG_MIN, 0, HG_N - 1.001), fz = clamp(z - HG_MIN, 0, HG_N - 1.001);
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz, k = iz * HG_N + ix;
  return lerp(lerp(HGT[k], HGT[k + 1], tx), lerp(HGT[k + HG_N], HGT[k + HG_N + 1], tx), tz);
}
// Smooth value noise in -1..1.
function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const h = (a, b) => { let n = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(seed, 1442695041); n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return lerp(lerp(h(ix, iz), h(ix + 1, iz), u), lerp(h(ix, iz + 1), h(ix + 1, iz + 1), u), v) * 2 - 1;
}
// Metres from the nearest place that must stay level (negative inside it).
function levelDist(x, z) {
  let d = Infinity;
  const rect = (cx, cz, hw, hd, m) => { const dx = Math.max(Math.abs(x - cx) - hw, 0), dz = Math.max(Math.abs(z - cz) - hd, 0); d = Math.min(d, Math.hypot(dx, dz) - m); };
  const pt = (px, pz, m) => { d = Math.min(d, Math.hypot(x - px, z - pz) - m); };
  for (const c of CABINS) rect(c.x, c.z, c.w / 2, c.d / 2, 2.5);
  rect(SAWMILL.x, SAWMILL.z, SAWMILL.w / 2 + 1.5, SAWMILL.d / 2, 2.5);
  rect((RUINS.x0 + RUINS.x1) / 2, (RUINS.z0 + RUINS.z1) / 2, (RUINS.x1 - RUINS.x0) / 2, (RUINS.z1 - RUINS.z0) / 2, 1.5);
  rect((GRAVES.x0 + GRAVES.x1) / 2, (GRAVES.z0 + GRAVES.z1) / 2, (GRAVES.x1 - GRAVES.x0) / 2, (GRAVES.z1 - GRAVES.z0) / 2, 1.5);
  d = Math.min(d, distToPolyline(x, z, CREEK) - (CREEK_W / 2 + 1.6));
  for (const p of PATHS) d = Math.min(d, distToPolyline(x, z, p) - 1.7);
  pt(CAMPFIRE.x, CAMPFIRE.z, 13); pt(TOWER.x, TOWER.z, 4); pt(CIRCLE.x, CIRCLE.z, CIRCLE.r + 2.5); pt(TRUCK.x, TRUCK.z, 4);
  pt(SPAWN_MON.x, SPAWN_MON.z, 3); pt(TRANSFORMER.x, TRANSFORMER.z, 3);
  for (const L of LOCKERS) pt(L.x, L.z, 2.4);
  for (const [lx, lz] of LAMPS) pt(lx, lz, 1);
  for (const [rx, rz] of RELIC_SPOTS) pt(rx, rz, 1.6);
  for (const g of GENS) pt(g.x, g.z, 3);
  // the fence line and the road out
  const edge = Math.min(x - FENCE, AREA - FENCE - x, z - FENCE, AREA - FENCE - z);
  d = Math.min(d, Math.abs(edge) - 2.5);
  if (z > AREA - 16) d = Math.min(d, Math.abs(x - GATE.x) - 6);
  return d;
}
function buildTerrain() {
  for (let iz = 0; iz < HG_N; iz++) for (let ix = 0; ix < HG_N; ix++) {
    const x = HG_MIN + ix, z = HG_MIN + iz;
    const n = vnoise(x / 23, z / 23, 7) * 0.65 + vnoise(x / 9, z / 9, 11) * 0.27 + vnoise(x / 3.7, z / 3.7, 3) * 0.08;
    let h = (n + 0.25) * 2.8;                                                 // rises to ~3.5 m, shallow hollows
    const out = Math.max(FENCE - x, x - (AREA - FENCE), FENCE - z, z - (AREA - FENCE), 0);
    h += smooth01((out - 3) / 38) * (9 + vnoise(x / 15, z / 15, 5) * 5);    // ridges beyond the fence
    HGT[iz * HG_N + ix] = h * smooth01(levelDist(x, z) / 7);
  }
}
// A flat ribbon following a polyline (for the water and its muddy banks).
function ribbonGeometry(pts, width, y) {
  const pos = [], uv = [], idx = [];
  let along = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    if (i) along += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    const nx = -tz * width / 2, nz = tx * width / 2;
    pos.push(p[0] + nx, y, p[1] + nz, p[0] - nx, y, p[1] - nz);
    uv.push(0, along / width, 1, along / width);
    if (i) { const k = i * 2; idx.push(k - 2, k, k - 1, k - 1, k, k + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// Densify a polyline (smooth enough for a ribbon) with a little wobble.
function densify(pts, step, rng) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 0; k < n; k++) { const t = k / n; out.push([lerp(ax, bx, t) + (k ? (rng() - 0.5) * 0.4 : 0), lerp(az, bz, t) + (k ? (rng() - 0.5) * 0.4 : 0)]); }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function buildCreek(rng) {
  const line = densify(CREEK, 2, rng);
  const bank = new THREE.Mesh(ribbonGeometry(line, CREEK_W + 2.6, 0.012), stdMat({ map: TEX.path, color: 0x6a5a48, polygonOffset: true, polygonOffsetFactor: -1 }));
  bank.receiveShadow = true; scene.add(reg(bank));
  const water = new THREE.Mesh(ribbonGeometry(line, CREEK_W, 0.03), new THREE.MeshStandardMaterial({ color: 0x0a161c, roughness: 0.08, metalness: 0.65, polygonOffset: true, polygonOffsetFactor: -3 }));
  water.receiveShadow = true; scene.add(reg(water));
  world.water = water;
  // Stones along the banks (not solid: they're ankle-high)
  for (let i = 0; i < line.length; i += 2) {
    if (rng() < 0.35) continue;
    const [x, z] = line[i], side = rng() < 0.5 ? -1 : 1, a = Math.atan2(line[Math.min(i + 1, line.length - 1)][1] - z, line[Math.min(i + 1, line.length - 1)][0] - x);
    const off = CREEK_W / 2 + 0.3 + rng() * 0.9, sx = x - Math.sin(a) * off * side, sz = z + Math.cos(a) * off * side;
    if (onBridge(sx, sz)) continue;
    const r = 0.15 + rng() * 0.3, geo = new THREE.DodecahedronGeometry(r, 0); geo.scale(1, 0.5, 1); geo.translate(sx, r * 0.2, sz);
    addToChunk('rock', geo, sx, sz);
  }
}
function buildBridges(rng) {
  const tiles = [ASSETS.bridge1, ASSETS.bridge2].filter(Boolean);
  for (const b of BRIDGES) {
    const yaw = Math.atan2(b.fx, b.fz) - Math.PI / 2; // each tile is a 2 m deck section running along its local X
    const n = Math.ceil((b.half * 2) / 2.0);
    for (let k = 0; k < n; k++) {
      const t = -b.half + (k + 0.5) * (b.half * 2 / n), x = b.x + b.fx * t, z = b.z + b.fz * t;
      let tile;
      if (tiles.length) {
        tile = tiles[Math.floor(rng() * tiles.length)].clone(true);
      } else { // fallback planks if the tile models didn't load
        tile = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 1.05), stdMat({ map: TEX.planks })); tile.position.y = 0.12;
      }
      const holder = new THREE.Group();
      holder.add(tile);
      holder.position.set(x, 0.04, z);
      holder.rotation.y = yaw + (rng() < 0.5 ? Math.PI : 0) + (rng() - 0.5) * 0.05;
      holder.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      scene.add(reg(holder));
    }
  }
}
// Low mist drifting over the creek (survivor view only).
function buildMist(rng) {
  const tex = canvasTex(256, (g, s) => {
    for (let i = 0; i < 18; i++) {
      const x = s * (0.2 + Math.random() * 0.6), y = s * (0.3 + Math.random() * 0.4), r = s * (0.12 + Math.random() * 0.2);
      const grd = g.createRadialGradient(x, y, 0, x, y, r); grd.addColorStop(0, 'rgba(70,80,92,0.05)'); grd.addColorStop(1, 'rgba(70,80,92,0)');
      g.fillStyle = grd; g.fillRect(0, 0, s, s);
    }
  });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.6, fog: true });
  world.mist = [];
  const line = densify(CREEK, 14, rng);
  for (const [x, z] of line) {
    if (x < 0 || x > AREA) continue;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(10 + rng() * 6, 10 + rng() * 6), mat);
    m.rotation.x = -Math.PI / 2; m.position.set(x + (rng() - 0.5) * 3, 0.35 + rng() * 0.4, z + (rng() - 0.5) * 3);
    scene.add(m); survivorOnly.push(m); world.mist.push({ m, x: m.position.x, phase: rng() * 10 });
  }
}

// Somewhere a tree/rock may not go: cabins, camp, generators, paths, gate, road and creek.
function keepClear(x, z, extra = 0) {
  if (distToPolyline(x, z, CREEK) < CREEK_W / 2 + 1.6 + extra) return true;
  for (const c of CABINS) if (Math.abs(x - c.x) < c.w / 2 + 3 + extra && Math.abs(z - c.z) < c.d / 2 + 3 + extra) return true;
  if (Math.hypot(x - CAMPFIRE.x, z - CAMPFIRE.z) < 10 + extra) return true;
  if (Math.hypot(x - SPAWN_MON.x, z - SPAWN_MON.z) < 3) return true;
  if (Math.hypot(x - TOWER.x, z - TOWER.z) < 5.5 + extra || Math.hypot(x - CIRCLE.x, z - CIRCLE.z) < CIRCLE.r + 3 + extra) return true;
  if (Math.abs(x - TRUCK.x) < 3 && Math.abs(z - TRUCK.z) < 4.5) return true;
  if (x > GRAVES.x0 - 1 && x < GRAVES.x1 + 1 && z > GRAVES.z0 - 1 && z < GRAVES.z1 + 1) return true;
  for (const L of LOCKERS) if (Math.hypot(x - L.x, z - L.z) < 2.6) return true;
  if (Math.abs(x - SAWMILL.x) < SAWMILL.w / 2 + 3.5 + extra && Math.abs(z - SAWMILL.z) < SAWMILL.d / 2 + 3 + extra) return true;
  if (x > RUINS.x0 - 2 - extra && x < RUINS.x1 + 2 + extra && z > RUINS.z0 - 2 - extra && z < RUINS.z1 + 2 + extra) return true;
  if (Math.hypot(x - TRANSFORMER.x, z - TRANSFORMER.z) < 3.5) return true;
  for (const P of POLES) if (Math.hypot(x - P.x, z - P.z) < 1.3) return true;
  for (const [lx, lz] of LAMPS) if (Math.hypot(x - lx, z - lz) < 1.5) return true;
  if (nearPath(x, z, 2.3 + extra)) return true;
  if (Math.abs(x - GATE.x) < 7 && z > AREA - 12) return true;
  if (x > EXIT_ZONE.minX - 3 && x < EXIT_ZONE.maxX + 3 && z > AREA - 4) return true;
  if (Math.abs(x - FENCE) < 1.5 || Math.abs(x - (AREA - FENCE)) < 1.5 || Math.abs(z - FENCE) < 1.5 || Math.abs(z - (AREA - FENCE)) < 1.5) return true;
  return false;
}

function buildTree(rng, x, z, inside) {
  const h = 7 + rng() * 7, r = 0.18 + rng() * 0.22, dead = rng() < 0.08, y0 = heightAt(x, z) - 0.25;
  const trunk = new THREE.CylinderGeometry(r * 0.55, r, h, 7, 1); trunk.translate(x, y0 + h / 2, z);
  addToChunk('bark', trunk, x, z);
  if (!dead) {
    const layers = 3 + Math.floor(rng() * 2), base = h * (0.25 + rng() * 0.1);
    for (let i = 0; i < layers; i++) {
      const t = i / layers, cr = (1.0 - t * 0.7) * (1.6 + rng() * 0.9), ch = (h - base) / layers * 1.9;
      const cone = new THREE.ConeGeometry(cr, ch, 8, 1); cone.rotateY(rng() * 3); cone.translate(x, y0 + base + t * (h - base) + ch / 2, z);
      addToChunk('needles', cone, x, z);
    }
  } else {
    for (let i = 0; i < 3; i++) { // bare broken branches
      const b = new THREE.CylinderGeometry(0.03, 0.06, 1.4 + rng(), 4); b.rotateZ(0.9 + rng() * 0.5); b.rotateY(rng() * 6.28); b.translate(x, y0 + h * (0.45 + i * 0.15), z);
      addToChunk('bark', b, x, z);
    }
  }
  if (inside) addCircle(x, z, r + 0.08, 'tree');
}

function buildCabin(c, i) {
  const H = c.h || 2.7, T = 0.3, DOOR = c.doorW || 1.6, DH = c.barn ? 2.9 : 2.1, x0 = c.x - c.w / 2, x1 = c.x + c.w / 2, z0 = c.z - c.d / 2, z1 = c.z + c.d / 2;
  const has = (side) => c.door === side || c.door2 === side;
  const g = new THREE.Group();
  const walls = [];
  // A wall along x (fixed z) or z (fixed x), with an optional door gap centred at `gap`.
  const wallX = (z, a, b, gap) => {
    const segs = gap == null ? [[a, b]] : [[a, gap - DOOR / 2], [gap + DOOR / 2, b]];
    for (const [s0, s1] of segs) { if (s1 - s0 < 0.05) continue; walls.push([s0, z - T / 2, s1, z + T / 2]); }
    if (gap != null) walls.push([gap - DOOR / 2, z - T / 2, gap + DOOR / 2, z + T / 2, 'lintel']);
  };
  const wallZ = (x, a, b, gap) => {
    const segs = gap == null ? [[a, b]] : [[a, gap - DOOR / 2], [gap + DOOR / 2, b]];
    for (const [s0, s1] of segs) { if (s1 - s0 < 0.05) continue; walls.push([x - T / 2, s0, x + T / 2, s1]); }
    if (gap != null) walls.push([x - T / 2, gap - DOOR / 2, x + T / 2, gap + DOOR / 2, 'lintel']);
  };
  wallX(z0, x0, x1, has('north') ? c.x : null);
  wallX(z1, x0, x1, has('south') ? c.x : null);
  wallZ(x0, z0, z1, has('west') ? c.z : null);
  wallZ(x1, z0, z1, has('east') ? c.z : null);
  if (c.split) wallZ(c.x - 1, z0, z1, c.z + 0.6);          // interior wall (west of the front door) with a doorway
  const wallGeos = [];
  for (const [a, b, cc, d, kind] of walls) {
    const lintel = kind === 'lintel', hh = lintel ? H - DH : H;
    const geo = new THREE.BoxGeometry(cc - a, hh, d - b);
    geo.translate((a + cc) / 2, lintel ? DH + hh / 2 : hh / 2, (b + d) / 2);
    wallGeos.push(geo);
    if (!lintel) addBox(a, b, cc, d, 'wall');
  }
  const wallMesh = new THREE.Mesh(mergeGeometries(wallGeos), c.barn ? stdMat({ map: TEX.planks, color: 0x7a3a2a }) : stdMat({ map: TEX.logs }));
  wallMesh.castShadow = wallMesh.receiveShadow = true;
  g.add(wallMesh);
  // Floor, gable roof and gable ends
  const floor = new THREE.Mesh(new THREE.BoxGeometry(c.w, 0.12, c.d), stdMat({ map: c.barn ? TEX.hay : TEX.planks, color: c.barn ? 0x8a7a55 : 0xffffff })); floor.position.set(c.x, 0.06, c.z); floor.receiveShadow = true;
  g.add(floor);
  const ridgeH = c.barn ? 2.6 : 1.6, over = 0.5, slope = Math.hypot(c.d / 2 + over, ridgeH);
  const roofMat = stdMat({ map: TEX.roof, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(c.w + over * 2, 0.12, slope), roofMat);
    r.position.set(c.x, H + ridgeH / 2, c.z + s * (c.d / 4 + over / 2)); r.rotation.x = s * Math.atan2(ridgeH, c.d / 2 + over);
    r.castShadow = true; g.add(r);
  }
  const gable = new THREE.Shape([new THREE.Vector2(-c.d / 2, 0), new THREE.Vector2(c.d / 2, 0), new THREE.Vector2(0, ridgeH)]);
  for (const s of [-1, 1]) {
    const ge = new THREE.Mesh(new THREE.ShapeGeometry(gable), c.barn ? stdMat({ map: TEX.planks, color: 0x7a3a2a, side: THREE.DoubleSide }) : stdMat({ map: TEX.logs, side: THREE.DoubleSide }));
    ge.rotation.y = Math.PI / 2; ge.position.set(c.x + s * c.w / 2, H, c.z); g.add(ge);
  }
  if (c.barn) { buildBarnInterior(c, g); scene.add(reg(g)); return; } // dark inside: no lamp, boarded windows
  // Glowing windows on the long walls and a warm lamp inside
  const winMat = new THREE.MeshStandardMaterial({ color: 0x1a1006, emissive: c.chapel ? 0x5f7fe0 : 0xffa040, emissiveIntensity: c.chapel ? 1.0 : 1.6 });
  for (const s of [-1, 1]) for (const fx of [-0.28, 0.28]) {
    if (c.door === (s < 0 ? 'north' : 'south') && Math.abs(fx) < 0.1) continue;
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.6), winMat);
    win.position.set(c.x + fx * c.w, 1.5, c.z + s * (c.d / 2 + T / 2 + 0.01)); win.rotation.y = s < 0 ? Math.PI : 0;
    g.add(win);
  }
  const lamp = new THREE.PointLight(c.chapel ? 0x7088ff : 0xffa860, c.chapel ? 4 : 6, c.chapel ? 12 : 9, 1.6); lamp.position.set(c.x + (c.split ? -c.w / 4 - 0.3 : 0), 2.2, c.z);
  g.add(lamp); survivorOnly.push(lamp);
  world.flickers.push({ light: lamp, base: 6, phase: i * 13.7, kind: 'lamp' });
  // Furniture (colliders too)
  const furn = [];
  if (c.chapel) { for (const px of [-2, 2]) for (const pz of [-2, 0.6, 3.2]) furn.push([c.x + px, c.z + pz, 2.3, 0.5, 0.55]); furn.push([c.x, c.z - 4.6, 1.8, 1.0, 0.8]); }
  else if (c.split) { furn.push([c.x + 2.5, c.z - 2.2, 1.6, 0.8, 0.8]); furn.push([c.x + 3.6, c.z + 2.4, 1.0, 0.6, 1.9]); }
  else if (c.w > 6) furn.push([c.x - 2.2, c.z - 2.0, 1.2, 0.8, 0.8]);
  for (const [fx, fz, fw, fh, fd] of furn) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, fd), stdMat({ map: TEX.crate })); m.position.set(fx, fh / 2, fz); m.castShadow = true;
    g.add(m); addBox(fx - fw / 2, fz - fd / 2, fx + fw / 2, fz + fd / 2, 'furniture');
  }
  scene.add(reg(g));
}

// The barn: stalls down the west side, hay bales stacked as cover, a loft beam overhead.
function buildBarnInterior(c, g) {
  const hay = stdMat({ map: TEX.hay, color: 0xd8c08a }), plank = stdMat({ map: TEX.planks, color: 0x6a5a48 });
  const block = (x, z, w, h, d, mat, y = h / 2, solid = true) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; g.add(m);
    if (solid) addBox(x - w / 2, z - d / 2, x + w / 2, z + d / 2, 'furniture');
    return m;
  };
  // Stall partitions (chest high: you can crouch behind them) either side of the generator aisle
  block(c.x - 1.4, c.z - 2.8, 4.2, 1.35, 0.14, plank); block(c.x - 1.4, c.z + 2.8, 4.2, 1.35, 0.14, plank);
  for (const s of [-1, 1]) block(c.x + 0.7, c.z + s * 4.1, 0.14, 1.35, 2.6, plank);
  // Hay bales: a two-high stack by the north wall and a scatter by the south door
  block(c.x + 3.0, c.z - 3.6, 2.0, 1.0, 1.0, hay); block(c.x + 3.1, c.z - 3.6, 1.2, 0.8, 0.9, hay, 1.4, false);
  block(c.x - 3.6, c.z + 3.9, 1.8, 1.0, 1.0, hay); block(c.x + 4.6, c.z + 3.2, 1.0, 0.9, 1.8, hay);
  // Loft beams and a hanging hook
  for (const bx of [-3.5, 0, 3.5]) { const beam = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, c.d), plank); beam.position.set(c.x + bx, c.h - 0.2, c.z); g.add(beam); }
  const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.4, 4), MAT.metal); chain.position.set(c.x + 1.8, c.h - 0.9, c.z + 0.6); g.add(chain);
  // Boarded windows
  for (const s of [-1, 1]) for (const fx of [-0.3, 0.3]) {
    if (c.door2 === 'south' && s > 0 && Math.abs(fx) < 0.1) continue;
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.7, 0.06), plank); b.position.set(c.x + fx * c.w, 2.0, c.z + s * (c.d / 2 + 0.18)); b.rotation.z = (fx > 0 ? 0.1 : -0.12); g.add(b);
  }
}
function buildSawmill() {
  const S = SAWMILL, x0 = S.x - S.w / 2, x1 = S.x + S.w / 2, z0 = S.z - S.d / 2, z1 = S.z + S.d / 2, H = 3.4, T = 0.25;
  const g = new THREE.Group(), clad = [], frame = [];
  const box = (list, minX, minZ, maxX, maxZ, y0, y1, solid = true) => {
    const geo = new THREE.BoxGeometry(maxX - minX, y1 - y0, maxZ - minZ); geo.translate((minX + maxX) / 2, (y0 + y1) / 2, (minZ + maxZ) / 2); list.push(geo);
    if (solid) addBox(minX, minZ, maxX, maxZ, 'wall');
  };
  box(clad, x0, z0 - T / 2, x1, z0 + T / 2, 0, H);                 // back (north) wall
  box(clad, x1 - T / 2, z0, x1 + T / 2, z1, 0, H);                 // east wall
  box(clad, x1 - 4.5, z1 - T / 2, x1, z1 + T / 2, 0, 1.25);        // half wall on the south side
  for (const px of [x0, x0 + 4.3, x0 + 8.6]) box(frame, px - 0.13, z1 - 0.13, px + 0.13, z1 + 0.13, 0, H);
  box(frame, x0 - 0.13, S.z - 0.13, x0 + 0.13, S.z + 0.13, 0, H);
  // Log carriage running through the middle, a log on it, and the great saw in its slot
  box(frame, S.x - 5, S.z + 0.25, S.x + 2.6, S.z + 1.35, 0, 0.9);
  box(clad, x0 + 0.7, z1 - 1.7, x0 + 3.3, z1 - 0.5, 0, 1.15);      // lumber stack
  const mat = stdMat({ map: TEX.planks, color: 0x6e5e4c }), frameMat = stdMat({ map: TEX.planks, color: 0x4a3e32 });
  const walls = new THREE.Mesh(mergeGeometries(clad), mat), frames = new THREE.Mesh(mergeGeometries(frame), frameMat);
  for (const m of [walls, frames]) { m.castShadow = m.receiveShadow = true; g.add(m); }
  const log = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 6.8, 10), MAT.bark); log.rotation.z = Math.PI / 2; log.position.set(S.x - 1.4, 1.22, S.z + 0.8); log.castShadow = true; g.add(log);
  const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.04, 28), stdMat({ color: 0x8a9092, metalness: 0.9, roughness: 0.35 }));
  blade.rotation.x = Math.PI / 2; blade.position.set(S.x + 1.6, 0.95, S.z + 0.8); g.add(blade);
  // Teeth
  for (let k = 0; k < 18; k++) { const a = (k / 18) * Math.PI * 2, t = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 3), blade.material); t.position.set(S.x + 1.6 + Math.cos(a) * 0.84, 0.95 + Math.sin(a) * 0.84, S.z + 0.8); t.rotation.z = a - Math.PI / 2; g.add(t); }
  world.sawBlade = blade;
  // Mono-pitch roof, high at the back
  const rise = 0.9, depth = S.d + 1.2, roof = new THREE.Mesh(new THREE.BoxGeometry(S.w + 1.2, 0.12, Math.hypot(depth, rise)), stdMat({ map: TEX.roof, side: THREE.DoubleSide }));
  roof.position.set(S.x, H + rise / 2, S.z + 0.3); roof.rotation.x = Math.atan2(rise, depth); roof.castShadow = true; g.add(roof);
  // Sawdust floor and a log pile outside the west end
  const dust = new THREE.Mesh(new THREE.PlaneGeometry(S.w, S.d), stdMat({ map: TEX.path, color: 0xb09870, polygonOffset: true, polygonOffsetFactor: -2 })); dust.rotation.x = -Math.PI / 2; dust.position.set(S.x, 0.02, S.z); dust.receiveShadow = true; g.add(dust);
  for (let k = 0; k < 6; k++) {
    const row = k < 3 ? 0 : 1, l = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 4.2, 9), MAT.bark);
    l.rotation.x = Math.PI / 2; l.position.set(x0 - 2.2 + (k % 3) * 0.62 + row * 0.31, 0.3 + row * 0.53, z0 + 1.6); l.castShadow = true; g.add(l);
  }
  addBox(x0 - 2.6, z0 - 0.5, x0 - 0.6, z0 + 3.7, 'logs');
  scene.add(reg(g));
}
function buildRuins(rng) {
  const geos = [], T = 0.6;
  const blockGeo = (cx, cz, w, h, d, ry = 0) => { const geo = new THREE.BoxGeometry(w, h, d); geo.rotateY(ry); geo.translate(cx, h / 2 - 0.05, cz); geos.push(geo); };
  for (const [ax, az, bx, bz, h] of RUIN_WALLS) {
    const len = Math.hypot(bx - ax, bz - az), alongX = Math.abs(bx - ax) > Math.abs(bz - az), n = Math.max(1, Math.round(len / 1.15));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, hh = h * (0.7 + rng() * 0.3) * (i === 0 || i === n - 1 ? 0.8 : 1), seg = len / n + 0.02;
      blockGeo(lerp(ax, bx, t), lerp(az, bz, t), alongX ? seg : T, hh, alongX ? T : seg);
      if (rng() < 0.35) blockGeo(lerp(ax, bx, t) + (rng() - 0.5) * 1.6, lerp(az, bz, t) + (rng() - 0.5) * 1.6, 0.4 + rng() * 0.4, 0.25 + rng() * 0.3, 0.4 + rng() * 0.4, rng() * 3); // fallen stones
    }
    addBox(Math.min(ax, bx) - (alongX ? 0 : T / 2), Math.min(az, bz) - (alongX ? T / 2 : 0), Math.max(ax, bx) + (alongX ? 0 : T / 2), Math.max(az, bz) + (alongX ? T / 2 : 0), 'wall');
  }
  // The arch over the south gap
  for (const px of [46, 50]) { blockGeo(px, RUINS.z1, 0.75, 3.3, 0.75); addBox(px - 0.38, RUINS.z1 - 0.38, px + 0.38, RUINS.z1 + 0.38, 'wall'); }
  blockGeo(48, RUINS.z1, 4.8, 0.55, 0.75); geos[geos.length - 1].translate(0, 3.05, 0);
  // Hollow tower stump with a doorway facing west
  const tw = RUINS.tower;
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    if (Math.abs(Math.atan2(Math.sin(a - Math.PI), Math.cos(a - Math.PI))) < 0.46) continue; // the collapsed breach
    const x = tw.x + Math.cos(a) * tw.r, z = tw.z + Math.sin(a) * tw.r, h = 3.2 + rng() * 1.6;
    blockGeo(x, z, 0.62, h, 0.9, -a);
    addCircle(x, z, 0.42, 'wall');
  }
  // Rubble
  for (let k = 0; k < 26; k++) {
    const x = RUINS.x0 + 1 + rng() * (RUINS.x1 - RUINS.x0 - 2), z = RUINS.z0 + 1 + rng() * (RUINS.z1 - RUINS.z0 - 2), r = 0.15 + rng() * 0.3;
    const geo = new THREE.DodecahedronGeometry(r, 0); geo.scale(1, 0.6, 1); geo.translate(x, r * 0.25, z); geos.push(geo);
  }
  const m = new THREE.Mesh(mergeGeometries(geos.map((g) => g.index ? g.toNonIndexed() : g)), stdMat({ map: TEX.rock, color: 0x9aa392, roughness: 0.95 }));
  m.castShadow = m.receiveShadow = true;
  scene.add(reg(m));
}
// ---- Power lines --------------------------------------------------------------------
// Poles carry the lines from every generator back to the transformer by the gate; a
// pole's lamp comes on once a generator down its line is running.
const GRID = [
  { x: 56.5, z: 105 },                 // 0: first pole from the transformer
  { x: 50.5, z: 90.5, p: 0 },          // 1: camp, west side
  { x: 49.5, z: 78, p: 1 },            // 2
  { x: 42.5, z: 63, p: 2 },            // 3
  { x: 45, z: 52.5, p: 3 },            // 4: south of the main cabin
  { x: 44.3, z: 37, p: 4, gen: 0 },    // 5: main cabin
  { x: 26, z: 52.5, p: 4, gen: 3 },    // 6: barn
  { x: 35, z: 92.5, p: 1, gen: 2 },    // 7: shed
  { x: 62.5, z: 104.5 },               // 8: east branch
  { x: 63, z: 87, p: 8 },              // 9: camp, east side
  { x: 74, z: 76.5, p: 9 },            // 10
  { x: 86.5, z: 73, p: 10, gen: 1 },   // 11: hunting cabin
  { x: 98, z: 84.5, p: 10, gen: 4 },   // 12: sawmill
];
const POLES = []; // { x, z, gens: Set of generator indices powered through this pole }
const SPANS = []; // [poleA, poleB]
function poleSpotOK(x, z) {
  if (nearPath(x, z, 2.0) || distToPolyline(x, z, CREEK) < CREEK_W / 2 + 1.4) return false;
  for (const c of CABINS) if (Math.abs(x - c.x) < c.w / 2 + 0.8 && Math.abs(z - c.z) < c.d / 2 + 0.8) return false;
  if (Math.abs(x - SAWMILL.x) < SAWMILL.w / 2 + 3 && Math.abs(z - SAWMILL.z) < SAWMILL.d / 2 + 0.8) return false;
  for (const L of LOCKERS) if (Math.hypot(x - L.x, z - L.z) < 2.4) return false;
  for (const g of GENS) if (Math.hypot(x - g.x, z - g.z) < 2) return false;
  if (Math.hypot(x - CAMPFIRE.x, z - CAMPFIRE.z) < 4) return false;
  for (const [sx, sz] of SPAWN_SURV) if (Math.hypot(x - sx, z - sz) < 1.5) return false;
  return true;
}
function poleSpot(x, z) {
  for (let r = 0; r <= 5; r += 0.5) for (let k = 0; k < (r ? 12 : 1); k++) {
    const px = x + Math.cos(k * Math.PI / 6) * r, pz = z + Math.sin(k * Math.PI / 6) * r;
    if (poleSpotOK(px, pz)) return [px, pz];
  }
  return [x, z];
}
function planPowerLines() {
  const nodePole = [];
  const root = { x: TRANSFORMER.x, z: TRANSFORMER.z, gens: new Set(), root: true };
  const place = (x, z) => { const [px, pz] = poleSpot(x, z); const P = { x: px, z: pz, gens: new Set() }; POLES.push(P); return P; };
  GRID.forEach((n, i) => { nodePole[i] = place(n.x, n.z); });
  GRID.forEach((n, i) => {
    const A = n.p === undefined ? root : nodePole[n.p], B = nodePole[i];
    const len = Math.hypot(B.x - A.x, B.z - A.z), k = Math.max(1, Math.ceil(len / 12.5));
    let prev = A;
    for (let j = 1; j < k; j++) { const P = place(lerp(A.x, B.x, j / k), lerp(A.z, B.z, j / k)); P.edge = i; SPANS.push([prev, P]); prev = P; }
    SPANS.push([prev, B]); B.edge = i;
  });
  // Which generators feed each pole: walk from each generator's node back to the root.
  const nodeGens = GRID.map(() => new Set());
  GRID.forEach((n, i) => { if (n.gen === undefined) return; for (let k = i; k !== undefined; k = GRID[k].p) nodeGens[k].add(n.gen); });
  for (const P of POLES) for (const g of nodeGens[P.edge] || []) P.gens.add(g);
  world.grid = { root, lit: '' };
}
function buildPowerLines() {
  const wood = stdMat({ map: TEX.bark, color: 0x5a4a3a }), geos = [], wires = [];
  const off = stdMat({ color: 0x181410, emissive: 0x000000 }), on = new THREE.MeshStandardMaterial({ color: 0x2a2010, emissive: 0xffc47a, emissiveIntensity: 2.6 });
  const top = (P) => new THREE.Vector3(P.x, (P.root ? 0 : heightAt(P.x, P.z)) + (P.root ? 3.2 : 7.0), P.z);
  for (const [A, B] of SPANS) { const ry = -Math.atan2(B.z - A.z, B.x - A.x) + Math.PI / 2; if (B.ry === undefined) B.ry = ry; if (A.ry === undefined && !A.root) A.ry = ry; }
  for (const P of POLES) {
    const y0 = heightAt(P.x, P.z) - 0.3, post = new THREE.CylinderGeometry(0.11, 0.15, 7.6, 7); post.translate(P.x, y0 + 3.8, P.z); geos.push(post);
    const arm = new THREE.BoxGeometry(1.5, 0.12, 0.12); arm.rotateY(P.ry || 0); arm.translate(P.x, y0 + 7.2, P.z); geos.push(arm);
    addCircle(P.x, P.z, 0.17, 'pole');
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), off); lamp.position.set(P.x, y0 + 6.7, P.z);
    scene.add(lamp); survivorOnly.push(lamp); P.lamp = lamp;
  }
  const m = new THREE.Mesh(mergeGeometries(geos.map((g) => g.index ? g.toNonIndexed() : g)), wood); m.castShadow = true;
  scene.add(reg(m));
  // Two sagging wires per span (survivor view only: thin lines don't take the sonar material)
  for (const [A, B] of SPANS) {
    const a = top(A), b = top(B), side = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize().multiplyScalar(0.6);
    for (const s of [-1, 1]) for (let k = 0; k < 10; k++) {
      for (const t of [k / 10, (k + 1) / 10]) {
        const p = a.clone().lerp(b, t).addScaledVector(side, s); p.y -= Math.sin(t * Math.PI) * 0.75; wires.push(p.x, p.y, p.z);
      }
    }
  }
  const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
  const lines = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x0c0c0c })); scene.add(lines); survivorOnly.push(lines);
  // The transformer: a fenced cabinet with insulators; it hums and glows once the gate has power
  const T = TRANSFORMER, g = new THREE.Group(); g.position.set(T.x, 0, T.z);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.5, 1.2), stdMat({ color: 0x4b5550, metalness: 0.6, roughness: 0.5 })); cab.position.y = 0.75; cab.castShadow = true; g.add(cab);
  for (const sx of [-0.5, 0, 0.5]) { const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.4, 8), stdMat({ color: 0x6a4a3a, roughness: 0.4 })); ins.position.set(sx, 1.7, 0); g.add(ins); }
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 4, 7), wood); pole.position.set(0.95, 2, 0.4); g.add(pole);
  for (const [fx, fz, fw, fd] of [[0, -1.2, 2.6, 0.04], [0, 1.2, 2.6, 0.04], [-1.3, 0, 0.04, 2.4], [1.3, 0, 0.04, 2.4]]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(fw, 1.8, fd), new THREE.MeshStandardMaterial({ map: TEX.gate, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5 }));
    f.position.set(fx, 0.9, fz); g.add(f);
  }
  scene.add(reg(g));
  addBox(T.x - 1.35, T.z - 1.25, T.x + 1.35, T.z + 1.25, 'transformer');
  const tl = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2200, emissiveIntensity: 2.5 });
  const tlamp = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), tl); tlamp.position.set(T.x, 1.62, T.z - 0.62); scene.add(tlamp); survivorOnly.push(tlamp);
  Object.assign(world.grid, { on, off, transformerLamp: tl });
}
// Light the poles along every line that has a running generator on it.
function updatePowerLines() {
  const G = world.grid; if (!G?.on) return;
  const escape = game.mode === 'escape' && (game.phase === 'playing' || game.phase === 'ended');
  const sig = escape ? game.gens.map((g) => (g.done ? 1 : 0)).join('') : '';
  if (sig === G.lit) return;
  G.lit = sig;
  for (const P of POLES) P.lamp.material = escape && [...P.gens].some((i) => game.gens[i]?.done) ? G.on : G.off;
  const n = escape ? game.gens.filter((g) => g.done).length : 0;
  G.transformerLamp.emissive.setHex(n >= ESCAPE_NEED ? 0x2bff6a : n > 0 ? 0xffa020 : 0xff2200);
}

// ---- Landmarks ---------------------------------------------------------------------
function buildChapelExtras(c) {
  const g = new THREE.Group();
  // Steeple over the door, with a cross
  const zf = c.z + c.d / 2 - 1.2;
  const tower = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.4, 2.2), stdMat({ map: TEX.logs })); tower.position.set(c.x, 4.4, zf);
  const spire = new THREE.Mesh(new THREE.ConeGeometry(1.8, 3.2, 4), stdMat({ map: TEX.roof })); spire.position.set(c.x, 7.7, zf); spire.rotation.y = Math.PI / 4;
  const crossMat = stdMat({ color: 0x15120e });
  const cv = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.3, 0.12), crossMat); cv.position.set(c.x, 9.8, zf);
  const ch = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 0.12), crossMat); ch.position.set(c.x, 10.0, zf);
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), stdMat({ color: 0x4a3c20, metalness: 0.8, roughness: 0.4 })); bell.position.set(c.x, 4.6, zf);
  for (const m of [tower, spire, cv, ch]) m.castShadow = true;
  g.add(tower, spire, cv, ch, bell);
  scene.add(reg(g));
}
function buildGraveyard(rng) {
  const geos = [];
  for (let gx = GRAVES.x0 + 2; gx < GRAVES.x1 - 1; gx += 2.6) for (let gz = GRAVES.z0 + 2; gz < GRAVES.z1 - 1; gz += 3.3) {
    if (rng() < 0.2) continue;
    const x = gx + (rng() - 0.5) * 0.6, z = gz + (rng() - 0.5) * 0.6, h = 0.7 + rng() * 0.5;
    const cross = rng() < 0.25;
    if (cross) {
      const a = new THREE.BoxGeometry(0.12, h + 0.5, 0.12); a.rotateZ((rng() - 0.5) * 0.25); a.translate(x, (h + 0.5) / 2, z); geos.push(a);
      const b = new THREE.BoxGeometry(0.6, 0.12, 0.12); b.translate(x, h + 0.1, z); geos.push(b);
    } else {
      const s = new THREE.BoxGeometry(0.55, h, 0.16); s.rotateX((rng() - 0.5) * 0.3); s.rotateZ((rng() - 0.5) * 0.2); s.translate(x, h / 2 - 0.05, z); geos.push(s);
      const mound = new THREE.BoxGeometry(0.7, 0.12, 1.7); mound.translate(x, 0.05, z + 1.05); geos.push(mound);
    }
    addCircle(x, z, 0.32, 'grave');
  }
  const m = new THREE.Mesh(mergeGeometries(geos), MAT.rock); m.castShadow = m.receiveShadow = true;
  scene.add(reg(m));
}
function buildTower() {
  const g = new THREE.Group(); g.position.set(TOWER.x, 0, TOWER.z);
  const wood = MAT.fence, H = 6.5;
  for (const sx of [-1.8, 1.8]) for (const sz of [-1.8, 1.8]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.28, H, 0.28), wood); leg.position.set(sx, H / 2, sz); leg.castShadow = true; g.add(leg);
    addCircle(TOWER.x + sx, TOWER.z + sz, 0.25, 'tower');
  }
  for (const [ax, az, rot] of [[0, -1.8, 0], [0, 1.8, 0], [-1.8, 0, Math.PI / 2], [1.8, 0, Math.PI / 2]]) {
    for (const s of [-1, 1]) {
      const brace = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.12, 0.12), wood);
      brace.position.set(ax, 2.6, az); brace.rotation.set(0, rot, s * 0.75); g.add(brace);
    }
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.2, 4.6), wood); deck.position.y = H; deck.castShadow = true; g.add(deck);
  for (const [ax, az, w, d] of [[0, -2.2, 4.6, 0.1], [0, 2.2, 4.6, 0.1], [-2.2, 0, 0.1, 4.6], [2.2, 0, 0.1, 4.6]]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, d), wood); rail.position.set(ax, H + 0.55, az); g.add(rail);
  }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(3.6, 1.6, 4), stdMat({ map: TEX.roof })); roof.position.y = H + 3; roof.rotation.y = Math.PI / 4; g.add(roof);
  for (const sx of [-2, 2]) for (const sz of [-2, 2]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.2, 0.14), wood); p.position.set(sx, H + 1.2, sz); g.add(p); }
  const ladder = new THREE.Mesh(new THREE.BoxGeometry(0.5, H, 0.08), wood); ladder.position.set(0, H / 2, -2.0); ladder.rotation.x = 0.08; g.add(ladder);
  scene.add(reg(g));
  // The searchlight: a slow beam sweeping the forest. It's the only light out there.
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.32, 0.5, 10), new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xdfe8ff, emissiveIntensity: 3 }));
  lamp.position.set(TOWER.x, H + 1.6, TOWER.z); scene.add(lamp); survivorOnly.push(lamp);
  const light = new THREE.SpotLight(0xdfe8ff, 900, 70, 0.13, 0.6, 1.3); light.position.copy(lamp.position);
  scene.add(light, light.target); survivorOnly.push(light);
  const len = 46, cg = new THREE.ConeGeometry(Math.tan(0.13) * len, len, 20, 1, true); cg.translate(0, -len / 2, 0); cg.rotateX(-Math.PI / 2);
  const cone = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ color: 0xbfd0ff, transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false }));
  cone.position.copy(lamp.position); scene.add(cone); survivorOnly.push(cone);
  world.search = { light, cone, lamp };
}
function buildStoneCircle(rng) {
  const g = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.2, x = CIRCLE.x + Math.cos(a) * CIRCLE.r, z = CIRCLE.z + Math.sin(a) * CIRCLE.r, h = 2.2 + rng() * 1.2;
    const st = new THREE.Mesh(new THREE.BoxGeometry(0.95, h, 0.5), MAT.rock);
    st.position.set(x, h / 2 - 0.1, z); st.rotation.set((rng() - 0.5) * 0.12, -a + Math.PI / 2, (rng() - 0.5) * 0.12); st.castShadow = true; g.add(st);
    addCircle(x, z, 0.55, 'stone');
    if (i % 3 === 0) { const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 1.3), MAT.rock); lintel.position.set(x, h + 0.05, z); lintel.rotation.y = -a + Math.PI / 2; g.add(lintel); }
  }
  const altar = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 0.9), MAT.rock); altar.position.set(CIRCLE.x, 0.45, CIRCLE.z); altar.castShadow = true; g.add(altar);
  addBox(CIRCLE.x - 0.8, CIRCLE.z - 0.45, CIRCLE.x + 0.8, CIRCLE.z + 0.45, 'altar');
  // Rune ring on the ground: dark until relics are found
  const tex = canvasTex(512, (c, s, r) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, s, s); c.strokeStyle = '#fff'; c.lineWidth = 3;
    for (const rad of [0.3, 0.47]) { c.beginPath(); c.arc(s / 2, s / 2, s * rad, 0, Math.PI * 2); c.stroke(); }
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2, x = s / 2 + Math.cos(a) * s * 0.385, y = s / 2 + Math.sin(a) * s * 0.385;
      c.save(); c.translate(x, y); c.rotate(a + Math.PI / 2); c.beginPath();
      for (let k = 0; k < 4; k++) { c.moveTo((r() - 0.5) * 22, (r() - 0.5) * 30); c.lineTo((r() - 0.5) * 22, (r() - 0.5) * 30); }
      c.stroke(); c.restore();
    }
    for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2 + 0.2; c.beginPath(); c.moveTo(s / 2, s / 2); c.lineTo(s / 2 + Math.cos(a) * s * 0.3, s / 2 + Math.sin(a) * s * 0.3); c.stroke(); }
  });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  const mat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x7fc8ff, emissiveMap: tex, emissiveIntensity: 0, transparent: true, alphaMap: tex, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(CIRCLE.r * 2.3, CIRCLE.r * 2.3), mat); ring.rotation.x = -Math.PI / 2; ring.position.set(CIRCLE.x, 0.03, CIRCLE.z);
  scene.add(ring); survivorOnly.push(ring);
  world.altar = mat;
  scene.add(reg(g));
}
function buildTruck() {
  const g = new THREE.Group(); g.position.set(TRUCK.x, 0, TRUCK.z); g.rotation.z = 0.04;
  const rust = stdMat({ color: 0x4a3328, roughness: 0.8, metalness: 0.4 }), dark = stdMat({ color: 0x0c0c0c, roughness: 0.9 });
  const bed = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.9, 4.8), rust); bed.position.y = 1.0;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.0, 1.7), rust); cab.position.set(0, 1.9, -1.0);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 0.05), stdMat({ color: 0x0a1418, roughness: 0.1, metalness: 0.8 })); glass.position.set(0, 2.0, -1.87);
  g.add(bed, cab, glass);
  for (const sx of [-1.05, 1.05]) for (const sz of [-1.6, 1.6]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.32, 12), dark); w.rotation.z = Math.PI / 2; w.position.set(sx, 0.48, sz); g.add(w); }
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffe9b0, emissiveIntensity: 1.5 });
  for (const sx of [-0.7, 0.7]) { const h = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.06), lampMat); h.position.set(sx, 1.1, -2.43); g.add(h); }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  world.truckLamp = lampMat;
  addBox(TRUCK.x - 1.15, TRUCK.z - 2.5, TRUCK.x + 1.15, TRUCK.z + 2.5, 'truck');
  world.truckBody = cab;
  scene.add(reg(g));
}
function buildLamps() {
  LAMPS.forEach(([x, z], i) => {
    const g = new THREE.Group(); g.position.set(x, 0, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 3.6, 8), MAT.metal); pole.position.y = 1.8; pole.castShadow = true;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 0.06), MAT.metal); arm.position.set(0.3, 3.55, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a1408, emissive: 0xffc27a, emissiveIntensity: 3 });
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.2), mat); head.position.set(0.6, 3.46, 0);
    g.add(pole, arm, head);
    const light = new THREE.PointLight(0xffc27a, 11, 15, 1.7); light.position.set(0.6, 3.3, 0); g.add(light); survivorOnly.push(light);
    world.flickers.push({ light, base: 11, phase: i * 7.3, kind: i === 1 ? 'dying' : 'lamp', mat });
    addCircle(x, z, 0.14, 'lamp');
    scene.add(reg(g));
  });
}
function buildLockers() {
  world.hides = [];
  LOCKERS.forEach((L, i) => {
    const g = new THREE.Group(); g.position.set(L.x, 0, L.z); g.rotation.y = L.ry;
    const box = (w, h, d, mat, x = 0, y = h / 2, z = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
    const dark = stdMat({ color: 0x050505 }), wood = stdMat({ map: TEX.planks, color: 0x8a7a66 }), woodD = stdMat({ map: TEX.planks, color: 0x5e5244 });
    const slits = (w, y0, z, n = 4) => { for (let k = 0; k < n; k++) box(w, 0.03, 0.02, dark, 0, y0 + k * 0.07, z); };
    let w = 0.9, d = 0.6;
    switch (L.type) {
      case 'locker':
        box(w, 2.0, d, MAT.metal); box(w * 0.84, 1.8, 0.04, stdMat({ color: 0x2c3638, metalness: 0.7, roughness: 0.5 }), 0, 1.0, -d / 2 - 0.02); slits(w * 0.55, 1.5, -d / 2 - 0.045);
        break;
      case 'wardrobe':
        w = 1.1; d = 0.6; box(w, 2.1, d, woodD); box(w * 0.46, 1.9, 0.04, wood, -w * 0.24, 1.05, -d / 2 - 0.02); box(w * 0.46, 1.9, 0.04, wood, w * 0.24, 1.05, -d / 2 - 0.02); slits(w * 0.7, 1.45, -d / 2 - 0.045);
        break;
      case 'outhouse':
        w = 1.1; d = 1.1; box(w, 2.2, d, wood); box(w * 0.84, 2.0, 0.04, woodD, 0, 1.1, -d / 2 - 0.02); slits(w * 0.5, 1.6, -d / 2 - 0.045);
        { const roof = box(w + 0.3, 0.1, d + 0.3, stdMat({ map: TEX.roof }), 0, 2.25); roof.rotation.x = 0.12; }
        break;
      case 'crypt': {
        w = 1.8; d = 1.4; box(w, 1.6, d, MAT.rock); box(w + 0.3, 0.2, d + 0.3, MAT.rock, 0, 1.7);
        box(0.9, 1.2, 0.06, stdMat({ color: 0x1a1d1c, metalness: 0.6, roughness: 0.6 }), 0, 0.6, -d / 2 - 0.03); // iron door, ajar
        for (let k = 0; k < 5; k++) box(0.03, 0.5, 0.03, dark, -0.3 + k * 0.15, 0.95, -d / 2 - 0.07);              // grille
        break;
      }
      case 'truck': w = 0; break; // the truck model is already there
      case 'log': {
        w = 0.9; d = 3.4;
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.55, d, 12, 1, true), MAT.bark); log.rotation.x = Math.PI / 2; log.position.y = 0.48; log.castShadow = true; g.add(log);
        const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.46, d - 0.02, 12, 1, true), stdMat({ color: 0x120c07, side: THREE.BackSide })); inner.rotation.x = Math.PI / 2; inner.position.y = 0.48; g.add(inner);
        const cap = new THREE.Mesh(new THREE.CircleGeometry(0.55, 12), MAT.bark); cap.position.set(0, 0.48, d / 2); g.add(cap);
        break;
      }
      case 'tent': {
        // A canvas A-frame; its front flaps are tied back so you can see the fire from inside
        w = 1.7; d = 2.1;
        const H = 1.3, hw = w / 2, hd = d / 2, P = (x, y, z) => new THREE.Vector3(x, y, z);
        const tris = [
          [P(-hw, 0, -hd), P(-hw, 0, hd), P(0, H, hd)], [P(-hw, 0, -hd), P(0, H, hd), P(0, H, -hd)],     // left slope
          [P(hw, 0, -hd), P(0, H, hd), P(hw, 0, hd)], [P(hw, 0, -hd), P(0, H, -hd), P(0, H, hd)],       // right slope
          [P(-hw, 0, hd), P(hw, 0, hd), P(0, H, hd)],                                                     // back
          [P(-hw, 0, -hd), P(0, H, -hd), P(-hw * 0.3, 0, -hd - 0.35)], [P(hw, 0, -hd), P(hw * 0.3, 0, -hd - 0.35), P(0, H, -hd)], // flaps
        ];
        const geo = new THREE.BufferGeometry().setFromPoints(tris.flat()); geo.computeVertexNormals();
        const canvasMat = stdMat({ map: TEX.canvas, color: 0x7a8060, side: THREE.DoubleSide, roughness: 1 });
        const tent = new THREE.Mesh(geo, canvasMat); tent.castShadow = true; tent.receiveShadow = true; g.add(tent);
        const ridge = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, d + 0.3, 5), MAT.bark); ridge.rotation.x = Math.PI / 2; ridge.position.y = H + 0.02; g.add(ridge);
        box(w * 0.9, 0.03, d * 0.95, stdMat({ color: 0x1c2016 }), 0, 0.02); // ground sheet
        break;
      }
      case 'crate':
        w = 1.4; d = 1.4; box(w, 1.3, d, stdMat({ map: TEX.crate })); box(w * 0.7, 0.9, 0.04, stdMat({ map: TEX.crate, color: 0x8a8a8a }), 0, 0.6, -d / 2 - 0.02); slits(w * 0.45, 0.85, -d / 2 - 0.045, 3);
        break;
    }
    if (w) {
      const hx = Math.abs(Math.cos(L.ry)) * w / 2 + Math.abs(Math.sin(L.ry)) * d / 2, hz = Math.abs(Math.sin(L.ry)) * w / 2 + Math.abs(Math.cos(L.ry)) * d / 2;
      addBox(L.x - hx, L.z - hz, L.x + hx, L.z + hz, 'locker');
    }
    scene.add(reg(g));
    world.hides[i] = g;
  });
}
// While you're inside, your own hiding spot is invisible to you (so you see out past its
// walls), your flashlight is off, and the screen frames the view through its gaps.
function setHideView(li) {
  (world.hides || []).forEach((g, i) => { if (g) g.visible = i !== li; });
  if (world.truckBody) world.truckBody.visible = !(li >= 0 && LOCKERS[li].type === 'truck');
  flashlight.visible = li < 0 && flashlightOn && viewMode === 'survivor';
  const o = $('#hide-overlay');
  o.className = li < 0 ? 'hidden' : 'hide-' + LOCKERS[li].type;
}

function buildGenerator(i) {
  const G = GENS[i];
  const g = new THREE.Group();
  g.position.set(G.x, 0, G.z); g.rotation.y = G.ry;
  const metal = stdMat({ color: 0x5b5e57, roughness: 0.55, metalness: 0.6 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.0, 0.9), metal); body.position.y = 0.5;
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.1, 14), stdMat({ color: 0x7a2a1d, roughness: 0.6, metalness: 0.3 }));
  tank.rotation.z = Math.PI / 2; tank.position.set(0, 1.2, 0);
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 8), metal); pipe.position.set(0.5, 1.4, 0.3);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2200, emissiveIntensity: 3 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), lampMat); lamp.position.set(0, 1.05, 0.46);
  for (const m of [body, tank, pipe]) { m.castShadow = true; m.receiveShadow = true; }
  g.add(body, tank, pipe, lamp);
  reg(g, 'gen');
  const light = new THREE.PointLight(0xff3010, 3, 7, 2); light.position.set(0, 1.4, 0.8); g.add(light); survivorOnly.push(light);
  // Circuit LEDs on the panel face: one per circuit, green as each is restored
  const leds = [];
  for (let k = 0; k < 3; k++) {
    const m = new THREE.MeshStandardMaterial({ color: 0x110000, emissive: 0x401008, emissiveIntensity: 1 });
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.02), m); led.position.set(-0.22 + k * 0.22, 0.78, 0.46);
    g.add(led); survivorOnly.push(led); leds.push(led);
  }
  // Panel door and cable stubs
  const panelMat = stdMat({ color: 0x2c312d, roughness: 0.6, metalness: 0.5 });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.03), panelMat); panel.position.set(0, 0.42, 0.46); g.add(panel);
  for (const sx of [-0.45, 0.45]) { const cable = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 6, 12, Math.PI), stdMat({ color: 0x111111 })); cable.position.set(sx, 0.08, 0.5); cable.rotation.y = Math.PI / 2; g.add(cable); }
  scene.add(g);
  // Footprint: 1.3 x 0.9 m, rotated with the generator
  const hx = Math.abs(Math.cos(G.ry)) * 0.65 + Math.abs(Math.sin(G.ry)) * 0.45, hz = Math.abs(Math.sin(G.ry)) * 0.65 + Math.abs(Math.cos(G.ry)) * 0.45;
  addBox(G.x - hx, G.z - hz, G.x + hx, G.z + hz, 'gen');
  world.gens.push({ group: g, lampMat, light, leds, pos: new THREE.Vector3(G.x, 0, G.z), shake: 0, cough: 0, spark: 0, puffT: 0 });
}

// Relics exist only in Ritual matches; they're rebuilt from the host's list each match.
function clearRelics() { for (const g of world.relics || []) { if (g) { unreg(g); scene.remove(g); } } world.relics = []; }
function buildRelics() {
  clearRelics();
  OBJ.forEach((o, i) => {
    if (o.kind !== 'relic') return;
    const g = new THREE.Group(); g.position.set(o.x, 0, o.z);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.0, 6), MAT.bark); stick.position.y = 0.5;
    const skull = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 0), new THREE.MeshStandardMaterial({ color: 0x202830, emissive: 0x9fd8ff, emissiveIntensity: 2.2, roughness: 0.4 }));
    skull.position.y = 1.15; skull.scale.set(1, 1.3, 1);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.015, 6, 20), new THREE.MeshStandardMaterial({ color: 0x101010, emissive: 0x6fb8ff, emissiveIntensity: 1.5 }));
    ring.position.y = 1.15;
    g.add(stick, skull, ring); g.userData.spin = [skull, ring];
    reg(g, 'gen'); scene.add(g); world.relics[i] = g;
  });
}
function buildWorld() {
  const rng = mulberry32(1337);
  MAT.bark = stdMat({ map: TEX.bark });
  MAT.needles = stdMat({ map: TEX.needles, color: 0x9fb39f });
  MAT.rock = stdMat({ map: TEX.rock, roughness: 0.95 });
  MAT.bush = stdMat({ map: TEX.needles, color: 0x6f8a62 });
  MAT.fence = stdMat({ map: TEX.planks, color: 0x8a8070 });
  MAT.metal = stdMat({ color: 0x3a4648, metalness: 0.7, roughness: 0.55 });

  // Ground and dirt paths
  buildTerrain();
  const gg = new THREE.PlaneGeometry(GROUND, GROUND, GROUND, GROUND);
  gg.rotateX(-Math.PI / 2); gg.translate(AREA / 2, 0, AREA / 2);
  const gpos = gg.attributes.position;
  for (let i = 0; i < gpos.count; i++) gpos.setY(i, heightAt(gpos.getX(i), gpos.getZ(i)));
  gg.computeVertexNormals();
  const ground = new THREE.Mesh(gg, stdMat({ map: TEX.ground, roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(reg(ground));
  const pathMat = stdMat({ map: TEX.path, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const p of PATHS) for (let i = 0; i < p.length - 1; i++) {
    const [ax, az] = p[i], [bx, bz] = p[i + 1], len = Math.hypot(bx - ax, bz - az);
    const seg = new THREE.Mesh(new THREE.PlaneGeometry(2.6, len + 2.4), pathMat);
    seg.rotation.x = -Math.PI / 2; seg.rotation.z = -Math.atan2(bx - ax, bz - az);
    seg.position.set((ax + bx) / 2, 0.012 + i * 0.001, (az + bz) / 2); seg.receiveShadow = true;
    scene.add(reg(seg));
  }

  // Creek, bridges and mist
  findBridges(); buildCreek(rng); buildMist(rng); // bridge planks go in once their models load

  // Cabins, the barn, the sawmill, the ruins, generators and the power lines
  CABINS.forEach(buildCabin);
  buildSawmill(); buildRuins(rng);
  GENS.forEach((_, i) => buildGenerator(i));
  buildChapelExtras(CABINS.find((c) => c.chapel)); buildGraveyard(rng); buildTower(); buildStoneCircle(rng); buildTruck(); buildLamps(); buildLockers();
  planPowerLines(); buildPowerLines();

  // Campfire: stone ring, logs, flickering flames and light
  const fire = new THREE.Group(); fire.position.set(CAMPFIRE.x, 0, CAMPFIRE.z);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2, st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22, 0), MAT.rock);
    st.position.set(Math.cos(a) * 0.75, 0.12, Math.sin(a) * 0.75); st.rotation.set(rng() * 3, rng() * 3, 0); fire.add(st);
  }
  for (let i = 0; i < 3; i++) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.1, 6), MAT.bark); l.rotation.set(Math.PI / 2, 0, i * 1.05); l.position.y = 0.12; fire.add(l); }
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.85, toneMapped: false });
  const flames = [];
  for (let i = 0; i < 4; i++) { const f = new THREE.Mesh(new THREE.ConeGeometry(0.22 - i * 0.03, 0.8 - i * 0.1, 6), flameMat); f.position.set((rng() - 0.5) * 0.25, 0.45, (rng() - 0.5) * 0.25); fire.add(f); flames.push(f); survivorOnly.push(f); }
  const fireLight = new THREE.PointLight(0xff8a3a, 14, 16, 1.6); fireLight.position.y = 1.0; fire.add(fireLight); survivorOnly.push(fireLight);
  // Logs to sit on
  for (const a of [0.4, 2.3, 4.2]) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.8, 8), MAT.bark); l.rotation.set(0, -a, Math.PI / 2); l.position.set(Math.cos(a) * 2.6, 0.22, Math.sin(a) * 2.6); l.castShadow = true; fire.add(l); }
  scene.add(reg(fire));
  addCircle(CAMPFIRE.x, CAMPFIRE.z, 0.95, 'fire');
  world.fire = { flames, light: fireLight };
  world.flickers.push({ light: fireLight, base: 14, phase: 0, kind: 'fire' });

  // Fence with the gate gap, and the road out
  const fenceGeos = [];
  const side = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(len / 3));
    for (let i = 0; i <= n; i++) { const t = i / n, post = new THREE.BoxGeometry(0.18, 1.8, 0.18); post.translate(lerp(x0, x1, t), 0.9, lerp(z0, z1, t)); fenceGeos.push(post); }
    for (const y of [0.55, 1.2, 1.7]) { const rail = new THREE.BoxGeometry(Math.abs(x1 - x0) + 0.1 || 0.08, 0.1, Math.abs(z1 - z0) + 0.1 || 0.08); rail.translate((x0 + x1) / 2, y, (z0 + z1) / 2); fenceGeos.push(rail); }
    addBox(Math.min(x0, x1) - 0.15, Math.min(z0, z1) - 0.15, Math.max(x0, x1) + 0.15, Math.max(z0, z1) + 0.15, 'fence');
  };
  const F0 = FENCE, F1 = AREA - FENCE, gx0 = GATE.x - GATE.w / 2, gx1 = GATE.x + GATE.w / 2;
  side(F0, F0, F1, F0); side(F0, F0, F0, F1); side(F1, F0, F1, F1);
  side(F0, F1, gx0, F1); side(gx1, F1, F1, F1);
  // Road walls (dense brush either side of the road)
  side(EXIT_ZONE.minX - 0.2, F1, EXIT_ZONE.minX - 0.2, EXIT_ZONE.maxZ); side(EXIT_ZONE.maxX + 0.2, F1, EXIT_ZONE.maxX + 0.2, EXIT_ZONE.maxZ);
  side(EXIT_ZONE.minX - 0.2, EXIT_ZONE.maxZ, EXIT_ZONE.maxX + 0.2, EXIT_ZONE.maxZ);
  const fence = new THREE.Mesh(mergeGeometries(fenceGeos), MAT.fence); fence.castShadow = fence.receiveShadow = true;
  scene.add(reg(fence));
  // Sliding chain-link gate
  const gateMat = new THREE.MeshStandardMaterial({ map: TEX.gate, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5 });
  const gate = new THREE.Mesh(new THREE.PlaneGeometry(GATE.w, 2.2), gateMat);
  gate.position.set(GATE.x, 1.1, F1); gate.castShadow = true;
  scene.add(reg(gate, 'gen'));
  addBox(gx0, F1 - 0.15, gx1, F1 + 0.15, 'gate');
  world.gate = { mesh: gate, x0: GATE.x };
  const signTex = canvasTex(256, (g, s) => {
    g.fillStyle = '#062a12'; g.fillRect(0, 0, s, s / 2);
    g.fillStyle = '#39ff8a'; g.font = 'bold 72px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('EXIT', s / 2, s / 4);
  });
  signTex.repeat.set(1, 2);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.35), new THREE.MeshBasicMaterial({ map: signTex, toneMapped: false, side: THREE.DoubleSide }));
  sign.position.set(GATE.x, 2.6, F1 - 0.05); sign.rotation.y = Math.PI;
  scene.add(reg(sign, 'gen'));
  for (const s of [-1, 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.9, 0.25), MAT.fence); post.position.set(GATE.x + s * (GATE.w / 2 + 0.15), 1.45, F1); scene.add(reg(post)); }
  const exitLight = new THREE.PointLight(0x2cff70, 5, 12, 1.8); exitLight.position.set(GATE.x, 2.4, F1 - 1.2);
  scene.add(exitLight); survivorOnly.push(exitLight); world.exitLight = exitLight;

  // Trees: blue-noise scatter inside the fence (with colliders) and a dense wall outside it.
  const treeGrid = new Map(), cellOf = (x, z) => Math.floor(x / 3) + ',' + Math.floor(z / 3);
  const tooClose = (x, z, md) => {
    const cx = Math.floor(x / 3), cz = Math.floor(z / 3);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) for (const t of treeGrid.get((cx + dx) + ',' + (cz + dz)) || []) if (Math.hypot(t[0] - x, t[1] - z) < md) return true;
    return false;
  };
  const plant = (x, z, inside) => { const k = cellOf(x, z); if (!treeGrid.has(k)) treeGrid.set(k, []); treeGrid.get(k).push([x, z]); buildTree(rng, x, z, inside); };
  for (let i = 0; i < 9000; i++) {
    const x = FENCE + 1 + rng() * (AREA - FENCE * 2 - 2), z = FENCE + 1 + rng() * (AREA - FENCE * 2 - 2);
    if (keepClear(x, z) || tooClose(x, z, 4.2)) continue;
    plant(x, z, true);
  }
  for (let i = 0; i < 5000; i++) {
    const x = -35 + rng() * (AREA + 70), z = -35 + rng() * (AREA + 70);
    const outside = x < FENCE - 1.5 || x > AREA - FENCE + 1.5 || z < FENCE - 1.5 || z > AREA - FENCE + 1.5;
    if (!outside || (x > EXIT_ZONE.minX - 2 && x < EXIT_ZONE.maxX + 2 && z > AREA - 6) || tooClose(x, z, 3.2)) continue;
    plant(x, z, false);
  }
  // Rocks and fallen logs (solid), bushes (cover, not solid)
  for (let i = 0, n = 0; i < 600 && n < 42; i++) {
    const x = 6 + rng() * (AREA - 12), z = 6 + rng() * (AREA - 12);
    if (keepClear(x, z) || tooClose(x, z, 2.5)) continue;
    const r = 0.5 + rng() * 1.1, geo = new THREE.DodecahedronGeometry(r, 0);
    geo.scale(1, 0.55 + rng() * 0.35, 1); geo.rotateY(rng() * 6); geo.translate(x, heightAt(x, z) + r * 0.25, z);
    addToChunk('rock', geo, x, z); addCircle(x, z, r * 0.95, 'rock'); n++;
  }
  for (let i = 0, n = 0; i < 600 && n < 20; i++) {
    const x = 6 + rng() * (AREA - 12), z = 6 + rng() * (AREA - 12), a = rng() * Math.PI, len = 4 + rng() * 4;
    const ex = Math.cos(a) * len / 2, ez = Math.sin(a) * len / 2;
    if (keepClear(x, z) || keepClear(x + ex, z + ez) || keepClear(x - ex, z - ez) || tooClose(x, z, 3)) continue;
    const geo = new THREE.CylinderGeometry(0.3, 0.38, len, 8); geo.rotateZ(Math.PI / 2); geo.rotateZ(Math.atan2(heightAt(x + ex, z + ez) - heightAt(x - ex, z - ez), len)); geo.rotateY(-a); geo.translate(x, heightAt(x, z) + 0.28, z);
    addToChunk('bark', geo, x, z);
    for (const t of [-0.4, 0, 0.4]) addCircle(x + Math.cos(a) * len * t, z + Math.sin(a) * len * t, 0.42, 'log');
    n++;
  }
  for (let i = 0, n = 0; i < 2000 && n < 160; i++) {
    const x = 4 + rng() * (AREA - 8), z = 4 + rng() * (AREA - 8);
    if (keepClear(x, z, -1.5)) continue;
    for (let k = 0; k < 3; k++) {
      const r = 0.45 + rng() * 0.4, geo = new THREE.IcosahedronGeometry(r, 0);
      const bx = x + (rng() - 0.5) * 1.2, bz = z + (rng() - 0.5) * 1.2;
      geo.scale(1.2, 0.75, 1.2); geo.translate(bx, heightAt(bx, bz) + r * 0.5, bz);
      addToChunk('bush', geo, x, z);
    }
    BUSHES.push([x, z]);
    n++;
  }
  flushChunks();

  // Night sky: stars and a hazy moon (survivor view only)
  const starPos = [];
  for (let i = 0; i < 1500; i++) {
    const u = rng() * Math.PI * 2, v = Math.acos(0.15 + rng() * 0.85), R = 180;
    starPos.push(AREA / 2 + R * Math.sin(v) * Math.cos(u), R * Math.cos(v), AREA / 2 + R * Math.sin(v) * Math.sin(u));
  }
  const starGeo = new THREE.BufferGeometry(); starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 0.9, sizeAttenuation: false, fog: false }));
  scene.add(stars); survivorOnly.push(stars);
  const moon = new THREE.Mesh(new THREE.SphereGeometry(6, 20, 16), new THREE.MeshBasicMaterial({ color: 0xdfe6ff, fog: false }));
  moon.position.set(AREA / 2 - 90, 110, AREA / 2 - 120); scene.add(moon); survivorOnly.push(moon);

  // Moonlight + sky/ground ambient
  const moonLight = new THREE.DirectionalLight(0x8fa3c8, 0.32); moonLight.position.set(-60, 100, -80); moonLight.target.position.set(AREA / 2, 0, AREA / 2);
  scene.add(moonLight, moonLight.target); survivorOnly.push(moonLight);
  scene.add(new THREE.HemisphereLight(0x3a4866, 0x0e0b07, 0.55));
  buildAtmosphere(rng);

  buildNav();
  for (let z = 0; z < NAV_H; z++) for (let x = 0; x < NAV_W; x++) if (navBlocked[navIdx(x, z)] === 0 && z < (AREA - FENCE) * NAV_RES) NAV_FREE.push({ x, z });
}

// Flashlight (survivor only)
let flashlightOn = true;
const flashlight = new THREE.SpotLight(0xfff0d6, 45, 28, 0.5, 0.45, 1.6);
flashlight.castShadow = true;
flashlight.shadow.mapSize.set(1024, 1024);
flashlight.shadow.camera.near = 0.2; flashlight.shadow.camera.far = 28;
flashlight.shadow.bias = -0.0005;
flashlight.position.set(0.2, -0.165, -0.56);
camera.add(flashlight);
flashlight.target.position.set(0.1, -0.1, -5);
camera.add(flashlight.target);

// ----------------------------------------------------------------------------
//  AVATARS
// ----------------------------------------------------------------------------
const SURV_COLORS = [0x3c6e91, 0x8a4f2d, 0x5d7a3a, 0x7a3a6d, 0x9a8a3a, 0x3a8a83];
function makeLabel(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d'); g.font = 'bold 28px monospace'; g.textAlign = 'center'; g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fillRect(0, 12, 256, 40); g.fillStyle = '#e6e2d3'; g.fillText(text, 128, 42);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: true, transparent: true, fog: false }));
  s.scale.set(1.2, 0.3, 1);
  survivorOnly.push(s); s.visible = viewMode !== 'monster';
  return s;
}
// ---- GLB character models (assets/), loaded once and cloned per player
const ASSETS = { survivor: null, monster: null, loaded: false };
const loader = new GLTFLoader();
// Decode embedded textures through <img> (TextureLoader) rather than fetch + createImageBitmap,
// since sandboxed embeds may forbid fetching blob: URLs. GLTFLoader still sets flipY = false.
loader.register((parser) => { parser.textureLoader = new THREE.TextureLoader(parser.options.manager); return { name: 'img_texture_loader' }; });
function loadGLB(url, onProgress) {
  if (window.BLINDSIGHT_MODELS && window.BLINDSIGHT_MODELS[url]) {
    // Hosts that can't serve .glb (IDEA Foundry): the build ships each model as base64 in
    // plain .js files loaded by script tags, which also works from file://.
    const bin = atob(window.BLINDSIGHT_MODELS[url].join('')), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    onProgress?.({ loaded: 1, total: 1 });
    return new Promise((res, rej) => loader.parse(bytes.buffer, '', res, rej));
  }
  if (window.BLINDSIGHT_EMBED) {
    // The artifact host only serves web types, so the embed build ships each .glb as
    // base64 inside a .json file (see tools/build-play.py).
    return fetch(url + '.json').then((r) => { if (!r.ok) throw new Error(r.status + ' ' + url); return r.json(); }).then((j) => {
      const bin = atob(j.glb), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      onProgress?.({ loaded: 1, total: 1 });
      return new Promise((res, rej) => loader.parse(bytes.buffer, '', res, rej));
    });
  }
  return new Promise((res, rej) => loader.load(url, res, (e) => onProgress?.(e), rej));
}
// Scale a model to a target height, stand it on y=0, centre it on x/z, and turn it to face -Z.
function normalizeModel(root, height, yaw) {
  const holder = new THREE.Group();
  holder.add(root);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  const size = box.getSize(new THREE.Vector3());
  const k = height / Math.max(size.y, 1e-6);
  root.scale.multiplyScalar(k);
  root.updateMatrixWorld(true);
  box.setFromObject(root, true);
  const c = box.getCenter(new THREE.Vector3());
  root.position.x -= c.x; root.position.z -= c.z; root.position.y -= box.min.y;
  const out = new THREE.Group(); out.add(holder); holder.rotation.y = yaw;
  return out;
}
async function prepSurvivorAsset(gltf) {
  // The source uses KHR_materials_pbrSpecularGlossiness, which three.js no longer reads,
  // so pull its diffuse texture (index 0) back in by hand.
  let diffuse = null;
  try { diffuse = await gltf.parser.getDependency('texture', 0); diffuse.colorSpace = THREE.SRGBColorSpace; } catch (e) { /* keep untextured */ }
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.frustumCulled = false;
    const m = o.material;
    if (diffuse && !m.map) m.map = diffuse;
    m.color?.set(0xffffff); m.metalness = 0; m.roughness = 0.75; m.side = THREE.FrontSide; m.needsUpdate = true;
  });
  const template = normalizeModel(gltf.scene, 1.75, Math.PI);
  // The single "Walk + Idle" clip (60 fps) holds a walk cycle (frames 0-64) then an idle (75-180).
  const clip = gltf.animations[0];
  let walk = null, idle = null;
  if (clip) {
    walk = THREE.AnimationUtils.subclip(clip, 'walk', 0, 64, 60);
    idle = THREE.AnimationUtils.subclip(clip, 'idle', 75, 180, 60);
    // Keep the walk in place: pin the hips' horizontal root motion to its first key.
    for (const t of walk.tracks) {
      if (!/Hips/i.test(t.name) || !t.name.endsWith('.position')) continue;
      const v = t.values;
      for (let i = 3; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; }
    }
  }
  return { template, walk, idle };
}
// ---- The monster: Zoonomaly Monster 2 (rigged, with its own animation clips) ---------
const MONSTER_H = 3.0;     // bind-pose height used for the first normalisation pass
const MONSTER_HEAD = 2.7;  // final height of its head when standing in its idle animation
const MONSTER_EYE = 2.55;  // the monster player's eye height
// Clip names in the file are prefixed "<armature>|"; map them to the roles the game needs.
const MONSTER_CLIPS = { idle: 'idle', walk: 'walk', run: 'walkfast', attack1: 'Attack 1', attack2: 'Attack 2', attack3: 'Attack 3', hit: 'Hit', jumpscare: 'Jumpscare' };
function prepMonsterAsset(gltf) {
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.frustumCulled = false; // skinned: bounds don't follow the pose
    o.material.side = THREE.FrontSide;
  });
  const clips = {};
  for (const [role, name] of Object.entries(MONSTER_CLIPS)) {
    const c = gltf.animations.find((a) => a.name.split('|').pop() === name);
    if (c) clips[role] = c;
  }
  if (!clips.idle || !clips.walk) throw new Error('monster.glb is missing its idle/walk clips');
  // Its bind pose is crouched but its animations stand it upright, so size it by where its
  // head ends up in the idle animation rather than by the bind-pose bounding box.
  const template = normalizeModel(gltf.scene, MONSTER_H, Math.PI);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(clips.idle).play(); mixer.update(0);
  template.updateMatrixWorld(true);
  let head = null; gltf.scene.traverse((o) => { if (o.isBone && /^head_011/.test(o.name)) head = o; });
  if (head) template.scale.multiplyScalar(MONSTER_HEAD / Math.max(0.5, head.getWorldPosition(new THREE.Vector3()).y));
  mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
  return { template, clips };
}
// Per-avatar controller: idle / walk / fast-walk blended by speed, with stride-matched
// playback rates; attacks, the jumpscare (kills) and the hit (a startle/convulsion) play
// on top as one-shots.
function makeMonsterAnimator(model) {
  const mixer = new THREE.AnimationMixer(model);
  const C = ASSETS.monster.clips, act = {};
  for (const [k, clip] of Object.entries(C)) {
    const a = mixer.clipAction(clip); act[k] = a;
    if (['idle', 'walk', 'run'].includes(k)) { a.play(); a.setEffectiveWeight(k === 'idle' ? 1 : 0); a.time = Math.random() * clip.duration; }
    else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
  }
  const st = { mixer, act, clips: C, w: { idle: 1, walk: 0, run: 0 }, shot: null, shotT: 0, shotW: 0, shotLen: 0, rate: 1, rest: [] };
  // The mixer only writes a bone when its animated value changes, so a bone holding still in
  // the clip would keep (and pile up) last frame's procedural rotations. Each frame every
  // bone is put back to the pose the clips produced before the mixer runs again.
  model.traverse((o) => { if (o.isBone) st.rest.push([o, o.quaternion.clone(), o.position.clone()]); });
  // play('attack') picks one of the three attacks at random; `len` can cut a long clip short.
  st.play = (name, { len = 0, rate = 1, from = 0 } = {}) => {
    if (name === 'attack') name = ['attack1', 'attack2', 'attack3'][Math.floor(Math.random() * 3)];
    if (!act[name]) return;
    if (st.shot && st.shot !== name) act[st.shot].stop();
    st.shot = name; st.shotT = 0; st.shotLen = (len || C[name].duration - from) / rate;
    act[name].reset(); act[name].time = from; act[name].timeScale = rate; act[name].play();
  };
  st.busy = () => !!st.shot;
  st.update = (dt, speed) => {
    const run = clamp((speed - 4.0) / 1.4, 0, 1), move = clamp(speed / 0.9, 0, 1);
    const tgt = { run: run * move, walk: (1 - run) * move, idle: 1 - move };
    for (const k in tgt) st.w[k] = damp(st.w[k], tgt[k], 7, dt);
    // Stride matching: the clips cover ~2.2 m (walk) and ~4.5 m (fast walk) per second at 1x.
    act.walk.timeScale = clamp(speed / 2.2, 0.5, 2.0) * st.rate;
    act.run.timeScale = clamp(speed / 4.5, 0.8, 1.6) * st.rate;
    act.idle.timeScale = st.rate;
    if (st.shot) {
      st.shotT += dt;
      st.shotW = smooth01(st.shotT / 0.1) * (1 - smooth01((st.shotT - (st.shotLen - 0.2)) / 0.2));
      if (st.shotT >= st.shotLen) { act[st.shot].stop(); st.shot = null; st.shotW = 0; }
    }
    const loco = 1 - st.shotW, sum = st.w.idle + st.w.walk + st.w.run || 1;
    for (const k of ['idle', 'walk', 'run']) act[k].setEffectiveWeight((st.w[k] / sum) * loco);
    if (st.shot) act[st.shot].setEffectiveWeight(st.shotW);
    for (const [b, q, p] of st.rest) { b.quaternion.copy(q); b.position.copy(p); }
    mixer.update(dt);
    for (const r of st.rest) { r[1].copy(r[0].quaternion); r[2].copy(r[0].position); } // the clean animated pose
  };
  return st;
}
function smooth01(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
async function loadAssets(onProgress) {
  const prog = { s: 0, m: 0 };
  const report = () => onProgress?.((prog.s + prog.m) / 2);
  const pct = (key) => (e) => { if (e.total) { prog[key] = e.loaded / e.total; report(); } };
  const [s, m, b1, b2] = await Promise.allSettled([
    loadGLB('assets/survivor.glb', pct('s')).then(prepSurvivorAsset),
    loadGLB('assets/monster.glb', pct('m')).then(prepMonsterAsset),
    loadGLB('assets/bridge1.glb').then((g) => g.scene),
    loadGLB('assets/bridge2.glb').then((g) => g.scene),
  ]);
  if (b1.status === 'fulfilled') ASSETS.bridge1 = b1.value;
  if (b2.status === 'fulfilled') ASSETS.bridge2 = b2.value;
  if (s.status === 'fulfilled') ASSETS.survivor = s.value; else console.warn('Survivor model failed to load, using fallback.', s.reason);
  if (m.status === 'fulfilled') ASSETS.monster = m.value; else console.warn('Monster model failed to load, using fallback.', m.reason);
  ASSETS.loaded = true;
}

function makeSurvivorAvatar(name, colorIdx) {
  const g = new THREE.Group();
  const rig = new THREE.Group(); g.add(rig);
  if (ASSETS.survivor) {
    const model = SkeletonUtils.clone(ASSETS.survivor.template);
    rig.add(model);
    const mixer = new THREE.AnimationMixer(model);
    const acts = {};
    if (ASSETS.survivor.walk) {
      acts.walk = mixer.clipAction(ASSETS.survivor.walk); acts.idle = mixer.clipAction(ASSETS.survivor.idle);
      acts.walk.play(); acts.idle.play(); acts.walk.setEffectiveWeight(0); acts.idle.time = Math.random() * 1.5;
    }
    g.userData.mixer = mixer; g.userData.acts = acts;
    const bones = {}; model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    g.userData.rest = Object.values(bones).map((b) => [b, b.quaternion.clone(), b.position.clone()]); // see makeMonsterAnimator
    const find = (re) => bones[Object.keys(bones).find((n) => re.test(n))];
    g.userData.bones = {
      spine: find(/Spine_/), spine2: find(/Spine2_/), neck: find(/Neck_/),
      lArm: find(/LeftArm_/), rArm: find(/RightArm_/), lFore: find(/LeftForeArm_/), rFore: find(/RightForeArm_/),
      lUp: find(/LeftUpLeg_/), rUp: find(/RightUpLeg_/), lLeg: find(/LeftLeg_/), rLeg: find(/RightLeg_/),
      lFoot: find(/LeftFoot_/), rFoot: find(/RightFoot_/),
    };
    reg(g, 'entity');
    const label = makeLabel(name); label.position.y = 2.05; g.add(label);
    g.userData.rig = rig;
    scene.add(g);
    return g;
  }
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.75, 4, 12), new THREE.MeshStandardMaterial({ color: SURV_COLORS[colorIdx % SURV_COLORS.length], roughness: 0.85 }));
  body.position.y = 0.75;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 12), new THREE.MeshStandardMaterial({ color: 0xc89d78, roughness: 0.7 }));
  head.position.y = 1.43;
  const torch = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.25, 8), new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff0c0, emissiveIntensity: 2 }));
  torch.rotation.x = Math.PI / 2; torch.position.set(0.24, 1.1, -0.28);
  for (const m of [body, head, torch]) m.castShadow = true;
  rig.add(body, head, torch);
  reg(g, 'entity');
  const label = makeLabel(name); label.position.y = 1.95; g.add(label);
  g.userData.rig = rig;
  scene.add(g);
  return g;
}
function makeMonsterAvatar() {
  const g = new THREE.Group();
  const rig = new THREE.Group(); g.add(rig);
  if (ASSETS.monster) {
    const model = SkeletonUtils.clone(ASSETS.monster.template);
    const mats = [], meshes = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      // alphaHash gives a dithered fade for the camouflage without transparency sorting.
      const m = o.material.clone(); m.alphaHash = true;
      o.material = m; mats.push(m); meshes.push(o);
    });
    rig.add(model);
    reg(g, 'entity');
    const bones = {};
    model.traverse((o) => { if (!o.isBone) return; for (const [k, re] of Object.entries(MONSTER_BONES)) if (re.test(o.name)) bones[k] = o; });
    const eyeMat = new THREE.SpriteMaterial({ map: TEX.glow, color: 0xff2a14, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const eyes = [new THREE.Sprite(eyeMat), new THREE.Sprite(eyeMat)];
    for (const e of eyes) { e.scale.setScalar(0.11); scene.add(e); survivorOnly.push(e); e.visible = viewMode !== 'monster'; }
    g.userData.monster = {
      eyes, anim: makeMonsterAnimator(model), mats, meshes, bones, camo: 0, stillT: 0, look: 0, spasms: [], nextSpasm: time + 1 + Math.random() * 3,
      bank: 0, pitch: 0, rateT: 0, rateTarget: 1, freeze: 0, owed: 0,
    };
    g.userData.rig = rig;
    scene.add(g);
    return g;
  }
  rig.scale.setScalar(MONSTER_H / 2.7);
  const skin = new THREE.MeshStandardMaterial({ color: 0x1b1714, roughness: 0.65, metalness: 0.1 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 1.35, 6, 14), skin); body.position.y = 1.35; body.scale.set(1, 1, 0.75);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 18, 14), skin); head.scale.set(0.85, 1.35, 1.1); head.position.set(0, 2.45, -0.12);
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.04, 0.05), new THREE.MeshStandardMaterial({ color: 0x200000, emissive: 0xff1a00, emissiveIntensity: 2.5 }));
  mouth.position.set(0, 2.25, -0.45);
  rig.add(body, head, mouth);
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.04, 1.7, 8), skin);
    arm.position.set(side * 0.46, 1.25, -0.12); arm.rotation.z = side * 0.12; arm.rotation.x = -0.25;
    const claw = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.35, 6), new THREE.MeshStandardMaterial({ color: 0x8a8070, roughness: 0.4 }));
    claw.position.y = -0.95; claw.rotation.x = Math.PI; arm.add(claw);
    rig.add(arm); arm.name = side < 0 ? 'armL' : 'armR';
  }
  rig.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  reg(g, 'entity');
  g.userData.rig = rig;
  scene.add(g);
  return g;
}

// ----------------------------------------------------------------------------
//  AUDIO (WebAudio synthesis — no assets)
// ----------------------------------------------------------------------------
const audio = { ctx: null, master: null, drone: [], noiseBuf: null };
function initAudio() {
  if (audio.ctx) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return; }
  const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
  audio.ctx = new C();
  audio.master = audio.ctx.createGain(); audio.master.gain.value = 0.7; audio.master.connect(audio.ctx.destination);
  const len = audio.ctx.sampleRate; audio.noiseBuf = audio.ctx.createBuffer(1, len, len);
  const d = audio.noiseBuf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
}
function tone({ f = 440, f2 = null, dur = 0.2, type = 'sine', vol = 0.2, pan = 0, delay = 0, attack = 0.005 }) {
  if (!audio.ctx || vol <= 0.001) return;
  const t0 = audio.ctx.currentTime + delay;
  const o = audio.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  const g = audio.ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  const p = audio.ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
  o.connect(g).connect(p).connect(audio.master); o.start(t0); o.stop(t0 + dur + 0.05);
}
function noise({ dur = 0.2, vol = 0.2, pan = 0, freq = 800, q = 1, type = 'bandpass', delay = 0 }) {
  if (!audio.ctx || vol <= 0.001) return;
  const t0 = audio.ctx.currentTime + delay;
  const s = audio.ctx.createBufferSource(); s.buffer = audio.noiseBuf;
  const f = audio.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = audio.ctx.createGain(); g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  const p = audio.ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
  s.connect(f).connect(g).connect(p).connect(audio.master); s.start(t0, Math.random() * 0.5); s.stop(t0 + dur + 0.05);
}
const sfx = {
  step: (vol, pan = 0) => noise({ dur: 0.09, vol: vol * 0.25, pan, freq: 300 + Math.random() * 200, q: 0.8 }),
  heavyStep: (vol, pan) => { tone({ f: 70, f2: 40, dur: 0.25, type: 'sine', vol: vol * 0.6, pan }); noise({ dur: 0.15, vol: vol * 0.2, pan, freq: 150 }); },
  heartbeat: (vol) => { tone({ f: 58, f2: 40, dur: 0.16, vol }); tone({ f: 52, f2: 36, dur: 0.2, vol: vol * 0.8, delay: 0.18 }); },
  blip: (vol, pan) => tone({ f: 900 + Math.random() * 200, f2: 500, dur: 0.18, type: 'sine', vol: vol * 0.25, pan }),
  ping: () => { tone({ f: 1400, f2: 200, dur: 1.4, type: 'sine', vol: 0.3 }); tone({ f: 700, f2: 120, dur: 1.6, type: 'triangle', vol: 0.15 }); },
  screech: (vol, pan) => { tone({ f: 600, f2: 2200, dur: 0.6, type: 'sawtooth', vol: vol * 0.15, pan }); tone({ f: 640, f2: 1500, dur: 0.8, type: 'square', vol: vol * 0.08, pan, delay: 0.05 }); noise({ dur: 0.7, vol: vol * 0.2, pan, freq: 2500, q: 2 }); },
  swipe: () => noise({ dur: 0.25, vol: 0.3, freq: 1800, q: 0.7 }),
  hit: () => { noise({ dur: 0.35, vol: 0.6, freq: 500, q: 0.6 }); tone({ f: 120, f2: 50, dur: 0.4, type: 'square', vol: 0.25 }); },
  gen: () => { tone({ f: 110, f2: 220, dur: 1.2, type: 'sawtooth', vol: 0.12 }); tone({ f: 660, dur: 0.3, vol: 0.12, delay: 0.9 }); },
  gate: () => { tone({ f: 60, f2: 90, dur: 2.5, type: 'sawtooth', vol: 0.15 }); noise({ dur: 2.5, vol: 0.12, freq: 200 }); },
  clicks: (vol, pan) => { const n = 3 + Math.floor(Math.random() * 5); for (let i = 0; i < n; i++) noise({ dur: 0.025, vol: vol * (0.5 + Math.random() * 0.5), pan, freq: 1800 + Math.random() * 2600, q: 6, delay: i * (0.045 + Math.random() * 0.05) }); },
  breath: (vol, pan) => { noise({ dur: 0.9, vol: vol * 0.5, pan, freq: 420, q: 0.7 }); noise({ dur: 1.1, vol: vol * 0.35, pan, freq: 260, q: 0.8, delay: 1.0 }); },
  chase: (k) => { tone({ f: 52, f2: 46, dur: 0.22, type: 'sawtooth', vol: 0.16 * k }); noise({ dur: 0.08, vol: 0.12 * k, freq: 140, q: 0.8 }); },
  sting: () => { for (const f of [311, 440, 466, 932]) tone({ f, f2: f * 1.03, dur: 1.1, type: 'sawtooth', vol: 0.07 }); noise({ dur: 0.5, vol: 0.3, freq: 3200, q: 0.8 }); },
  branch: (vol, pan) => { noise({ dur: 0.06, vol: vol * 0.7, pan, freq: 2600, q: 2 }); noise({ dur: 0.12, vol: vol * 0.5, pan, freq: 900, q: 1.5, delay: 0.05 }); noise({ dur: 0.3, vol: vol * 0.2, pan, freq: 400, q: 1, delay: 0.12 }); },
  creak: (vol, pan) => { tone({ f: 70 + Math.random() * 40, f2: 50 + Math.random() * 30, dur: 1.4 + Math.random(), type: 'sawtooth', vol: vol * 0.08, pan, attack: 0.3 }); tone({ f: 140, f2: 95, dur: 1.2, type: 'triangle', vol: vol * 0.05, pan, attack: 0.4 }); },
  owl: (vol, pan) => { for (const [d, f] of [[0, 380], [0.45, 360], [0.75, 360]]) tone({ f, f2: f * 0.92, dur: 0.35, type: 'sine', vol: vol * 0.22, pan, delay: d, attack: 0.06 }); },
  crow: (vol, pan) => { for (const d of [0, 0.35, 0.7]) { tone({ f: 620, f2: 480, dur: 0.22, type: 'sawtooth', vol: vol * 0.06, pan, delay: d }); noise({ dur: 0.2, vol: vol * 0.15, pan, freq: 1400, q: 2, delay: d }); } },
  rustle: (vol, pan) => { for (let i = 0; i < 6; i++) noise({ dur: 0.08 + Math.random() * 0.1, vol: vol * 0.18, pan, freq: 3000 + Math.random() * 3000, q: 0.8, delay: i * 0.07 + Math.random() * 0.05 }); },
  splash: (vol, pan) => { noise({ dur: 0.35, vol: vol * 0.3, pan, freq: 1100, q: 0.5 }); noise({ dur: 0.15, vol: vol * 0.15, pan, freq: 3200, q: 1, delay: 0.08 }); },
  bell: (vol, pan) => { for (const f of [196, 392, 588, 932]) tone({ f, dur: 4, type: 'sine', vol: vol * (f === 196 ? 0.14 : 0.05), pan, attack: 0.005 }); },
  howl: (vol, pan) => { tone({ f: 250, f2: 520, dur: 1.1, type: 'sine', vol, pan, attack: 0.4 }); tone({ f: 520, f2: 180, dur: 2.6, type: 'sine', vol: vol * 0.9, pan, delay: 1.0, attack: 0.1 }); tone({ f: 527, f2: 186, dur: 2.6, type: 'triangle', vol: vol * 0.4, pan, delay: 1.0 }); },
  relic: () => { tone({ f: 660, f2: 990, dur: 0.5, type: 'sine', vol: 0.12 }); tone({ f: 1320, dur: 0.7, type: 'sine', vol: 0.06, delay: 0.15 }); },
  repair: () => noise({ dur: 0.06, vol: 0.06, freq: 2500 + Math.random() * 1500, q: 4 }),
  panel: () => { noise({ dur: 0.12, vol: 0.2, freq: 900, q: 2 }); tone({ f: 180, f2: 120, dur: 0.15, type: 'square', vol: 0.05, delay: 0.05 }); },
  pipeTick: () => noise({ dur: 0.03, vol: 0.05, freq: 3200 + Math.random() * 800, q: 6 }),
  valve: (c) => { tone({ f: 330 + c * 70, dur: 0.12, type: 'triangle', vol: 0.08 }); noise({ dur: 0.08, vol: 0.12, freq: 1200, q: 3 }); },
  circuit: () => { tone({ f: 220, f2: 660, dur: 0.5, type: 'sawtooth', vol: 0.08 }); for (const [d, f] of [[0.1, 523], [0.22, 659], [0.34, 784]]) tone({ f, dur: 0.25, type: 'triangle', vol: 0.09, delay: d }); },
  clang: (vol, pan) => { tone({ f: 190, f2: 120, dur: 0.9, type: 'square', vol: vol * 0.08, pan }); tone({ f: 1430, f2: 1360, dur: 1.2, type: 'sine', vol: vol * 0.12, pan }); noise({ dur: 0.4, vol: vol * 0.3, pan, freq: 700, q: 0.8 }); },
  sabotage: (vol, pan) => { for (let i = 0; i < 9; i++) noise({ dur: 0.05 + Math.random() * 0.08, vol: vol * (0.3 + Math.random() * 0.4), pan, freq: 2500 + Math.random() * 4000, q: 2, delay: i * 0.06 + Math.random() * 0.04 }); tone({ f: 120, f2: 40, dur: 0.8, type: 'sawtooth', vol: vol * 0.15, pan }); noise({ dur: 0.5, vol: vol * 0.4, pan, freq: 400, q: 0.6 }); },
  splash: (vol) => { noise({ dur: 0.25, vol: 0.18 + vol * 0.2, freq: 900 + Math.random() * 600, q: 0.5 }); noise({ dur: 0.12, vol: 0.1, freq: 3000, q: 1, delay: 0.05 }); },
  creak: (vol) => { tone({ f: 160 + Math.random() * 60, f2: 110, dur: 0.22, type: 'sawtooth', vol: 0.03 + vol * 0.05 }); noise({ dur: 0.08, vol: vol * 0.2, freq: 500, q: 1 }); },
};
// Continuous ambience: a wind bed that swells with gusts, and the creek when you're near it.
const ambBed = { wind: null, windF: null, creek: null };
function startAmbience() {
  if (!audio.ctx || ambBed.wind) return;
  const mk = (type, freq, q) => {
    const s = audio.ctx.createBufferSource(); s.buffer = audio.noiseBuf; s.loop = true;
    const f = audio.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = audio.ctx.createGain(); g.gain.value = 0;
    s.connect(f).connect(g).connect(audio.master); s.start();
    return { g, f };
  };
  const w = mk('bandpass', 380, 0.6), c = mk('bandpass', 1700, 0.9);
  ambBed.wind = w.g; ambBed.windF = w.f; ambBed.creek = c.g;
}
function updateAmbience() {
  if (!audio.ctx) return;
  startAmbience();
  const playing = game.phase === 'playing' || game.phase === 'ended', t = audio.ctx.currentTime;
  const wind = playing ? 0.025 + ENV.gust * 0.11 + Math.sin(time * 0.3) * 0.008 : 0;
  ambBed.wind.gain.setTargetAtTime(wind, t, 0.4);
  ambBed.windF.frequency.setTargetAtTime(320 + ENV.gust * 380 + Math.sin(time * 0.7) * 60, t, 0.5);
  const dc = distToPolyline(me.pos.x, me.pos.z, CREEK);
  ambBed.creek.gain.setTargetAtTime(playing ? clamp(1 - dc / 28, 0, 1) ** 2 * 0.07 : 0, t, 0.5);
}
function startDrone(mode) {
  if (!audio.ctx) return;
  for (const n of audio.drone) { try { n.stop(); } catch (e) { /* already stopped */ } }
  audio.drone = [];
  if (!mode) return;
  const freqs = mode === 'monster' ? [41, 41.6, 82.5] : [55, 55.7, 110.4, 164];
  const g = audio.ctx.createGain(); g.gain.value = mode === 'monster' ? 0.05 : 0.035;
  const f = audio.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
  g.connect(f).connect(audio.master);
  for (const fr of freqs) { const o = audio.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fr; o.connect(g); o.start(); audio.drone.push(o); }
}
// Stereo pan of a world position relative to the local camera.
function panOf(pos) {
  const vx = pos.x - me.pos.x, vz = pos.z - me.pos.z, len = Math.hypot(vx, vz) || 1;
  return clamp((vx * Math.cos(me.yaw) - vz * Math.sin(me.yaw)) / len, -1, 1);
}

// ----------------------------------------------------------------------------
//  GAME STATE
// ----------------------------------------------------------------------------
const game = {
  phase: 'menu', // menu | lobby | playing | ended
  mode: 'escape',
  gens: GENS.map(() => ({ progress: 0, done: false })),   // one entry per objective in OBJ
  timeLeft: CFG.DURATION,
  gateOpen: false,
};
const me = {
  id: null, name: 'Survivor', isMonster: false, pos: new THREE.Vector3(), yaw: 0, pitch: 0,
  hp: CFG.MAX_HP, status: 'alive', stamina: 1, exhausted: false, crouch: false, sprint: false, noise: 0,
  moving: false, repairing: false, boost: 0, attackCD: 0, sonarCD: 0, eye: 1.6, bob: 0, stepT: 0,
  repairAcc: 0, repairGen: -1, escapeSent: false, damage: 0, lunge: 0, colorIdx: 0,
};
const players = new Map(); // remote players (everyone except me)
let lobbyPlayers = [];

// ----------------------------------------------------------------------------
//  NETWORKING (PeerJS, host-authoritative star)
// ----------------------------------------------------------------------------
//  Client → Host : hello, state, attack, repair, sonar, escape
//  Host → Client : welcome, reject, lobby, start, snap (15–20 Hz), event, end
const net = { peer: null, isHost: false, offline: false, hostConn: null, conns: new Map(), code: null };

// Optional self-hosted signaling server: ?peerHost=example.com&peerPort=9000&peerPath=/&peerSecure=0
// Where the game is hosted for online play (GitHub Pages; see .github/workflows/pages.yml).
const ONLINE_URL = 'https://aarteaga2030-prog.github.io/Horrorgamenew/';
// STUN finds each player's public address; the TURN relay carries traffic for players
// behind strict NATs (mobile networks, some routers) who can't connect directly.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
function peerOptions() {
  const q = new URLSearchParams(location.search);
  const o = { debug: 1, config: { iceServers: ICE_SERVERS } };
  if (q.get('peerHost')) {
    o.host = q.get('peerHost');
    o.port = +(q.get('peerPort') || 443);
    o.path = q.get('peerPath') || '/';
    o.secure = q.get('peerSecure') ? q.get('peerSecure') !== '0' : location.protocol === 'https:';
  }
  return o;
}
function randomCode() { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 5; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }

function sendToHost(msg) {
  if (net.isHost) hostHandle(me.id, msg);
  else if (net.hostConn && net.hostConn.open) net.hostConn.send(msg);
}
function broadcast(msg) {
  for (const c of net.conns.values()) if (c.open) c.send(msg);
  clientHandle(msg);
}
function sendTo(id, msg) {
  if (id === me.id) clientHandle(msg);
  else { const c = net.conns.get(id); if (c && c.open) c.send(msg); }
}

function hostCreate(offline) {
  net.isHost = true; net.offline = offline;
  if (offline) { me.id = 'local'; net.code = 'OFFLINE'; hostInit(); return; }
  if (typeof Peer === 'undefined') { menuStatus('PeerJS failed to load. Try "Practice offline".', true); return; }
  const code = randomCode();
  menuStatus('Creating room…');
  const peer = new Peer(CFG.PEER_PREFIX + code, peerOptions());
  net.peer = peer;
  peer.on('open', (id) => { me.id = id; net.code = code; hostInit(); });
  peer.on('connection', (conn) => {
    conn.on('data', (d) => hostHandle(conn.peer, d));
    conn.on('open', () => net.conns.set(conn.peer, conn));
    conn.on('close', () => hostRemovePlayer(conn.peer));
    conn.on('error', () => hostRemovePlayer(conn.peer));
  });
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id') { peer.destroy(); hostCreate(false); return; }
    menuStatus('Network error: ' + e.type, true);
  });
  let retries = 0;
  peer.on('disconnected', () => {
    // Losing the signaling server does not drop existing P2P links; just try to re-register a few times.
    if (!peer.destroyed && retries++ < 5) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000 * retries);
  });
}
function joinRoom(code) {
  code = code.trim().toUpperCase();
  if (!code) { menuStatus('Enter a room ID.', true); return; }
  if (typeof Peer === 'undefined') { menuStatus('PeerJS failed to load.', true); return; }
  menuStatus('Connecting…');
  const peer = new Peer(peerOptions());
  net.peer = peer;
  peer.on('open', (id) => {
    me.id = id;
    const conn = peer.connect(CFG.PEER_PREFIX + code, { reliable: true, serialization: 'json' });
    net.hostConn = conn; net.code = code;
    conn.on('open', () => conn.send({ t: 'hello', name: me.name }));
    conn.on('data', clientHandle);
    conn.on('close', () => fatal('Lost connection to the host.'));
    setTimeout(() => { if (!conn.open && game.phase === 'menu') menuStatus('Could not reach room ' + code + '.', true); }, 9000);
  });
  peer.on('error', (e) => menuStatus(e.type === 'peer-unavailable' ? 'Room not found.' : 'Network error: ' + e.type, true));
}

// ---------------- HOST AUTHORITY ----------------
const hs = { players: {}, phase: 'lobby', gens: [], timeLeft: 0, gateOpen: false, snapAcc: 0, lastSnapIds: '' };
function hostInit() {
  hs.players = {};
  // Role flags are assigned on join: the room creator starts as the monster,
  // everyone who joins later is a survivor. The host may reassign in the lobby.
  hs.players[me.id] = newHostPlayer(me.id, me.name, true, false);
  hs.phase = 'lobby';
  broadcastLobby();
}
function newHostPlayer(id, name, isMonster, isBot) {
  return { id, name, isMonster, isBot, x: 0, z: 0, ry: 0, n: 0, c: 0, r: 0, hp: CFG.MAX_HP, s: 'alive', lastHit: -99, lastAttack: -99, colorIdx: Object.keys(hs.players).length, bot: null };
}
function lobbyList() { return Object.values(hs.players).map((p) => ({ id: p.id, name: p.name, isMonster: p.isMonster, isBot: p.isBot })); }
function broadcastLobby() { broadcast({ t: 'lobby', code: net.code, mode: $('#mode-select').value, players: lobbyList() }); }

function hostHandle(from, msg) {
  const p = hs.players[from];
  switch (msg.t) {
    case 'hello': {
      if (hs.phase !== 'lobby') { const c = net.conns.get(from); c?.send({ t: 'reject', reason: 'Game already in progress.' }); setTimeout(() => c?.close(), 300); return; }
      hs.players[from] = newHostPlayer(from, String(msg.name || 'Survivor').slice(0, 16), false, false);
      sendTo(from, { t: 'welcome', id: from });
      broadcastLobby();
      break;
    }
    case 'state': {
      if (!p || hs.phase !== 'playing' || p.s !== 'alive') return;
      p.x = msg.x; p.z = msg.z; p.ry = msg.ry; p.n = clamp(+msg.n || 0, 0, 1); p.c = msg.c; p.r = msg.r; p.h = msg.h ? 1 : 0;
      break;
    }
    case 'attack': hostAttack(p, msg.ry); break;
    case 'throw': {
      if (!p || p.isMonster || p.s !== 'alive' || hs.phase !== 'playing' || !(p.stones > 0)) return;
      if (Math.hypot(msg.x - p.x, msg.z - p.z) > 20) return;
      p.stones--; hs.pending.push({ t: time + 0.9, x: +msg.x, z: +msg.z });
      break;
    }
    case 'repair': hostRepair(p, msg.gen, msg.dt); break;
    case 'solve': hostSolve(p, msg.gen | 0); break;
    case 'sonar': if (p?.isMonster && p.s === 'alive' && time - (p.lastShriek ?? -99) > CFG.SONAR_CD * 0.9) hostShriek(p); break;
    case 'escape': {
      if (!p || p.isMonster || p.s !== 'alive' || !hs.gateOpen) return;
      if (!inExit(p.x, p.z)) return;
      p.s = 'escaped';
      broadcast({ t: 'event', k: 'escaped', id: from, name: p.name });
      break;
    }
  }
}
// The sonar shriek: every survivor in range who isn't hidden is located and lit up.
function hostShriek(p) {
  p.lastShriek = time;
  hs.shriek = { x: p.x, z: p.z, t: time };
  const seen = Object.values(hs.players).filter((s) => !s.isMonster && s.s === 'alive' && !s.h && Math.hypot(s.x - p.x, s.z - p.z) < CFG.SONAR_RANGE).map((s) => [r2(s.x), r2(s.z), s.id]);
  broadcast({ t: 'event', k: 'sonar', by: p.id, x: p.x, z: p.z, seen });
  return seen;
}
function hostRemovePlayer(id) {
  net.conns.delete(id);
  const p = hs.players[id];
  if (!p) return;
  delete hs.players[id];
  if (hs.phase === 'lobby') broadcastLobby();
  else broadcast({ t: 'event', k: 'left', id, name: p.name });
}
function hostAttack(m, ry) {
  if (!m || !m.isMonster || hs.phase !== 'playing') return;
  if (time - m.lastAttack < CFG.ATTACK_CD * 0.9) return;
  m.lastAttack = time;
  broadcast({ t: 'event', k: 'swing', by: m.id });
  const fx = -Math.sin(ry), fz = -Math.cos(ry);
  let best = null, bestD = Infinity;
  for (const s of Object.values(hs.players)) {
    if (s.isMonster || s.s !== 'alive') continue;
    const dx = s.x - m.x, dz = s.z - m.z, d = Math.hypot(dx, dz);
    if (d > CFG.ATTACK_RANGE) continue;
    if (s.h && d > 1.9) continue;                              // hidden: it has to strike the locker itself
    if (d > 0.9 && (dx * fx + dz * fz) / d < 0.35) continue; // must be roughly in front
    if (d < bestD) { best = s; bestD = d; }
  }
  if (best) { hostHit(m, best); return; }
  // Nobody in reach: tear the wiring out of a generator someone has started on.
  OBJ.forEach((o, i) => {
    const g = hs.gens[i];
    if (o.kind !== 'gen' || !g || g.done || !(g.fixes > 0) || time < (g.sabT || 0)) return;
    const dx = o.x - m.x, dz = o.z - m.z, d = Math.hypot(dx, dz);
    if (d > 2.7 || (d > 1.0 && (dx * fx + dz * fz) / d < 0.2)) return;
    g.fixes--; g.progress = g.fixes / g.need; g.sabT = time + 18;
    broadcast({ t: 'event', k: 'sabotage', i, x: o.x, z: o.z, n: g.fixes, need: g.need });
  });
}
function hostHit(m, best) {
  if (time - best.lastHit < CFG.HIT_INVULN) return;
  best.lastHit = time; best.hp -= 1; best.h = 0;
  if (best.hp <= 0) { best.s = 'caught'; hs.lastKill = time; }
  broadcast({ t: 'event', k: 'hit', id: best.id, by: m.id, name: best.name, hp: best.hp, x: best.x, z: best.z });
}
// Relics and the altar are held (E); generators are wired one circuit at a time (hostSolve).
function hostRepair(p, gi, dt) {
  if (!p || p.isMonster || p.s !== 'alive' || hs.phase !== 'playing') return;
  const g = hs.gens[gi];
  if (!g || g.done || objLocked(gi, hs.gens) || OBJ[gi].kind === 'gen') return;
  const gp = genPos(gi), kind = OBJ[gi].kind;
  if (Math.hypot(p.x - gp.x, p.z - gp.z) > 3.2) return;
  // The altar takes longer with more survivors, so team size stays fair.
  const dur = kind === 'relic' ? 4 : 18 * hs.mult;
  g.progress = Math.min(1, g.progress + clamp(+dt || 0, 0, 0.5) / dur);
  if (g.progress >= 1 && !g.done) completeObjective(gi);
}
// A survivor finished one circuit puzzle at a generator.
function hostSolve(p, gi) {
  if (!p || p.isMonster || p.s !== 'alive' || hs.phase !== 'playing' || hs.gateOpen) return;
  const g = hs.gens[gi], o = OBJ[gi];
  if (!g || g.done || !o || o.kind !== 'gen') return;
  if (Math.hypot(p.x - o.x, p.z - o.z) > 3.4) return;
  if (time - (p.lastSolve ?? -99) < 2.4) return; // nobody wires a panel faster than this
  p.lastSolve = time;
  g.fixes++; g.progress = Math.min(1, g.fixes / g.need);
  if (g.fixes >= g.need) completeObjective(gi);
  else broadcast({ t: 'event', k: 'fix', i: gi, x: o.x, z: o.z, n: g.fixes, need: g.need, by: p.id });
  // The clang carries: a bot monster in earshot comes to look.
  for (const m of Object.values(hs.players)) {
    if (m.isMonster && m.bot && Math.hypot(m.x - o.x, m.z - o.z) < 0.9 * CFG.BOT_HEARING && Math.random() < 0.7) {
      m.bot.lead = { x: o.x, z: o.z, t: time }; if (m.bot.mode !== 'stalk') { m.bot.mode = 'stalk'; m.bot.goalKey = ''; } m.bot.listenT = 0;
    }
  }
}
function completeObjective(gi) {
  const g = hs.gens[gi], kind = OBJ[gi].kind, gp = genPos(gi);
  g.done = true; g.progress = 1;
  const left = kind === 'gen'
    ? Math.max(0, ESCAPE_NEED - hs.gens.filter((x, k) => x.done && OBJ[k].kind === 'gen').length)
    : hs.gens.filter((x, k) => !x.done && OBJ[k].kind === kind).length;
  broadcast({ t: 'event', k: 'gen', i: gi, kind, x: gp.x, z: gp.z, left });
  if (kind === 'gen' && left === 0 && !hs.gateOpen) {
    hs.gateOpen = true;
    broadcast({ t: 'event', k: 'gate', x: GATE.x, z: GATE.z });
  }
  if (kind === 'altar') hs.banished = true;
}
function hostStart() {
  const list = Object.values(hs.players);
  if (!list.some((p) => p.isMonster)) addFeed('Starting without a monster (testing mode).', 'warn');
  let si = 0;
  list.forEach((p, idx) => {
    p.hp = CFG.MAX_HP; p.s = 'alive'; p.n = 0; p.c = 0; p.r = 0; p.h = 0; p.stones = 3; p.lastHit = -99; p.lastAttack = -99; p.colorIdx = idx;
    if (p.isMonster) { p.x = SPAWN_MON.x; p.z = SPAWN_MON.z; p.ry = Math.random() * Math.PI * 2; }
    else {
      const [sx, sz] = SPAWN_SURV[si % SPAWN_SURV.length]; si++;
      p.x = sx; p.z = sz; p.ry = Math.atan2(-(CAMPFIRE.x - sx), -(CAMPFIRE.z - sz)) + Math.PI; // back to the fire
    }
    p.bot = p.isBot ? newBrain(p) : null;
  });
  hs.mode = MODES[$('#mode-select').value] ? $('#mode-select').value : 'escape';
  OBJ = makeObjectives(hs.mode);
  const nSurv = list.filter((p) => !p.isMonster).length;
  hs.mult = [0.75, 0.75, 1, 1.2, 1.4][Math.min(nSurv, 4)];
  hs.phase = 'playing'; hs.timeLeft = MODES[hs.mode].duration; hs.gateOpen = false; hs.lastKill = undefined;
  hs.ambT = 3; hs.gustT = 25; hs.gust = 0; hs.gustDur = 0;
  hs.banished = false; hs.pending = []; hs.nextPulse = 40; hs.omen = false; hs.shriek = null;
  const fixNeed = nSurv >= 3 ? 3 : 2; // circuits per generator
  hs.gens = OBJ.map((o) => ({ progress: 0, done: false, fixes: 0, need: o.kind === 'gen' ? fixNeed : 0, sabT: 0 }));
  broadcast({ t: 'start', mode: hs.mode, objs: OBJ, need: fixNeed, duration: hs.timeLeft, players: list.map((p) => ({ id: p.id, name: p.name, isMonster: p.isMonster, isBot: p.isBot, x: p.x, z: p.z, ry: p.ry, colorIdx: p.colorIdx })) });
}
function hostUpdate(dt) {
  if (hs.phase !== 'playing') return;
  hs.timeLeft -= dt;
  for (const p of Object.values(hs.players)) {
    const v = Math.hypot(p.x - (p.lx ?? p.x), p.z - (p.lz ?? p.z)) / Math.max(dt, 1e-4);
    p.spd = damp(p.spd || 0, v, 4, dt); p.lx = p.x; p.lz = p.z;
  }
  for (const p of Object.values(hs.players)) {
    if (!p.isBot || p.s !== 'alive') continue;
    updateBot(p, dt);
    if (!p.isMonster && p.n > 0 && p.spd > 0.3 && onBridge(p.x, p.z)) p.n = Math.min(1, p.n * 1.3);
  }

  hs.snapAcc += dt;
  if (hs.snapAcc >= 1 / CFG.NET_HZ) {
    hs.snapAcc = 0;
    broadcast({
      t: 'snap', tl: r2(hs.timeLeft), go: hs.gateOpen, wg: r2(hs.gust),
      g: hs.gens.map((g) => r2(g.progress)),
      p: Object.values(hs.players).map((p) => ({ id: p.id, x: r2(p.x), z: r2(p.z), ry: r2(p.ry), n: r2(p.n), c: p.c, r: p.r, h: p.h ? 1 : 0, hp: p.hp, s: p.s })),
    });
  }

  // The forest's own noises: random sounds that reach the monster just like a survivor's.
  hs.ambT -= dt;
  if (hs.ambT <= 0) {
    hs.ambT = 2.5 + Math.random() * 5;
    const k = AMBIENT_KINDS[weightedPick(AMBIENT_KINDS.map((a) => a.w))];
    let x = FENCE + 4 + Math.random() * (AREA - FENCE * 2 - 8), z = FENCE + 4 + Math.random() * (AREA - FENCE * 2 - 8);
    if (k.at) [x, z] = k.at();
    broadcast({ t: 'event', k: 'amb', a: k.id, x: r2(x), z: r2(z) });
    for (const m of Object.values(hs.players)) {
      // the bot monster is fooled by loud ones close enough to hear, now and then
      if (m.isMonster && m.bot && k.loud > 0.5 && Math.hypot(m.x - x, m.z - z) < k.loud * CFG.BOT_HEARING && Math.random() < 0.45) {
        m.bot.lead = { x, z, t: time }; if (m.bot.mode !== 'stalk') { m.bot.mode = 'stalk'; m.bot.goalKey = ''; } m.bot.listenT = 0;
      }
    }
  }
  // Wind gusts: every so often the wind rises for several seconds and hides quiet movement.
  hs.gustT -= dt;
  if (hs.gustT <= 0 && hs.gustDur <= 0) { hs.gustDur = 5 + Math.random() * 5; hs.gustT = 20 + Math.random() * 25; }
  if (hs.gustDur > 0) { hs.gustDur -= dt; hs.gust = Math.min(1, hs.gust + dt / 1.5); } else hs.gust = Math.max(0, hs.gust - dt / 2);
  ENV.gust = hs.gust;
  // Thrown stones land (a decoy noise the monster can hear)
  for (const q of hs.pending.filter((q) => time >= q.t)) {
    broadcast({ t: 'event', k: 'clack', x: q.x, z: q.z });
    for (const m of Object.values(hs.players)) {
      if (m.isMonster && m.bot && Math.hypot(m.x - q.x, m.z - q.z) < 0.8 * CFG.BOT_HEARING && Math.random() < 0.8) { m.bot.lead = { x: q.x, z: q.z, t: time }; if (m.bot.mode !== 'stalk') { m.bot.mode = 'stalk'; m.bot.goalKey = ''; } m.bot.listenT = 0; }
    }
  }
  hs.pending = hs.pending.filter((q) => time < q.t);
  // Last Light: every 40 s the moon exposes every survivor who isn't hidden.
  if (hs.mode === 'survive') {
    hs.nextPulse -= dt;
    if (hs.nextPulse < 6 && !hs.omen) { hs.omen = true; broadcast({ t: 'event', k: 'omen' }); }
    if (hs.nextPulse <= 0) {
      hs.nextPulse = 40; hs.omen = false;
      const seen = Object.values(hs.players).filter((p) => !p.isMonster && p.s === 'alive' && !p.h).map((p) => [r2(p.x), r2(p.z)]);
      broadcast({ t: 'event', k: 'pulse', seen });
      for (const m of Object.values(hs.players)) {
        if (!m.isMonster || !m.bot || !seen.length) continue;
        const near = seen.slice().sort((a, b) => Math.hypot(a[0] - m.x, a[1] - m.z) - Math.hypot(b[0] - m.x, b[1] - m.z))[0];
        m.bot.lead = { x: near[0], z: near[1], t: time - 1.5 }; m.bot.mode = 'stalk'; m.bot.goalKey = ''; m.bot.listenT = 0;
      }
    }
  }

  // Win conditions
  const surv = Object.values(hs.players).filter((p) => !p.isMonster);
  const alive = surv.filter((p) => p.s === 'alive').length;
  const escaped = surv.filter((p) => p.s === 'escaped').length;
  const caught = surv.filter((p) => p.s === 'caught').length;
  let end = null;
  if (surv.length > 0 && alive === 0) end = escaped > 0 ? { w: 'survivors', reason: `${escaped} escaped, ${caught} taken.` } : { w: 'monster', reason: 'Every survivor was taken.' };
  else if (hs.banished) end = { w: 'survivors', reason: `The ritual is complete. It is gone. ${caught} taken.` };
  else if (hs.timeLeft <= 0) {
    if (hs.mode === 'ritual') end = { w: 'monster', reason: 'Dawn came and the ritual was never finished.' };
    else end = alive + escaped > 0 ? { w: 'survivors', reason: `Dawn broke. ${alive + escaped} survived, ${caught} taken.` } : { w: 'monster', reason: 'Nobody made it.' };
  }
  // Let a final kill animation and kill cam play out before showing the result.
  if (end && hs.lastKill !== undefined && time - hs.lastKill < KILL.end + 0.8) end = null;
  if (end) {
    hs.phase = 'ended';
    broadcast({ t: 'end', winner: end.w, reason: end.reason, stats: surv.map((p) => ({ name: p.name, s: p.s })) });
  }
}
const AMBIENT_KINDS = [
  { id: 'branch', w: 3, loud: 0.8 },   // a branch snaps somewhere
  { id: 'creak', w: 4, loud: 0.45 },   // a trunk groans in the wind
  { id: 'owl', w: 3, loud: 0.6 },
  { id: 'crow', w: 1.5, loud: 0.7 },
  { id: 'rustle', w: 4, loud: 0.35 },  // something small in the brush
  { id: 'splash', w: 2, loud: 0.5, at: () => { const k = Math.floor(Math.random() * (CREEK.length - 1)), t = Math.random(); return [clamp(lerp(CREEK[k][0], CREEK[k + 1][0], t), 6, AREA - 6), clamp(lerp(CREEK[k][1], CREEK[k + 1][1], t), 6, AREA - 6)]; } },
  { id: 'bell', w: 0.5, loud: 1.0, at: () => [84, 32] },  // the chapel bell, moved by the wind
];
function weightedPick(ws) { let r = Math.random() * ws.reduce((a, b) => a + b, 0); for (let i = 0; i < ws.length; i++) { r -= ws[i]; if (r <= 0) return i; } return ws.length - 1; }
function hostBackToLobby() { hs.phase = 'lobby'; broadcastLobby(); }

// ---------------- BOTS (simulated on the host) ----------------
// Both bots play by the same rules as people. Survivor bots only know what they've
// seen or heard of the monster, and they survive by staying silent: freezing, creeping
// away crouched, and sprinting only when it is on top of them. The monster bot is blind
// and hunts by sound: it stalks slowly, stops to listen, charges only at fresh, close
// sounds, and shrieks when it loses the trail.
function newBrain(p) {
  return p.isMonster
    ? { path: [], goalKey: '', repathT: 0, mode: 'patrol', lead: null, hearT: 0, sonarCD: 12, attackCD: 0, wait: 1, listenT: 0, nextListen: 4, sweep: 0, stuckT: 0, lx: p.x, lz: p.z }
    : { path: [], goalKey: '', repathT: 0, state: 'work', t: 0, mem: null, lastScare: -99, wait: Math.random() * 1.5, lookT: 6 + Math.random() * 6, stamina: 1, stuckT: 0, lx: p.x, lz: p.z };
}
function botPathTo(p, b, tile, allowExit = false) {
  const key = tile.x + ',' + tile.z;
  if (key === b.goalKey && b.path.length && b.repathT > 0) return;
  b.goalKey = key; b.repathT = 0.6;
  b.path = bfsPath(tileOf(p.x, p.z), tile, allowExit).slice(1);
}
// Steps along the current path (or straight at `direct`). Returns true when it has arrived.
function botStep(p, b, speed, r, dt, direct = null) {
  b.repathT -= dt;
  let tx, tz;
  if (direct) { tx = direct.x; tz = direct.z; }
  else {
    if (!b.path.length) return true;
    const c = tileCenter(b.path[0].x, b.path[0].z); tx = c.x; tz = c.z;
  }
  const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
  if (d < 0.35) { if (!direct) b.path.shift(); return direct ? true : !b.path.length; }
  const step = Math.min(d, speed * dt);
  const v = { x: p.x, z: p.z };
  moveWithCollision(v, (dx / d) * step, (dz / d) * step, r);
  p.x = v.x; p.z = v.z;
  p.ry = angleDamp(p.ry, Math.atan2(-dx, -dz), 10, dt);
  // Unstick: if barely moving for a second, drop the path so it gets recomputed.
  b.stuckT = Math.hypot(p.x - b.lx, p.z - b.lz) < speed * dt * 0.2 ? b.stuckT + dt : 0;
  b.lx = p.x; b.lz = p.z;
  if (b.stuckT > 1) { b.path = []; b.goalKey = ''; b.stuckT = 0; }
  return false;
}
function updateBot(p, dt) { if (p.isMonster) updateMonsterBot(p, dt); else updateSurvivorBot(p, dt); }

// A reachable spot away from a threat: far from it, not a long detour, and preferably
// sideways rather than straight back (so a charging monster overshoots).
function botPathAway(p, b, from, minDist = 14) {
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < 24; i++) {
    const t = randomFloorTile(), c = tileCenter(t.x, t.z);
    const dFrom = Math.hypot(c.x - from.x, c.z - from.z), dMe = Math.hypot(c.x - p.x, c.z - p.z);
    if (dMe > 30) continue;
    const ax = p.x - from.x, az = p.z - from.z, al = Math.hypot(ax, az) || 1;
    const side = Math.abs(((c.x - p.x) * az - (c.z - p.z) * ax) / al) / (dMe || 1); // 1 = perpendicular
    const score = Math.min(dFrom, minDist + 6) - dMe * 0.3 + side * 4;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  b.goalKey = ''; if (best) botPathTo(p, b, best);
}
function survivorEscapes(p) { p.s = 'escaped'; broadcast({ t: 'event', k: 'escaped', id: p.id, name: p.name }); }

function updateSurvivorBot(p, dt) {
  const b = p.bot;
  p.r = 0;
  const mon = Object.values(hs.players).find((q) => q.isMonster && q.s === 'alive');
  const dm = mon ? Math.hypot(mon.x - p.x, mon.z - p.z) : Infinity;
  // ---- Perception (no cheating: only what this survivor could see or hear)
  const sees = mon && (dm < 4 || (mon.spd > 0.6 && dm < 14));
  const hearsSteps = mon && mon.spd > 4.7 && dm < 22;                  // a charge is loud
  const hearsShriek = hs.shriek && time - hs.shriek.t < 0.3 && Math.hypot(hs.shriek.x - p.x, hs.shriek.z - p.z) < 60;
  if (sees || hearsSteps) {
    const prevD = b.mem ? Math.hypot(b.mem.x - p.x, b.mem.z - p.z) : dm;
    b.mem = { x: mon.x, z: mon.z, t: time, closing: dm < prevD - 0.02 && mon.spd > 0.6, d: dm };
  } else if (hearsShriek) b.mem = { x: hs.shriek.x, z: hs.shriek.z, t: time, closing: false, d: Math.hypot(hs.shriek.x - p.x, hs.shriek.z - p.z) };
  const fresh = b.mem && time - b.mem.t < 1.5;
  const recent = b.mem && time - b.mem.t < 12;
  const memD = b.mem ? Math.hypot(b.mem.x - p.x, b.mem.z - p.z) : Infinity;
  if (fresh && memD < 16) b.lastScare = time;
  const scared = time - b.lastScare < 15;              // move crouched for a while after a scare
  const face = (x, z) => { p.ry = angleDamp(p.ry, Math.atan2(-(x - p.x), -(z - p.z)), 6, dt); };

  // ---- Emergencies. It's blind, so a monster that is merely close usually doesn't know
  // we're here: creep away silently. Only sprint when it is charging right at us or has
  // just hit us, and only briefly (sprinting is what gives us away).
  const charging = sees && mon.spd > 4.9 && b.mem?.closing && dm < 4;
  const justHit = time - p.lastHit < 0.3;
  if (b.state !== 'evade' && mon && (justHit || (charging && time > (b.quietUntil || 0)))) {
    b.state = 'evade'; b.t = 1.1 + Math.random() * 0.6; botPathAway(p, b, mon, 10);
    b.quietUntil = time + b.t + 5; // after one burst, commit to silence: the sprint is what it's chasing
  } else if (b.state !== 'evade' && b.state !== 'sneak' && sees && dm < 3) {
    b.state = 'sneak'; botPathAway(p, b, mon, 12);
  }
  if (b.state === 'evade') {
    b.t -= dt;
    const sprint = b.stamina > 0.05;
    b.stamina = clamp(b.stamina - (sprint ? dt / 4 : -dt * 0.15), 0, 1);
    p.c = 0; p.n = sprint ? CFG.NOISE.sprint : CFG.NOISE.walk;
    // Then drop to a crouch and keep creeping away (the monster lost the trail when we went quiet).
    if (botStep(p, b, sprint ? CFG.SPEED.sprint : CFG.SPEED.walk, CFG.SURV_R, dt) || b.t <= 0) { b.state = 'sneak'; if (!b.path.length) botPathAway(p, b, mon || p, 12); }
    return;
  }
  b.stamina = clamp(b.stamina + dt * 0.12, 0, 1);

  // ---- Spotted or heard it nearby: freeze (silent), watch, then decide
  if ((b.state === 'work' || b.state === 'lurk') && fresh && memD < 18) { b.state = 'freeze'; b.t = 2 + Math.random() * 2; b.frozeAt = time; }
  if (b.state === 'freeze') {
    p.n = 0; p.c = 1; p.r = 0;
    if (b.mem) face(b.mem.x, b.mem.z);
    b.t -= dt;
    // It's coming straight for us and getting close: creep away sideways instead.
    if (fresh && b.mem.closing && memD < 7) { b.state = 'sneak'; botPathAway(p, b, b.mem, 16); return; }
    // Stay frozen while it's close and coming nearer; once it's gone quiet, moved off, or
    // simply isn't heading our way, slip away rather than waiting forever.
    const longFreeze = time - (b.frozeAt || time) > 6;
    if (b.t <= 0 && (!fresh || memD > 12 || !b.mem.closing || longFreeze)) { b.state = 'sneak'; botPathAway(p, b, b.mem || p, 16); }
    return;
  }
  if (b.state === 'sneak') {
    p.c = 1; p.n = CFG.NOISE.crouch; // inaudible beyond ~3.6 m
    if (fresh && b.mem.closing && memD < 5 && !b.path.length) botPathAway(p, b, b.mem, 16);
    if (botStep(p, b, CFG.SPEED.crouch, CFG.SURV_R, dt)) { b.state = 'work'; b.wait = 1 + Math.random() * 2; }
    return;
  }

  // ---- Normal play
  if (b.wait > 0) { b.wait -= dt; p.n = 0; p.c = scared ? 1 : 0; return; }
  // Every so often, stop and look around instead of plodding on.
  b.lookT -= dt;
  if (b.lookT <= 0) { b.lookT = 7 + Math.random() * 8; b.wait = 1 + Math.random() * 1.5; return; }
  const mode = scared ? 'crouch' : 'walk';
  p.c = mode === 'crouch' ? 1 : 0;

  if (hs.gateOpen) {
    // If it was recently near the gate, hang back silently out of earshot and let the
    // clock run (survivors win at dawn) instead of walking into it.
    const guarded = recent && Math.hypot(b.mem.x - GATE.x, b.mem.z - GATE.z) < 16 && time - b.mem.t < 8;
    if (guarded && Math.hypot(p.x - GATE.x, p.z - GATE.z) < 26) {
      p.n = 0; p.c = 1; face(b.mem.x, b.mem.z);
      if (memD < 8 && !b.path.length) { b.state = 'sneak'; botPathAway(p, b, b.mem, 16); }
      return;
    }
    botPathTo(p, b, tileOf(GATE.x, EXIT_ZONE.minZ + 4), true);
    // Only break into a run for the very last stretch, and only if it's right behind.
    const dash = fresh && memD < 6 && Math.hypot(p.x - GATE.x, p.z - GATE.z) < 15 && b.stamina > 0.1;
    p.n = dash ? CFG.NOISE.sprint : CFG.NOISE[mode];
    botStep(p, b, dash ? CFG.SPEED.sprint : CFG.SPEED[mode], CFG.SURV_R, dt);
    if (inExit(p.x, p.z)) survivorEscapes(p);
    return;
  }
  if (!OBJ.length) {
    // Last Light: nothing to fix. Keep low and keep moving between quiet corners.
    if (!b.path.length) {
      let t = randomFloorTile();
      for (let k = 0; k < 8; k++) { const c = tileCenter(t.x, t.z); if (Math.hypot(c.x - p.x, c.z - p.z) < 35) break; t = randomFloorTile(); }
      b.goalKey = ''; botPathTo(p, b, t);
    }
    p.c = 1; p.n = CFG.NOISE.crouch;
    if (botStep(p, b, CFG.SPEED.crouch, CFG.SURV_R, dt)) b.wait = 4 + Math.random() * 8;
    return;
  }
  // Pick an objective: nearest, avoiding ones other bots are on and where the monster was last seen.
  let gi = -1, gd = Infinity, best = Infinity;
  const taken = new Set(Object.values(hs.players).filter((q) => q !== p && q.bot && !q.isMonster && q.s === 'alive').map((q) => q.bot.gen));
  hs.gens.forEach((g, i) => {
    if (g.done || objLocked(i, hs.gens)) return;
    const c = genPos(i), d = Math.hypot(c.x - p.x, c.z - p.z);
    const danger = recent ? Math.max(0, 20 - Math.hypot(c.x - b.mem.x, c.z - b.mem.z)) * 2 : 0;
    const score = d + (taken.has(i) && OBJ[i].kind !== 'altar' ? 40 : 0) + danger;
    if (score < best) { best = score; gd = d; gi = i; }
  });
  b.gen = gi;
  if (gi < 0) { p.n = 0; return; }
  if (gd < 2.3) {
    // Repairing hums (heard ~13 m away): don't do it while the monster was recently close.
    if (recent && memD < 16) { b.state = 'lurk'; p.n = 0; p.c = 1; if (b.mem) face(b.mem.x, b.mem.z); return; }
    b.state = 'work';
    p.r = 1; p.c = 0; p.n = OBJ_NOISE[OBJ[gi].kind];
    const c = genPos(gi);
    p.ry = Math.atan2(-(c.x - p.x), -(c.z - p.z));
    if (OBJ[gi].kind === 'gen') {
      // One circuit puzzle at a time; walking away loses the one in progress.
      if (b.fixT === undefined || b.fixGen !== gi || time - (b.fixAt || 0) > 0.5) { b.fixT = 8 + Math.random() * 5; b.fixGen = gi; }
      b.fixAt = time; b.fixT -= dt;
      if (b.fixT <= 0) { b.fixT = undefined; hostSolve(p, gi); }
    } else hostRepair(p, gi, dt * 0.6);
    return;
  }
  botPathTo(p, b, genApproach(gi));
  if (!b.path.length && gd > 2.3) { b.wait = 1 + Math.random(); b.goalKey = ''; p.n = 0; return; }
  p.n = CFG.NOISE[mode];
  if (botStep(p, b, CFG.SPEED[mode], CFG.SURV_R, dt) && gd >= 2.3) botStep(p, b, CFG.SPEED[mode], CFG.SURV_R, dt, genPos(gi));
}

const MON_SPEED = { prowl: 2.6, stalk: 3.3, charge: 6.2 };
function updateMonsterBot(p, dt) {
  const b = p.bot;
  b.attackCD -= dt; b.sonarCD -= dt; b.hearT -= dt;
  p.n = 0; p.c = 0; p.r = 0;
  const prey = Object.values(hs.players).filter((q) => !q.isMonster && q.s === 'alive');

  // ---- Hearing: a survivor is audible within (noise x 24 m), plus touch range (1.6 m).
  if (b.hearT <= 0) {
    b.hearT = 0.2;
    let best = null, bestScore = -Infinity;
    for (const s of prey) {
      if (s.h) continue; // hidden survivors make no sound
      const d = Math.hypot(s.x - p.x, s.z - p.z), radius = Math.max(1.6, heardNoise(s.n, s.c && !s.r, s.x, s.z) * CFG.BOT_HEARING);
      if (d > radius) continue;
      if (radius - d > bestScore) { bestScore = radius - d; best = s; }
    }
    if (best) {
      const d = Math.hypot(best.x - p.x, best.z - p.z), jitter = d * 0.1; // far sounds are vaguer
      b.lead = { x: best.x + (Math.random() - 0.5) * jitter, z: best.z + (Math.random() - 0.5) * jitter, t: time };
      if (b.mode === 'patrol' || b.mode === 'search' || b.mode === 'listen') { b.mode = 'stalk'; b.goalKey = ''; }
      b.listenT = 0;
    }
  }

  // ---- Strike anything within reach
  for (const s of prey) {
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    if (s.h && b.mode !== 'locker') continue; // it has to decide to check a hiding place
    if (d < 1.9 && b.attackCD <= 0) {
      const ry = Math.atan2(-(s.x - p.x), -(s.z - p.z));
      p.ry = ry; b.attackCD = CFG.ATTACK_CD + 0.3;
      hostAttack(p, ry);
      if (s.s !== 'alive' || s.hp <= 0) { b.mode = 'patrol'; b.listenT = 2.5; b.lead = null; b.path = []; }
      break;
    }
  }

  // ---- Listening pause: stand still (it fades from sight) and wait for a sound
  if (b.listenT > 0) {
    b.listenT -= dt;
    if (b.listenT <= 0 && b.mode === 'search') shriekOrSweep(p, b, prey);
    return;
  }

  if (b.mode === 'stalk' && b.lead) {
    const age = time - b.lead.t, d = Math.hypot(b.lead.x - p.x, b.lead.z - p.z);
    // Charge only at a fresh sound that's close; otherwise creep in.
    const charge = age < 1.2 && d < 9;
    const speed = charge ? MON_SPEED.charge : MON_SPEED.stalk;
    if (!charge) {
      b.nextListen -= dt;
      if (b.nextListen <= 0) { b.nextListen = 3 + Math.random() * 3; b.listenT = 1 + Math.random() * 0.8; return; }
    }
    if (d < 4.5) { if (botStep(p, b, speed, CFG.MON_R, dt, b.lead)) arriveAtLead(b); return; }
    botPathTo(p, b, tileOf(b.lead.x, b.lead.z));
    if (botStep(p, b, speed, CFG.MON_R, dt)) arriveAtLead(b);
    return;
  }
  if (b.mode === 'locker') {
    // Walk up to the hiding place and tear it open.
    const L = LOCKERS[b.locker], f = lockerFront(L, 1.1);
    botPathTo(p, b, tileOf(f.x, f.z));
    const arrived = botStep(p, b, MON_SPEED.stalk, CFG.MON_R, dt) || Math.hypot(p.x - f.x, p.z - f.z) < 0.9;
    if (arrived || !b.path.length) {
      p.ry = Math.atan2(-(L.x - p.x), -(L.z - p.z));
      if (b.attackCD <= 0) {
        b.attackCD = CFG.ATTACK_CD + 0.3; hostAttack(p, p.ry);
        b.mode = 'sweep'; b.sweep = 1; b.path = []; b.lead = b.lead || { x: p.x, z: p.z, t: time };
      }
    }
    return;
  }
  if (b.mode === 'sweep' && b.lead) {
    // Check a few spots around where it last heard something.
    if (!b.path.length) {
      if (b.sweep-- <= 0) { b.mode = 'patrol'; b.lead = null; return; }
      const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 6;
      b.goalKey = ''; botPathTo(p, b, tileOf(b.lead.x + Math.cos(a) * r, b.lead.z + Math.sin(a) * r));
      if (!b.path.length) return;
    }
    if (botStep(p, b, MON_SPEED.prowl, CFG.MON_R, dt)) { b.listenT = 1.5 + Math.random(); b.path = []; }
    return;
  }

  // ---- Patrol: prowl between generators (prioritising ones mid-repair) or guard the gate
  if (b.wait > 0) { b.wait -= dt; return; }
  b.nextListen -= dt;
  if (b.nextListen <= 0) { b.nextListen = 6 + Math.random() * 6; b.listenT = 2 + Math.random() * 2; return; }
  if (!b.path.length) {
    let t;
    b.kick = undefined;
    if (hs.gateOpen && Math.random() < 0.7) t = tileOf(GATE.x + (Math.random() - 0.5) * 16, AREA - FENCE - 4 - Math.random() * 14);
    else {
      const active = hs.gens.map((g, i) => [g, i]).filter(([g]) => !g.done && g.progress > 0.05);
      const ready = OBJ.findIndex((o, i) => o.kind === 'altar' && !objLocked(i, hs.gens));
      if (ready >= 0 && Math.random() < 0.7) t = genApproach(ready);       // the ritual is ready: guard the circle
      else if (active.length && Math.random() < 0.65) { const gi = active[Math.floor(Math.random() * active.length)][1]; t = genApproach(gi); b.kick = gi; }
      else t = OBJ.length && Math.random() < 0.5 ? genApproach(Math.floor(Math.random() * OBJ.length)) : randomFloorTile();
    }
    b.goalKey = ''; botPathTo(p, b, t);
    if (!b.path.length) { b.wait = 0.5; return; }
  }
  if (botStep(p, b, MON_SPEED.prowl, CFG.MON_R, dt)) {
    b.wait = 0.5 + Math.random() * 1.5;
    // Arrived at a half-wired generator: tear into it.
    const o = OBJ[b.kick], g = hs.gens[b.kick];
    if (o && g && o.kind === 'gen' && !g.done && g.fixes > 0 && b.attackCD <= 0 && Math.hypot(o.x - p.x, o.z - p.z) < 2.8) {
      p.ry = Math.atan2(-(o.x - p.x), -(o.z - p.z)); b.attackCD = CFG.ATTACK_CD + 0.3; hostAttack(p, p.ry);
    }
    b.kick = undefined;
  }
}
function arriveAtLead(b) {
  b.mode = 'search'; b.listenT = 2 + Math.random(); b.path = [];
  if (b.lead && Math.random() < 0.4) {
    const li = LOCKERS.findIndex((L) => Math.hypot(L.x - b.lead.x, L.z - b.lead.z) < 7);
    if (li >= 0) { b.mode = 'locker'; b.locker = li; b.listenT = 0.8; b.goalKey = ''; }
  }
}
const lockerFront = (L, d = 1.0) => ({ x: L.x - Math.sin(L.ry) * d, z: L.z - Math.cos(L.ry) * d });
// Lost the trail: shriek if it can (every survivor within 26 m answers by being located),
// otherwise sweep the area around the last sound.
function shriekOrSweep(p, b, prey) {
  if (b.sonarCD <= 0) {
    b.sonarCD = 14;
    hostShriek(p);
    let near = null, nd = CFG.SONAR_RANGE;
    for (const s of prey) { const d = Math.hypot(s.x - p.x, s.z - p.z); if (d < nd) { nd = d; near = s; } }
    if (near) { b.lead = { x: near.x, z: near.z, t: time - 1.5 }; b.mode = 'stalk'; b.goalKey = ''; return; } // stalk, don't charge
  }
  b.mode = 'sweep'; b.sweep = 2 + Math.floor(Math.random() * 2); b.path = [];
}

// ---------------- CLIENT HANDLING ----------------
function clientHandle(msg) {
  switch (msg.t) {
    case 'welcome': me.id = msg.id; break;
    case 'reject': fatal(msg.reason); break;
    case 'lobby': onLobby(msg); break;
    case 'start': onStart(msg); break;
    case 'snap': onSnap(msg); break;
    case 'event': onEvent(msg); break;
    case 'end': onEnd(msg); break;
  }
}
function onLobby(msg) {
  lobbyPlayers = msg.players;
  if (!net.isHost && msg.mode) { $('#mode-select').value = msg.mode; $('#mode-select').disabled = true; showModeDesc(); }
  if (game.phase === 'playing' || game.phase === 'ended') leaveMatch();
  game.phase = 'lobby';
  showScreen('menu');
  $('#menu-main').classList.add('hidden');
  $('#menu-lobby').classList.remove('hidden');
  $('#room-code').textContent = msg.code;
  $('#invite-row').classList.toggle('hidden', !net.isHost || net.offline);
  if (net.isHost && !net.offline) $('#invite-link').textContent = inviteLink();
  $('#host-controls').classList.toggle('hidden', !net.isHost);
  $('#btn-lobby-menu').classList.toggle('hidden', !net.offline);
  $('#lobby-status').textContent = net.isHost ? (net.offline ? 'Offline practice: add bots, pick a role, start.' : 'Share the Room ID. Click a player to make them the monster.') : 'Waiting for host to start…';
  const ul = $('#player-list'); ul.innerHTML = '';
  for (const p of msg.players) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = p.name + (p.id === me.id ? ' (you)' : '');
    const right = document.createElement('span');
    right.innerHTML = `<span class="badge ${p.isMonster ? 'monster' : 'survivor'}">${p.isMonster ? 'MONSTER' : 'SURVIVOR'}</span>${p.isBot ? ' <span class="badge bot">BOT</span>' : ''}`;
    if (net.isHost && !p.isBot) {
      const b = document.createElement('button'); b.className = 'small'; b.textContent = p.isMonster ? 'Make survivor' : 'Make monster';
      b.style.marginLeft = '8px';
      b.onclick = () => setMonster(p.isMonster ? null : p.id);
      right.appendChild(b);
    }
    li.append(name, right); ul.appendChild(li);
  }
}
function setMonster(id) {
  for (const p of Object.values(hs.players)) p.isMonster = p.id === id;
  broadcastLobby();
}

function onStart(msg) {
  leaveMatch();
  game.phase = 'playing'; game.timeLeft = msg.duration; game.gateOpen = false;
  game.mode = msg.mode || 'escape'; OBJ = msg.objs || OBJ; game.fixNeed = msg.need || 2;
  game.gens = OBJ.map(() => ({ progress: 0, done: false }));
  closePipe();
  buildRelics();
  me.hidden = -1; me.hideT = 0; me.hideCD = 0; me.stones = 3; me.throwCD = 0;
  setHideView(-1);
  for (const p of msg.players) {
    if (p.id === me.id) {
      me.isMonster = p.isMonster; me.pos.set(p.x, 0, p.z); me.yaw = p.ry; me.pitch = 0;
      me.hp = CFG.MAX_HP; me.status = 'alive'; me.stamina = 1; me.exhausted = false; me.attackCD = 0; me.sonarCD = 2;
      me.escapeSent = false; me.boost = 0; me.damage = 0; me.repairGen = -1; me.colorIdx = p.colorIdx;
      me.killCam = null; me.roll = 0; me.flinch = 0; me.camo = 0; me.stillT = 0; me.gy = undefined; me.gal = 0; me.galPh = 0; me.thump = 0;
      me.eye = me.isMonster ? MONSTER_EYE : 1.6;
    } else addRemote(p);
  }
  setViewMode(me.isMonster ? 'monster' : 'survivor');
  clearRipples();
  showScreen('hud');
  $('#hud-role').textContent = me.isMonster ? 'THE MONSTER' : 'SURVIVOR';
  $('#hud-role').className = me.isMonster ? 'monster' : 'survivor';
  $('#hud-survivor').classList.toggle('hidden', me.isMonster);
  $('#hud-monster').classList.toggle('hidden', !me.isMonster);
  initAudio(); startDrone(me.isMonster ? 'monster' : 'survivor');
  const brief = {
    escape: ['Repair the generators. Stay quiet. Escape.', 'They are fixing the generators. Stop them.'],
    ritual: ['Find the five relics, then banish it at the stone circle.', 'They are gathering relics. Do not let them reach the stones.'],
    survive: ['There is no way out. Hide, keep moving, and live until dawn.', 'None of them leave this forest. Dawn is coming.'],
  }[game.mode];
  addFeed(brief[me.isMonster ? 1 : 0], me.isMonster ? 'good' : 'warn');
  if (!me.isMonster) addFeed(game.mode === 'escape' ? 'E at a generator opens its panel: connect the matching valves. E also hides you in lockers, tents and outhouses.' : 'E hides you in lockers, tents and outhouses. G throws a stone as a decoy.', '');
  updateResumeOverlay();
  lockPointer();
}
function addRemote(p) {
  const r = {
    id: p.id, name: p.name, isMonster: p.isMonster, isBot: p.isBot,
    pos: new THREE.Vector3(p.x, 0, p.z), target: new THREE.Vector3(p.x, 0, p.z), yaw: p.ry, targetYaw: p.ry,
    noise: 0, crouch: 0, repairing: 0, hp: CFG.MAX_HP, status: 'alive', stepT: Math.random(), speed: 0, walkT: 0,
    anim: { crouch: 0, repair: 0, lean: 0, flinch: 0, dead: -1, deadDelay: 0 },
    avatar: p.isMonster ? makeMonsterAvatar() : makeSurvivorAvatar(p.name, p.colorIdx || 0),
  };
  players.set(p.id, r);
  return r;
}
function removeRemote(id) {
  const r = players.get(id); if (!r) return;
  for (const e of r.avatar.userData.monster?.eyes || []) { scene.remove(e); const i = survivorOnly.indexOf(e); if (i >= 0) survivorOnly.splice(i, 1); }
  unreg(r.avatar); scene.remove(r.avatar);
  r.avatar.traverse((o) => { const i = survivorOnly.indexOf(o); if (i >= 0) survivorOnly.splice(i, 1); });
  players.delete(id);
}
function leaveMatch() {
  closePipe();
  if (camera.fov !== 75) { camera.fov = 75; camera.updateProjectionMatrix(); }
  for (const id of [...players.keys()]) removeRemote(id);
  clearRelics(); me.hidden = -1; setHideView(-1);
  game.gateOpen = false;
  if (world.gate) world.gate.mesh.position.x = world.gate.x0;
}
function onSnap(msg) {
  if (game.phase !== 'playing') return;
  game.timeLeft = msg.tl;
  if (!net.isHost) ENV.gust = msg.wg || 0;
  game.gateOpen = msg.go;
  msg.g.forEach((v, i) => { if (game.gens[i]) { game.gens[i].progress = v; game.gens[i].done = v >= 1; } });
  const seen = new Set();
  for (const s of msg.p) {
    seen.add(s.id);
    if (s.id === me.id) {
      me.hp = s.hp;
      if (s.s !== me.status) setMyStatus(s.s);
      continue;
    }
    const r = players.get(s.id); if (!r) continue;
    const dying = r.anim && (r.anim.dead >= 0 || r.anim.deadDelay > 0);
    const killing = r.avatar.userData.monster?.anim.shot === 'jumpscare';
    if (!dying && !killing) { r.target.set(s.x, 0, s.z); r.targetYaw = s.ry; } r.noise = s.n; r.crouch = s.c; r.repairing = s.r; r.hp = s.hp;
    if (r.hidden !== !!s.h) { r.hidden = !!s.h; if (r.status === 'alive' && !dying) r.avatar.visible = !r.hidden; }
    if (r.status !== s.s) {
      r.status = s.s;
      if (s.s === 'escaped') r.avatar.visible = false;
      if (s.s === 'caught' && r.anim.dead < 0 && r.anim.deadDelay <= 0) r.anim.dead = 0; // missed the kill event
    }
  }
  for (const id of [...players.keys()]) if (!seen.has(id)) removeRemote(id);
}
function setMyStatus(s) {
  const prev = me.status; me.status = s;
  if (s === prev || me.isMonster) return;
  if (s === 'caught' && !me.killCam) addFeed('You were taken. Spectating. Press V for monster vision.', 'bad');
  if (s === 'escaped') addFeed('You escaped! Spectating — press V for monster vision.', 'good');
}
// A sudden loud noise nearby makes the monster flinch (the first part of its Hit clip).
function startleMonsters(x, z, range) {
  for (const r of players.values()) {
    const M = r.isMonster && r.avatar.userData.monster;
    if (M && !M.anim.busy() && Math.hypot(r.pos.x - x, r.pos.z - z) < range) M.anim.play('hit', { len: 1.3, rate: 1.3 });
  }
}
function onEvent(e) {
  const pos = new THREE.Vector3(e.x || 0, 0.1, e.z || 0);
  switch (e.k) {
    case 'swing': {
      const m = players.get(e.by);
      const M = m?.avatar.userData.monster;
      if (M && M.anim.shot !== 'jumpscare') M.anim.play('attack');
      if (m && !me.isMonster) noise({ dur: 0.3, vol: 0.3 * distVol(m.pos, 25), pan: panOf(m.pos), freq: 1600, q: 0.8 });
      break;
    }
    case 'hit': {
      const lethal = e.hp <= 0;
      addRipple(pos, lethal ? 22 : 14, lethal ? 2.2 : 1.6, 12);
      const m = players.get(e.by), M = m?.avatar.userData.monster;
      // Choreography: monster and victim turn to face each other; the victim is drawn in
      // to claw's reach, so the slam lands on them and they fall away from the monster.
      const attacker = e.by === me.id ? me.pos : m?.pos;
      if (lethal && m) {
        if (M) M.anim.play('jumpscare');
        m.targetYaw = m.yaw = Math.atan2(-(e.x - m.pos.x), -(e.z - m.pos.z));
      }
      const victim = players.get(e.id);
      if (lethal && victim && attacker) {
        const dx = victim.pos.x - attacker.x, dz = victim.pos.z - attacker.z, d = Math.hypot(dx, dz) || 1;
        if (d > 1.3) { victim.pos.set(attacker.x + (dx / d) * 1.3, 0, attacker.z + (dz / d) * 1.3); victim.target.copy(victim.pos); }
        victim.targetYaw = victim.yaw = Math.atan2(dx, dz); // forward (-Z) points back at the attacker
      }
      if (e.id === me.id) {
        if (me.hidden >= 0) exitHide(true);
        closePipe();
        me.damage = 1; me.boost = 3; sfx.hit();
        if (lethal) startKillCam(e.by); else { me.flinch = 1; addFeed('You are wounded! RUN.', 'bad'); }
      } else {
        const r = players.get(e.id);
        if (r) { if (lethal) { r.status = 'caught'; r.anim.deadDelay = m ? KILL.raise + 0.05 : 0.01; } else r.anim.flinch = 1; }
        if (me.isMonster) {
          sfx.hit(); addFeed(lethal ? `You took ${e.name}.` : `You wounded ${e.name}.`, 'good');
          monsterPost.pass.uniforms.uGlitch.value = lethal ? 1.4 : 0.8;
          if (lethal) { me.lunge = 1.6; monsterPost.pass.uniforms.uPulse.value = 1.4; viewBody.anim?.play('jumpscare'); }
        } else { addFeed(lethal ? `${e.name} was taken.` : `${e.name} was wounded.`, 'bad'); noise({ dur: 0.4, vol: 0.25 * distVol(pos, 40), pan: panOf(pos), freq: 600 }); }
      }
      break;
    }
    case 'sonar': {
      const sm = players.get(e.by)?.avatar.userData.monster;
      if (sm && sm.anim.shot !== 'jumpscare') sm.anim.play('hit', { len: 2.4, rate: 1.15 }); // convulsing shriek
      if (e.by !== me.id) { addRipple(pos.setY(1.5), CFG.SONAR_RANGE, 2.2, 20); sfx.screech(distVol(pos, 70) + 0.25, panOf(pos)); if (viewMode === 'monster') monsterPost.pass.uniforms.uShock.value = 0.8; }
      // Everyone it found flares up when the wave reaches them, and stays lit for a few seconds.
      const found = e.seen || [];
      if (me.isMonster || viewMode === 'monster') {
        for (const [x, z] of found) {
          const delay = Math.hypot(x - e.x, z - e.z) / 20 * 1000;
          setTimeout(() => { for (let k = 0; k < 3; k++) setTimeout(() => { if (game.phase === 'playing') addRipple(_v.set(x, 1.0, z), 8, 2.0 - k * 0.5, 16); }, k * 900); }, delay);
        }
        if (e.by === me.id) addFeed(found.length ? `Your shriek found ${found.length === 1 ? 'one of them' : found.length + ' of them'}.` : 'Your shriek finds nothing.', found.length ? 'good' : 'warn');
      }
      if (!me.isMonster && me.status === 'alive') {
        if (found.some((f) => f[2] === me.id)) { me.damage = Math.max(me.damage, 0.5); addFeed('The shriek found you! It knows where you are. MOVE.', 'bad'); }
        else addFeed(me.hidden >= 0 ? 'The creature shrieks… your hiding place kept you hidden.' : 'The creature shrieks…', 'warn');
      }
      break;
    }
    case 'fix': {
      // One circuit restored: the generator coughs and clangs (loud: the monster hears it).
      if (game.gens[e.i]) game.gens[e.i].progress = e.n / e.need;
      addRipple(pos.setY(1), 16, 1.15, 12);
      if (world.gens[e.i]) { world.gens[e.i].shake = 0.6; world.gens[e.i].cough = 1; }
      sfx.clang(Math.max(0.15, distVol(pos, 45)), panOf(pos));
      if (e.by === me.id) addFeed(`Circuit restored (${e.n}/${e.need}).`, 'good');
      else if (me.isMonster) addFeed('Metal clangs somewhere: a generator is being worked on.', 'warn');
      break;
    }
    case 'sabotage': {
      if (game.gens[e.i]) game.gens[e.i].progress = e.n / e.need;
      addRipple(pos.setY(1), 18, 1.4, 12);
      if (world.gens[e.i]) { world.gens[e.i].shake = 1; world.gens[e.i].spark = 1.2; }
      sparkBurst(e.x, 1.1, e.z, 34);
      sfx.sabotage(Math.max(0.2, distVol(pos, 50)), panOf(pos));
      if (pipe.open && pipe.gen === e.i) { pipe.shake = 1; closePipe('Sparks! It tore the panel apart.'); }
      if (me.isMonster) { addFeed('You rip out its wiring. A circuit is lost.', 'good'); monsterPost.pass.uniforms.uGlitch.value = 0.7; }
      else addFeed('Something tore into a generator! A circuit was lost.', 'bad');
      break;
    }
    case 'gen': {
      if (game.gens[e.i]) { game.gens[e.i].done = true; game.gens[e.i].progress = 1; }
      if (pipe.open && pipe.gen === e.i) closePipe();
      if (e.kind === 'relic') {
        addRipple(pos.setY(1), 10, 0.9, 9); sfx.relic();
        addFeed(e.left > 0 ? `A relic was taken. ${e.left} remaining.` : 'All relics found. The stone circle is awake!', me.isMonster ? 'warn' : 'good');
      } else if (e.kind === 'altar') {
        addRipple(pos.setY(1), 60, 2, 16); sfx.gate();
      } else {
        addRipple(pos.setY(1), 26, 1.4, 11);
        if (world.gens[e.i]) world.gens[e.i].shake = 1;
        startleMonsters(e.x, e.z, 25);
        sfx.gen();
        addFeed(e.left > 0 ? `A generator roars to life. ${e.left} more needed.` : 'The gate has power!', me.isMonster ? 'warn' : 'good');
        sparkBurst(e.x, 1.4, e.z, 20);
      }
      break;
    }
    case 'amb': {
      const k = AMBIENT_KINDS.find((a) => a.id === e.a); if (!k) break;
      if (me.isMonster || viewMode === 'monster') addRipple(pos.setY(0.05), 2.5 + k.loud * 10, 0.3 + k.loud * 0.8);
      const v = distVol(pos, 70) * (0.4 + k.loud * 0.6), pan = panOf(pos);
      sfx[e.a]?.(v, pan);
      break;
    }
    case 'clack': {
      // A thrown stone lands: the monster hears it like any other noise in range.
      if (me.isMonster || viewMode === 'monster') addRipple(pos.setY(0.05), 12, 1.1);
      noise({ dur: 0.07, vol: 0.5 * distVol(pos, 30), pan: panOf(pos), freq: 2200, q: 3 }); noise({ dur: 0.05, vol: 0.3 * distVol(pos, 30), pan: panOf(pos), freq: 1300, q: 3, delay: 0.16 });
      break;
    }
    case 'omen': if (!me.isMonster) { addFeed('The moon is turning. In a few seconds it will expose everyone who is not hidden.', 'warn'); tone({ f: 220, f2: 440, dur: 2.5, type: 'sine', vol: 0.08 }); } break;
    case 'pulse': {
      fx.lightning = 1;
      if (me.isMonster || viewMode === 'monster') for (const [x, z] of e.seen) addRipple(_v.set(x, 0.05, z), 7, 1.5, 6);
      if (me.isMonster) addFeed(e.seen.length ? 'The moon shows them to you.' : 'The moon finds no one.', 'good');
      else if (me.status === 'alive') { if (me.hidden >= 0) addFeed('The moonlight passes over your hiding place.', 'good'); else { me.damage = 0.5; addFeed('It saw where you are. Move!', 'bad'); } }
      tone({ f: 90, f2: 45, dur: 1.2, type: 'sawtooth', vol: 0.12 });
      break;
    }
    case 'gate': {
      game.gateOpen = true;
      addRipple(pos.setY(1.5), 40, 1.5, 12);
      startleMonsters(e.x, e.z, 35);
      sfx.gate();
      addFeed(me.isMonster ? 'The exit gate is opening. Guard it.' : 'The EXIT GATE is open! Escape south!', me.isMonster ? 'bad' : 'good');
      break;
    }
    case 'escaped': if (e.id !== me.id) addFeed(`${e.name} escaped!`, me.isMonster ? 'bad' : 'good'); break;
    case 'left': addFeed(`${e.name} left the game.`, 'warn'); removeRemote(e.id); break;
  }
}
function distVol(pos, range) { return clamp(1 - me.pos.distanceTo(pos) / range, 0, 1); }
function onEnd(msg) {
  game.phase = 'ended';
  unlockPointer();
  const mine = (msg.winner === 'monster') === me.isMonster;
  $('#end-title').textContent = msg.winner === 'monster' ? 'THE HUNT ENDS' : 'SURVIVORS PREVAIL';
  $('#end-title').style.color = mine ? '' : '#ff3b3b';
  $('#end-reason').textContent = (mine ? 'Victory. ' : 'Defeat. ') + msg.reason;
  $('#end-stats').innerHTML = msg.stats.map((s) => `<li>${escapeHtml(s.name)} — ${s.s === 'escaped' ? 'escaped' : s.s === 'caught' ? 'taken' : 'survived'}</li>`).join('');
  $('#btn-lobby').classList.toggle('hidden', !net.isHost || quickRole !== null);
  $('#btn-rematch').classList.toggle('hidden', quickRole === null);
  $('#btn-menu').classList.toggle('hidden', !net.offline);
  $('#end-wait').classList.toggle('hidden', net.isHost);
  showScreen('end');
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Client → host state stream
let stateAcc = 0;
function sendState(dt) {
  stateAcc += dt;
  if (stateAcc < 1 / CFG.NET_HZ) return;
  stateAcc = 0;
  if (me.status !== 'alive') return;
  sendToHost({ t: 'state', x: r2(me.pos.x), z: r2(me.pos.z), ry: r2(me.yaw), n: r2(me.noise), c: me.crouch ? 1 : 0, r: me.repairing ? 1 : 0, h: me.hidden >= 0 ? 1 : 0 });
}

// ----------------------------------------------------------------------------
//  INPUT
// ----------------------------------------------------------------------------
const keys = {};
// Look controls: pointer lock (mouse) when the browser grants it; otherwise "drag to look",
// which is also what touch screens use. Movement and actions always come from the keyboard.
let pointerLocked = false;
let lookMode = 'lock'; // 'lock' | 'drag'
const controlsActive = () => game.phase === 'playing' && (pointerLocked || lookMode === 'drag');
function updateResumeOverlay() {
  $('#resume').classList.toggle('hidden', game.phase !== 'playing' || pointerLocked || lookMode === 'drag' || pipe.open);
}
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
// Take the cursor back after the generator panel closes. If the browser refuses, the
// "click to resume" overlay simply shows (it doesn't switch you over to drag-look).
let softLock = false;
function relockPointer() {
  if (game.phase !== 'playing' || lookMode !== 'lock' || !canvas.requestPointerLock) return;
  softLock = true;
  try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => { softLock = false; updateResumeOverlay(); }); } catch (e) { softLock = false; updateResumeOverlay(); }
}
function useDragLook() { lookMode = 'drag'; unlockPointer(); updateResumeOverlay(); }

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  keys[e.code] = true;
  if (game.phase !== 'playing') return;
  if (e.code === 'KeyF' && !me.isMonster) { flashlightOn = !flashlightOn; flashlight.visible = flashlightOn && viewMode === 'survivor' && !(me.hidden >= 0); tone({ f: 1800, dur: 0.03, vol: 0.05 }); }
  if (e.code === 'KeyQ') monsterSonar();
  if (pipe.open && !e.repeat && (e.code === 'KeyE' || e.code === 'Escape' || MOVE_KEYS.includes(e.code))) {
    closePipe(); if (e.code !== 'Escape') relockPointer();
  } else if (e.code === 'KeyE' && !e.repeat && !tryOpenPipe()) toggleHide();
  if (e.code === 'KeyG' && !e.repeat) throwStone();
  if (e.code === 'Space' && me.isMonster && !e.repeat) monsterAttack();
  if (e.code === 'KeyV' && !me.isMonster && me.status !== 'alive') setViewMode(viewMode === 'monster' ? 'survivor' : 'monster');
  if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
function lockPointer() {
  if (game.phase !== 'playing' || lookMode !== 'lock') return;
  if (!canvas.requestPointerLock) { useDragLook(); return; }
  try {
    const r = canvas.requestPointerLock();
    if (r && r.catch) r.catch(useDragLook);
  } catch (e) { useDragLook(); }
}
function unlockPointer() { if (document.pointerLockElement) document.exitPointerLock(); }
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas; softLock = false;
  updateResumeOverlay();
});
document.addEventListener('pointerlockerror', () => { if (softLock) { softLock = false; updateResumeOverlay(); } else useDragLook(); });
$('#resume').addEventListener('click', () => { initAudio(); lockPointer(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Locked mouse look
document.addEventListener('mousemove', (e) => {
  if (!pointerLocked || lookMode === 'drag' || game.phase !== 'playing') return;
  me.yaw -= e.movementX * 0.0022;
  me.pitch = clamp(me.pitch - e.movementY * 0.0022, -1.45, 1.45);
});
// Drag look (touch, or mouse when pointer lock is unavailable)
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  initAudio();
  if (e.pointerType === 'touch' || e.pointerType === 'pen') useDragLook();
  if (game.phase !== 'playing') return;
  if (pointerLocked && e.pointerType === 'mouse') { if (e.button === 0) monsterAttack(); if (e.button === 2) monsterSonar(); return; }
  if (lookMode === 'lock' && e.pointerType === 'mouse') { lockPointer(); return; }
  if (e.button === 2) { monsterSonar(); return; }
  if (drag) return; // ignore extra fingers
  drag = { id: e.pointerId, x: null, y: null, moved: 0, type: e.pointerType }; // origin set on first move
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (drag.x === null) { drag.x = e.clientX; drag.y = e.clientY; return; }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
  const sens = drag.type === 'touch' ? 0.006 : 0.004;
  me.yaw -= dx * sens;
  me.pitch = clamp(me.pitch - dy * sens, -1.45, 1.45);
});
function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  // A mouse click without dragging still strikes, so drag-look mice keep click-to-attack.
  if (drag.type === 'mouse' && drag.moved < 6 && e.button === 0) monsterAttack();
  drag = null;
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) drag = null; });
// ---- Survivor tools: hiding and decoy stones
function nearLocker() {
  let best = 1.9, li = -1;
  LOCKERS.forEach((L, i) => { const f = lockerFront(L, 0.8), d = Math.hypot(me.pos.x - f.x, me.pos.z - f.z); if (d < best) { best = d; li = i; } });
  return li;
}
function toggleHide() {
  if (me.isMonster || me.status !== 'alive' || me.killCam) return;
  if (me.hidden >= 0) { exitHide(false); return; }
  const li = nearLocker();
  if (li < 0 || me.repairGen >= 0 || me.hideCD > 0) return;
  if ([...players.values()].some((r) => r.hidden && Math.hypot(r.pos.x - LOCKERS[li].x, r.pos.z - LOCKERS[li].z) < 0.8)) { addFeed('Someone is already in there.', 'warn'); return; }
  const L = LOCKERS[li];
  me.hidden = li; me.pos.set(L.x, 0, L.z); me.yaw = L.ry; me.pitch = 0;
  setHideView(li);
  noise({ dur: 0.18, vol: 0.12, freq: 400, q: 1 });
}
function exitHide(forced) {
  if (me.hidden < 0) return;
  const f = lockerFront(LOCKERS[me.hidden], 0.95);
  me.pos.set(f.x, 0, f.z); me.hidden = -1; me.hideCD = HIDE_COOLDOWN;
  resolveCollision(me.pos, CFG.SURV_R);
  setHideView(-1);
  noise({ dur: 0.2, vol: forced ? 0.4 : 0.12, freq: 350, q: 1 });
}
function throwStone() {
  if (me.isMonster || me.status !== 'alive' || me.hidden >= 0 || !(me.stones > 0) || me.throwCD > 0) return;
  me.stones--; me.throwCD = 1.5;
  const d = 15, x = clamp(me.pos.x - Math.sin(me.yaw) * d, FENCE + 1, AREA - FENCE - 1), z = clamp(me.pos.z - Math.cos(me.yaw) * d, FENCE + 1, AREA - FENCE - 1);
  noise({ dur: 0.25, vol: 0.12, freq: 1500, q: 0.6 });
  sendToHost({ t: 'throw', x: r2(x), z: r2(z) });
}
function monsterAttack() {
  if (!me.isMonster || me.status !== 'alive' || me.attackCD > 0) return;
  me.attackCD = CFG.ATTACK_CD; me.lunge = 1;
  viewBody.anim?.play('attack');
  sfx.swipe();
  // a short forward lunge
  moveWithCollision(me.pos, -Math.sin(me.yaw) * 0.6, -Math.cos(me.yaw) * 0.6, CFG.MON_R);
  sendToHost({ t: 'attack', ry: me.yaw });
}
function monsterSonar() {
  if (!me.isMonster || me.status !== 'alive' || me.sonarCD > 0) return;
  me.sonarCD = CFG.SONAR_CD;
  addRipple(new THREE.Vector3(me.pos.x, 1.5, me.pos.z), CFG.SONAR_RANGE, 2.2, 20);
  viewBody.anim?.play('hit', { len: 2.4, rate: 1.15 });
  monsterPost.pass.uniforms.uPulse.value = 1; monsterPost.pass.uniforms.uShock.value = 1;
  sfx.ping();
  sendToHost({ t: 'sonar' });
}


// ---- Generator circuits: a pipe-connecting puzzle ------------------------------------
// E at a generator opens its panel: join every pair of matching valves with pipes that
// don't cross (drag from a valve; dragging over another pipe cuts it). Each solved panel
// restores one circuit; a generator runs once all its circuits are restored. You can't
// move or look around while you work, the generator hums the whole time, and every
// circuit that kicks in clangs loud enough for the monster to hear.
const PIPE_COLORS = ['#ff4b3a', '#33d0ff', '#ffd23a', '#6dff52', '#d45cff', '#ff9a2e'];
const pipe = { open: false, gen: -1, N: 5, K: 4, ends: [], paths: [], endAt: null, drawing: -1, solved: false, solvedT: 0, sendAt: 0, lastSent: -99, flash: 0, shake: 0, size: 0, cs: 0, pad: 0 };
const pipeCanvas = $('#pipe-canvas'), pipeCtx = pipeCanvas.getContext('2d');
// A random path through every cell (backbite moves on a serpentine), cut into K pipes of
// at least 3 cells whose two ends don't touch: always solvable, never trivial.
function makePipePuzzle(N, K) {
  let path = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) path.push(y * N + (y % 2 ? N - 1 - x : x));
  const adj = (a, b) => Math.abs((a % N) - (b % N)) + Math.abs(((a / N) | 0) - ((b / N) | 0)) === 1;
  for (let it = 0; it < N * N * 40; it++) {
    if (Math.random() < 0.5) path.reverse();
    const e = path[0], ex = e % N, ey = (e / N) | 0;
    const nbs = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [ex + dx, ey + dy]).filter(([x, y]) => x >= 0 && y >= 0 && x < N && y < N);
    const [nx, ny] = nbs[Math.floor(Math.random() * nbs.length)], j = path.indexOf(ny * N + nx);
    if (j > 1) path = path.slice(0, j).reverse().concat(path.slice(j));
  }
  let segs = null;
  for (let tries = 0; tries < 80; tries++) {
    const lens = Array(K).fill(3); let rest = N * N - 3 * K;
    while (rest-- > 0) lens[Math.floor(Math.random() * K)]++;
    segs = []; let k = 0;
    for (const L of lens) { segs.push(path.slice(k, k + L)); k += L; }
    if (segs.every((sg) => !adj(sg[0], sg[sg.length - 1]))) break;
  }
  return segs;
}
function newPipePuzzle() {
  const g = game.gens[pipe.gen], need = game.fixNeed || 2, done = Math.round((g?.progress || 0) * need);
  pipe.N = done === 0 ? 5 : 6; pipe.K = pipe.N === 5 ? 4 : 5;
  const segs = makePipePuzzle(pipe.N, pipe.K);
  pipe.sol = segs;
  pipe.ends = segs.map((sg) => [sg[0], sg[sg.length - 1]]);
  pipe.endAt = new Int8Array(pipe.N * pipe.N).fill(-1);
  pipe.ends.forEach(([a, b], c) => { pipe.endAt[a] = c; pipe.endAt[b] = c; });
  pipe.paths = pipe.ends.map(() => []);
  pipe.drawing = -1; pipe.solved = false; pipe.solvedT = 0; pipe.sendAt = 0;
  $('#pipe-status').textContent = 'Connect each pair of matching valves.';
  layoutPipe();
}
function layoutPipe() {
  const css = pipeCanvas.getBoundingClientRect().width || 380, dpr = Math.min(window.devicePixelRatio || 1, 2);
  pipe.size = Math.round(css * dpr); pipeCanvas.width = pipeCanvas.height = pipe.size;
  pipe.pad = pipe.size * 0.05; pipe.cs = (pipe.size - pipe.pad * 2) / pipe.N;
}
const pipeConnected = (c) => { const P = pipe.paths[c]; return P.length > 1 && P[0] !== P[P.length - 1] && pipe.endAt[P[0]] === c && pipe.endAt[P[P.length - 1]] === c; };
function tryOpenPipe() {
  if (me.isMonster || me.status !== 'alive' || me.hidden >= 0 || me.killCam) return false;
  const gi = me.repairGen;
  if (gi < 0 || OBJ[gi]?.kind !== 'gen' || game.gens[gi]?.done || game.gateOpen) return false;
  pipe.open = true; pipe.gen = gi; me.repairing = true;
  $('#pipe-ui').classList.remove('hidden');
  newPipePuzzle();
  unlockPointer(); updateResumeOverlay();
  sfx.panel();
  return true;
}
function closePipe(msg) {
  if (!pipe.open) return;
  pipe.open = false; pipe.gen = -1; pipe.drawing = -1; me.repairing = false;
  $('#pipe-ui').classList.add('hidden');
  if (msg) addFeed(msg, 'bad');
  updateResumeOverlay();
}
function pipeCellAt(e) {
  const r = pipeCanvas.getBoundingClientRect(), k = pipe.size / r.width;
  const x = Math.floor(((e.clientX - r.left) * k - pipe.pad) / pipe.cs), y = Math.floor(((e.clientY - r.top) * k - pipe.pad) / pipe.cs);
  return x >= 0 && y >= 0 && x < pipe.N && y < pipe.N ? y * pipe.N + x : -1;
}
// Extend pipe c by one cell. Returns false if blocked.
function pipeStep(c, cell) {
  const P = pipe.paths[c], head = P[P.length - 1], N = pipe.N;
  if (cell === head) return true;
  const k = P.indexOf(cell);
  if (k >= 0) { P.length = k + 1; return true; }            // pulled back along itself
  if (Math.abs((cell % N) - (head % N)) + Math.abs(((cell / N) | 0) - ((head / N) | 0)) !== 1) return false;
  if (P.length > 1 && pipe.endAt[head] === c) return false;  // already reached its valve
  const ec = pipe.endAt[cell];
  if (ec >= 0 && ec !== c) return false;                      // someone else's valve
  for (let o = 0; o < pipe.K; o++) if (o !== c) { const j = pipe.paths[o].indexOf(cell); if (j >= 0) pipe.paths[o].length = j; } // cut through
  P.push(cell);
  if (ec === c) sfx.valve(c);
  else sfx.pipeTick();
  return true;
}
function pipeDragTo(c, target) {
  const N = pipe.N;
  for (let guard = 0; guard < 16; guard++) {
    const P = pipe.paths[c], head = P[P.length - 1];
    if (head === target || !P.length) return;
    if (P.includes(target)) { pipeStep(c, target); return; }
    const hx = head % N, hy = (head / N) | 0, tx = target % N, ty = (target / N) | 0;
    const next = Math.abs(tx - hx) >= Math.abs(ty - hy) ? hy * N + hx + Math.sign(tx - hx) : (hy + Math.sign(ty - hy)) * N + hx;
    if (!pipeStep(c, next)) return;
  }
}
function checkPipeSolved() {
  if (pipe.solved || !pipe.paths.every((_, c) => pipeConnected(c))) return;
  pipe.solved = true; pipe.solvedT = 0; pipe.drawing = -1; pipe.flash = 1;
  pipe.sendAt = Math.max(time, pipe.lastSent + 2.6);   // the host won't take panels faster than that
  $('#pipe-status').textContent = 'CIRCUIT RESTORED';
  sfx.circuit();
}
pipeCanvas.addEventListener('pointerdown', (e) => {
  if (!pipe.open || pipe.solved) return;
  e.preventDefault(); initAudio();
  const cell = pipeCellAt(e); if (cell < 0) return;
  const ec = pipe.endAt[cell];
  if (ec >= 0) { pipe.paths[ec] = [cell]; pipe.drawing = ec; }
  else {
    const c = pipe.paths.findIndex((P) => P.includes(cell));
    if (c < 0) return;
    pipe.paths[c].length = pipe.paths[c].indexOf(cell) + 1; pipe.drawing = c;
  }
  try { pipeCanvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
});
pipeCanvas.addEventListener('pointermove', (e) => {
  if (!pipe.open || pipe.drawing < 0) return;
  const cell = pipeCellAt(e); if (cell >= 0) pipeDragTo(pipe.drawing, cell);
});
const endPipeDrag = () => { if (pipe.drawing >= 0) { pipe.drawing = -1; checkPipeSolved(); } };
pipeCanvas.addEventListener('pointerup', endPipeDrag);
pipeCanvas.addEventListener('pointercancel', endPipeDrag);
$('#pipe-ui').addEventListener('contextmenu', (e) => e.preventDefault());
function updatePipe(dt) {
  if (!pipe.open) return;
  const gi = pipe.gen, o = OBJ[gi];
  if (game.phase !== 'playing' || me.status !== 'alive' || !o || game.gens[gi]?.done || game.gateOpen || Math.hypot(me.pos.x - o.x, me.pos.z - o.z) > 3.2) { closePipe(); return; }
  pipe.flash = Math.max(0, pipe.flash - dt * 1.5); pipe.shake = Math.max(0, pipe.shake - dt * 3);
  if (pipe.solved) {
    pipe.solvedT += dt;
    if (pipe.sendAt && time >= pipe.sendAt) { pipe.sendAt = 0; pipe.lastSent = time; sendToHost({ t: 'solve', gen: gi }); }
    if (!pipe.sendAt && pipe.solvedT > 1.1) newPipePuzzle();   // on to the next circuit
  }
  const need = game.fixNeed || 2, done = Math.round((game.gens[gi]?.progress || 0) * need);
  $('#pipe-title').textContent = `GENERATOR · CIRCUIT ${Math.min(need, done + 1)} / ${need}`;
  $('#pipe-pips').innerHTML = Array.from({ length: need }, (_, k) => `<span class="${k < done ? 'on' : ''}"></span>`).join('');
  drawPipe();
}
function drawPipe() {
  const g = pipeCtx, S = pipe.size, N = pipe.N, cs = pipe.cs, pad = pipe.pad;
  if (!S) return;
  const sx = pipe.shake ? (Math.random() - 0.5) * cs * 0.15 * pipe.shake : 0;
  g.setTransform(1, 0, 0, 1, sx, 0);
  g.clearRect(-cs, 0, S + cs * 2, S);
  // Steel backplate with rivets
  const bg = g.createLinearGradient(0, 0, 0, S); bg.addColorStop(0, '#1c2420'); bg.addColorStop(1, '#0c100e');
  g.fillStyle = bg; g.fillRect(0, 0, S, S);
  g.fillStyle = '#3a443e';
  for (const [rx, ry] of [[0.5, 0.5], [S - 0.5, 0.5], [0.5, S - 0.5], [S - 0.5, S - 0.5]]) { g.beginPath(); g.arc(rx ? rx - pad * 0.5 : pad * 0.5, ry > 1 ? ry - pad * 0.5 : pad * 0.5, pad * 0.18, 0, Math.PI * 2); g.fill(); }
  const cx = (k) => pad + ((k % N) + 0.5) * cs, cy = (k) => pad + (((k / N) | 0) + 0.5) * cs;
  // Cells, tinted by whichever pipe runs through them
  const own = new Int8Array(N * N).fill(-1);
  pipe.paths.forEach((P, c) => { for (const k of P) own[k] = c; });
  for (let k = 0; k < N * N; k++) {
    g.fillStyle = '#0a0f0c'; g.fillRect(cx(k) - cs * 0.46, cy(k) - cs * 0.46, cs * 0.92, cs * 0.92);
    if (own[k] >= 0) { g.fillStyle = PIPE_COLORS[own[k]] + (pipeConnected(own[k]) ? '33' : '1a'); g.fillRect(cx(k) - cs * 0.46, cy(k) - cs * 0.46, cs * 0.92, cs * 0.92); }
  }
  // Pipes: dark casing, coloured body, highlight, and a flow pulse once connected
  g.lineCap = 'round'; g.lineJoin = 'round';
  pipe.paths.forEach((P, c) => {
    if (P.length < 2) return;
    const ok = pipeConnected(c), trace = () => { g.beginPath(); P.forEach((k, i) => (i ? g.lineTo(cx(k), cy(k)) : g.moveTo(cx(k), cy(k)))); };
    trace(); g.strokeStyle = '#030504'; g.lineWidth = cs * 0.46; g.stroke();
    trace(); g.strokeStyle = PIPE_COLORS[c]; g.globalAlpha = ok ? 1 : 0.75; g.lineWidth = cs * 0.34; g.stroke();
    g.globalAlpha = 1;
    g.save(); g.translate(-cs * 0.05, -cs * 0.06); trace(); g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = cs * 0.07; g.stroke(); g.restore();
    if (ok) { trace(); g.setLineDash([cs * 0.16, cs * 0.34]); g.lineDashOffset = -time * cs * 1.6; g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = cs * 0.11; g.stroke(); g.setLineDash([]); }
  });
  // Valves
  pipe.ends.forEach((pair, c) => {
    const ok = pipeConnected(c);
    for (const k of pair) {
      const x = cx(k), y = cy(k), r = cs * 0.3;
      if (ok) { g.shadowColor = PIPE_COLORS[c]; g.shadowBlur = cs * 0.4; }
      g.fillStyle = '#050706'; g.beginPath(); g.arc(x, y, r * 1.18, 0, Math.PI * 2); g.fill();
      g.fillStyle = PIPE_COLORS[c]; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = cs * 0.05;
      g.beginPath(); g.moveTo(x - r * 0.6, y); g.lineTo(x + r * 0.6, y); g.moveTo(x, y - r * 0.6); g.lineTo(x, y + r * 0.6); g.stroke(); // the wheel's spokes
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.arc(x - r * 0.35, y - r * 0.35, r * 0.18, 0, Math.PI * 2); g.fill();
    }
  });
  // Solved: the panel lights up
  if (pipe.solved || pipe.flash > 0) {
    g.fillStyle = `rgba(80,255,140,${0.12 + pipe.flash * 0.25})`; g.fillRect(0, 0, S, S);
    g.fillStyle = '#d8ffe6'; g.font = `bold ${Math.round(cs * 0.42)}px "Share Tech Mono", monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (pipe.solved) g.fillText('CIRCUIT RESTORED', S / 2, S / 2);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
}
addEventListener('resize', () => { if (pipe.open) layoutPipe(); });

// ----------------------------------------------------------------------------
//  LOCAL SIMULATION
// ----------------------------------------------------------------------------
const _v = new THREE.Vector3();
// First-person death: you're turned to face the monster as it rears up and slams down,
// then you collapse to the floor before switching to spectating.
function startKillCam(by) {
  me.killCam = { t: 0, by, slammed: false };
  me.status = 'caught';
  me.noise = 0; me.repairing = false;
}
const _kcPos = new THREE.Vector3(), _kcHead = new THREE.Vector3(), _kcDir = new THREE.Vector3();
function updateKillCam(dt) {
  const K = me.killCam; K.t += dt;
  const m = players.get(K.by), B = m?.avatar.userData.monster?.bones;
  if (K.t >= KILL.raise && !K.slammed) { K.slammed = true; me.damage = 1.4; sfx.hit(); sfx.heavyStep(0.9, 0); }
  const shake = K.t > KILL.raise && K.t < KILL.slam + 0.4 ? 0.05 : 0.008;
  if (B?.camera && B.head && K.t < KILL.end) {
    // Ride the creature's own jumpscare camera, staring into its face as it pins you down.
    B.camera.updateWorldMatrix(true, false); B.head.updateWorldMatrix(true, false);
    B.camera.getWorldPosition(_kcPos); B.head.getWorldPosition(_kcHead);
    // Keep at least 1.1 m from its face along the camera bone's line, so it fills the view
    // without the lens ending up inside its head.
    _kcDir.subVectors(_kcPos, _kcHead); const dl = _kcDir.length();
    if (dl < 1.1) _kcPos.copy(_kcHead).addScaledVector(_kcDir.normalize(), 1.1);
    if (!K.started) { K.started = true; camera.position.set(me.pos.x, (me.gy || 0) + me.eye, me.pos.z); flashlight.intensity = 10; }
    camera.position.lerp(_kcPos, 1 - Math.exp(-dt * (K.t < KILL.raise ? 5 : 12)));
    camera.position.x += (Math.random() - 0.5) * shake; camera.position.y += (Math.random() - 0.5) * shake;
    camera.lookAt(_kcHead);
  } else if (m) {
    // No rig (fallback model): face it, then collapse to the floor.
    const d = Math.max(0.5, Math.hypot(m.pos.x - me.pos.x, m.pos.z - me.pos.z));
    me.yaw = angleDamp(me.yaw, Math.atan2(-(m.pos.x - me.pos.x), -(m.pos.z - me.pos.z)), 8, dt);
    const fall = ease((K.t - KILL.slam) / 0.6);
    me.eye = lerp(1.6, 0.25, fall); me.roll = 1.2 * fall;
    me.pitch = damp(me.pitch, K.t < KILL.slam ? Math.atan2(MONSTER_HEAD - me.eye, d) : 0.5, 4, dt);
    camera.position.set(me.pos.x + (Math.random() - 0.5) * shake, (me.gy || 0) + me.eye, me.pos.z);
    camera.rotation.set(me.pitch, me.yaw, me.roll);
  }
  if (K.t > KILL.end + 0.4) {
    // Hand over to the spectator camera, keeping the current view direction.
    camera.getWorldDirection(_kcDir);
    me.yaw = Math.atan2(-_kcDir.x, -_kcDir.z); me.pitch = Math.asin(clamp(_kcDir.y, -1, 1));
    me.pos.set(camera.position.x, 0, camera.position.z); me.eye = Math.max(1.2, camera.position.y - heightAt(camera.position.x, camera.position.z)); me.gy = undefined;
    me.killCam = null; me.roll = 0; flashlight.intensity = 45;
    addFeed('You were taken. Spectating. Press V for monster vision.', 'bad');
  }
}
function updateLocal(dt) {
  me.attackCD = Math.max(0, me.attackCD - dt);
  me.sonarCD = Math.max(0, me.sonarCD - dt);
  me.boost = Math.max(0, me.boost - dt);
  me.damage = Math.max(0, me.damage - dt * 1.2);
  me.lunge = Math.max(0, me.lunge - dt * 4);

  if (me.killCam) { updateKillCam(dt); return; }
  me.throwCD = Math.max(0, (me.throwCD || 0) - dt); me.hideCD = Math.max(0, (me.hideCD || 0) - dt);
  if (me.hidden >= 0 && me.status === 'alive') {
    // Inside a hiding place: silent and unseen, peering out through the slats.
    const L = LOCKERS[me.hidden];
    me.hideT += dt; me.noise = 0; me.repairing = false; me.moving = false; me.crouch = false;
    let rel = me.yaw - L.ry; rel = ((rel + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    me.yaw = L.ry + clamp(rel, -0.7, 0.7); me.pitch = clamp(me.pitch, -0.4, 0.4);
    me.eye = damp(me.eye, HIDE_TYPES[L.type] || 1.45, 10, dt);
    applyCamera(dt, 0);
    if (me.hideT >= HIDE_MAX) { exitHide(true); addFeed('You burst out, gasping for air.', 'bad'); }
    return;
  }
  me.hideT = Math.max(0, (me.hideT || 0) - dt * 1.5);
  me.flinch = Math.max(0, (me.flinch || 0) - dt * 3);
  const ctrl = controlsActive();
  let fx = 0, fz = 0;
  if (ctrl) {
    if (keys.KeyW || keys.ArrowUp) fz -= 1;
    if (keys.KeyS || keys.ArrowDown) fz += 1;
    if (keys.KeyA || keys.ArrowLeft) fx -= 1;
    if (keys.KeyD || keys.ArrowRight) fx += 1;
  }
  const len = Math.hypot(fx, fz);
  if (len > 0) { fx /= len; fz /= len; }
  const sin = Math.sin(me.yaw), cos = Math.cos(me.yaw);
  const mx = fx * cos + fz * sin, mz = -fx * sin + fz * cos;

  // ---- Spectator: free fly, no collision
  if (me.status !== 'alive') {
    const up = (ctrl && keys.Space ? 1 : 0) - (ctrl && (keys.KeyC || keys.ShiftLeft) ? 1 : 0);
    const sp = 9;
    me.pos.x += mx * sp * dt; me.pos.z += mz * sp * dt;
    me.eye = clamp(me.eye + up * sp * dt, 0.5, 30);
    me.noise = 0; me.repairing = false;
    applyCamera(dt, 0);
    return;
  }

  // ---- Repair interaction (survivors)
  let nearGen = -1;
  if (!me.isMonster) {
    let best = 2.6;
    OBJ.forEach((G, i) => {
      if (!game.gens[i] || game.gens[i].done || objLocked(i, game.gens)) return;
      const d = Math.hypot(me.pos.x - G.x, me.pos.z - G.z);
      if (d < best) { best = d; nearGen = i; }
    });
  }
  me.repairGen = nearGen;
  const held = ctrl && nearGen >= 0 && OBJ[nearGen].kind !== 'gen' && keys.KeyE && len === 0;
  me.repairing = pipe.open || held;
  if (held) {
    me.repairAcc += dt;
    if (me.repairAcc >= 0.1) { sendToHost({ t: 'repair', gen: nearGen, dt: me.repairAcc }); me.repairAcc = 0; if (Math.random() < 0.6) sfx.repair(); }
  } else me.repairAcc = 0;

  // ---- Movement modes & stamina
  const moving = len > 0;
  me.crouch = !me.isMonster && ctrl && keys.KeyC; // C only: Ctrl+W closes the browser tab
  const wantSprint = ctrl && (keys.ShiftLeft || keys.ShiftRight) && moving && !me.crouch;
  if (me.stamina <= 0) me.exhausted = true;
  if (me.exhausted && me.stamina > 0.35) me.exhausted = false;
  me.sprint = wantSprint && !me.exhausted;
  me.stamina = clamp(me.stamina + (me.sprint ? -dt / (me.isMonster ? 5.5 : 5) : dt * (me.isMonster ? (moving ? 0.16 : 0.28) : (moving ? 0.15 : 0.25))), 0, 1);

  let speed;
  if (me.isMonster) speed = me.sprint ? CFG.SPEED.monsterSprint : CFG.SPEED.monster;
  else speed = me.crouch ? CFG.SPEED.crouch : me.sprint ? CFG.SPEED.sprint : CFG.SPEED.walk;
  if (me.boost > 0) speed *= 1.35;
  const wading = inWater(me.pos.x, me.pos.z), planks = !wading && onBridge(me.pos.x, me.pos.z);
  if (wading) speed *= me.isMonster ? 0.8 : 0.6;
  if (moving) moveWithCollision(me.pos, mx * speed * dt, mz * speed * dt, me.isMonster ? CFG.MON_R : CFG.SURV_R);
  me.moving = moving;
  me.speedNow = damp(me.speedNow || 0, Math.hypot(me.pos.x - (me.lastX ?? me.pos.x), me.pos.z - (me.lastZ ?? me.pos.z)) / Math.max(dt, 1e-4), 10, dt);
  me.lastX = me.pos.x; me.lastZ = me.pos.z;
  if (me.isMonster) {
    // Drop onto all fours at a full charge (not while striking)
    const striking = me.attackCD > CFG.ATTACK_CD - 0.6;
    me.gal = damp(me.gal || 0, striking ? 0 : smooth01(((me.speedNow || 0) - 4.4) / 0.8), striking ? 12 : 5, dt);
    const was = me.galPh || 0;
    me.galPh = (was + dt * gallopFreq(Math.max(me.speedNow || 0, 4.4)) * (me.gal > 0.01 ? 1 : 0)) % 1;
    if (me.gal > 0.4) for (const at of [0.02, 0.52]) if ((was < at && me.galPh >= at) || (was > me.galPh && at < me.galPh)) {
      // Each pair of paws hitting the ground: a thud, a jolt, and a pulse of your own echo
      me.thump = 1; sfx.heavyStep(at > 0.5 ? 0.42 : 0.3, 0);
      addRipple(_v.set(me.pos.x - Math.sin(me.yaw) * (at > 0.5 ? 1.2 : -0.3), 0.05, me.pos.z - Math.cos(me.yaw) * (at > 0.5 ? 1.2 : -0.3)), 7, 0.24, 10, true);
    }
    me.stillT = moving || me.attackCD > CFG.ATTACK_CD - 0.5 ? 0 : (me.stillT || 0) + dt;
    me.camo = me.stillT > 1.2 ? Math.min(1, (me.camo || 0) + dt / 1.4) : Math.max(0, (me.camo || 0) - dt / 0.25);
  }

  // ---- Noise (what the monster "sees")
  me.noise = !moving ? (me.repairing ? OBJ_NOISE[OBJ[pipe.open ? pipe.gen : nearGen]?.kind] || 0 : 0) : me.crouch ? CFG.NOISE.crouch : me.sprint ? CFG.NOISE.sprint : CFG.NOISE.walk;
  if (moving && wading) me.noise = Math.min(1, Math.max(0.45, me.noise * 1.8)); // splashing
  else if (moving && planks) me.noise = Math.min(1, me.noise * 1.3);           // creaking boards

  // ---- Footsteps
  if (moving) {
    me.stepT -= dt * speed;
    if (me.stepT <= 0) {
      me.stepT = me.isMonster ? 2.6 : 2.0;
      if (me.isMonster) {
        // The monster's own steps send a faint ripple — enough to feel nearby walls.
        if (!(me.gal > 0.4)) { addRipple(_v.set(me.pos.x, 0.05, me.pos.z), me.sprint ? 6 : 4.5, 0.2, 8, true); sfx.heavyStep(0.25, 0); }
      } else if (wading) sfx.splash(me.noise); else if (planks) sfx.creak(me.noise); else sfx.step(me.noise, 0);
    }
  }

  // ---- Escape
  if (!me.isMonster && game.gateOpen && !me.escapeSent && inExit(me.pos.x, me.pos.z)) {
    me.escapeSent = true; sendToHost({ t: 'escape' });
  }

  const targetEye = me.isMonster ? lerp(MONSTER_EYE, 1.75, me.gal || 0) : me.crouch ? 1.0 : 1.6;
  me.eye = damp(me.eye, targetEye, 10, dt);
  me.thump = Math.max(0, (me.thump || 0) - dt * 5);
  me.bob += moving ? dt * speed * 2.2 : 0;
  applyCamera(dt, moving ? (me.isMonster ? 0.06 : 0.04) * (speed / 3.4) : 0);
}
function applyCamera(dt, bobAmp) {
  const gh = heightAt(me.pos.x, me.pos.z);
  me.gy = me.gy === undefined ? gh : damp(me.gy, gh, 14, dt);   // smoothed ground height under you
  // Galloping: the view drops low, bounds with the stride, jolts on each landing and widens.
  const g = me.isMonster && me.status === 'alive' ? (me.gal || 0) : 0, gp = me.galPh || 0;
  camera.position.set(me.pos.x, me.gy + me.eye + Math.sin(me.bob) * bobAmp * (1 - g) + gallopBob(gp) * 1.4 * g, me.pos.z);
  if (me.lunge > 0) { camera.position.x -= Math.sin(me.yaw) * me.lunge * 0.3; camera.position.z -= Math.cos(me.yaw) * me.lunge * 0.3; }
  camera.rotation.set(me.pitch - (me.flinch || 0) * 0.12 - (me.thump || 0) * 0.035 * g, me.yaw,
    Math.sin(me.bob * 0.5) * bobAmp * 0.3 * (1 - g) + Math.sin(gp * Math.PI * 2) * 0.028 * g + (me.flinch || 0) * 0.08);
  const fov = 75 + 10 * g;
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

// ---- Avatar animation -------------------------------------------------------
const _q = new THREE.Quaternion(), _axis = new THREE.Vector3();
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
// Rotate a bone about one of its local axes, on top of whatever the mixer set this frame.
function boneRot(b, axis, ang) { if (b && ang) b.quaternion.multiply(_q.setFromAxisAngle(AXES[axis], ang)); }
const ease = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
// Kill timeline (s), matching the monster's Jumpscare clip: it leaps (0-0.8), drives the
// victim down (0.8-1.4), then crouches over them face to face until 4.1 s.
const KILL = { raise: 0.8, slam: 1.4, recover: 3.6, end: 4.13 };
const _sv1 = new THREE.Vector3(), _sv2 = new THREE.Vector3();

function animateSurvivor(r, dt, monAt) {
  const a = r.avatar, A = r.anim, rig = a.userData.rig, B = a.userData.bones;
  A.flinch = Math.max(0, A.flinch - dt * 2.5);
  if (A.deadDelay > 0) { A.deadDelay -= dt; if (A.deadDelay <= 0) A.dead = 0; }
  const dead = A.dead >= 0;
  A.crouch = damp(A.crouch, !dead && (r.crouch || r.repairing) ? 1 : 0, 8, dt);
  A.repair = damp(A.repair, !dead && r.repairing ? 1 : 0, 6, dt);
  A.lean = damp(A.lean, clamp((r.speed - 4) / 2, 0, 1), 6, dt);
  const mixer = a.userData.mixer, acts = a.userData.acts;
  if (mixer && acts?.walk) {
    // Blend idle <-> walk by speed. Crouch-walking uses short, slow strides.
    const w = dead ? 0 : clamp(r.speed / 1.2, 0, 1);
    acts.walk.setEffectiveWeight(w); acts.idle.setEffectiveWeight(1 - w);
    acts.walk.timeScale = clamp(r.speed / (A.crouch > 0.5 ? 1.5 : 3.2), 0.4, 2.2);
    const rest = a.userData.rest;
    for (const [b, q, p] of rest) { b.quaternion.copy(q); b.position.copy(p); }
    mixer.update(dead ? 0 : dt);
    for (const x of rest) { x[1].copy(x[0].quaternion); x[2].copy(x[0].position); }
  }
  if (B) {
    const c = A.crouch, rp = A.repair;
    // Crouch: thighs forward, knees bent, feet flat, back hunched.
    boneRot(B.lUp, 'x', 1.0 * c); boneRot(B.rUp, 'x', 1.0 * c);
    boneRot(B.lLeg, 'x', -1.75 * c); boneRot(B.rLeg, 'x', -1.75 * c);
    boneRot(B.lFoot, 'x', 0.75 * c); boneRot(B.rFoot, 'x', 0.75 * c);
    boneRot(B.spine, 'x', 0.25 * c + 0.35 * rp + 0.3 * A.lean - 0.6 * A.flinch);
    boneRot(B.neck, 'x', -0.25 * c);
    // Repair: arms reach forward and work at the panel.
    const work = Math.sin(time * 9) * 0.18 * rp;
    boneRot(B.lArm, 'z', (1.0 + work) * rp); boneRot(B.rArm, 'z', -(1.0 - work) * rp);
    boneRot(B.lFore, 'z', 0.5 * rp); boneRot(B.rFore, 'z', -0.5 * rp);
    // Death: arms flung out.
    if (dead) { const k = ease(A.dead / 0.6); boneRot(B.lArm, 'z', -0.9 * k); boneRot(B.rArm, 'z', 0.9 * k); boneRot(B.spine, 'x', -0.3 * k); }
    // Sprinting: elbows bent, arms pumping against the legs (read off which foot is ahead).
    A.run = damp(A.run || 0, !dead && r.speed > 4.2 ? 1 : 0, 6, dt);
    if (A.run > 0.01 && B.lFoot && B.rFoot) {
      const yaw = a.rotation.y, side = _lAx.set(Math.cos(yaw), 0, -Math.sin(yaw));
      a.updateMatrixWorld(true);
      B.lFoot.getWorldPosition(_sv1); B.rFoot.getWorldPosition(_sv2);
      const lead = clamp(((_sv1.x - _sv2.x) * -Math.sin(yaw) + (_sv1.z - _sv2.z) * -Math.cos(yaw)) / 0.45, -1, 1); // +1: left foot ahead
      rotateBoneWorld(B.lArm, side, -lead * 0.75 * A.run); rotateBoneWorld(B.rArm, side, lead * 0.75 * A.run);
      rotateBoneWorld(B.lFore, side, 1.2 * A.run); rotateBoneWorld(B.rFore, side, 1.2 * A.run);
      // Glancing back over a shoulder at the thing chasing you
      A.lookT = (A.lookT ?? 0) - dt;
      if (monAt && A.lookT < -1.6) {
        const dx = monAt.x - r.pos.x, dz = monAt.z - r.pos.z, d = Math.hypot(dx, dz);
        if (d < 16 && (dx * -Math.sin(yaw) + dz * -Math.cos(yaw)) < 0) { A.lookT = 0.75; A.lookYaw = clamp(Math.atan2(Math.sin(Math.atan2(-dx, -dz) - yaw), Math.cos(Math.atan2(-dx, -dz) - yaw)), -1.8, 1.8); }
      }
      const k = A.lookT > 0 ? Math.sin((1 - A.lookT / 0.75) * Math.PI) * A.run : 0;
      if (k > 0.01) { rotateBoneWorld(B.spine2, UP, A.lookYaw * 0.35 * k); rotateBoneWorld(B.neck, UP, A.lookYaw * 0.55 * k); }
    }
    rig.position.y = -0.42 * A.crouch;
  } else {
    rig.scale.y = damp(rig.scale.y, r.crouch ? 0.68 : 1, 10, dt);
    rig.position.y = Math.abs(Math.sin(r.walkT)) * 0.05 * Math.min(r.speed, 2);
  }
  if (dead) {
    // Fall backwards onto the floor with a small bounce.
    A.dead += dt;
    const t = A.dead, k = t < 0.55 ? ease(t / 0.55) : 1 + Math.sin(Math.min(1, (t - 0.55) / 0.25) * Math.PI) * 0.05;
    rig.rotation.x = 1.5 * k; rig.position.z = 0.25 * k; rig.position.y = 0.05 * k;
  } else {
    rig.rotation.x = -0.25 * A.flinch; rig.position.z = 0;
  }
}

// Dynamic layer on top of the clips, applied in world space (so it works whatever the
// rig's bone axes are): the head turns to track a nearby survivor, random spasms jerk
// the head, neck and hands, and the fingers never stop trembling.
const _lv = new THREE.Vector3(), _lq = new THREE.Quaternion(), _lpq = new THREE.Quaternion(), _lAx = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
function rotateBoneWorld(b, axis, ang) {
  if (!b || !ang || !b.parent) return;
  b.parent.updateWorldMatrix(true, false);
  b.parent.getWorldQuaternion(_lpq);
  _lq.setFromAxisAngle(axis, ang).premultiply(_lpq.clone().invert()).multiply(_lpq); // parent^-1 * delta * parent
  b.quaternion.premultiply(_lq);
}
const MONSTER_BONES = {
  head: /^head_011/, neck: /^neck2_010/, neck1: /^neck1_09/, spine: /^spine3_04/, spine1: /^spine1_02/, spine2: /^spine2_03/,
  armL: /^arm_L_06/, armR: /^arm_R_013/, handL: /^hand_L_08$/, handR: /^hand_R_015$/, forearmL: /^forarm_L_07/, forearmR: /^forarm_R_014/,
  thighL: /^thigh_L_017/, thighR: /^thigh_R_021/, shinL: /^shin_L_018/, shinR: /^shin_R_022/, footL: /^foot_L_019$/, footR: /^foot_R_023$/,
  camera: /^camera_024$/,
};
// ---- The gallop ------------------------------------------------------------------------
// At a full charge it doesn't run upright: it drops onto all fours and bounds, the spine
// pitched nearly flat and flexing with each stride, its long arms slamming down ahead as
// front legs and its hind legs driving underneath. It's procedural: the spine and neck are
// bent in world space and every limb is placed by two-bone IK on the ground (so it works on
// hills too), layered over the clips with a weight that rises with speed.
const GALLOP = { drop: 0.36, back: 0.25, duty: 0.4, lift: { arm: 0.5, leg: 0.36 } };
// Rear legs land together (slightly staggered), then the arms half a stride later.
const GAIT = { thighL: 0, thighR: 0.07, armL: 0.5, armR: 0.57 };
const gallopFreq = (speed) => clamp(speed / 3.0, 1.2, 2.1);
const _ga = new THREE.Vector3(), _gb = new THREE.Vector3(), _gc = new THREE.Vector3(), _gd = new THREE.Vector3(), _ge = new THREE.Vector3(), _gt = new THREE.Vector3();
const _gq = new THREE.Quaternion(), _gpq = new THREE.Quaternion(), _gq2 = new THREE.Quaternion(), _gI = new THREE.Quaternion();
const _gF = new THREE.Vector3(), _gR = new THREE.Vector3(), _gP = new THREE.Vector3(), _gTgt = new THREE.Vector3();
// Turn bone b in world space so that direction `from` becomes `to` (unit vectors), by weight w.
function aimBone(b, from, to, w) {
  if (!b || !b.parent) return;
  _gq.setFromUnitVectors(from, to);
  if (w < 1) _gq.slerp(_gI, 1 - w);
  b.parent.getWorldQuaternion(_gpq);
  _gq2.copy(_gpq).invert().multiply(_gq).multiply(_gpq);
  b.quaternion.premultiply(_gq2);
  b.updateMatrixWorld(true);
}
// Two-bone IK: upper bone A, lower bone B, end C reach for `target`; the middle joint
// bends toward `pole`.
function ik2(A, B, C, target, pole, w) {
  if (!A || !B || !C) return;
  A.getWorldPosition(_ga); B.getWorldPosition(_gb); C.getWorldPosition(_gc);
  const l1 = _ga.distanceTo(_gb), l2 = _gb.distanceTo(_gc);
  _gt.subVectors(target, _ga);
  const d = clamp(_gt.length(), Math.abs(l1 - l2) + 0.02, (l1 + l2) * 0.995); _gt.normalize();
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _gd.copy(pole).addScaledVector(_gt, -pole.dot(_gt)).normalize();
  _ge.copy(_ga).addScaledVector(_gt, a).addScaledVector(_gd, h);                 // where the elbow/knee goes
  aimBone(A, _gb.sub(_ga).normalize(), _ge.sub(_ga).normalize(), w);
  B.getWorldPosition(_gb); C.getWorldPosition(_gc);
  _ge.copy(_ga).addScaledVector(_gt, d);                                          // the (reachable) target
  aimBone(B, _gc.sub(_gb).normalize(), _ge.sub(_gb).normalize(), w);
}
// Bend the body into the gallop: lower, pitched forward, spine flexing with the stride.
function gallopPose(B, yaw, w, ph) {
  const R = _gR.set(Math.cos(yaw), 0, -Math.sin(yaw));
  const flex = Math.cos(ph * Math.PI * 2);                                         // +1 gathered, -1 stretched out
  rotateBoneWorld(B.spine1, R, -(0.92 + flex * 0.06) * w);
  rotateBoneWorld(B.spine2, R, -(0.3 + flex * 0.16) * w);
  rotateBoneWorld(B.spine, R, -(0.14 + flex * 0.08) * w);
  rotateBoneWorld(B.neck1, R, (0.85 + flex * 0.1) * w);                            // keep its face toward where it's going
  rotateBoneWorld(B.head, R, (0.42 - flex * 0.12) * w);
}
// Body bob for the gallop: two lifts per stride (after the hind push and the front push).
const gallopBob = (ph) => 0.07 * Math.sin(ph * Math.PI * 4 - 0.6);
// Place each limb: stance sweeps the paw back along the ground, swing lifts it forward.
function gallopLimbs(B, root, yaw, w, ph, speed, limbs, opt = {}) {
  const F = _gF.set(-Math.sin(yaw), 0, -Math.cos(yaw)), R = _gR.set(Math.cos(yaw), 0, -Math.sin(yaw));
  const f = gallopFreq(speed), sweep = clamp(speed * GALLOP.duty / f, 0.6, 1.4);
  for (const name of limbs) {
    const arm = name.startsWith('arm'), side = name.endsWith('L') ? -1 : 1;
    const A = B[name], Bm = arm ? B['forearm' + name.slice(-1)] : B['shin' + name.slice(-1)], C = arm ? B['hand' + name.slice(-1)] : B['foot' + name.slice(-1)];
    if (!A || !Bm || !C) continue;
    const u = ((ph - GAIT[name]) % 1 + 1) % 1, D = GALLOP.duty;
    const fwd = arm ? (opt.reach ?? 0.78) : 0.3, back = sweep - fwd;            // reach ahead of the joint, push behind it
    let along, lift;
    if (u < D) { along = lerp(fwd, -back, u / D); lift = 0; }
    else { const s = (u - D) / (1 - D), e = s * s * (3 - 2 * s); along = lerp(-back, fwd + 0.15, e); lift = Math.sin(s * Math.PI) * (arm ? (opt.lift ?? GALLOP.lift.arm) : GALLOP.lift.leg); }
    A.getWorldPosition(_gTgt);
    const bx = _gTgt.x + F.x * along + R.x * side * (arm ? 0.12 : 0.06), bz = _gTgt.z + F.z * along + R.z * side * (arm ? 0.12 : 0.06);
    _gTgt.set(bx, heightAt(bx, bz) + (arm ? 0.08 : 0.15) + lift, bz);
    // elbows point back and out; knees point forward
    if (arm) _gP.copy(F).multiplyScalar(-1).addScaledVector(R, side * 0.45).addScaledVector(UP, 0.25);
    else _gP.copy(F).addScaledVector(R, side * 0.2);
    ik2(A, Bm, C, _gTgt, _gP, w);
  }
  root?.updateMatrixWorld(true);
}
function liveLayer(g, M, dt) {
  const B = M.bones;
  // Head tracking: only when a survivor is watching from nearby, and not mid-kill.
  const watching = viewMode === 'survivor' && M.anim.shot !== 'jumpscare';
  g.worldToLocal(_lv.copy(camera.position));
  const dist = Math.hypot(_lv.x, _lv.z);
  M.look = damp(M.look, watching && dist < 16 ? 1 : 0, 2.5, dt);
  if (M.look > 0.01) {
    const yaw = clamp(Math.atan2(-_lv.x, -_lv.z), -1.4, 1.4) * M.look;  // relative to the avatar's facing (-Z)
    rotateBoneWorld(B.neck1, UP, yaw * 0.4);
    rotateBoneWorld(B.head, UP, yaw * 0.6);
    // tilt the head down/up toward the watcher: axis is the avatar's sideways direction
    const side = _lAx.set(Math.cos(g.rotation.y), 0, -Math.sin(g.rotation.y));
    rotateBoneWorld(B.head, side, clamp(Math.atan2(_lv.y - MONSTER_HEAD, Math.max(dist, 0.5)), -0.6, 0.5) * M.look);
  }
  // Spasms
  if (time > M.nextSpasm) {
    M.nextSpasm = time + 1.2 + Math.random() * 3.5;
    const parts = ['head', 'head', 'neck', 'handL', 'handR', 'forearmL', 'forearmR', 'spine'];
    const name = parts[Math.floor(Math.random() * parts.length)];
    const ax = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    M.spasms.push({ bone: B[name], ax, amp: (/hand|fore/.test(name) ? 0.6 : 0.4) * (Math.random() < 0.5 ? -1 : 1), t: 0, dur: 0.2 + Math.random() * 0.45 });
  }
  M.spasms = M.spasms.filter((sp) => {
    sp.t += dt;
    const env = sp.t < 0.04 ? sp.t / 0.04 : Math.pow(Math.max(0, 1 - (sp.t - 0.04) / sp.dur), 2);
    rotateBoneWorld(sp.bone, sp.ax, sp.amp * env);
    return sp.t < sp.dur + 0.04;
  });
  // Finger tremor
  rotateBoneWorld(B.handL, UP, Math.sin(time * 31) * 0.06 + Math.sin(time * 17.3) * 0.04);
  rotateBoneWorld(B.handR, UP, Math.sin(time * 29 + 1) * 0.06 + Math.sin(time * 19.1) * 0.04);
}

const _fl = new THREE.Vector3();
function inFlashlight(pos, range) {
  if (viewMode !== 'survivor' || !flashlightOn || me.isMonster || me.status !== 'alive') return false;
  _fl.set(pos.x, heightAt(pos.x, pos.z) + 1.4, pos.z).sub(camera.position);
  const d = _fl.length(); if (d > range) return false;
  camera.getWorldDirection(_v2);
  return _fl.dot(_v2) / d > Math.cos(0.45);
}
const _v2 = new THREE.Vector3();
function animateMonster(r, dt) {
  const a = r.avatar, rig = a.userData.rig, M = a.userData.monster;
  if (!M) { // primitive fallback: simple lurch
    const gait = Math.min(r.speed, 6);
    rig.rotation.x = 0.1 + gait * 0.025 + Math.sin(time * 1.3) * 0.03;
    rig.position.y = Math.abs(Math.sin(r.walkT * 0.5)) * 0.08 * Math.min(gait, 1.5);
    return;
  }
  const busy = M.anim.busy();
  // ---- Dynamic motion
  // Turn banking and acceleration pitch, from how its heading and speed are changing.
  let dYaw = r.yaw - (M.prevYaw ?? r.yaw); dYaw = ((dYaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const turnRate = dYaw / Math.max(dt, 1e-4), accel = (r.speed - (M.prevSpeed ?? r.speed)) / Math.max(dt, 1e-4);
  M.prevYaw = r.yaw; M.prevSpeed = r.speed;
  M.bank = damp(M.bank, clamp(-turnRate * r.speed * 0.05, -0.35, 0.35), 5, dt);
  M.pitch = damp(M.pitch, clamp(accel * 0.03, -0.15, 0.25), 4, dt);
  rig.rotation.z = M.bank; rig.rotation.x = M.pitch;
  // Idle playback drifts so the loop never looks the same twice.
  M.rateT -= dt;
  if (M.rateT <= 0) { M.rateT = 1.5 + Math.random() * 3; M.rateTarget = 0.75 + Math.random() * 0.55; }
  M.anim.rate = damp(M.anim.rate, M.rateTarget, 1.5, dt);
  // Stop-motion stutter: it freezes for a few frames, then lurches to catch up.
  let adt = dt;
  if (!busy) {
    if (M.freeze > 0) { M.freeze -= dt; M.owed += dt; adt = 0; }
    else if (M.owed > 0) { const pay = Math.min(M.owed, dt * 1.5); M.owed -= pay; adt = dt + pay; }
    else if (Math.random() < dt * (r.speed > 0.5 ? 0.5 : 0.25)) M.freeze = 0.06 + Math.random() * 0.16;
  }
  // ---- Animation + camouflage
  M.stillT = r.speed < 0.3 && !busy && Math.abs(turnRate) < 0.6 ? M.stillT + dt : 0;
  // Turning on the spot: shuffle its feet instead of rotating like a statue.
  const gait = r.speed < 0.5 ? Math.max(r.speed, Math.min(1.6, Math.abs(turnRate) * 0.9)) : r.speed;
  M.anim.update(adt, gait);
  liveLayer(a, M, dt);
  // Listening crouch: when it has been still a while it sinks low and hunches forward.
  M.crouch = damp(M.crouch || 0, M.stillT > 0.8 ? 1 : 0, 2.2, dt);
  if (M.crouch > 0.01) {
    const side = _lAx.set(Math.cos(a.rotation.y), 0, -Math.sin(a.rotation.y));
    rotateBoneWorld(M.bones.spine, side, -0.45 * M.crouch);
    rotateBoneWorld(M.bones.head, side, 0.35 * M.crouch);          // keep the face level, peering ahead
    rotateBoneWorld(M.bones.head, UP, Math.sin(time * 0.6) * 0.5 * M.crouch);
  }
  if (!(M.gal > 0.01)) rig.position.y = -0.35 * M.crouch;
  // Gallop at a full charge (never mid-strike): weight follows speed.
  M.gal = damp(M.gal || 0, busy ? 0 : smooth01((r.speed - 4.4) / 0.8), busy ? 12 : 5, dt);
  M.galPh = ((M.galPh || 0) + dt * gallopFreq(r.speed) * (M.gal > 0.01 ? 1 : 0)) % 1;
  if (M.gal > 0.01) {
    rig.position.y = -GALLOP.drop * M.gal + gallopBob(M.galPh) * M.gal; rig.position.z = GALLOP.back * M.gal;
    rig.updateMatrixWorld(true);
    gallopPose(M.bones, a.rotation.y, M.gal, M.galPh);
    a.updateMatrixWorld(true);
    gallopLimbs(M.bones, a, a.rotation.y, M.gal, M.galPh, Math.max(r.speed, 4.4), ['thighL', 'thighR', 'armL', 'armR']);
    // Heavy paws hitting the ground: the hind pair, then the front pair
    const was = M.galPrev ?? M.galPh;
    for (const at of [0.02, 0.52]) if ((was < at && M.galPh >= at) || (was > M.galPh && at < M.galPh)) {
      if (!me.isMonster && M.gal > 0.5) sfx.heavyStep(distVol(r.pos, 34) * (at > 0.5 ? 0.9 : 0.7), panOf(r.pos));
    }
    M.galPrev = M.galPh;
  } else rig.position.z = 0;
  // Camouflage builds after 1.2 s of stillness, but a survivor's flashlight beam on it
  // (within 14 m) breaks it, and it never fades completely: a faint shimmer remains.
  const lit = inFlashlight(r.pos, 14);
  M.camo = M.stillT > 1.2 && !lit ? Math.min(1, M.camo + dt / 1.4) : Math.max(0, M.camo - dt / (lit ? 0.6 : 0.25));
  // Its eyes: two red points that turn to you. They still glint faintly when it is hidden.
  if (M.eyes && M.bones.head) {
    M.bones.head.getWorldPosition(_lv);
    _fl.subVectors(camera.position, _lv); const ed = _fl.length() || 1; _fl.divideScalar(ed);
    const facing = clamp((_fl.x * -Math.sin(a.rotation.y) + _fl.z * -Math.cos(a.rotation.y)) * 1.6 + 0.5 + M.look, 0, 1);
    const vis = r.status === 'alive' && viewMode === 'survivor' ? facing * (M.camo > 0.5 ? (ed < 16 ? 0.35 : 0) : 0.95) * (0.85 + 0.15 * Math.sin(time * 9)) : 0;
    _v2.set(_fl.z, 0, -_fl.x).normalize();
    M.eyes[0].material.opacity = vis;
    M.eyes.forEach((e, i) => { e.position.copy(_lv).addScaledVector(_fl, 0.3).addScaledVector(_v2, i ? 0.075 : -0.075); e.position.y += 0.04; });
  }
  const op = 1 - 0.9 * M.camo;
  for (const m of M.mats) m.opacity = op;
  for (const o of M.meshes) o.castShadow = M.camo < 0.3;
}

// ---- First-person body for the monster player ---------------------------------------
// The player sees its own creature: a clone of the model drawn in the sonar style, set at
// the camera with the head and neck collapsed out of the way. It animates from the
// player's real movement, so the arms swing as you walk, your claws rake into view when
// you strike, and you convulse when you shriek.
const viewBody = { group: null, model: null, anim: null, hide: [], neck: new THREE.Vector3() };
const _vbN0 = new THREE.Vector3(), _vbN1 = new THREE.Vector3();
function setupViewBody() {
  if (!ASSETS.monster || viewBody.group) return;
  const model = SkeletonUtils.clone(ASSETS.monster.template);
  const mat = makeSonarMaterial({ base: 0.3, gain: 0.8, grid: 1.6, near: 0, color: 0x9dffd0 }); // your own claws stay readable
  model.traverse((o) => {
    if (o.isMesh) { o.material = mat; o.frustumCulled = false; o.castShadow = false; }
    if (o.isBone && /^(head_011|neck2_010|head_end|hip_L_016|hip_R_020)/.test(o.name)) viewBody.hide.push(o); // head and legs fold away
    if (o.isBone && /^neck1_09/.test(o.name)) viewBody.neckBone = o;
    if (o.isBone && /^arm_L_06/.test(o.name)) viewBody.armL = o;
    if (o.isBone && /^arm_R_013/.test(o.name)) viewBody.armR = o;
    if (o.isBone) for (const [k, re] of Object.entries(MONSTER_BONES)) if (re.test(o.name)) (viewBody.bones ||= {})[k] = o;
  });
  const group = new THREE.Group(); group.add(model); group.visible = false; scene.add(group);
  const anim = makeMonsterAnimator(model);
  anim.update(0, 0); group.updateMatrixWorld(true);
  viewBody.neckBone?.getWorldPosition(viewBody.neck); // shoulders in body space, standing idle
  Object.assign(viewBody, { group, model, anim });
}
function updateViewBody(dt) {
  const vb = viewBody;
  if (!vb.group) return;
  // First person: you see your own long arms and claws reaching into the bottom of the
  // view (head and legs folded away). They sway as you walk and rake across on strikes.
  const show = me.isMonster && game.phase === 'playing' && me.status === 'alive' && viewMode === 'monster';
  vb.group.visible = show;
  if (!show) return;
  // Shoulders just in front of and below the eyes.
  const sin = Math.sin(me.yaw), cos = Math.cos(me.yaw);
  const nx = vb.neck.x, nz = vb.neck.z, ahead = 0.3;
  vb.group.rotation.y = me.yaw;
  vb.group.position.set(
    me.pos.x - (nx * cos + nz * sin) - sin * ahead,
    (me.gy || 0) + me.eye - 0.35 - vb.neck.y,
    me.pos.z - (-nx * sin + nz * cos) - cos * ahead,
  );
  vb.group.updateMatrixWorld(true);
  vb.anim.update(dt, me.speedNow || 0);
  for (const b of vb.hide) b.scale.setScalar(0.001);
  const right = _lAx.set(Math.cos(me.yaw), 0, -Math.sin(me.yaw));
  const fwd = _v2.set(-Math.sin(me.yaw), 0, -Math.cos(me.yaw));
  const g = me.gal || 0;
  // Galloping: bend into the run, keep the shoulders where they were under the camera,
  // then the arms pound the ground ahead (the claws swing up into view each stride).
  if (g > 0.01 && vb.bones) {
    vb.neckBone.getWorldPosition(_vbN0);
    gallopPose(vb.bones, me.yaw, g, me.galPh || 0);
    vb.neckBone.getWorldPosition(_vbN1);
    vb.group.position.sub(_vbN1).add(_vbN0); vb.group.updateMatrixWorld(true);
  }
  // Resting pose: arms lifted forward so the claws hang at the lower corners of the view,
  // swinging with your stride and twitching now and then.
  const stride = Math.sin(vb.stride = (vb.stride || 0) + dt * (me.speedNow || 0) * 1.4) * Math.min(1, (me.speedNow || 0) / 3);
  for (const b of [vb.armL, vb.armR]) {
    const s = b === vb.armL ? 1 : -1;
    rotateBoneWorld(b, right, (1.25 + stride * 0.18 * s + Math.sin(time * 1.3 + s) * 0.03) * (1 - g));
    rotateBoneWorld(b, fwd, s * 0.5 * (1 - g));
  }
  if (g > 0.01 && vb.bones) gallopLimbs(vb.bones, vb.group, me.yaw, g, me.galPh || 0, Math.max(me.speedNow || 0, 4.4), ['armL', 'armR'], { lift: 1.0, reach: 1.05 });
  // Claw rake on a strike: one arm (both for a kill) swings up into view and across.
  const A = vb.anim, rake = A.shot && /^attack|jumpscare/.test(A.shot) ? A.shotT / A.shotLen : -1;
  if (rake >= 0) {
    if (A.shotT < 0.02) vb.side = vb.side === vb.armL ? vb.armR : vb.armL;
    const k = Math.sin(Math.min(1, rake * 1.6) * Math.PI);
    const arm = A.shot === 'jumpscare' ? null : (vb.side || vb.armR);
    for (const b of arm ? [arm] : [vb.armL, vb.armR]) {
      rotateBoneWorld(b, right, 0.7 * k);
      rotateBoneWorld(b, fwd, (b === vb.armL ? 1 : -1) * (rake - 0.3) * 1.4 * k);
    }
  }
}

// ---- Survivor's own hands: a flashlight in the right hand, the left hand low in view.
const fpHands = new THREE.Group();
(function buildHands() {
  // A touch of self-light so your hands read against the dark (as if lit by the torch spill).
  const skin = new THREE.MeshStandardMaterial({ color: 0xc89d78, roughness: 0.7, emissive: 0x3a2618, emissiveIntensity: 0.6 });
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x2c3e4f, roughness: 0.9, emissive: 0x0e1418, emissiveIntensity: 0.6 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.4, metalness: 0.7 });
  const arm = (side) => {
    const g = new THREE.Group();
    const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.42, 10), sleeve); fore.rotation.x = Math.PI / 2; fore.position.z = 0.16;
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.055, 0.11), skin); hand.position.z = -0.07;
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.06), skin); thumb.position.set(-side * 0.05, 0.015, -0.08); thumb.rotation.y = side * 0.5;
    g.add(fore, hand, thumb);
    return g;
  };
  const R = arm(1), L = arm(-1);
  const torch = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.2, 10), metal); torch.rotation.x = Math.PI / 2; torch.position.set(0, 0.035, -0.12);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.03, 12), new THREE.MeshBasicMaterial({ color: 0xfff4d6 })); lens.position.set(0, 0.035, -0.222); lens.rotation.y = Math.PI;
  R.add(torch, lens); fpHands.userData.lens = lens;
  R.position.set(0.2, -0.2, -0.32); R.rotation.set(0.12, 0.08, 0);
  L.position.set(-0.24, -0.26, -0.36); L.rotation.set(0.25, -0.15, 0.3);
  fpHands.add(R, L); fpHands.userData.R = R; fpHands.userData.L = L;
  fpHands.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.renderOrder = 10; } });
  camera.add(fpHands);
})();
function updateHands(dt) {
  const show = !me.isMonster && game.phase === 'playing' && me.status === 'alive' && !(me.hidden >= 0) && !me.killCam && viewMode === 'survivor';
  fpHands.visible = show;
  if (!show) return;
  const sp = Math.min(1, (me.speedNow || 0) / 6), t = me.bob || 0;
  const { R, L } = fpHands.userData;
  // Walk bob, sprint pump, and a startle jolt when hit.
  R.position.set(0.2 + Math.sin(t * 0.5) * 0.012 * sp, -0.2 + Math.abs(Math.cos(t * 0.5)) * 0.015 * sp - (me.sprint ? 0.04 : 0), -0.32);
  L.position.set(-0.24 - Math.sin(t * 0.5) * 0.012 * sp, -0.26 + Math.abs(Math.sin(t * 0.5)) * 0.015 * sp - (me.sprint ? 0.05 : 0), -0.36);
  R.rotation.x = 0.12 + (me.flinch || 0) * 0.5; L.rotation.x = 0.25 + (me.flinch || 0) * 0.6 + (me.repairing ? -0.6 : 0);
  L.position.y += me.repairing ? 0.08 : 0; L.position.x += me.repairing ? 0.12 : 0;
  fpHands.userData.lens.material.color.setHex(flashlightOn && flashlight.intensity > 5 ? 0xfff4d6 : 0x222222);
}

function updateRemotes(dt) {
  let monsterDist = Infinity, monsterPos = null, mon = null;
  const monAt = me.isMonster ? me.pos : [...players.values()].find((q) => q.isMonster && q.status === 'alive')?.pos;
  for (const r of players.values()) {
    const prev = _v.copy(r.pos);
    r.pos.x = damp(r.pos.x, r.target.x, 12, dt);
    r.pos.z = damp(r.pos.z, r.target.z, 12, dt);
    r.speed = damp(r.speed, prev.distanceTo(r.pos) / Math.max(dt, 1e-4), 8, dt);
    r.yaw = angleDamp(r.yaw, r.targetYaw, 12, dt);
    const a = r.avatar;
    a.position.copy(r.pos); a.position.y = heightAt(r.pos.x, r.pos.z); a.rotation.y = r.yaw;
    r.walkT += dt * r.speed * 2.4;
    if (r.isMonster) animateMonster(r, dt); else animateSurvivor(r, dt, monAt);
    if (r.status !== 'alive') continue;

    if (r.isMonster) {
      const d = r.pos.distanceTo(me.pos);
      if (d < monsterDist) { monsterDist = d; monsterPos = r.pos; mon = r; }
      // Survivors hear the monster's heavy footfalls
      if (!me.isMonster && r.speed > 0.5 && !(r.avatar.userData.monster?.gal > 0.5)) {
        r.stepT -= dt * r.speed;
        if (r.stepT <= 0) { r.stepT = 2.6; sfx.heavyStep(distVol(r.pos, 30) * 0.8, panOf(r.pos)); }
      }
    } else if (me.isMonster || viewMode === 'monster') {
      // ===== ECHOLOCATION: survivor noise → sonar ripples on the monster's grid
      const n = heardNoise(r.noise, r.crouch && !r.repairing, r.pos.x, r.pos.z);
      if (n > 0.005) {
        r.stepT -= dt;
        if (r.stepT <= 0) {
          const crouched = r.crouch && !r.repairing;
          r.stepT = (crouched ? 1.2 + Math.random() * 0.8 : lerp(0.95, 0.32, n)) * (r.repairing ? 1.4 : 1);
          if (crouched) addRipple(_v.set(r.pos.x, 0.05, r.pos.z), 1.6, 0.18, 24);          // faint, but it still carries
          else addRipple(_v.set(r.pos.x, 0.05, r.pos.z), 2.2 + n * 11, 0.3 + n * 0.95);
          if (me.isMonster) sfx.blip(Math.max(0.15, distVol(r.pos, 60)) * (0.3 + n), panOf(r.pos)); // faint but audible at any range
        }
      }
    }
  }
  return { monsterDist, monsterPos, mon };
}

// ----------------------------------------------------------------------------
//  WORLD ANIMATION, HUD, AMBIENCE
// ----------------------------------------------------------------------------
// ---- Atmosphere: sky, lightning, grass, fireflies, embers (survivor view only) ---------
const atmo = { uTime: { value: 0 }, uGust: { value: 0 } };
function pointCloud(positions, color, size, mode) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(Array.from({ length: positions.length / 3 }, () => Math.random()), 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: atmo.uTime, uColor: { value: new THREE.Color(color) }, uSize: { value: size }, uMode: { value: mode } },
    vertexShader: /* glsl */ `
      attribute float aPhase; uniform float uTime; uniform float uSize; uniform float uMode; varying float vA;
      void main() {
        vec3 p = position; float t = uTime + aPhase * 40.0;
        if (uMode < 0.5) {            // fireflies: drift and blink
          p.x += sin(t * 0.5) * 0.9; p.y += sin(t * 0.9 + aPhase * 6.0) * 0.35; p.z += cos(t * 0.4) * 0.9;
          vA = smoothstep(0.55, 1.0, sin(t * 1.3) * 0.5 + 0.5);
        } else {                      // embers: rise, wander, die
          float k = fract(t * 0.22); p.y += k * 3.6; p.x += sin(t * 2.0 + aPhase * 20.0) * 0.3 * k; p.z += cos(t * 1.7 + aPhase * 13.0) * 0.3 * k;
          vA = (1.0 - k) * 0.9;
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vA *= smoothstep(50.0, 22.0, -mv.z);
        gl_PointSize = uSize * (300.0 / max(-mv.z, 0.5)); gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying float vA;
      void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(uColor * 2.5, smoothstep(0.5, 0.0, d) * vA); }`,
  });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false;
  scene.add(pts); survivorOnly.push(pts);
  return pts;
}
function buildAtmosphere(rng) {
  // Sky dome: deep gradient, moon halo, and a term lightning can light up
  const sky = new THREE.Mesh(new THREE.SphereGeometry(210, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uFlash: { value: 0 }, uMoon: { value: new THREE.Vector3(-90, 110, -120).normalize() }, uTime: atmo.uTime },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uFlash; uniform vec3 uMoon; uniform float uTime; varying vec3 vDir;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        vec3 d = normalize(vDir); float h = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(vec3(0.016, 0.024, 0.04), vec3(0.002, 0.004, 0.012), pow(h, 0.45));
        float m = max(dot(d, uMoon), 0.0);
        col += vec3(0.30, 0.36, 0.5) * pow(m, 90.0) * 0.5 + vec3(0.07, 0.09, 0.14) * pow(m, 7.0) * 0.5;
        // slow drifting cloud banks that catch the moon and the lightning
        vec2 uv = d.xz / (d.y + 0.25) * 1.6 + vec2(uTime * 0.004, 0.0);
        float c = smoothstep(0.52, 0.85, vnoise(uv) * 0.6 + vnoise(uv * 2.7) * 0.4) * smoothstep(0.02, 0.3, h);
        col = mix(col, vec3(0.02, 0.026, 0.04) + vec3(0.05, 0.06, 0.09) * pow(m, 3.0), c * 0.8);
        col += vec3(0.55, 0.6, 0.78) * uFlash * (0.2 + 0.6 * c + 0.3 * (1.0 - h));
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  sky.position.set(AREA / 2, 0, AREA / 2); sky.renderOrder = -2; scene.add(sky); survivorOnly.push(sky);
  world.sky = sky;
  const flash = new THREE.DirectionalLight(0xc8d6ff, 0); flash.position.set(40, 120, 60); flash.target.position.set(AREA / 2, 0, AREA / 2);
  scene.add(flash, flash.target); survivorOnly.push(flash); world.flash = flash;

  // Grass tufts (instanced, swaying)
  const bladeTex = canvasTex(64, (g, s, r) => {
    g.clearRect(0, 0, s, s);
    for (let i = 0; i < 11; i++) {
      const x = 6 + r() * (s - 12), lean = (r() - 0.5) * 18, h = s * (0.45 + r() * 0.5), v = 50 + r() * 50;
      g.strokeStyle = `rgb(${v * 0.55},${v},${v * 0.45})`; g.lineWidth = 1.5 + r() * 1.5;
      g.beginPath(); g.moveTo(x, s); g.quadraticCurveTo(x + lean * 0.3, s - h * 0.6, x + lean, s - h); g.stroke();
    }
  });
  bladeTex.wrapS = bladeTex.wrapT = THREE.ClampToEdgeWrapping;
  const q1 = new THREE.PlaneGeometry(0.6, 0.5); q1.translate(0, 0.25, 0); const q2 = q1.clone(); q2.rotateY(Math.PI / 2);
  const grassMat = new THREE.MeshStandardMaterial({ map: bladeTex, alphaTest: 0.4, side: THREE.DoubleSide, color: 0x9db597, roughness: 1 });
  grassMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = atmo.uTime; sh.uniforms.uGust = atmo.uGust;
    sh.vertexShader = 'uniform float uTime;\nuniform float uGust;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n#ifdef USE_INSTANCING\n transformed.x += sin(uTime * 1.6 + instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.5) * (0.08 + uGust * 0.22) * position.y * 2.0;\n#endif');
  };
  const N = 6500, grass = new THREE.InstancedMesh(mergeGeometries([q1, q2]), grassMat, N), dummy = new THREE.Object3D();
  let n = 0;
  for (let i = 0; i < N * 4 && n < N; i++) {
    const x = FENCE + 0.5 + rng() * (AREA - FENCE * 2 - 1), z = FENCE + 0.5 + rng() * (AREA - FENCE * 2 - 1);
    if (keepClear(x, z, -1.2)) continue;
    dummy.position.set(x, heightAt(x, z) - 0.02, z); dummy.rotation.y = rng() * Math.PI; dummy.scale.setScalar(0.7 + rng() * 0.9); dummy.updateMatrix();
    grass.setMatrixAt(n++, dummy.matrix);
  }
  grass.count = n; grass.frustumCulled = false; grass.receiveShadow = true;
  scene.add(grass); survivorOnly.push(grass);

  // Fireflies along the creek and in the brush; embers over the campfire
  const ff = [];
  for (let i = 0; i < 170; i++) {
    let x, z;
    if (i % 2) { const b = BUSHES[Math.floor(rng() * BUSHES.length)] || [60, 60]; x = b[0] + (rng() - 0.5) * 5; z = b[1] + (rng() - 0.5) * 5; }
    else { const k = Math.floor(rng() * (CREEK.length - 1)), t = rng(); x = lerp(CREEK[k][0], CREEK[k + 1][0], t) + (rng() - 0.5) * 9; z = lerp(CREEK[k][1], CREEK[k + 1][1], t) + (rng() - 0.5) * 9; }
    ff.push(x, heightAt(x, z) + 0.5 + rng() * 1.5, z);
  }
  pointCloud(ff, 0xc8ff70, 0.11, 0);
  const em = [];
  for (let i = 0; i < 46; i++) em.push(CAMPFIRE.x + (rng() - 0.5) * 0.5, 0.5, CAMPFIRE.z + (rng() - 0.5) * 0.5);
  pointCloud(em, 0xff8a30, 0.09, 1);
  // Moving water
  if (world.water) {
    const wn = canvasTex(128, (g, s, r) => { for (let y = 0; y < s; y += 4) for (let x = 0; x < s; x += 4) { g.fillStyle = `rgb(${128 + (r() - 0.5) * 70},${128 + (r() - 0.5) * 70},255)`; g.fillRect(x, y, 4, 4); } });
    wn.colorSpace = THREE.NoColorSpace;
    world.water.material.normalMap = wn; world.water.material.normalScale = new THREE.Vector2(0.5, 0.5); world.waterN = wn;
  }
}
// The thing in the dark: what a survivor hears and sees as it gets close.
const scare = { clickT: 2, breathT: 0, chase: 0, chaseT: 0, lastSting: -99, howlT: 20 };
function updateScares(dt, d, mon) {
  // Lightning and thunder
  fx.nextLightning -= dt;
  if (fx.nextLightning <= 0 && viewMode === 'survivor' && game.phase === 'playing') {
    fx.nextLightning = 22 + Math.random() * 45; fx.lightning = 1;
    noise({ dur: 3.2, vol: 0.35, freq: 110, q: 0.4, type: 'lowpass', delay: 0.5 + Math.random() * 1.8 });
  }
  fx.lightning = Math.max(0, fx.lightning - dt * 2.2);
  const fl = fx.lightning > 0.02 ? fx.lightning * (0.55 + 0.45 * Math.sin(time * 47)) : 0;
  if (world.flash) world.flash.intensity = fl * 4;
  if (world.sky) world.sky.material.uniforms.uFlash.value = fl;
  survivorPost.pass.uniforms.uFlash.value = fl;
  if (world.waterN) world.waterN.offset.y -= dt * 0.12;

  if (me.isMonster || me.status !== 'alive' || !mon || mon.status !== 'alive' || game.phase !== 'playing') { if (!me.killCam) flashlight.intensity = 45; return; }
  const M = mon.avatar.userData.monster, pan = panOf(mon.pos), hiddenMon = M ? M.camo > 0.6 : false;
  // Wet clicking as it moves; breathing when it is very close
  scare.clickT -= dt;
  if (d < 22 && scare.clickT <= 0) { scare.clickT = 0.4 + Math.random() * 2.4 * (d / 22 + 0.15); sfx.clicks(distVol(mon.pos, 24) * 0.6, pan); }
  scare.breathT -= dt;
  if (d < 9 && scare.breathT <= 0) { scare.breathT = 2.3; sfx.breath(distVol(mon.pos, 10) * 0.6, pan); }
  // Pulse when it is charging you
  const chasing = mon.speed > 4.8 && d < 16;
  scare.chase = damp(scare.chase, chasing ? 1 : 0, chasing ? 4 : 0.7, dt);
  scare.chaseT -= dt;
  if (scare.chase > 0.3 && scare.chaseT <= 0) { scare.chaseT = 0.3; sfx.chase(scare.chase); }
  // A stab of sound the moment you actually see it up close
  if (d < 10 && !hiddenMon && time - scare.lastSting > 18) {
    camera.getWorldDirection(_v2); _fl.subVectors(mon.pos, camera.position).normalize();
    if (_v2.dot(_fl) > 0.6) { scare.lastSting = time; sfx.sting(); }
  }
  // Far-off howl: a rough bearing on where it is
  scare.howlT -= dt;
  if (scare.howlT <= 0) { scare.howlT = 30 + Math.random() * 40; if (d > 22) sfx.howl(0.12 + 0.3 * distVol(mon.pos, 150), pan); }
  // Your flashlight falters as it closes in (a warning, even when you can't see it)
  const near = clamp(1 - d / 11, 0, 1);
  if (!me.killCam) flashlight.intensity = 45 * (near > 0 ? (Math.random() < near * 0.22 ? 0.04 : 1 - near * 0.45 * Math.random()) : 1);
}

// ---- Sparks and smoke (survivor view only) -------------------------------------------
const fxGroup = new THREE.Group(); scene.add(fxGroup); survivorOnly.push(fxGroup);
const FX = [];
const sparkMat = new THREE.SpriteMaterial({ map: TEX.glow, color: 0xffc070, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
const smokeMat = new THREE.SpriteMaterial({ map: TEX.glow, color: 0x6a6a66, transparent: true, depthWrite: false, opacity: 0.35 });
function sparkBurst(x, y, z, n) {
  if (FX.length > 260) return;
  const gy = heightAt(x, z);
  for (let k = 0; k < n; k++) {
    const sp = new THREE.Sprite(sparkMat); sp.scale.setScalar(0.06 + Math.random() * 0.05); sp.position.set(x, gy + y, z); fxGroup.add(sp);
    FX.push({ o: sp, v: new THREE.Vector3((Math.random() - 0.5) * 5, 1.5 + Math.random() * 3.5, (Math.random() - 0.5) * 5), life: 0.4 + Math.random() * 0.6, g: 9.8, kind: 'spark' });
  }
}
function smokePuff(x, y, z, size) {
  if (FX.length > 260) return;
  const m = smokeMat.clone(), sp = new THREE.Sprite(m); sp.scale.setScalar(size * 0.5); sp.position.set(x, heightAt(x, z) + y, z); fxGroup.add(sp);
  FX.push({ o: sp, v: new THREE.Vector3((Math.random() - 0.5) * 0.3 + ENV.gust * 0.8, 0.8 + Math.random() * 0.4, (Math.random() - 0.5) * 0.3), life: 2.4, max: 2.4, g: -0.1, kind: 'smoke', size });
}
function updateFx(dt) {
  for (let i = FX.length - 1; i >= 0; i--) {
    const f = FX[i]; f.life -= dt;
    if (f.life <= 0) { fxGroup.remove(f.o); if (f.kind === 'smoke') f.o.material.dispose(); FX.splice(i, 1); continue; }
    f.v.y -= f.g * dt; f.o.position.addScaledVector(f.v, dt);
    if (f.kind === 'smoke') { const k = 1 - f.life / f.max; f.o.scale.setScalar(f.size * (0.5 + k * 1.8)); f.o.material.opacity = 0.3 * (1 - k); }
    else f.o.material.opacity = 1;
  }
}

let heartT = 0;
const monHeart = { t: 0 };
function updateWorld(dt, monsterDist, mon) {
  atmo.uTime.value = time; atmo.uGust.value = ENV.gust;
  updateAmbience();
  updateScares(dt, monsterDist, mon);
  // Firelight and cabin lamps flicker
  for (const l of world.flickers) {
    const k = l.kind === 'fire'
      ? 0.75 + Math.sin(time * 9 + l.phase) * 0.12 + Math.sin(time * 23.7) * 0.08 + Math.random() * 0.08
      : 0.9 + Math.sin(time * 31 + l.phase) * 0.04 + (Math.sin(time * 2.3 + l.phase) > 0.97 ? -0.5 : 0);
    const kk = l.kind === 'dying' ? k * (Math.sin(time * 1.7) > 0.2 ? (Math.random() < 0.85 ? 1 : 0.1) : 0.04) : k;
    l.light.intensity = l.base * kk;
    if (l.mat) l.mat.emissiveIntensity = 3 * kk;
  }
  if (world.search) {
    const a = time * 0.22, tx = TOWER.x + Math.cos(a) * 34, tz = TOWER.z + Math.sin(a) * 34;
    world.search.light.target.position.set(tx, 0, tz); world.search.cone.lookAt(tx, 0, tz);
  }
  if (world.truckLamp) world.truckLamp.emissiveIntensity = Math.sin(time * 0.9) > 0.6 ? 1.5 + Math.random() : 0.05;
  if (world.mist) { for (const w of world.mist) w.m.position.x = w.x + Math.sin(time * 0.07 + w.phase) * 2.5; if (world.mist[0]) world.mist[0].m.material.opacity = 0.5 + Math.sin(time * 0.2) * 0.1; }
  if (world.fire) world.fire.flames.forEach((f, i) => { f.scale.set(1, 0.8 + Math.sin(time * 11 + i * 2) * 0.25 + Math.random() * 0.1, 1); f.rotation.y = time * (1 + i); });
  // Generators
  const idle = { done: false, progress: 0 };
  const need = game.fixNeed || 2;
  world.gens.forEach((g, i) => {
    const s = game.mode === 'escape' && game.gens[i] ? game.gens[i] : idle;
    g.light.visible = game.mode === 'escape' && viewMode === 'survivor';
    const col = s.done ? 0x2bff6a : s.progress > 0 ? 0xffa020 : 0xff2200;
    g.lampMat.emissive.setHex(col); g.light.color.setHex(col);
    g.spark = Math.max(0, g.spark - dt);
    g.light.intensity = s.done ? 4 : g.spark > 0 ? (Math.random() < 0.5 ? 9 : 0.3) : 2.5 + Math.sin(time * 6) * 0.5;
    const fixes = Math.round(s.progress * need);
    g.leds.forEach((led, k) => {
      led.visible = k < need && game.mode === 'escape';
      led.material.emissive.setHex(k < fixes ? 0x2bff6a : (pipe.open && pipe.gen === i && k === fixes && Math.sin(time * 8) > 0) ? 0xffa020 : 0x401008);
      led.material.emissiveIntensity = k < fixes ? 2.5 : 1.2;
    });
    if (g.spark > 0 && Math.random() < dt * 14) sparkBurst(g.pos.x + (Math.random() - 0.5) * 0.6, 1.0 + Math.random() * 0.4, g.pos.z + (Math.random() - 0.5) * 0.6, 4);
    // Exhaust: a running generator puffs steadily; a restored circuit makes it cough once
    g.cough = Math.max(0, g.cough - dt);
    g.puffT -= dt;
    if ((s.done && g.puffT <= 0) || (g.cough > 0.5 && g.puffT <= 0)) {
      const ry = GENS[i].ry; g.puffT = s.done ? 0.45 : 0.12;
      smokePuff(g.pos.x + 0.5 * Math.cos(ry) + 0.3 * Math.sin(ry), 1.9, g.pos.z - 0.5 * Math.sin(ry) + 0.3 * Math.cos(ry), s.done ? 0.5 : 0.8); // from the exhaust pipe
    }
    const running = s.done;
    g.shake = Math.max(0, g.shake - dt);
    g.group.position.x = g.pos.x + (running ? Math.sin(time * 60) * 0.006 : 0) + Math.sin(time * 80) * g.shake * 0.04;
  });
  updateFx(dt);
  updatePowerLines();
  if (world.sawBlade) world.sawBlade.rotation.y += dt * (game.mode === 'escape' && game.gens[4]?.done ? 14 : 0);
  // Gate
  // Relics hover and turn until taken; the altar's runes brighten as they're found.
  (world.relics || []).forEach((g, i) => {
    if (!g) return;
    g.visible = !game.gens[i]?.done;
    g.userData.spin[0].rotation.y = time * 1.2; g.userData.spin[0].position.y = 1.15 + Math.sin(time * 2 + i) * 0.05;
    g.userData.spin[1].rotation.x = time * 0.9; g.userData.spin[1].rotation.y = time * 0.5;
  });
  if (world.altar) {
    const n = OBJ.filter((o) => o.kind === 'relic').length, a = OBJ.filter((o, i) => o.kind === 'relic' && game.gens[i]?.done).length;
    const k = game.mode === 'ritual' && game.phase === 'playing' && n ? a / n : 0;
    world.altar.emissiveIntensity = k * (k >= 1 ? 3 + Math.sin(time * 5) : 1.2);
  }
  // Gate slides aside when all generators are running
  if (world.gate) world.gate.mesh.position.x = damp(world.gate.mesh.position.x, world.gate.x0 + (game.gateOpen ? GATE.w + 0.2 : 0), 0.8, dt);
  if (world.exitLight) world.exitLight.color.setHex(game.gateOpen ? 0x2cff70 : 0xff2a10);

  // Post-process uniforms
  const sp = monsterPost.pass.uniforms; sp.uTime.value = time; sp.uPulse.value = Math.max(0, sp.uPulse.value - dt * 1.5);
  sp.uShock.value = Math.max(0, sp.uShock.value - dt * 1.1);
  sp.uGlitch.value = Math.max(0, sp.uGlitch.value - dt * 2.2);
  sp.uGal.value = me.isMonster && me.status === 'alive' ? (me.gal || 0) : 0;
  // Its heartbeat: slow while it stalks, racing when it charges
  monHeart.t += dt * (me.isMonster ? lerp(0.9, 2.3, me.gal || 0) : 0.9);
  const hp = monHeart.t % 1;
  sp.uBeat.value = Math.exp(-hp * 9) + (hp > 0.2 ? 0.6 * Math.exp(-(hp - 0.2) * 11) : 0);
  const vp = survivorPost.pass.uniforms; vp.uTime.value = time; vp.uDamage.value = me.damage * 0.8;
  vp.uLowHp.value = !me.isMonster && me.status === 'alive' && me.hp === 1 ? 1 : 0;
  vp.uFear.value = !me.isMonster && me.status === 'alive' ? clamp(1 - monsterDist / 14, 0, 1) : 0;

  // Heartbeat proximity cue
  if (!me.isMonster && me.status === 'alive' && monsterDist < 24) {
    heartT -= dt;
    if (heartT <= 0) { heartT = lerp(0.42, 1.3, monsterDist / 24); sfx.heartbeat(lerp(0.55, 0.08, monsterDist / 24)); }
  }
}
function updateHUD() {
  $('#hud-timer').textContent = fmtTime(game.timeLeft);
  const count = (kind) => [OBJ.filter((o, i) => o.kind === kind && game.gens[i]?.done).length, OBJ.filter((o) => o.kind === kind).length];
  let objective;
  if (game.mode === 'ritual') { const [a, n] = count('relic'); objective = a < n ? `Relics ${a}/${n}` : 'BANISH IT AT THE STONE CIRCLE'; }
  else if (game.mode === 'survive') objective = 'Survive until dawn';
  else { const [a] = count('gen'); objective = game.gateOpen ? 'EXIT GATE OPEN' : `Generators ${a}/${ESCAPE_NEED}`; }
  $('#hud-objective').textContent = objective;
  let prompt = '';
  if (me.status !== 'alive' && !me.isMonster && !me.killCam) prompt = `Spectating · WASD fly · Space/C up/down · V ${viewMode === 'monster' ? 'normal' : 'monster'} vision`;
  if (me.isMonster) {
    $('#sonar-fill').style.width = `${(1 - me.sonarCD / CFG.SONAR_CD) * 100}%`;
    $('#attack-fill').style.width = `${(1 - me.attackCD / CFG.ATTACK_CD) * 100}%`;
    $('#mstamina-fill').style.width = `${me.stamina * 100}%`;
    $('#camo-fill').style.width = `${(me.camo || 0) * 100}%`;
    $('#camo-label').textContent = (me.camo || 0) > 0.95 ? 'Hidden' : 'Camouflage';
    let prey = 0; for (const r of players.values()) if (!r.isMonster && r.status === 'alive') prey++;
    $('#prey-count').textContent = prey;
  } else {
    $('#hp-pips').innerHTML = Array.from({ length: CFG.MAX_HP }, (_, i) => `<span class="${i < me.hp ? 'on' : ''}"></span>`).join('');
    $('#stamina-fill').style.width = `${me.stamina * 100}%`;
    $('#stamina-fill').style.background = me.exhausted ? '#ff3b3b' : '';
    // The bar shows what the monster actually hears, after the surroundings mask it.
    const heard = heardNoise(me.noise, me.crouch && !me.repairing, me.pos.x, me.pos.z);
    $('#noise-fill').style.width = `${heard * 100}%`;
    $('#stone-count').textContent = me.stones ?? 0;
    $('#breath-row').classList.toggle('hidden', !(me.hidden >= 0 || me.hideT > 0.2));
    $('#breath-fill').style.width = `${(1 - (me.hideT || 0) / HIDE_MAX) * 100}%`;
    if (me.status === 'alive') {
      const verb = { gen: ['Repairing', 'Hold E to repair'], relic: ['Taking the relic', 'Hold E to take the relic'], altar: ['Banishing', 'Hold E to begin the banishing'] };
      if (me.hidden >= 0) prompt = 'Hidden. Hold your breath. E to step out.';
      else if (pipe.open) prompt = '';
      else if (me.repairGen >= 0 && OBJ[me.repairGen].kind === 'gen') {
        const need = game.fixNeed || 2, done = Math.round(game.gens[me.repairGen].progress * need);
        prompt = game.gateOpen ? 'The gate already has power. Get out!' : `Press E to wire the generator — circuits ${done}/${need}`;
      } else if (me.repairGen >= 0) prompt = `${verb[OBJ[me.repairGen].kind][me.repairing ? 0 : 1]} — ${Math.floor(game.gens[me.repairGen].progress * 100)}%`;
      else if (nearLocker() >= 0) prompt = me.hideCD > 0 ? `Catching your breath (${Math.ceil(me.hideCD)}s)` : 'Press E to hide';
      else if (game.gateOpen && !inExit(me.pos.x, me.pos.z)) prompt = 'The gate is open: get to the road south of the camp.';
    }
  }
  $('#prompt').textContent = prompt;
}
function addFeed(text, cls = '') {
  const d = document.createElement('div'); d.textContent = text; d.className = cls;
  const f = $('#feed'); f.prepend(d);
  while (f.children.length > 6) f.lastChild.remove();
  setTimeout(() => d.remove(), 6500);
}

// Lobby backdrop: slow orbit over the facility in monster vision, random pings
let lobbyPingT = 0;
function updateLobbyCamera(dt) {
  const cx = AREA / 2, cz = AREA / 2;
  const a = time * 0.05;
  camera.position.set(cx + Math.cos(a) * 70, 55, cz + Math.sin(a) * 60);
  camera.lookAt(cx, 0, cz);
  lobbyPingT -= dt;
  if (lobbyPingT <= 0) {
    lobbyPingT = 0.35 + Math.random() * 0.6;
    const t = randomFloorTile();
    const p = tileCenter(t.x, t.z);
    const n = Math.random();
    addRipple(p.setY(0.05), 4 + n * 14, 0.4 + n);
  }
  monsterPost.pass.uniforms.uTime.value = time;
}

// ----------------------------------------------------------------------------
//  UI WIRING
// ----------------------------------------------------------------------------
function showScreen(which) {
  $('#menu').classList.toggle('hidden', which !== 'menu');
  $('#hud').classList.toggle('hidden', which !== 'hud');
  $('#endscreen').classList.toggle('hidden', which !== 'end');
  if (which !== 'hud') { $('#resume').classList.add('hidden'); sonarHud.classList.add('hidden'); } else updateResumeOverlay();
}
function menuStatus(text, err) { const s = $('#menu-status'); s.textContent = text; s.classList.toggle('err', !!err); }
function fatal(msg) { game.phase = 'menu'; unlockPointer(); $('#fatal-msg').textContent = msg; $('#fatal').classList.remove('hidden'); }
const STORE = 'blindsight:'; // every storage key carries the app's prefix (shared-origin hosts)
function readName() { me.name = ($('#name-input').value.trim() || 'Survivor').slice(0, 16); try { localStorage.setItem(STORE + 'name', me.name); } catch (e) { /* storage unavailable */ } }
try { $('#name-input').value = localStorage.getItem(STORE + 'name') || ''; } catch (e) { /* storage unavailable */ }

$('#btn-host').onclick = () => { initAudio(); readName(); hostCreate(false); };
$('#btn-offline').onclick = () => { quickRole = null; initAudio(); readName(); hostCreate(true); };
$('#btn-join').onclick = () => { initAudio(); readName(); joinRoom($('#code-input').value); };
$('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
// Invite link: opening it fills in the room and joins straight away.
const inviteLink = () => location.origin + location.pathname + location.search + '#join=' + net.code;
function copyText(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = t; }, 1500); };
  const fallback = () => { const i = document.createElement('input'); i.value = text; document.body.appendChild(i); i.select(); try { document.execCommand('copy'); done(); } catch (e) { /* select-only fallback */ } i.remove(); };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
}
$('#btn-copy').onclick = () => copyText(net.code, $('#btn-copy'));
$('#btn-invite').onclick = () => copyText(inviteLink(), $('#btn-invite'));
$('#btn-start').onclick = () => { initAudio(); hostStart(); };
$('#btn-random-monster').onclick = () => { const humans = Object.values(hs.players).filter((p) => !p.isBot); setMonster(humans[Math.floor(Math.random() * humans.length)].id); };
let botN = 1;
function addBot(isMonster) {
  if (isMonster) for (const p of Object.values(hs.players)) p.isMonster = false; // only one monster
  const id = 'bot-' + botN;
  hs.players[id] = newHostPlayer(id, isMonster ? 'The Stalker' : 'Bot ' + botN, isMonster, true);
  botN++;
}
$('#btn-add-bot').onclick = () => { addBot(false); broadcastLobby(); };
$('#btn-add-bot-monster').onclick = () => { addBot(true); broadcastLobby(); };
// Quick play: an offline match against bots, starting straight away.
let quickRole = null; // role of the last vs-bot match, for Rematch
function playVsBots(asMonster) {
  quickRole = asMonster;
  initAudio(); readName();
  hostCreate(true);
  hs.players[me.id].isMonster = asMonster;
  if (asMonster) { addBot(false); addBot(false); } else addBot(true);
  hostStart();
}
$('#btn-bot-survivor').onclick = () => playVsBots(false);
$('#btn-bot-monster').onclick = () => playVsBots(true);
$('#btn-clear-bots').onclick = () => { for (const p of Object.values(hs.players)) if (p.isBot) delete hs.players[p.id]; broadcastLobby(); };
$('#btn-lobby').onclick = () => hostBackToLobby();
// Offline only: drop back to the main menu without a page reload.
function backToMenu() {
  leaveMatch();
  game.phase = 'menu'; net.isHost = false; net.offline = false; quickRole = null; $('#mode-select').disabled = false;
  hs.phase = 'lobby'; hs.players = {};
  clearRipples(); setViewMode('monster'); startDrone(null);
  showScreen('menu');
  $('#menu-main').classList.remove('hidden'); $('#menu-lobby').classList.add('hidden');
}
$('#btn-menu').onclick = backToMenu;
function showModeDesc() { $('#mode-desc').textContent = MODES[$('#mode-select').value]?.desc || ''; }
$('#mode-select').onchange = () => { showModeDesc(); if (net.isHost && hs.phase === 'lobby' && game.phase === 'lobby') broadcastLobby(); };
showModeDesc();
$('#btn-lobby-menu').onclick = backToMenu;
$('#btn-rematch').onclick = () => playVsBots(quickRole);

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  for (const p of [monsterPost, survivorPost]) p.comp.setSize(window.innerWidth, window.innerHeight);
  monsterPost.pass.uniforms.uRes.value.set(window.innerWidth, window.innerHeight);
});
monsterPost.pass.uniforms.uRes.value.set(window.innerWidth, window.innerHeight);


// ----------------------------------------------------------------------------
//  MAIN LOOP
// ----------------------------------------------------------------------------
buildWorld();
monsterSky.position.set(AREA / 2, 0, AREA / 2); scene.add(monsterSky);
setViewMode('monster');

// Embedded pages (the Claude artifact build) can't use WebRTC, so hide online play there.
const EMBEDDED = !!window.BLINDSIGHT_EMBED;
if (EMBEDDED) { $('#online-group').classList.add('hidden'); $('#embed-note').classList.remove('hidden'); $('#online-link').href = ONLINE_URL; }
const inviteCode = (location.hash.match(/join=([A-Za-z0-9]{4,6})/) || [])[1];
if (inviteCode && !EMBEDDED) $('#code-input').value = inviteCode.toUpperCase();
loadAssets((f) => menuStatus(`Loading models… ${Math.round(f * 100)}%`)).finally(() => {
  menuStatus(ASSETS.survivor && ASSETS.monster ? '' : 'Some models failed to load; using simple stand-ins.', !(ASSETS.survivor && ASSETS.monster));
  buildBridges(mulberry32(77));
  setupViewBody();
  for (const id of ['#btn-bot-survivor', '#btn-bot-monster', '#btn-host', '#btn-offline', '#btn-join']) $(id).disabled = false;
  if (inviteCode && !EMBEDDED) {
    history.replaceState(null, '', location.pathname + location.search); // don't rejoin on refresh
    readName(); joinRoom(inviteCode);
  }
});

const DEBUG = { dtScale: 1 }; // set to 0 from the console to freeze the simulation
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05) * DEBUG.dtScale;
  time += dt;
  sonarShared.uTime.value = time;

  if (game.phase === 'playing' || game.phase === 'ended') {
    if (game.phase === 'playing') updateLocal(dt);
    const { monsterDist, mon } = updateRemotes(dt);
    updateViewBody(dt); updateHands(dt); updatePipe(dt);
    updateWorld(dt, monsterDist, mon);
    if (net.isHost) hostUpdate(dt);
    if (game.phase === 'playing') { sendState(dt); updateHUD(); }
    drawSonarHud();
  } else {
    updateLobbyCamera(dt);
    updateWorld(dt, Infinity, null);
  }

  sonarShared.uCamPos.value.copy(camera.position);
  (viewMode === 'monster' ? monsterPost : survivorPost).comp.render(dt);
}
animate();

// Debug handle for the console
window.BLINDSIGHT = { CFG, game, me, players, hs, net, setViewMode, addRipple, ASSETS, THREE, renderer, scene, camera, viewBody, LOCKERS, nearLocker, ENV, heardNoise, ambientMask, hostUpdate, hostAttack, DEBUG, KILL, heightAt, POLES, world, pipe, checkPipeSolved, MAT, monsterPost, step: (dt) => { time += dt; hostUpdate(dt); }, nav: { bfsPath, tileOf, tileCenter, navOpen, genApproach, navBlocked, NAV_W } };
