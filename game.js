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
  SPEED: { crouch: 1.8, walk: 3.4, sprint: 6.0, monster: 4.6, monsterSprint: 6.4 },
  NOISE: { crouch: 0.15, walk: 0.5, sprint: 1.0, repair: 0.55 },
  ATTACK_RANGE: 2.6,
  ATTACK_CD: 1.2,
  SONAR_CD: 10,
  HIT_INVULN: 1.5,
  MAX_HP: 2,
  MAX_RIPPLES: 48,
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
  // x/z = centre, w (x) by d (z) metres, door side, optional interior wall
  { x: 38, z: 40, w: 10, d: 8, door: 'south', split: true },
  { x: 88, z: 68, w: 8, d: 7, door: 'west' },
  { x: 28, z: 86, w: 5, d: 4.4, door: 'east' },
];
const GENS = [
  { x: 34.6, z: 38.4, ry: Math.PI / 2 },   // main cabin, west room
  { x: 90, z: 66.4, ry: 0 },               // hunting cabin
  { x: 26.8, z: 86, ry: Math.PI / 2 },     // shed
];
const CAMPFIRE = { x: 58, z: 96 };
const SPAWN_SURV = [[54, 99], [62, 99], [58, 101.5], [55, 93], [61, 93], [58, 90.5]];
const SPAWN_MON = { x: 98, z: 18 };
const PATHS = [
  [[60, AREA + 14], [60, 112], [59, 104], [58, 96]],
  [[58, 96], [53, 80], [46, 62], [40, 50], [38, 45]],
  [[58, 96], [70, 86], [80, 74], [83.5, 68]],
  [[58, 96], [44, 92], [31, 86]],
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
const genPos = (i) => new THREE.Vector3(GENS[i].x, 0, GENS[i].z);
// A free nav cell beside each generator, on its working side.
const genApproach = (i) => nearestOpen(tileOf(GENS[i].x + Math.sin(GENS[i].ry) * 1.2, GENS[i].z + Math.cos(GENS[i].ry) * 1.2), false) || tileOf(GENS[i].x, GENS[i].z);

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
const survivorFog = new THREE.FogExp2(0x101722, 0.024);
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
const SONAR_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCamPos;
  uniform vec4 uRip[MAXR];
  uniform vec3 uRipP[MAXR];
  uniform float uBase;      // ambient visibility of this surface (env is barely visible)
  uniform float uGain;      // how strongly ripples light this surface
  uniform float uGrid;      // grid cell size in metres
  uniform float uNearGain;  // faint "touch" sense right around the monster
  uniform vec3 uColor;
  uniform float uSelf;      // 1 = this surface's own look; 0 = indistinguishable from the environment
  varying vec3 vWorld;
  varying vec3 vNormalW;

  float gridLine(vec2 c) {
    vec2 d = fwidth(c);
    vec2 g = abs(fract(c - 0.5) - 0.5) / max(d, vec2(1e-4));
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 an = abs(n);
    // Triplanar-ish projection: pick the plane most aligned with the surface.
    vec2 uv = an.y > 0.5 ? vWorld.xz : (an.x > an.z ? vWorld.zy : vWorld.xy);
    float grid = mix(1.0, uGrid, uSelf);
    float minor = gridLine(uv / grid) * 0.65;
    float major = gridLine(uv / (grid * 4.0));
    float lines = max(minor, major);

    // Accumulate expanding spherical shells from every active ripple.
    float energy = 0.0;
    for (int i = 0; i < MAXR; i++) {
      vec4 r = uRip[i];
      vec3 p = uRipP[i];
      float age = uTime - r.w;
      if (age < 0.0 || p.y <= 0.0) continue;
      float rad = age * p.z;
      if (rad > p.x) continue;
      float d = distance(vWorld, r.xyz);
      float w = 0.3 + rad * 0.06;
      float ring = exp(-pow((d - rad) / w, 2.0));
      float fill = (1.0 - smoothstep(0.0, rad + 0.001, d)) * 0.08;
      float fade = 1.0 - rad / p.x;
      fade *= fade;
      energy += (ring + fill) * fade * p.y;
    }

    float dc = distance(vWorld, uCamPos);
    float base = mix(0.05, uBase, uSelf) * (1.0 - smoothstep(8.0, 45.0, dc));
    float near = (1.0 - smoothstep(0.0, 5.0, dc)) * mix(0.22, uNearGain, uSelf);
    float I = base + energy * mix(1.0, uGain, uSelf) + near;

    vec3 V = normalize(uCamPos - vWorld);
    float fres = pow(1.0 - abs(dot(V, n)), 2.5);
    vec3 col = mix(vec3(0.169, 1.0, 0.478), uColor, uSelf) * (lines * I * 1.8 + I * 0.025 + fres * I * 0.22);
    gl_FragColor = vec4(col, 1.0);
  }`;
function makeSonarMaterial({ base, gain, grid, near, color }) {
  return new THREE.ShaderMaterial({
    defines: { MAXR: CFG.MAX_RIPPLES },
    uniforms: Object.assign({}, sonarShared, {
      uBase: { value: base }, uGain: { value: gain }, uGrid: { value: grid },
      uNearGain: { value: near }, uColor: { value: new THREE.Color(color) }, uSelf: { value: 1 },
    }),
    vertexShader: SONAR_VERT,
    fragmentShader: SONAR_FRAG,
  });
}
const ENTITY_SONAR = { base: 0.0, gain: 2.6, grid: 0.2, near: 0.35, color: 0x9bffc4 };
const SONAR_MATS = {
  env: makeSonarMaterial({ base: 0.05, gain: 1.0, grid: 1.0, near: 0.22, color: 0x2bff7a }),
  gen: makeSonarMaterial({ base: 0.35, gain: 1.0, grid: 0.25, near: 0.3, color: 0xb4ff3b }),   // objectives faintly visible
  entity: makeSonarMaterial({ base: 0.0, gain: 2.6, grid: 0.2, near: 0.35, color: 0x9bffc4 }), // players: ONLY visible via noise
};

// Ripple ring buffer
let rippleIdx = 0;
function addRipple(pos, maxR, strength, speed) {
  const i = rippleIdx; rippleIdx = (rippleIdx + 1) % CFG.MAX_RIPPLES;
  sonarShared.uRip.value[i].set(pos.x, pos.y, pos.z, time);
  sonarShared.uRipP.value[i].set(maxR, strength, speed || Math.max(7, maxR / 1.2));
}
function clearRipples() { for (const v of sonarShared.uRip.value) v.w = -999; }

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
  scene.fog = mon ? null : survivorFog;
  scene.background = new THREE.Color(mon ? 0x000000 : 0x101722);
  flashlight.visible = !mon && flashlightOn;
}

// ----------------------------------------------------------------------------
//  POST-PROCESSING
// ----------------------------------------------------------------------------
const SonarPostShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2() }, uPulse: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes; uniform float uPulse;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      vec2 uv = 0.5 + c * (1.0 + 0.07 * dot(c, c));       // CRT barrel
      float ab = 0.0015 + uPulse * 0.004;                   // chromatic split
      vec3 col;
      col.r = texture2D(tDiffuse, uv + vec2(ab, 0.0)).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - vec2(ab, 0.0)).b;
      float scan = 0.82 + 0.18 * sin(uv.y * uRes.y * 1.3 + uTime * 6.0);
      col *= scan;
      col += vec3(0.0, 0.035, 0.015) * hash(uv * (uTime + 1.0));
      float vig = smoothstep(0.85, 0.2, length(c));
      col *= vig;
      col += vec3(0.0, 0.18, 0.08) * uPulse * (1.0 - vig * 0.5);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);
      gl_FragColor = vec4(col, 1.0);
    }`,
};
const SurvivorPostShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uDamage: { value: 0 }, uLowHp: { value: 0 }, uFear: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uDamage; uniform float uLowHp; uniform float uFear;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      vec2 uv = vUv + c * uFear * 0.01 * sin(uTime * 7.0);
      vec3 col = texture2D(tDiffuse, uv).rgb;
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
function buildComposer(passShader, bloom) {
  const comp = new EffectComposer(renderer);
  comp.addPass(new RenderPass(scene, camera));
  let bloomPass = null;
  if (bloom) { bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.85, 0.5, 0.03); comp.addPass(bloomPass); }
  const pass = new ShaderPass(passShader);
  comp.addPass(pass);
  comp.addPass(new OutputPass());
  return { comp, pass, bloomPass };
}
const monsterPost = buildComposer(SonarPostShader, true);
const survivorPost = buildComposer(SurvivorPostShader, false);

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
const world = { gens: [], gate: null, flickers: [], exitLight: null, fire: null };
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
// Somewhere a tree/rock may not go: cabins, camp, generators, paths, gate and road.
function keepClear(x, z, extra = 0) {
  for (const c of CABINS) if (Math.abs(x - c.x) < c.w / 2 + 3 + extra && Math.abs(z - c.z) < c.d / 2 + 3 + extra) return true;
  if (Math.hypot(x - CAMPFIRE.x, z - CAMPFIRE.z) < 10 + extra) return true;
  if (Math.hypot(x - SPAWN_MON.x, z - SPAWN_MON.z) < 3) return true;
  if (nearPath(x, z, 2.3 + extra)) return true;
  if (Math.abs(x - GATE.x) < 7 && z > AREA - 12) return true;
  if (x > EXIT_ZONE.minX - 3 && x < EXIT_ZONE.maxX + 3 && z > AREA - 4) return true;
  if (Math.abs(x - FENCE) < 1.5 || Math.abs(x - (AREA - FENCE)) < 1.5 || Math.abs(z - FENCE) < 1.5 || Math.abs(z - (AREA - FENCE)) < 1.5) return true;
  return false;
}

function buildTree(rng, x, z, inside) {
  const h = 7 + rng() * 7, r = 0.18 + rng() * 0.22, dead = rng() < 0.08;
  const trunk = new THREE.CylinderGeometry(r * 0.55, r, h, 7, 1); trunk.translate(x, h / 2, z);
  addToChunk('bark', trunk, x, z);
  if (!dead) {
    const layers = 3 + Math.floor(rng() * 2), base = h * (0.25 + rng() * 0.1);
    for (let i = 0; i < layers; i++) {
      const t = i / layers, cr = (1.0 - t * 0.7) * (1.6 + rng() * 0.9), ch = (h - base) / layers * 1.9;
      const cone = new THREE.ConeGeometry(cr, ch, 8, 1); cone.rotateY(rng() * 3); cone.translate(x, base + t * (h - base) + ch / 2, z);
      addToChunk('needles', cone, x, z);
    }
  } else {
    for (let i = 0; i < 3; i++) { // bare broken branches
      const b = new THREE.CylinderGeometry(0.03, 0.06, 1.4 + rng(), 4); b.rotateZ(0.9 + rng() * 0.5); b.rotateY(rng() * 6.28); b.translate(x, h * (0.45 + i * 0.15), z);
      addToChunk('bark', b, x, z);
    }
  }
  if (inside) addCircle(x, z, r + 0.08, 'tree');
}

function buildCabin(c, i) {
  const H = 2.7, T = 0.3, DOOR = 1.6, x0 = c.x - c.w / 2, x1 = c.x + c.w / 2, z0 = c.z - c.d / 2, z1 = c.z + c.d / 2;
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
  wallX(z0, x0, x1, c.door === 'north' ? c.x : null);
  wallX(z1, x0, x1, c.door === 'south' ? c.x : null);
  wallZ(x0, z0, z1, c.door === 'west' ? c.z : null);
  wallZ(x1, z0, z1, c.door === 'east' ? c.z : null);
  if (c.split) wallZ(c.x - 1, z0, z1, c.z + 0.6);          // interior wall (west of the front door) with a doorway
  const wallGeos = [];
  for (const [a, b, cc, d, kind] of walls) {
    const lintel = kind === 'lintel', hh = lintel ? H - 2.1 : H;
    const geo = new THREE.BoxGeometry(cc - a, hh, d - b);
    geo.translate((a + cc) / 2, lintel ? 2.1 + hh / 2 : hh / 2, (b + d) / 2);
    wallGeos.push(geo);
    if (!lintel) addBox(a, b, cc, d, 'wall');
  }
  const wallMesh = new THREE.Mesh(mergeGeometries(wallGeos), stdMat({ map: TEX.logs }));
  wallMesh.castShadow = wallMesh.receiveShadow = true;
  g.add(wallMesh);
  // Floor, gable roof and gable ends
  const floor = new THREE.Mesh(new THREE.BoxGeometry(c.w, 0.12, c.d), stdMat({ map: TEX.planks })); floor.position.set(c.x, 0.06, c.z); floor.receiveShadow = true;
  g.add(floor);
  const ridgeH = 1.6, over = 0.5, slope = Math.hypot(c.d / 2 + over, ridgeH);
  const roofMat = stdMat({ map: TEX.roof, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(c.w + over * 2, 0.12, slope), roofMat);
    r.position.set(c.x, H + ridgeH / 2, c.z + s * (c.d / 4 + over / 2)); r.rotation.x = s * Math.atan2(ridgeH, c.d / 2 + over);
    r.castShadow = true; g.add(r);
  }
  const gable = new THREE.Shape([new THREE.Vector2(-c.d / 2, 0), new THREE.Vector2(c.d / 2, 0), new THREE.Vector2(0, ridgeH)]);
  for (const s of [-1, 1]) {
    const ge = new THREE.Mesh(new THREE.ShapeGeometry(gable), stdMat({ map: TEX.logs, side: THREE.DoubleSide }));
    ge.rotation.y = Math.PI / 2; ge.position.set(c.x + s * c.w / 2, H, c.z); g.add(ge);
  }
  // Glowing windows on the long walls and a warm lamp inside
  const winMat = new THREE.MeshStandardMaterial({ color: 0x1a1006, emissive: 0xffa040, emissiveIntensity: 1.6 });
  for (const s of [-1, 1]) for (const fx of [-0.28, 0.28]) {
    if (c.door === (s < 0 ? 'north' : 'south') && Math.abs(fx) < 0.1) continue;
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.6), winMat);
    win.position.set(c.x + fx * c.w, 1.5, c.z + s * (c.d / 2 + T / 2 + 0.01)); win.rotation.y = s < 0 ? Math.PI : 0;
    g.add(win);
  }
  const lamp = new THREE.PointLight(0xffa860, 6, 9, 1.6); lamp.position.set(c.x + (c.split ? -c.w / 4 - 0.3 : 0), 2.2, c.z);
  g.add(lamp); survivorOnly.push(lamp);
  world.flickers.push({ light: lamp, base: 6, phase: i * 13.7, kind: 'lamp' });
  // Furniture (colliders too)
  const furn = [];
  if (c.split) { furn.push([c.x + 2.5, c.z - 2.2, 1.6, 0.8, 0.8]); furn.push([c.x + 3.6, c.z + 2.4, 1.0, 0.6, 1.9]); }
  else if (c.w > 6) furn.push([c.x - 2.2, c.z - 2.0, 1.2, 0.8, 0.8]);
  for (const [fx, fz, fw, fh, fd] of furn) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, fd), stdMat({ map: TEX.crate })); m.position.set(fx, fh / 2, fz); m.castShadow = true;
    g.add(m); addBox(fx - fw / 2, fz - fd / 2, fx + fw / 2, fz + fd / 2, 'furniture');
  }
  scene.add(reg(g));
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
  scene.add(g);
  // Footprint: 1.3 x 0.9 m, rotated with the generator
  const hx = Math.abs(Math.cos(G.ry)) * 0.65 + Math.abs(Math.sin(G.ry)) * 0.45, hz = Math.abs(Math.sin(G.ry)) * 0.65 + Math.abs(Math.cos(G.ry)) * 0.45;
  addBox(G.x - hx, G.z - hz, G.x + hx, G.z + hz, 'gen');
  world.gens.push({ group: g, lampMat, light, pos: genPos(i), shake: 0 });
}

function buildWorld() {
  const rng = mulberry32(1337);
  MAT.bark = stdMat({ map: TEX.bark });
  MAT.needles = stdMat({ map: TEX.needles, color: 0x9fb39f });
  MAT.rock = stdMat({ map: TEX.rock, roughness: 0.95 });
  MAT.bush = stdMat({ map: TEX.needles, color: 0x6f8a62 });
  MAT.fence = stdMat({ map: TEX.planks, color: 0x8a8070 });

  // Ground and dirt paths
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND, GROUND), stdMat({ map: TEX.ground, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(AREA / 2, 0, AREA / 2); ground.receiveShadow = true;
  scene.add(reg(ground));
  const pathMat = stdMat({ map: TEX.path, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const p of PATHS) for (let i = 0; i < p.length - 1; i++) {
    const [ax, az] = p[i], [bx, bz] = p[i + 1], len = Math.hypot(bx - ax, bz - az);
    const seg = new THREE.Mesh(new THREE.PlaneGeometry(2.6, len + 2.4), pathMat);
    seg.rotation.x = -Math.PI / 2; seg.rotation.z = -Math.atan2(bx - ax, bz - az);
    seg.position.set((ax + bx) / 2, 0.012 + i * 0.001, (az + bz) / 2); seg.receiveShadow = true;
    scene.add(reg(seg));
  }

  // Cabins and generators
  CABINS.forEach(buildCabin);
  GENS.forEach((_, i) => buildGenerator(i));

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
  for (let i = 0, n = 0; i < 400 && n < 28; i++) {
    const x = 6 + rng() * (AREA - 12), z = 6 + rng() * (AREA - 12);
    if (keepClear(x, z) || tooClose(x, z, 2.5)) continue;
    const r = 0.5 + rng() * 0.9, geo = new THREE.DodecahedronGeometry(r, 0);
    geo.scale(1, 0.55 + rng() * 0.3, 1); geo.rotateY(rng() * 6); geo.translate(x, r * 0.3, z);
    addToChunk('rock', geo, x, z); addCircle(x, z, r * 0.95, 'rock'); n++;
  }
  for (let i = 0, n = 0; i < 400 && n < 14; i++) {
    const x = 6 + rng() * (AREA - 12), z = 6 + rng() * (AREA - 12), a = rng() * Math.PI, len = 4 + rng() * 4;
    const ex = Math.cos(a) * len / 2, ez = Math.sin(a) * len / 2;
    if (keepClear(x, z) || keepClear(x + ex, z + ez) || keepClear(x - ex, z - ez) || tooClose(x, z, 3)) continue;
    const geo = new THREE.CylinderGeometry(0.3, 0.38, len, 8); geo.rotateZ(Math.PI / 2); geo.rotateY(-a); geo.translate(x, 0.33, z);
    addToChunk('bark', geo, x, z);
    for (const t of [-0.4, 0, 0.4]) addCircle(x + Math.cos(a) * len * t, z + Math.sin(a) * len * t, 0.42, 'log');
    n++;
  }
  for (let i = 0, n = 0; i < 2000 && n < 160; i++) {
    const x = 4 + rng() * (AREA - 8), z = 4 + rng() * (AREA - 8);
    if (keepClear(x, z, -1.5)) continue;
    for (let k = 0; k < 3; k++) {
      const r = 0.45 + rng() * 0.4, geo = new THREE.IcosahedronGeometry(r, 0);
      geo.scale(1.2, 0.75, 1.2); geo.translate(x + (rng() - 0.5) * 1.2, r * 0.55, z + (rng() - 0.5) * 1.2);
      addToChunk('bush', geo, x, z);
    }
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
  const moonLight = new THREE.DirectionalLight(0xa9bde0, 1.6); moonLight.position.set(-60, 100, -80); moonLight.target.position.set(AREA / 2, 0, AREA / 2);
  scene.add(moonLight, moonLight.target); survivorOnly.push(moonLight);
  scene.add(new THREE.HemisphereLight(0x6a7ea6, 0x2a2216, 2.4));

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
flashlight.position.set(0.2, -0.15, 0);
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
const MONSTER_H = 2.13; // 7 ft
function prepMonsterAsset(gltf) {
  let hips = null;
  gltf.scene.traverse((o) => {
    if (o.isBone && o.name === 'Hips') hips = o;
    if (!o.isMesh) return;
    o.castShadow = true; o.frustumCulled = false; // skinned: bounds don't follow the pose
    o.material.side = THREE.FrontSide;
  });
  if (!hips) throw new Error('monster.glb has no Hips bone (rebuild it with tools/optimize-monster.mjs)');
  const clips = buildMonsterClips(hips.position.clone());
  return { template: normalizeModel(gltf.scene, MONSTER_H, Math.PI), clips };
}
// ---- Wendigo animation ------------------------------------------------------------
// The rig (tools/optimize-monster.mjs) rests in a T-pose with identity bone rotations,
// +Y up, +Z forward, +X the creature's left. Clips are sampled from pose functions:
// each returns Euler XYZ angles per bone (radians) plus a Hips offset in metres.
//   spine/neck/head: +x leans forward, y turns, z tilts
//   arms: `lower` drops the arm from the T-pose, `fwd` swings it forward/up,
//         `elbow`/`curl` bend the forearm/claws forward
//   legs: thigh -x swings forward, knee +x bends, foot +x points the toes down
const SIDES = [['L', 1], ['R', -1]];
function basePose() {
  const p = { Hips: [0, 0, 0], Spine: [0.22, 0, 0], Chest: [0.18, 0, 0], Neck: [-0.12, 0, 0], Head: [-0.1, 0, 0], hips: [0, -0.06, 0] };
  for (const [S] of SIDES) { p['Clavicle' + S] = [0, 0, 0]; p['Toe' + S] = [0, 0, 0]; }
  setArm(p, 'L', {}); setArm(p, 'R', {}); setLeg(p, 'L', {}); setLeg(p, 'R', {});
  return p;
}
function setArm(p, S, { lower = 1.3, fwd = 0.25, elbow = 0.35, curl = 0.3, twist = 0 } = {}) {
  const s = S === 'L' ? 1 : -1;
  p['UpperArm' + S] = [-fwd, twist * s, -s * lower];
  p['Forearm' + S] = [0, -s * elbow, 0];
  p['Hand' + S] = [0, -s * curl * 0.4, 0];
  p['Claws' + S] = [0, -s * curl, 0];
}
function setLeg(p, S, { thigh = -0.22, knee = 0.42, foot = -0.18, splay = 0 } = {}) {
  const s = S === 'L' ? 1 : -1;
  p['UpLeg' + S] = [thigh, 0, s * splay];
  p['Leg' + S] = [knee, 0, 0];
  p['Foot' + S] = [foot, 0, 0];
}
const TAU = Math.PI * 2;
function gaitPose(t, T, k) {
  // k: 0 = walk, 1 = run. One stride per T seconds; legs in antiphase.
  const p = basePose(), ph = (t / T) * TAU;
  p.Spine[0] = lerp(0.3, 0.62, k); p.Chest[0] = lerp(0.18, 0.3, k); p.Neck[0] = lerp(-0.2, -0.45, k);
  p.Spine[1] = Math.sin(ph) * lerp(0.12, 0.2, k); p.Chest[1] = -Math.sin(ph) * lerp(0.08, 0.14, k);
  p.Head[2] = Math.sin(ph) * 0.05;
  for (const [S, s] of SIDES) {
    const q = ph + (s > 0 ? 0 : Math.PI), sw = Math.sin(q);
    setLeg(p, S, {
      thigh: -0.25 - sw * lerp(0.5, 0.95, k),
      knee: lerp(0.35, 0.55, k) + Math.max(0, Math.cos(q)) * lerp(0.8, 1.5, k),
      foot: -0.15 + sw * 0.3,
    });
    setArm(p, S, { lower: lerp(1.25, 1.1, k), fwd: lerp(0.3, 0.75, k) + sw * lerp(0.45, 0.8, k), elbow: lerp(0.4, 0.8, k), curl: 0.35 });
  }
  p.hips = [0, lerp(-0.08, -0.16, k) + Math.cos(ph * 2) * lerp(0.035, 0.07, k), 0];
  return p;
}
function idlePose(t) {
  const p = basePose(), b = Math.sin((t / 3.2) * TAU);
  p.Chest[0] += b * 0.04; p.Spine[0] += b * 0.02;
  // Slow head sweep with a sudden twitch, like it's listening.
  p.Head[1] = Math.sin((t / 3.2) * TAU) * 0.3; p.Head[2] = t > 1.9 && t < 2.2 ? 0.35 : 0.05;
  for (const [S, s] of SIDES) setArm(p, S, { fwd: 0.25 + b * 0.05 * s, curl: 0.3 + Math.sin(t * 3 + s) * 0.15 });
  p.hips[1] = -0.06 + b * 0.01;
  return p;
}
function stalkPose(t) {
  // Low crouch, head craned forward and tilting side to side, claws near the ground.
  const p = basePose(), w = Math.sin((t / 2.6) * TAU);
  p.Spine[0] = 0.75; p.Chest[0] = 0.3; p.Neck[0] = -0.6; p.Head[0] = -0.15; p.Head[2] = w * 0.4; p.Head[1] = Math.sin((t / 2.6) * TAU * 0.5) * 0.25;
  for (const [S, s] of SIDES) {
    setLeg(p, S, { thigh: -1.05, knee: 1.75, foot: -0.6, splay: 0.12 });
    setArm(p, S, { lower: 1.15, fwd: 0.85 + w * 0.06 * s, elbow: 0.7, curl: 0.55 + Math.sin(t * 5 + s * 2) * 0.12 });
  }
  p.hips = [0, -0.5, -0.05];
  return p;
}
function swipePose(t, side) {
  // Wind up overhead, rake down and across, recover. 0.6 s.
  const p = gaitPose(0, 1, 0), S = side > 0 ? 'L' : 'R';
  const up = smooth01(t / 0.2), down = smooth01((t - 0.2) / 0.16), back = smooth01((t - 0.38) / 0.22);
  const fwd = lerp(lerp(0.3, 2.6, up), 0.5, down), lower = lerp(lerp(1.25, 0.7, up), 1.3, down);
  const a = { fwd: lerp(fwd, 0.3, back), lower: lerp(lower, 1.25, back), elbow: lerp(lerp(0.4, 0.9, up), 0.1, down), curl: lerp(0.3, -0.25, up) };
  setArm(p, S, a);
  p.Chest[1] = side * (lerp(0.35 * up, -0.45, down) * (1 - back));
  p.Spine[0] = 0.3 + 0.35 * down * (1 - back);
  p.hips[2] = 0.25 * down * (1 - back);
  return p;
}
function killPose(t) {
  // Rear up with claws raised (0-0.45), slam down and lunge (0.45-0.7), hold, recover (1.25-1.7).
  const p = basePose();
  const up = smooth01(t / 0.45), slam = smooth01((t - 0.45) / 0.25), rec = smooth01((t - 1.25) / 0.45);
  const shake = t > 0.7 && t < 1.25 ? Math.sin(t * 60) * 0.03 : 0;
  p.Spine[0] = lerp(lerp(0.22, -0.25, up), 0.95, slam) * (1 - rec) + 0.22 * rec;
  p.Chest[0] = lerp(lerp(0.18, -0.1, up), 0.3, slam);
  p.Neck[0] = lerp(lerp(-0.12, -0.7, up), -0.3, slam) + shake;
  p.Head[0] = lerp(-0.1, -0.35, up);
  for (const [S] of SIDES) {
    setArm(p, S, {
      fwd: lerp(lerp(0.25, 2.7, up), 0.35, slam) * (1 - rec) + 0.25 * rec,
      lower: lerp(lerp(1.3, 0.55, up), 1.2, slam), elbow: lerp(lerp(0.35, 0.6, up), 0.15, slam), curl: lerp(lerp(0.3, -0.35, up), 0.7, slam),
    });
    setLeg(p, S, { thigh: lerp(-0.22, -0.95, slam) * (1 - rec) - 0.22 * rec, knee: lerp(0.42, 1.25, slam) * (1 - rec) + 0.42 * rec, foot: lerp(-0.18, -0.45, slam) });
  }
  p.hips = [0, lerp(lerp(-0.06, 0.06, up), -0.38, slam) * (1 - rec) - 0.06 * rec, lerp(0, 0.5, slam) * (1 - rec)];
  return p;
}
function shriekPose(t) {
  // Head thrown back, chest arched, arms flung wide and shaking. 1.3 s.
  const p = basePose(), a = smooth01(t / 0.3) * (1 - smooth01((t - 0.95) / 0.35)), sh = Math.sin(t * 55) * 0.05 * a;
  p.Spine[0] = lerp(0.22, -0.2, a); p.Chest[0] = lerp(0.18, -0.35, a); p.Neck[0] = lerp(-0.12, -0.75, a) + sh; p.Head[0] = lerp(-0.1, -0.35, a); p.Head[2] = sh * 2;
  for (const [S] of SIDES) setArm(p, S, { lower: lerp(1.3, 0.35, a), fwd: lerp(0.25, -0.35, a), elbow: lerp(0.35, 0.15, a), curl: lerp(0.3, -0.45, a) + sh });
  return p;
}
function smooth01(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
// Sample a pose function into an AnimationClip (quaternion tracks + Hips position).
function poseClip(name, duration, fn, restHips, fps = 30) {
  const n = Math.max(2, Math.round(duration * fps) + 1), times = [], poses = [];
  for (let i = 0; i < n; i++) { const t = (i / (n - 1)) * duration; times.push(t); poses.push(fn(t)); }
  const tracks = [], e = new THREE.Euler(), q = new THREE.Quaternion();
  for (const bone of Object.keys(poses[0])) {
    if (bone === 'hips') continue;
    const vals = [];
    for (const p of poses) { const a = p[bone]; q.setFromEuler(e.set(a[0], a[1], a[2], 'XYZ')); vals.push(q.x, q.y, q.z, q.w); }
    tracks.push(new THREE.QuaternionKeyframeTrack(bone + '.quaternion', times, vals));
  }
  const hv = [];
  for (const p of poses) hv.push(restHips.x + p.hips[0], restHips.y + p.hips[1], restHips.z + p.hips[2]);
  tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, hv));
  return new THREE.AnimationClip(name, duration, tracks);
}
function buildMonsterClips(restHips) {
  return {
    idle: poseClip('idle', 3.2, idlePose, restHips),
    walk: poseClip('walk', 1.1, (t) => gaitPose(t, 1.1, 0), restHips),
    run: poseClip('run', 0.72, (t) => gaitPose(t, 0.72, 1), restHips),
    stalk: poseClip('stalk', 2.6, stalkPose, restHips),
    swipeL: poseClip('swipeL', 0.6, (t) => swipePose(t, 1), restHips),
    swipeR: poseClip('swipeR', 0.6, (t) => swipePose(t, -1), restHips),
    kill: poseClip('kill', 1.7, killPose, restHips),
    shriek: poseClip('shriek', 1.3, shriekPose, restHips),
  };
}
// Per-avatar controller: locomotion loops blended by speed/stillness, one-shots on top.
function makeMonsterAnimator(model) {
  const mixer = new THREE.AnimationMixer(model);
  const C = ASSETS.monster.clips, act = {};
  for (const [k, clip] of Object.entries(C)) {
    const a = mixer.clipAction(clip); act[k] = a;
    if (['idle', 'walk', 'run', 'stalk'].includes(k)) { a.play(); a.setEffectiveWeight(k === 'idle' ? 1 : 0); }
    else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
  }
  const st = { mixer, act, w: { idle: 1, walk: 0, run: 0, stalk: 0 }, shot: null, shotT: 0, shotW: 0, swipeSide: 1 };
  st.play = (name) => {
    if (name === 'swipe') { st.swipeSide = -st.swipeSide; name = st.swipeSide > 0 ? 'swipeL' : 'swipeR'; }
    if (st.shot && st.shot !== name) act[st.shot].stop();
    st.shot = name; st.shotT = 0; act[name].reset().play();
  };
  st.busy = () => !!st.shot;
  st.update = (dt, speed, still) => {
    const run = clamp((speed - 4.9) / 1.0, 0, 1), move = clamp(speed / 1.2, 0, 1);
    const tgt = { run: run * move, walk: (1 - run) * move, stalk: still * (1 - move), idle: (1 - still) * (1 - move) };
    for (const k in tgt) st.w[k] = damp(st.w[k], tgt[k], 8, dt);
    act.walk.timeScale = clamp(speed / 3.6, 0.5, 1.6); act.run.timeScale = clamp(speed / 6.0, 0.8, 1.4);
    if (st.shot) {
      st.shotT += dt;
      const dur = C[st.shot].duration;
      st.shotW = smooth01(st.shotT / 0.08) * (1 - smooth01((st.shotT - (dur - 0.15)) / 0.15));
      if (st.shotT >= dur) { act[st.shot].stop(); st.shot = null; st.shotW = 0; }
    }
    const loco = 1 - st.shotW, sum = st.w.idle + st.w.walk + st.w.run + st.w.stalk || 1;
    for (const k of ['idle', 'walk', 'run', 'stalk']) act[k].setEffectiveWeight((st.w[k] / sum) * loco);
    if (st.shot) act[st.shot].setEffectiveWeight(st.shotW);
    mixer.update(dt);
  };
  return st;
}

async function loadAssets(onProgress) {
  const prog = { s: 0, m: 0 };
  const report = () => onProgress?.((prog.s + prog.m) / 2);
  const pct = (key) => (e) => { if (e.total) { prog[key] = e.loaded / e.total; report(); } };
  const [s, m] = await Promise.allSettled([
    loadGLB('assets/survivor.glb', pct('s')).then(prepSurvivorAsset),
    loadGLB('assets/monster.glb', pct('m')).then(prepMonsterAsset),
  ]);
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
    const find = (re) => bones[Object.keys(bones).find((n) => re.test(n))];
    g.userData.bones = {
      spine: find(/Spine_/), spine2: find(/Spine2_/), neck: find(/Neck_/),
      lArm: find(/LeftArm_/), rArm: find(/RightArm_/), lFore: find(/LeftForeArm_/), rFore: find(/RightForeArm_/),
      lUp: find(/LeftUpLeg_/), rUp: find(/RightUpLeg_/), lLeg: find(/LeftLeg_/), rLeg: find(/RightLeg_/),
      lFoot: find(/LeftFoot_/), rFoot: find(/RightFoot_/),
    };
    reg(g, 'entity');
    // Own sonar material: uSelf fades between "lit by its own noise" and "just more background".
    const sonar = makeSonarMaterial(ENTITY_SONAR);
    for (const e of swappables) if (e.mesh.parent && g.getObjectById(e.mesh.id)) { e.m = sonar; if (viewMode === 'monster') e.mesh.material = sonar; }
    g.userData.sonar = sonar;
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
    g.userData.monster = { anim: makeMonsterAnimator(model), mats, meshes, camo: 0, stillT: 0, still: 0 };
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
  repair: () => noise({ dur: 0.06, vol: 0.06, freq: 2500 + Math.random() * 1500, q: 4 }),
};
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
  gens: GENS.map(() => ({ progress: 0, done: false })),
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
function peerOptions() {
  const q = new URLSearchParams(location.search);
  const o = { debug: 1 };
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
function broadcastLobby() { broadcast({ t: 'lobby', code: net.code, players: lobbyList() }); }

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
      p.x = msg.x; p.z = msg.z; p.ry = msg.ry; p.n = clamp(+msg.n || 0, 0, 1); p.c = msg.c; p.r = msg.r;
      break;
    }
    case 'attack': hostAttack(p, msg.ry); break;
    case 'repair': hostRepair(p, msg.gen, msg.dt); break;
    case 'sonar': if (p?.isMonster) broadcast({ t: 'event', k: 'sonar', by: from, x: p.x, z: p.z }); break;
    case 'escape': {
      if (!p || p.isMonster || p.s !== 'alive' || !hs.gateOpen) return;
      if (!inExit(p.x, p.z)) return;
      p.s = 'escaped';
      broadcast({ t: 'event', k: 'escaped', id: from, name: p.name });
      break;
    }
  }
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
    if (d > 0.9 && (dx * fx + dz * fz) / d < 0.35) continue; // must be roughly in front
    if (d < bestD) { best = s; bestD = d; }
  }
  if (!best || time - best.lastHit < CFG.HIT_INVULN) return;
  best.lastHit = time; best.hp -= 1;
  if (best.hp <= 0) { best.s = 'caught'; hs.lastKill = time; }
  broadcast({ t: 'event', k: 'hit', id: best.id, by: m.id, name: best.name, hp: best.hp, x: best.x, z: best.z });
}
function hostRepair(p, gi, dt) {
  if (!p || p.isMonster || p.s !== 'alive' || hs.phase !== 'playing') return;
  const g = hs.gens[gi];
  if (!g || g.done) return;
  const gp = genPos(gi);
  if (Math.hypot(p.x - gp.x, p.z - gp.z) > 3.2) return;
  g.progress = Math.min(1, g.progress + clamp(+dt || 0, 0, 0.5) / CFG.GEN_TIME);
  if (g.progress >= 1 && !g.done) {
    g.done = true;
    broadcast({ t: 'event', k: 'gen', i: gi, x: gp.x, z: gp.z, left: hs.gens.filter((x) => !x.done).length });
    if (hs.gens.every((x) => x.done) && !hs.gateOpen) {
      hs.gateOpen = true;
      broadcast({ t: 'event', k: 'gate', x: GATE.x, z: GATE.z });
    }
  }
}
function hostStart() {
  const list = Object.values(hs.players);
  if (!list.some((p) => p.isMonster)) addFeed('Starting without a monster (testing mode).', 'warn');
  let si = 0;
  list.forEach((p, idx) => {
    p.hp = CFG.MAX_HP; p.s = 'alive'; p.n = 0; p.c = 0; p.r = 0; p.lastHit = -99; p.lastAttack = -99; p.colorIdx = idx;
    if (p.isMonster) { p.x = SPAWN_MON.x; p.z = SPAWN_MON.z; p.ry = Math.random() * Math.PI * 2; }
    else {
      const [sx, sz] = SPAWN_SURV[si % SPAWN_SURV.length]; si++;
      p.x = sx; p.z = sz; p.ry = Math.atan2(-(CAMPFIRE.x - sx), -(CAMPFIRE.z - sz)) + Math.PI; // back to the fire
    }
    p.bot = p.isBot ? newBrain(p) : null;
  });
  hs.phase = 'playing'; hs.timeLeft = CFG.DURATION; hs.gateOpen = false; hs.lastKill = undefined;
  hs.gens = GENS.map(() => ({ progress: 0, done: false }));
  broadcast({ t: 'start', duration: CFG.DURATION, players: list.map((p) => ({ id: p.id, name: p.name, isMonster: p.isMonster, isBot: p.isBot, x: p.x, z: p.z, ry: p.ry, colorIdx: p.colorIdx })) });
}
function hostUpdate(dt) {
  if (hs.phase !== 'playing') return;
  hs.timeLeft -= dt;
  for (const p of Object.values(hs.players)) {
    const v = Math.hypot(p.x - (p.lx ?? p.x), p.z - (p.lz ?? p.z)) / Math.max(dt, 1e-4);
    p.spd = damp(p.spd || 0, v, 4, dt); p.lx = p.x; p.lz = p.z;
  }
  for (const p of Object.values(hs.players)) if (p.isBot && p.s === 'alive') updateBot(p, dt);

  hs.snapAcc += dt;
  if (hs.snapAcc >= 1 / CFG.NET_HZ) {
    hs.snapAcc = 0;
    broadcast({
      t: 'snap', tl: r2(hs.timeLeft), go: hs.gateOpen,
      g: hs.gens.map((g) => r2(g.progress)),
      p: Object.values(hs.players).map((p) => ({ id: p.id, x: r2(p.x), z: r2(p.z), ry: r2(p.ry), n: r2(p.n), c: p.c, r: p.r, hp: p.hp, s: p.s })),
    });
  }

  // Win conditions
  const surv = Object.values(hs.players).filter((p) => !p.isMonster);
  const alive = surv.filter((p) => p.s === 'alive').length;
  const escaped = surv.filter((p) => p.s === 'escaped').length;
  const caught = surv.filter((p) => p.s === 'caught').length;
  let end = null;
  if (surv.length > 0 && alive === 0) end = escaped > 0 ? { w: 'survivors', reason: `${escaped} escaped, ${caught} taken.` } : { w: 'monster', reason: 'Every survivor was taken.' };
  else if (hs.timeLeft <= 0) end = alive + escaped > 0 ? { w: 'survivors', reason: `Dawn broke. ${alive + escaped} survived, ${caught} taken.` } : { w: 'monster', reason: 'Nobody made it.' };
  // Let a final kill animation and kill cam play out before showing the result.
  if (end && hs.lastKill !== undefined && time - hs.lastKill < 3.2) end = null;
  if (end) {
    hs.phase = 'ended';
    broadcast({ t: 'end', winner: end.w, reason: end.reason, stats: surv.map((p) => ({ name: p.name, s: p.s })) });
  }
}
function hostBackToLobby() { hs.phase = 'lobby'; broadcastLobby(); }

// ---------------- BOTS (simulated on the host) ----------------
// Survivor bots sneak to generators, repair them, flee from the monster and run for
// the exit. The monster bot hunts by sound only: it hears survivors within a radius
// set by their noise level, investigates, and shrieks (sonar) when it loses the trail.
function newBrain(p) {
  return p.isMonster
    ? { path: [], goalKey: '', repathT: 0, mode: 'patrol', target: null, preyId: null, hearT: 0, sonarCD: 10, attackCD: 0, wait: 1, stuckT: 0, lx: p.x, lz: p.z }
    : { path: [], goalKey: '', repathT: 0, state: 'work', t: 0, alert: 0, refreeze: 0, wait: Math.random() * 1.5, stamina: 1, stuckT: 0, lx: p.x, lz: p.z };
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

// Pick a reachable tile far from the monster, weighted against long detours.
function botPathAway(p, b, mon) {
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < 16; i++) {
    const t = randomFloorTile(), c = tileCenter(t.x, t.z);
    const score = Math.hypot(c.x - mon.x, c.z - mon.z) - Math.hypot(c.x - p.x, c.z - p.z) * 0.35;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  b.goalKey = ''; botPathTo(p, b, best);
}
function updateSurvivorBot(p, dt) {
  const b = p.bot;
  p.r = 0;
  const mon = Object.values(hs.players).find((q) => q.isMonster && q.s === 'alive');
  const dm = mon ? Math.hypot(mon.x - p.x, mon.z - p.z) : Infinity;
  // Survivors spot a moving monster at 14 m; a still (camouflaged) one only within 4.5 m.
  const seen = mon && (dm < 4.5 || (mon.spd > 0.6 && dm < 14));
  b.refreeze -= dt; b.alert = seen ? 10 : b.alert - dt;
  const faceMonster = () => { p.ry = angleDamp(p.ry, Math.atan2(-(mon.x - p.x), -(mon.z - p.z)), 6, dt); };

  // Panic only when it is right on top of them or they've just been hit.
  if (mon && b.state !== 'flee' && (dm < 2.6 || time - p.lastHit < 0.3)) {
    b.state = 'flee'; b.t = 2.5 + Math.random(); botPathAway(p, b, mon);
  }
  if (b.state === 'flee') {
    b.t -= dt;
    const sprint = b.stamina > 0.05;
    b.stamina = clamp(b.stamina - (sprint ? dt / 4 : -dt * 0.15), 0, 1);
    const mode = sprint ? 'sprint' : 'walk';
    p.n = CFG.NOISE[mode]; p.c = 0;
    if (botStep(p, b, CFG.SPEED[mode], CFG.SURV_R, dt) || b.t <= 0) { b.state = 'sneak'; if (mon) botPathAway(p, b, mon); }
    return;
  }
  if (b.state === 'work' && seen && b.refreeze <= 0) { b.state = 'freeze'; b.t = 1.2 + Math.random() * 1.8; b.refreeze = 4; }
  if (b.state === 'freeze') {
    // Freeze: drop into a crouch and hold perfectly still (silent) while watching it.
    p.n = 0; p.c = 1; if (mon) faceMonster();
    b.t -= dt;
    if (b.t <= 0) { b.state = 'sneak'; if (mon) botPathAway(p, b, mon); }
    return;
  }
  if (b.state === 'sneak') {
    // Creep away in a crouch. Freeze again if it comes closer while moving.
    p.c = 1; p.n = CFG.NOISE.crouch;
    if (mon && seen && mon.spd > 0.6 && dm < 7 && b.refreeze <= 0) { b.state = 'freeze'; b.t = 1 + Math.random(); b.refreeze = 4; return; }
    if (botStep(p, b, CFG.SPEED.crouch, CFG.SURV_R, dt) || dm > 18) {
      if (dm > 14 || !mon) b.state = 'work'; else if (mon) botPathAway(p, b, mon);
    }
    return;
  }
  b.stamina = clamp(b.stamina + dt * 0.2, 0, 1);
  if (b.wait > 0) { b.wait -= dt; p.n = 0; return; }

  // Stay crouched for a while after a sighting, otherwise walk.
  const mode = b.alert > 0 ? 'crouch' : 'walk';
  p.c = mode === 'crouch' ? 1 : 0;

  if (hs.gateOpen) {
    botPathTo(p, b, tileOf(GATE.x, EXIT_ZONE.minZ + 4), true);
    p.n = CFG.NOISE[mode];
    botStep(p, b, CFG.SPEED[mode], CFG.SURV_R, dt);
    if (inExit(p.x, p.z)) {
      p.s = 'escaped';
      broadcast({ t: 'event', k: 'escaped', id: p.id, name: p.name });
    }
    return;
  }
  // Nearest unfinished generator, preferring ones no other bot is already working on
  let gi = -1, gd = Infinity, best = Infinity;
  const taken = new Set(Object.values(hs.players).filter((q) => q !== p && q.bot && !q.isMonster && q.s === 'alive').map((q) => q.bot.gen));
  hs.gens.forEach((g, i) => {
    if (g.done) return;
    const c = genPos(i), d = Math.hypot(c.x - p.x, c.z - p.z);
    const score = d + (taken.has(i) ? 40 : 0);
    if (score < best) { best = score; gd = d; gi = i; }
  });
  b.gen = gi;
  if (gi < 0) { p.n = 0; return; }
  if (gd < 2.3) {
    // Repair at 60% of a human's speed so a hunting monster has time to interrupt.
    p.r = 1; p.c = 0; p.n = CFG.NOISE.repair;
    const c = genPos(gi);
    p.ry = Math.atan2(-(c.x - p.x), -(c.z - p.z));
    hostRepair(p, gi, dt * 0.6);
    return;
  }
  botPathTo(p, b, genApproach(gi));
  if (!b.path.length && gd > 2.3) { b.wait = 1 + Math.random(); b.goalKey = ''; p.n = 0; return; }
  p.n = CFG.NOISE[mode];
  if (botStep(p, b, CFG.SPEED[mode], CFG.SURV_R, dt) && gd >= 2.3) {
    // Arrived next to the generator tile: shuffle in close.
    const c = genPos(gi);
    botStep(p, b, CFG.SPEED[mode], CFG.SURV_R, dt, c);
  }
}

function updateMonsterBot(p, dt) {
  const b = p.bot;
  b.attackCD -= dt; b.sonarCD -= dt; b.hearT -= dt;
  p.n = 0; p.c = 0; p.r = 0;
  const prey = Object.values(hs.players).filter((q) => !q.isMonster && q.s === 'alive');

  // Hearing: each survivor is audible within (noise × 24 m), plus a 2 m "touch" radius.
  if (b.hearT <= 0) {
    b.hearT = 0.2;
    let best = null, bestScore = -Infinity;
    for (const s of prey) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      const radius = Math.max(2, s.n * 24);
      if (d > radius) continue;
      const score = radius - d;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (best) {
      const d = Math.hypot(best.x - p.x, best.z - p.z);
      const jitter = d * 0.08; // far sounds are vaguer
      b.target = { x: best.x + (Math.random() - 0.5) * jitter, z: best.z + (Math.random() - 0.5) * jitter };
      b.preyId = best.id;
      b.mode = d < 9 ? 'chase' : 'investigate';
      b.wait = 0;
    }
  }

  // Strike anything within reach that is roughly in front.
  for (const s of prey) {
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    if (d < 1.9 && b.attackCD <= 0) {
      const ry = Math.atan2(-(s.x - p.x), -(s.z - p.z));
      p.ry = ry; b.attackCD = CFG.ATTACK_CD + 0.3;
      hostAttack(p, ry);
      if (s.s !== 'alive' || s.hp <= 0) { b.mode = 'patrol'; b.target = null; }
      break;
    }
  }

  if (b.mode === 'chase' && b.target) {
    const d = Math.hypot(b.target.x - p.x, b.target.z - p.z);
    const sameArea = d < 5;
    if (!sameArea) botPathTo(p, b, tileOf(b.target.x, b.target.z));
    if (botStep(p, b, 5.3, CFG.MON_R, dt, sameArea ? b.target : null)) b.mode = 'search';
    return;
  }
  if (b.mode === 'investigate' && b.target) {
    botPathTo(p, b, tileOf(b.target.x, b.target.z));
    if (botStep(p, b, 4.4, CFG.MON_R, dt)) b.mode = 'search';
    return;
  }
  if (b.mode === 'search') {
    // Lost the trail: shriek to reveal nearby survivors, or give up and patrol.
    if (b.sonarCD <= 0) {
      b.sonarCD = 14;
      broadcast({ t: 'event', k: 'sonar', by: p.id, x: p.x, z: p.z });
      let near = null, nd = 26;
      for (const s of prey) { const d = Math.hypot(s.x - p.x, s.z - p.z); if (d < nd) { nd = d; near = s; } }
      if (near) { b.target = { x: near.x, z: near.z }; b.preyId = near.id; b.mode = 'investigate'; b.goalKey = ''; return; }
    }
    b.mode = 'patrol'; b.wait = 1 + Math.random() * 1.5; b.path = []; b.goalKey = '';
    return;
  }
  // Patrol: drift between generators (where survivors must go) and random rooms.
  if (b.wait > 0) { b.wait -= dt; return; }
  if (!b.path.length) {
    const t = Math.random() < 0.6 ? genApproach(Math.floor(Math.random() * GENS.length)) : randomFloorTile();
    b.goalKey = ''; botPathTo(p, b, t);
    if (!b.path.length) { b.wait = 0.5; return; }
  }
  if (botStep(p, b, 3.4, CFG.MON_R, dt)) b.wait = 0.5 + Math.random() * 2;
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
  if (game.phase === 'playing' || game.phase === 'ended') leaveMatch();
  game.phase = 'lobby';
  showScreen('menu');
  $('#menu-main').classList.add('hidden');
  $('#menu-lobby').classList.remove('hidden');
  $('#room-code').textContent = msg.code;
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
  game.gens.forEach((g) => { g.progress = 0; g.done = false; });
  for (const p of msg.players) {
    if (p.id === me.id) {
      me.isMonster = p.isMonster; me.pos.set(p.x, 0, p.z); me.yaw = p.ry; me.pitch = 0;
      me.hp = CFG.MAX_HP; me.status = 'alive'; me.stamina = 1; me.exhausted = false; me.attackCD = 0; me.sonarCD = 2;
      me.escapeSent = false; me.boost = 0; me.damage = 0; me.repairGen = -1; me.colorIdx = p.colorIdx;
      me.killCam = null; me.roll = 0; me.flinch = 0; me.camo = 0; me.stillT = 0;
      me.eye = me.isMonster ? 1.95 : 1.6;
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
  addFeed(me.isMonster ? 'You are blind. Listen for the ripples. Hunt.' : 'Repair the generators. Stay quiet. Escape.', me.isMonster ? 'good' : 'warn');
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
  unreg(r.avatar); scene.remove(r.avatar);
  r.avatar.traverse((o) => { const i = survivorOnly.indexOf(o); if (i >= 0) survivorOnly.splice(i, 1); });
  players.delete(id);
}
function leaveMatch() {
  for (const id of [...players.keys()]) removeRemote(id);
  game.gateOpen = false;
  if (world.gate) world.gate.mesh.position.x = world.gate.x0;
}
function onSnap(msg) {
  if (game.phase !== 'playing') return;
  game.timeLeft = msg.tl;
  game.gateOpen = msg.go;
  msg.g.forEach((v, i) => { game.gens[i].progress = v; game.gens[i].done = v >= 1; });
  const seen = new Set();
  for (const s of msg.p) {
    seen.add(s.id);
    if (s.id === me.id) {
      me.hp = s.hp;
      if (s.s !== me.status) setMyStatus(s.s);
      continue;
    }
    const r = players.get(s.id); if (!r) continue;
    r.target.set(s.x, 0, s.z); r.targetYaw = s.ry; r.noise = s.n; r.crouch = s.c; r.repairing = s.r; r.hp = s.hp;
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
function onEvent(e) {
  const pos = new THREE.Vector3(e.x || 0, 0.1, e.z || 0);
  switch (e.k) {
    case 'swing': {
      const m = players.get(e.by);
      const M = m?.avatar.userData.monster;
      if (M && M.anim.act.kill && M.anim.shot !== 'kill') M.anim.play('swipe');
      if (m && !me.isMonster) noise({ dur: 0.3, vol: 0.3 * distVol(m.pos, 25), pan: panOf(m.pos), freq: 1600, q: 0.8 });
      break;
    }
    case 'hit': {
      const lethal = e.hp <= 0;
      addRipple(pos, lethal ? 22 : 14, lethal ? 2.2 : 1.6, 12);
      const m = players.get(e.by), M = m?.avatar.userData.monster;
      if (lethal && m) {
        // Monster kill animation, turned toward its victim.
        if (M) M.anim.play('kill');
        m.targetYaw = Math.atan2(-(e.x - m.pos.x), -(e.z - m.pos.z));
      }
      if (e.id === me.id) {
        me.damage = 1; me.boost = 2.5; sfx.hit();
        if (lethal) startKillCam(e.by); else { me.flinch = 1; addFeed('You are wounded! RUN.', 'bad'); }
      } else {
        const r = players.get(e.id);
        if (r) { if (lethal) { r.status = 'caught'; r.anim.deadDelay = m ? KILL.raise + 0.05 : 0.01; } else r.anim.flinch = 1; }
        if (me.isMonster) {
          sfx.hit(); addFeed(lethal ? `You took ${e.name}.` : `You wounded ${e.name}.`, 'good');
          if (lethal) { me.lunge = 1.6; monsterPost.pass.uniforms.uPulse.value = 1.4; }
        } else { addFeed(lethal ? `${e.name} was taken.` : `${e.name} was wounded.`, 'bad'); noise({ dur: 0.4, vol: 0.25 * distVol(pos, 40), pan: panOf(pos), freq: 600 }); }
      }
      break;
    }
    case 'sonar': {
      const sm = players.get(e.by)?.avatar.userData.monster;
      if (sm && sm.anim.shot !== 'kill') sm.anim.play('shriek');
      if (e.by !== me.id) { addRipple(pos.setY(1.5), 30, 1.3, 14); sfx.screech(distVol(pos, 60) + 0.2, panOf(pos)); if (!me.isMonster) addFeed('The creature shrieks…', 'warn'); }
      break;
    }
    case 'gen': {
      addRipple(pos.setY(1), 26, 1.4, 11);
      world.gens[e.i].shake = 1;
      game.gens[e.i].done = true; game.gens[e.i].progress = 1;
      sfx.gen();
      addFeed(e.left > 0 ? `A generator roars to life. ${e.left} remaining.` : 'All generators online!', me.isMonster ? 'warn' : 'good');
      break;
    }
    case 'gate': {
      game.gateOpen = true;
      addRipple(pos.setY(1.5), 40, 1.5, 12);
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
  sendToHost({ t: 'state', x: r2(me.pos.x), z: r2(me.pos.z), ry: r2(me.yaw), n: r2(me.noise), c: me.crouch ? 1 : 0, r: me.repairing ? 1 : 0 });
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
  $('#resume').classList.toggle('hidden', game.phase !== 'playing' || pointerLocked || lookMode === 'drag');
}
function useDragLook() { lookMode = 'drag'; unlockPointer(); updateResumeOverlay(); }

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  keys[e.code] = true;
  if (game.phase !== 'playing') return;
  if (e.code === 'KeyF' && !me.isMonster) { flashlightOn = !flashlightOn; flashlight.visible = flashlightOn && viewMode === 'survivor'; tone({ f: 1800, dur: 0.03, vol: 0.05 }); }
  if (e.code === 'KeyQ') monsterSonar();
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
  pointerLocked = document.pointerLockElement === canvas;
  updateResumeOverlay();
});
document.addEventListener('pointerlockerror', useDragLook);
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
function monsterAttack() {
  if (!me.isMonster || me.status !== 'alive' || me.attackCD > 0) return;
  me.attackCD = CFG.ATTACK_CD; me.lunge = 1;
  sfx.swipe();
  // a short forward lunge
  moveWithCollision(me.pos, -Math.sin(me.yaw) * 0.6, -Math.cos(me.yaw) * 0.6, CFG.MON_R);
  sendToHost({ t: 'attack', ry: me.yaw });
}
function monsterSonar() {
  if (!me.isMonster || me.status !== 'alive' || me.sonarCD > 0) return;
  me.sonarCD = CFG.SONAR_CD;
  addRipple(new THREE.Vector3(me.pos.x, 1.5, me.pos.z), 30, 1.3, 14);
  monsterPost.pass.uniforms.uPulse.value = 1;
  sfx.ping();
  sendToHost({ t: 'sonar' });
}

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
function updateKillCam(dt) {
  const K = me.killCam; K.t += dt;
  const m = players.get(K.by);
  if (m) {
    const head = MONSTER_H - 0.2, d = Math.max(0.5, Math.hypot(m.pos.x - me.pos.x, m.pos.z - me.pos.z));
    me.yaw = angleDamp(me.yaw, Math.atan2(-(m.pos.x - me.pos.x), -(m.pos.z - me.pos.z)), 8, dt);
    if (K.t < KILL.slam) me.pitch = damp(me.pitch, Math.atan2(head - me.eye, d), 6, dt);
  }
  if (K.t >= KILL.raise + 0.15 && !K.slammed) { K.slammed = true; me.damage = 1.4; sfx.hit(); sfx.heavyStep(0.9, 0); }
  // Collapse: drop to the floor and roll onto your side, looking up.
  const fall = ease((K.t - KILL.slam) / 0.6);
  me.eye = lerp(me.crouch ? 1.0 : 1.6, 0.25, fall);
  me.roll = 1.2 * fall;
  if (K.t > KILL.slam) me.pitch = damp(me.pitch, 0.5, 3, dt);
  const shake = K.t < KILL.slam + 0.3 ? (K.t > KILL.raise ? 0.06 : 0.015) : 0;
  camera.position.set(me.pos.x + (Math.random() - 0.5) * shake, me.eye + (Math.random() - 0.5) * shake, me.pos.z);
  camera.rotation.set(me.pitch, me.yaw, me.roll);
  if (K.t > 2.8) {
    me.killCam = null; me.roll = 0; me.eye = 1.8;
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
    GENS.forEach((G, i) => {
      if (game.gens[i].done) return;
      const d = Math.hypot(me.pos.x - G.x, me.pos.z - G.z);
      if (d < best) { best = d; nearGen = i; }
    });
  }
  me.repairing = ctrl && nearGen >= 0 && keys.KeyE && len === 0;
  me.repairGen = nearGen;
  if (me.repairing) {
    me.repairAcc += dt;
    if (me.repairAcc >= 0.1) { sendToHost({ t: 'repair', gen: nearGen, dt: me.repairAcc }); me.repairAcc = 0; if (Math.random() < 0.6) sfx.repair(); }
  } else me.repairAcc = 0;

  // ---- Movement modes & stamina
  const moving = len > 0;
  me.crouch = !me.isMonster && ctrl && (keys.KeyC || keys.ControlLeft);
  const wantSprint = ctrl && (keys.ShiftLeft || keys.ShiftRight) && moving && !me.crouch;
  if (me.stamina <= 0) me.exhausted = true;
  if (me.exhausted && me.stamina > 0.35) me.exhausted = false;
  me.sprint = wantSprint && !me.exhausted;
  me.stamina = clamp(me.stamina + (me.sprint ? -dt / (me.isMonster ? 3 : 4) : dt * (moving ? 0.15 : 0.25)), 0, 1);

  let speed;
  if (me.isMonster) speed = me.sprint ? CFG.SPEED.monsterSprint : CFG.SPEED.monster;
  else speed = me.crouch ? CFG.SPEED.crouch : me.sprint ? CFG.SPEED.sprint : CFG.SPEED.walk;
  if (me.boost > 0) speed *= 1.35;
  if (moving) moveWithCollision(me.pos, mx * speed * dt, mz * speed * dt, me.isMonster ? CFG.MON_R : CFG.SURV_R);
  me.moving = moving;
  if (me.isMonster) {
    me.stillT = moving || me.attackCD > CFG.ATTACK_CD - 0.5 ? 0 : (me.stillT || 0) + dt;
    me.camo = me.stillT > 0.6 ? Math.min(1, (me.camo || 0) + dt / 1.4) : Math.max(0, (me.camo || 0) - dt / 0.25);
  }

  // ---- Noise (what the monster "sees")
  me.noise = !moving ? (me.repairing ? CFG.NOISE.repair : 0) : me.crouch ? CFG.NOISE.crouch : me.sprint ? CFG.NOISE.sprint : CFG.NOISE.walk;

  // ---- Footsteps
  if (moving) {
    me.stepT -= dt * speed;
    if (me.stepT <= 0) {
      me.stepT = me.isMonster ? 2.6 : 2.0;
      if (me.isMonster) {
        // The monster's own steps send a faint ripple — enough to feel nearby walls.
        addRipple(_v.set(me.pos.x, 0.05, me.pos.z), me.sprint ? 7 : 5, 0.35, 8);
        sfx.heavyStep(0.25, 0);
      } else sfx.step(me.noise, 0);
    }
  }

  // ---- Escape
  if (!me.isMonster && game.gateOpen && !me.escapeSent && inExit(me.pos.x, me.pos.z)) {
    me.escapeSent = true; sendToHost({ t: 'escape' });
  }

  const targetEye = me.isMonster ? 1.95 : me.crouch ? 1.0 : 1.6;
  me.eye = damp(me.eye, targetEye, 10, dt);
  me.bob += moving ? dt * speed * 2.2 : 0;
  applyCamera(dt, moving ? (me.isMonster ? 0.06 : 0.04) * (speed / 3.4) : 0);
}
function applyCamera(dt, bobAmp) {
  camera.position.set(me.pos.x, me.eye + Math.sin(me.bob) * bobAmp, me.pos.z);
  if (me.lunge > 0) { camera.position.x -= Math.sin(me.yaw) * me.lunge * 0.3; camera.position.z -= Math.cos(me.yaw) * me.lunge * 0.3; }
  camera.rotation.set(me.pitch - (me.flinch || 0) * 0.12, me.yaw, Math.sin(me.bob * 0.5) * bobAmp * 0.3 + (me.flinch || 0) * 0.08);
}

// ---- Avatar animation -------------------------------------------------------
const _q = new THREE.Quaternion(), _axis = new THREE.Vector3();
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
// Rotate a bone about one of its local axes, on top of whatever the mixer set this frame.
function boneRot(b, axis, ang) { if (b && ang) b.quaternion.multiply(_q.setFromAxisAngle(AXES[axis], ang)); }
const ease = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const KILL = { raise: 0.45, slam: 0.7, recover: 1.25, end: 1.7 }; // monster kill timeline (s)

function animateSurvivor(r, dt) {
  const a = r.avatar, A = r.anim, rig = a.userData.rig, B = a.userData.bones;
  // In monster vision a survivor stands out only while making noise; standing still they
  // fade back into the environment grid over ~1.5 s.
  const loud = r.noise > 0.05 || r.repairing || A.flinch > 0.1 || A.dead >= 0;
  A.self = loud ? Math.min(1, (A.self ?? 0) + dt * 6) : Math.max(0, (A.self ?? 0) - dt * 0.7);
  if (a.userData.sonar) a.userData.sonar.uniforms.uSelf.value = A.self;
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
    mixer.update(dead ? 0 : dt);
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

function animateMonster(r, dt) {
  const a = r.avatar, rig = a.userData.rig, M = a.userData.monster;
  if (!M) { // primitive fallback: simple lurch
    const gait = Math.min(r.speed, 6);
    rig.rotation.x = 0.1 + gait * 0.025 + Math.sin(time * 1.3) * 0.03;
    rig.position.y = Math.abs(Math.sin(r.walkT * 0.5)) * 0.08 * Math.min(gait, 1.5);
    return;
  }
  // Still for a moment -> drops into its listening crouch and fades almost completely.
  M.stillT = r.speed < 0.3 && !M.anim.busy() ? M.stillT + dt : 0;
  const still = M.stillT > 0.6 ? 1 : 0;
  M.anim.update(dt, r.speed, still);
  M.camo = still ? Math.min(1, M.camo + dt / 1.2) : Math.max(0, M.camo - dt / 0.25);
  const op = 1 - 0.985 * M.camo;
  for (const m of M.mats) m.opacity = op;
  for (const o of M.meshes) o.castShadow = M.camo < 0.3;
}

function updateRemotes(dt) {
  let monsterDist = Infinity, monsterPos = null;
  for (const r of players.values()) {
    const prev = _v.copy(r.pos);
    r.pos.x = damp(r.pos.x, r.target.x, 12, dt);
    r.pos.z = damp(r.pos.z, r.target.z, 12, dt);
    r.speed = damp(r.speed, prev.distanceTo(r.pos) / Math.max(dt, 1e-4), 8, dt);
    r.yaw = angleDamp(r.yaw, r.targetYaw, 12, dt);
    const a = r.avatar;
    a.position.copy(r.pos); a.rotation.y = r.yaw;
    r.walkT += dt * r.speed * 2.4;
    if (r.isMonster) animateMonster(r, dt); else animateSurvivor(r, dt);
    if (r.status !== 'alive') continue;

    if (r.isMonster) {
      const d = r.pos.distanceTo(me.pos);
      if (d < monsterDist) { monsterDist = d; monsterPos = r.pos; }
      // Survivors hear the monster's heavy footfalls
      if (!me.isMonster && r.speed > 0.5) {
        r.stepT -= dt * r.speed;
        if (r.stepT <= 0) { r.stepT = 2.6; sfx.heavyStep(distVol(r.pos, 30) * 0.8, panOf(r.pos)); }
      }
    } else if (me.isMonster || viewMode === 'monster') {
      // ===== ECHOLOCATION: survivor noise → sonar ripples on the monster's grid
      if (r.noise > 0.01) {
        r.stepT -= dt;
        if (r.stepT <= 0) {
          const n = r.noise;
          r.stepT = lerp(0.95, 0.32, n) * (r.repairing ? 1.4 : 1);
          addRipple(_v.set(r.pos.x, 0.05, r.pos.z), 2.2 + n * 11, 0.3 + n * 0.95);
          if (me.isMonster) sfx.blip(distVol(r.pos, 50) * (0.3 + n), panOf(r.pos));
        }
      }
    }
  }
  return { monsterDist, monsterPos };
}

// ----------------------------------------------------------------------------
//  WORLD ANIMATION, HUD, AMBIENCE
// ----------------------------------------------------------------------------
let heartT = 0;
function updateWorld(dt, monsterDist) {
  // Firelight and cabin lamps flicker
  for (const l of world.flickers) {
    const k = l.kind === 'fire'
      ? 0.75 + Math.sin(time * 9 + l.phase) * 0.12 + Math.sin(time * 23.7) * 0.08 + Math.random() * 0.08
      : 0.9 + Math.sin(time * 31 + l.phase) * 0.04 + (Math.sin(time * 2.3 + l.phase) > 0.97 ? -0.5 : 0);
    l.light.intensity = l.base * k;
  }
  if (world.fire) world.fire.flames.forEach((f, i) => { f.scale.set(1, 0.8 + Math.sin(time * 11 + i * 2) * 0.25 + Math.random() * 0.1, 1); f.rotation.y = time * (1 + i); });
  // Generators
  world.gens.forEach((g, i) => {
    const s = game.gens[i];
    const col = s.done ? 0x2bff6a : s.progress > 0 ? 0xffa020 : 0xff2200;
    g.lampMat.emissive.setHex(col); g.light.color.setHex(col);
    g.light.intensity = s.done ? 4 : 2.5 + Math.sin(time * 6) * 0.5;
    const running = s.done;
    g.shake = Math.max(0, g.shake - dt);
    g.group.position.x = g.pos.x + (running ? Math.sin(time * 60) * 0.006 : 0) + Math.sin(time * 80) * g.shake * 0.04;
  });
  // Gate
  // Gate slides aside when all generators are running
  if (world.gate) world.gate.mesh.position.x = damp(world.gate.mesh.position.x, world.gate.x0 + (game.gateOpen ? GATE.w + 0.2 : 0), 0.8, dt);
  if (world.exitLight) world.exitLight.color.setHex(game.gateOpen ? 0x2cff70 : 0xff2a10);

  // Post-process uniforms
  const sp = monsterPost.pass.uniforms; sp.uTime.value = time; sp.uPulse.value = Math.max(0, sp.uPulse.value - dt * 1.5);
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
  const left = game.gens.filter((g) => !g.done).length;
  $('#hud-objective').textContent = game.gateOpen ? 'EXIT GATE OPEN' : `Generators ${game.gens.length - left}/${game.gens.length}`;
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
    $('#noise-fill').style.width = `${me.noise * 100}%`;
    if (me.status === 'alive') {
      if (me.repairGen >= 0) prompt = `${me.repairing ? 'Repairing' : 'Hold E to repair'} — ${Math.floor(game.gens[me.repairGen].progress * 100)}%`;
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
  if (which !== 'hud') $('#resume').classList.add('hidden'); else updateResumeOverlay();
}
function menuStatus(text, err) { const s = $('#menu-status'); s.textContent = text; s.classList.toggle('err', !!err); }
function fatal(msg) { game.phase = 'menu'; unlockPointer(); $('#fatal-msg').textContent = msg; $('#fatal').classList.remove('hidden'); }
function readName() { me.name = ($('#name-input').value.trim() || 'Survivor').slice(0, 16); try { localStorage.setItem('blindsight-name', me.name); } catch (e) { /* storage unavailable */ } }
try { $('#name-input').value = localStorage.getItem('blindsight-name') || ''; } catch (e) { /* storage unavailable */ }

$('#btn-host').onclick = () => { initAudio(); readName(); hostCreate(false); };
$('#btn-offline').onclick = () => { quickRole = null; initAudio(); readName(); hostCreate(true); };
$('#btn-join').onclick = () => { initAudio(); readName(); joinRoom($('#code-input').value); };
$('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
$('#btn-copy').onclick = () => navigator.clipboard?.writeText(net.code);
$('#btn-start').onclick = () => { initAudio(); hostStart(); };
$('#btn-random-monster').onclick = () => { const humans = Object.values(hs.players).filter((p) => !p.isBot); setMonster(humans[Math.floor(Math.random() * humans.length)].id); };
let botN = 1;
function addBot(isMonster) {
  if (isMonster) for (const p of Object.values(hs.players)) p.isMonster = false; // only one monster
  const id = 'bot-' + botN;
  hs.players[id] = newHostPlayer(id, isMonster ? 'The Wendigo' : 'Bot ' + botN, isMonster, true);
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
  game.phase = 'menu'; net.isHost = false; net.offline = false; quickRole = null;
  hs.phase = 'lobby'; hs.players = {};
  clearRipples(); setViewMode('monster'); startDrone(null);
  showScreen('menu');
  $('#menu-main').classList.remove('hidden'); $('#menu-lobby').classList.add('hidden');
}
$('#btn-menu').onclick = backToMenu;
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
setViewMode('monster');

// Embedded pages (the Claude artifact build) can't use WebRTC, so hide online play there.
const EMBEDDED = !!window.BLINDSIGHT_EMBED;
if (EMBEDDED) { $('#online-group').classList.add('hidden'); $('#embed-note').classList.remove('hidden'); }
loadAssets((f) => menuStatus(`Loading models… ${Math.round(f * 100)}%`)).finally(() => {
  menuStatus(ASSETS.survivor && ASSETS.monster ? '' : 'Some models failed to load; using simple stand-ins.', !(ASSETS.survivor && ASSETS.monster));
  for (const id of ['#btn-bot-survivor', '#btn-bot-monster', '#btn-host', '#btn-offline', '#btn-join']) $(id).disabled = false;
});

const DEBUG = { dtScale: 1 }; // set to 0 from the console to freeze the simulation
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05) * DEBUG.dtScale;
  time += dt;
  sonarShared.uTime.value = time;

  if (game.phase === 'playing' || game.phase === 'ended') {
    if (game.phase === 'playing') updateLocal(dt);
    const { monsterDist } = updateRemotes(dt);
    updateWorld(dt, monsterDist);
    if (net.isHost) hostUpdate(dt);
    if (game.phase === 'playing') { sendState(dt); updateHUD(); }
  } else {
    updateLobbyCamera(dt);
    updateWorld(dt, Infinity);
  }

  sonarShared.uCamPos.value.copy(camera.position);
  (viewMode === 'monster' ? monsterPost : survivorPost).comp.render(dt);
}
animate();

// Debug handle for the console
window.BLINDSIGHT = { CFG, game, me, players, hs, net, setViewMode, addRipple, ASSETS, THREE, renderer, hostUpdate, hostAttack, DEBUG, KILL, nav: { bfsPath, tileOf, tileCenter, navOpen, genApproach, navBlocked, NAV_W } };
