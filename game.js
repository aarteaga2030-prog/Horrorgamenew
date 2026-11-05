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
  TILE: 4,
  WALL_H: 3.6,
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

// '#' wall · '.' floor · 'C' crate · 'G' generator · 'S' survivor spawn
// 'M' monster spawn · 'D' exit gate · 'X' escape zone
const MAP = [
  '############################',
  '#S.....#........#.........G#',
  '#.##...#..####..#..####....#',
  '#.#.......#..#.....#..#..C.#',
  '#.#.C.....#..#..C..#..#....#',
  '#...###...#......###..###..#',
  '###...#...####.........#...#',
  '#G#...#.......#..###...#.###',
  '#...#.##..##..#..#M#...#...#',
  '#...#.....#...#..#.#.......#',
  '#.###..C..#...#....#..##...#',
  '#.....###.#..####..#...#...#',
  '#..#......#........#.C.#...#',
  '#..####..###..###..###.#...#',
  '#S......................#..#',
  '#######..########..####.#..#',
  '#.....#..#.......C......#..#',
  '#..C..#..#..#####...#####..#',
  '#.........S...G#...........#',
  '############D###############',
  '###########XXX##############',
  '###########XXX##############',
];

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
//  MAP HELPERS
// ----------------------------------------------------------------------------
const { TILE, WALL_H } = CFG;
const MH = MAP.length;
const MW = Math.max(...MAP.map((r) => r.length));
const grid = MAP.map((r) => r.padEnd(MW, '#').split(''));
const cell = (x, z) => (x < 0 || z < 0 || x >= MW || z >= MH ? '#' : grid[z][x]);
const tileCenter = (x, z) => new THREE.Vector3((x + 0.5) * TILE, 0, (z + 0.5) * TILE);
const findTiles = (ch) => {
  const out = [];
  for (let z = 0; z < MH; z++) for (let x = 0; x < MW; x++) if (grid[z][x] === ch) out.push({ x, z });
  return out;
};
const GEN_TILES = findTiles('G');
const SPAWN_S = findTiles('S');
const SPAWN_M = findTiles('M')[0];
const GATE_TILE = findTiles('D')[0];
const FLOOR_TILES = [];
for (let z = 0; z < MH; z++) for (let x = 0; x < MW; x++) if ('.SM'.includes(grid[z][x])) FLOOR_TILES.push({ x, z });

// Collision boxes (AABB on XZ plane), reused to avoid allocations.
const _box = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
function solidBox(tx, tz) {
  const c = cell(tx, tz);
  const x0 = tx * TILE, z0 = tz * TILE;
  let half = 0;
  if (c === '#' || (c === 'D' && !game.gateOpen)) half = TILE / 2;
  else if (c === 'C') half = 0.9;
  else if (c === 'G') half = 0.75;
  else return null;
  const cx = x0 + TILE / 2, cz = z0 + TILE / 2;
  _box.minX = cx - half; _box.maxX = cx + half; _box.minZ = cz - half; _box.maxZ = cz + half;
  return _box;
}
// Circle-vs-AABB push-out, gives smooth wall sliding.
function resolveCollision(p, r) {
  for (let iter = 0; iter < 3; iter++) {
    const tx = Math.floor(p.x / TILE), tz = Math.floor(p.z / TILE);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const b = solidBox(tx + dx, tz + dz);
      if (!b) continue;
      const cx = clamp(p.x, b.minX, b.maxX), cz = clamp(p.z, b.minZ, b.maxZ);
      const ox = p.x - cx, oz = p.z - cz, d2 = ox * ox + oz * oz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        p.x += (ox / d) * (r - d); p.z += (oz / d) * (r - d);
      } else {
        const l = p.x - b.minX, rr = b.maxX - p.x, t = p.z - b.minZ, bt = b.maxZ - p.z;
        const m = Math.min(l, rr, t, bt);
        if (m === l) p.x = b.minX - r; else if (m === rr) p.x = b.maxX + r;
        else if (m === t) p.z = b.minZ - r; else p.z = b.maxZ + r;
      }
    }
  }
}
function moveWithCollision(p, dx, dz, r) {
  const len = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(len / (r * 0.7)));
  for (let i = 0; i < steps; i++) { p.x += dx / steps; p.z += dz / steps; resolveCollision(p, r); }
}
// BFS path between tiles (used by bots).
function bfsPath(from, to, allowExit = false) {
  const key = (x, z) => z * MW + x;
  const prev = new Map([[key(from.x, from.z), -1]]);
  const q = [from];
  while (q.length) {
    const c = q.shift();
    if (c.x === to.x && c.z === to.z) break;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = c.x + dx, nz = c.z + dz, ch = cell(nx, nz);
      if ('#CG'.includes(ch) || (!allowExit && 'DX'.includes(ch)) || prev.has(key(nx, nz))) continue;
      prev.set(key(nx, nz), key(c.x, c.z));
      q.push({ x: nx, z: nz });
    }
  }
  if (!prev.has(key(to.x, to.z))) return [];
  const path = [];
  for (let k = key(to.x, to.z); k !== -1; k = prev.get(k)) path.push({ x: k % MW, z: Math.floor(k / MW) });
  return path.reverse();
}

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
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 220);
camera.rotation.order = 'YXZ';
scene.add(camera);
const survivorFog = new THREE.FogExp2(0x0b0d0b, 0.04);
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
    float minor = gridLine(uv / uGrid) * 0.65;
    float major = gridLine(uv / (uGrid * 4.0));
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
    float base = uBase * (1.0 - smoothstep(8.0, 45.0, dc));
    float near = (1.0 - smoothstep(0.0, 5.0, dc)) * uNearGain;
    float I = base + energy * uGain + near;

    vec3 V = normalize(uCamPos - vWorld);
    float fres = pow(1.0 - abs(dot(V, n)), 2.5);
    vec3 col = uColor * (lines * I * 1.8 + I * 0.025 + fres * I * 0.22);
    gl_FragColor = vec4(col, 1.0);
  }`;
function makeSonarMaterial({ base, gain, grid, near, color }) {
  return new THREE.ShaderMaterial({
    defines: { MAXR: CFG.MAX_RIPPLES },
    uniforms: Object.assign({}, sonarShared, {
      uBase: { value: base }, uGain: { value: gain }, uGrid: { value: grid },
      uNearGain: { value: near }, uColor: { value: new THREE.Color(color) },
    }),
    vertexShader: SONAR_VERT,
    fragmentShader: SONAR_FRAG,
  });
}
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
  scene.background = new THREE.Color(mon ? 0x000000 : 0x050605);
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
function grime(g, s, rng, n, alpha) {
  for (let i = 0; i < n; i++) {
    const x = rng() * s, y = rng() * s, r = rng() * s * 0.08 + 2;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(20,16,10,${alpha * rng()})`); grd.addColorStop(1, 'rgba(20,16,10,0)');
    g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
}
function speck(g, s, rng, n) {
  for (let i = 0; i < n; i++) { const v = 40 + rng() * 60; g.fillStyle = `rgba(${v},${v},${v},${rng() * 0.25})`; g.fillRect(rng() * s, rng() * s, 1 + rng() * 2, 1 + rng() * 2); }
}
const TEX = {
  floor: canvasTex(512, (g, s, rng) => {
    g.fillStyle = '#2d2e2a'; g.fillRect(0, 0, s, s);
    const n = 4, t = s / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = 52 + rng() * 18; g.fillStyle = `rgb(${v},${v - 2},${v - 6})`; g.fillRect(x * t + 2, y * t + 2, t - 4, t - 4);
    }
    speck(g, s, rng, 3000); grime(g, s, rng, 40, 0.6);
  }, MW, MH),
  wall: canvasTex(512, (g, s, rng) => {
    g.fillStyle = '#6a685c'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#34463d'; g.fillRect(0, s * 0.62, s, s * 0.38);          // institutional green dado
    g.fillStyle = '#23302a'; g.fillRect(0, s * 0.6, s, s * 0.03);
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
    for (let x = 0; x <= s; x += s / 4) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s); g.stroke(); }
    speck(g, s, rng, 2500);
    for (let i = 0; i < 14; i++) {                                           // drip streaks
      const x = rng() * s, len = rng() * s * 0.6;
      const grd = g.createLinearGradient(0, 0, 0, len);
      grd.addColorStop(0, 'rgba(40,30,15,0.5)'); grd.addColorStop(1, 'rgba(40,30,15,0)');
      g.fillStyle = grd; g.fillRect(x, 0, 2 + rng() * 6, len);
    }
    grime(g, s, rng, 25, 0.5);
    g.strokeStyle = 'rgba(15,10,5,0.6)'; g.lineWidth = 1;                   // cracks
    for (let i = 0; i < 5; i++) { let x = rng() * s, y = rng() * s; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 8; k++) { x += (rng() - 0.5) * 30; y += rng() * 20; g.lineTo(x, y); } g.stroke(); }
  }),
  ceil: canvasTex(256, (g, s, rng) => {
    g.fillStyle = '#26261f'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#141410'; g.lineWidth = 3;
    for (let i = 0; i <= s; i += s / 2) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.moveTo(0, i); g.lineTo(s, i); g.stroke(); }
    speck(g, s, rng, 800); grime(g, s, rng, 12, 0.7);
  }, MW, MH),
  crate: canvasTex(256, (g, s, rng) => {
    g.fillStyle = '#5a4026'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += s / 6) { const v = rng() * 20; g.fillStyle = `rgb(${90 + v},${62 + v},${36 + v})`; g.fillRect(4, y + 3, s - 8, s / 6 - 6); }
    g.strokeStyle = '#2b1d10'; g.lineWidth = 10; g.strokeRect(5, 5, s - 10, s - 10);
    g.beginPath(); g.moveTo(10, 10); g.lineTo(s - 10, s - 10); g.stroke();
    speck(g, s, rng, 600);
  }),
  gate: canvasTex(256, (g, s, rng) => {
    g.fillStyle = '#4b4f52'; g.fillRect(0, 0, s, s);
    g.fillStyle = 'rgba(0,0,0,0.3)'; for (let y = 0; y < s; y += 16) g.fillRect(0, y, s, 3);
    for (let i = -s; i < s * 2; i += 40) { g.fillStyle = '#c9a400'; g.beginPath(); g.moveTo(i, s * 0.82); g.lineTo(i + 20, s * 0.82); g.lineTo(i + 20 + 40, s); g.lineTo(i + 40, s); g.fill(); }
    g.fillStyle = '#111'; g.fillRect(0, s * 0.8, s, 4);
    grime(g, s, rng, 20, 0.7); speck(g, s, rng, 800);
  }),
};

// ----------------------------------------------------------------------------
//  WORLD CONSTRUCTION
// ----------------------------------------------------------------------------
const world = { gens: [], gate: null, lamps: [], exitLight: null };
function buildWorld() {
  // Floor & ceiling
  const floorMat = new THREE.MeshStandardMaterial({ map: TEX.floor, roughness: 0.85, metalness: 0.05 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(MW * TILE, MH * TILE), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.position.set((MW * TILE) / 2, 0, (MH * TILE) / 2); floor.receiveShadow = true;
  scene.add(reg(floor));
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(MW * TILE, MH * TILE), new THREE.MeshStandardMaterial({ map: TEX.ceil, roughness: 1 }));
  ceil.rotation.x = Math.PI / 2; ceil.position.set((MW * TILE) / 2, WALL_H, (MH * TILE) / 2);
  scene.add(reg(ceil));

  // Walls (only those touching walkable space) merged into one draw call
  const wallGeos = [], crateGeos = [];
  const walkable = (c) => !'#'.includes(c);
  for (let z = 0; z < MH; z++) for (let x = 0; x < MW; x++) {
    const c = grid[z][x];
    const p = tileCenter(x, z);
    if (c === '#') {
      if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => walkable(cell(x + dx, z + dz)))) continue;
      const g = new THREE.BoxGeometry(TILE, WALL_H, TILE); g.translate(p.x, WALL_H / 2, p.z); wallGeos.push(g);
    } else if (c === 'C') {
      const g = new THREE.BoxGeometry(1.8, 1.8, 1.8); g.rotateY((x * 7 + z * 3) % 5 * 0.12); g.translate(p.x, 0.9, p.z); crateGeos.push(g);
      if ((x + z) % 2 === 0) { const g2 = new THREE.BoxGeometry(1.1, 1.1, 1.1); g2.rotateY(0.6); g2.translate(p.x + 0.2, 2.35, p.z - 0.1); crateGeos.push(g2); }
    }
  }
  const walls = new THREE.Mesh(mergeGeometries(wallGeos), new THREE.MeshStandardMaterial({ map: TEX.wall, roughness: 0.9 }));
  walls.castShadow = walls.receiveShadow = true;
  scene.add(reg(walls));
  const crates = new THREE.Mesh(mergeGeometries(crateGeos), new THREE.MeshStandardMaterial({ map: TEX.crate, roughness: 0.8 }));
  crates.castShadow = crates.receiveShadow = true;
  scene.add(reg(crates));

  // Generators
  GEN_TILES.forEach((t, i) => {
    const g = new THREE.Group();
    const p = tileCenter(t.x, t.z); g.position.copy(p);
    const metal = new THREE.MeshStandardMaterial({ color: 0x5b5e57, roughness: 0.55, metalness: 0.6 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.0, 0.9), metal); body.position.y = 0.5;
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.1, 14), new THREE.MeshStandardMaterial({ color: 0x7a2a1d, roughness: 0.6, metalness: 0.3 }));
    tank.rotation.z = Math.PI / 2; tank.position.set(0, 1.2, 0);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 8), metal); pipe.position.set(0.5, 1.4, 0.3);
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2200, emissiveIntensity: 3 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), lampMat); lamp.position.set(0, 1.05, 0.46);
    for (const m of [body, tank, pipe]) { m.castShadow = true; m.receiveShadow = true; }
    g.add(body, tank, pipe, lamp);
    reg(g, 'gen');
    const light = new THREE.PointLight(0xff3010, 3, 7, 2); light.position.set(0, 1.4, 0.8); g.add(light); survivorOnly.push(light);
    scene.add(g);
    world.gens.push({ group: g, lampMat, light, pos: p, shake: 0 });
  });

  // Exit gate + escape zone
  const gp = tileCenter(GATE_TILE.x, GATE_TILE.z);
  const gate = new THREE.Mesh(new THREE.BoxGeometry(TILE, WALL_H, TILE * 0.5), new THREE.MeshStandardMaterial({ map: TEX.gate, roughness: 0.5, metalness: 0.7 }));
  gate.position.set(gp.x, WALL_H / 2, gp.z); gate.castShadow = true;
  scene.add(reg(gate)); world.gate = gate;
  const signTex = canvasTex(256, (g, s) => {
    g.fillStyle = '#062a12'; g.fillRect(0, 0, s, s / 2);
    g.fillStyle = '#39ff8a'; g.font = 'bold 72px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('EXIT', s / 2, s / 4);
  });
  signTex.repeat.set(1, 2);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.35), new THREE.MeshBasicMaterial({ map: signTex, toneMapped: false }));
  sign.position.set(gp.x, WALL_H - 0.35, gp.z - TILE / 2 - 0.25);
  sign.lookAt(gp.x, WALL_H - 0.35, gp.z - TILE * 2);
  scene.add(reg(sign, 'gen'));
  const exitLight = new THREE.PointLight(0x2cff70, 4, 10, 2); exitLight.position.set(gp.x, WALL_H - 0.6, gp.z - TILE * 0.7);
  scene.add(exitLight); survivorOnly.push(exitLight); world.exitLight = exitLight;

  // Ceiling lamps (fixture meshes + a capped number of real point lights)
  const fixtureMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xfff1c4, emissiveIntensity: 2.5 });
  let lightsPlaced = 0;
  const rng = mulberry32(42);
  for (const t of FLOOR_TILES) {
    if (!((t.x % 5 === 2 && t.z % 4 === 1) || (t.x % 6 === 4 && t.z % 5 === 3))) continue;
    const p = tileCenter(t.x, t.z);
    const fx = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.25), fixtureMat.clone());
    fx.position.set(p.x, WALL_H - 0.04, p.z); scene.add(reg(fx, 'env'));
    let light = null;
    if (lightsPlaced < 7) {
      light = new THREE.PointLight(0xffe2b0, 30, 18, 1.5); light.position.set(p.x, WALL_H - 0.3, p.z);
      scene.add(light); survivorOnly.push(light); lightsPlaced++;
    }
    world.lamps.push({ fx, light, base: light ? light.intensity : 0, phase: rng() * 100, bad: rng() < 0.4, dead: false });
  }

  scene.add(new THREE.HemisphereLight(0x8a96a0, 0x3a2e1e, 2.6));
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
function prepMonsterAsset(gltf) {
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.material.side = THREE.FrontSide;
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
  });
  return { template: normalizeModel(gltf.scene, 2.7, Math.PI) };
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
    rig.add(ASSETS.monster.template.clone(true));
    reg(g, 'entity');
    g.userData.rig = rig;
    scene.add(g);
    return g;
  }
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
  gens: GEN_TILES.map(() => ({ progress: 0, done: false })),
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
      if (cell(Math.floor(p.x / TILE), Math.floor(p.z / TILE)) !== 'X') return;
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
  if (best.hp <= 0) best.s = 'caught';
  broadcast({ t: 'event', k: 'hit', id: best.id, name: best.name, hp: best.hp, x: best.x, z: best.z });
}
function hostRepair(p, gi, dt) {
  if (!p || p.isMonster || p.s !== 'alive' || hs.phase !== 'playing') return;
  const g = hs.gens[gi], t = GEN_TILES[gi];
  if (!g || g.done) return;
  const gp = tileCenter(t.x, t.z);
  if (Math.hypot(p.x - gp.x, p.z - gp.z) > 3.2) return;
  g.progress = Math.min(1, g.progress + clamp(+dt || 0, 0, 0.5) / CFG.GEN_TIME);
  if (g.progress >= 1 && !g.done) {
    g.done = true;
    broadcast({ t: 'event', k: 'gen', i: gi, x: gp.x, z: gp.z, left: hs.gens.filter((x) => !x.done).length });
    if (hs.gens.every((x) => x.done) && !hs.gateOpen) {
      hs.gateOpen = true;
      const d = tileCenter(GATE_TILE.x, GATE_TILE.z);
      broadcast({ t: 'event', k: 'gate', x: d.x, z: d.z });
    }
  }
}
function hostStart() {
  const list = Object.values(hs.players);
  if (!list.some((p) => p.isMonster)) addFeed('Starting without a monster (testing mode).', 'warn');
  let si = 0;
  list.forEach((p, idx) => {
    p.hp = CFG.MAX_HP; p.s = 'alive'; p.n = 0; p.c = 0; p.r = 0; p.lastHit = -99; p.lastAttack = -99; p.colorIdx = idx;
    let t;
    if (p.isMonster) t = SPAWN_M; else { t = SPAWN_S[si % SPAWN_S.length]; si++; }
    const c = tileCenter(t.x, t.z);
    const off = p.isMonster ? 0 : Math.floor((si - 1) / SPAWN_S.length);
    p.x = c.x + (off % 2) * 1.6; p.z = c.z + Math.floor(off / 2) * 1.6; p.ry = Math.random() * Math.PI * 2;
    p.bot = p.isBot ? newBrain(p) : null;
  });
  hs.phase = 'playing'; hs.timeLeft = CFG.DURATION; hs.gateOpen = false;
  hs.gens = GEN_TILES.map(() => ({ progress: 0, done: false }));
  broadcast({ t: 'start', duration: CFG.DURATION, players: list.map((p) => ({ id: p.id, name: p.name, isMonster: p.isMonster, isBot: p.isBot, x: p.x, z: p.z, ry: p.ry, colorIdx: p.colorIdx })) });
}
function hostUpdate(dt) {
  if (hs.phase !== 'playing') return;
  hs.timeLeft -= dt;
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
const tileOf = (x, z) => ({ x: Math.floor(x / TILE), z: Math.floor(z / TILE) });
function newBrain(p) {
  return p.isMonster
    ? { path: [], goalKey: '', repathT: 0, mode: 'patrol', target: null, preyId: null, hearT: 0, sonarCD: 10, attackCD: 0, wait: 1, stuckT: 0, lx: p.x, lz: p.z }
    : { path: [], goalKey: '', repathT: 0, flee: 0, wait: Math.random() * 1.5, stamina: 1, stuckT: 0, lx: p.x, lz: p.z };
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
function randomFloorTile() { return FLOOR_TILES[Math.floor(Math.random() * FLOOR_TILES.length)]; }
function walkableNeighbour(t) {
  for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if ('.SM'.includes(cell(t.x + dx, t.z + dz))) return { x: t.x + dx, z: t.z + dz };
  return t;
}
function updateBot(p, dt) { if (p.isMonster) updateMonsterBot(p, dt); else updateSurvivorBot(p, dt); }

function updateSurvivorBot(p, dt) {
  const b = p.bot;
  p.r = 0;
  const mon = Object.values(hs.players).find((q) => q.isMonster && q.s === 'alive');
  const dm = mon ? Math.hypot(mon.x - p.x, mon.z - p.z) : Infinity;

  // Panic: the monster is close, so sprint to the far side of the map.
  if (dm < 7 && b.flee <= 0) {
    b.flee = 4 + Math.random() * 2;
    let best = null, bestD = -1;
    for (let i = 0; i < 14; i++) {
      const t = randomFloorTile(), c = tileCenter(t.x, t.z);
      const score = Math.hypot(c.x - mon.x, c.z - mon.z) - Math.hypot(c.x - p.x, c.z - p.z) * 0.3;
      if (score > bestD) { bestD = score; best = t; }
    }
    b.goalKey = ''; botPathTo(p, b, best);
  }
  if (b.flee > 0) {
    b.flee -= dt;
    const sprint = b.stamina > 0.05;
    b.stamina = clamp(b.stamina - (sprint ? dt / 4 : -dt * 0.15), 0, 1);
    const mode = sprint ? 'sprint' : 'walk';
    p.n = CFG.NOISE[mode]; p.c = 0;
    if (botStep(p, b, CFG.SPEED[mode], CFG.SURV_R, dt)) b.flee = 0;
    return;
  }
  b.stamina = clamp(b.stamina + dt * 0.2, 0, 1);
  if (b.wait > 0) { b.wait -= dt; p.n = 0; return; }

  // Sneak when the monster is within earshot, otherwise walk.
  const mode = dm < 16 ? 'crouch' : 'walk';
  p.c = mode === 'crouch' ? 1 : 0;

  if (hs.gateOpen) {
    const exit = findTiles('X')[0];
    botPathTo(p, b, exit, true);
    p.n = CFG.NOISE[mode];
    botStep(p, b, CFG.SPEED[mode], CFG.SURV_R, dt);
    if (cell(Math.floor(p.x / TILE), Math.floor(p.z / TILE)) === 'X') {
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
    const c = tileCenter(GEN_TILES[i].x, GEN_TILES[i].z), d = Math.hypot(c.x - p.x, c.z - p.z);
    const score = d + (taken.has(i) ? 40 : 0);
    if (score < best) { best = score; gd = d; gi = i; }
  });
  b.gen = gi;
  if (gi < 0) { p.n = 0; return; }
  if (gd < 2.3) {
    // Repair at 60% of a human's speed so a hunting monster has time to interrupt.
    p.r = 1; p.c = 0; p.n = CFG.NOISE.repair;
    const c = tileCenter(GEN_TILES[gi].x, GEN_TILES[gi].z);
    p.ry = Math.atan2(-(c.x - p.x), -(c.z - p.z));
    hostRepair(p, gi, dt * 0.6);
    return;
  }
  botPathTo(p, b, walkableNeighbour(GEN_TILES[gi]));
  p.n = CFG.NOISE[mode];
  if (botStep(p, b, CFG.SPEED[mode], CFG.SURV_R, dt) && gd >= 2.3) {
    // Arrived next to the generator tile: shuffle in close.
    const c = tileCenter(GEN_TILES[gi].x, GEN_TILES[gi].z);
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
    const t = Math.random() < 0.6 ? walkableNeighbour(GEN_TILES[Math.floor(Math.random() * GEN_TILES.length)]) : randomFloorTile();
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
      me.eye = me.isMonster ? 2.3 : 1.6;
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
  if (world.gate) world.gate.position.y = WALL_H / 2;
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
    if (r.status !== s.s) { r.status = s.s; r.avatar.visible = s.s === 'alive'; }
  }
  for (const id of [...players.keys()]) if (!seen.has(id)) removeRemote(id);
}
function setMyStatus(s) {
  const prev = me.status; me.status = s;
  if (s === prev || me.isMonster) return;
  if (s === 'caught') addFeed('You were taken. Spectating — press V for monster vision.', 'bad');
  if (s === 'escaped') addFeed('You escaped! Spectating — press V for monster vision.', 'good');
}
function onEvent(e) {
  const pos = new THREE.Vector3(e.x || 0, 0.1, e.z || 0);
  switch (e.k) {
    case 'hit': {
      addRipple(pos, 14, 1.6, 12);
      if (e.id === me.id) {
        me.damage = 1; me.boost = 2.5; sfx.hit();
        if (e.hp <= 0) setMyStatus('caught'); else addFeed('You are wounded! RUN.', 'bad');
      } else {
        if (me.isMonster) { sfx.hit(); addFeed(e.hp <= 0 ? `${e.name} was taken.` : `You wounded ${e.name}.`, 'good'); }
        else { addFeed(e.hp <= 0 ? `${e.name} was taken.` : `${e.name} was wounded.`, 'bad'); noise({ dur: 0.4, vol: 0.25 * distVol(pos, 40), pan: panOf(pos), freq: 600 }); }
        const r = players.get(e.id); if (r && e.hp <= 0) { r.status = 'caught'; r.avatar.visible = false; }
      }
      break;
    }
    case 'sonar': {
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
function updateLocal(dt) {
  me.attackCD = Math.max(0, me.attackCD - dt);
  me.sonarCD = Math.max(0, me.sonarCD - dt);
  me.boost = Math.max(0, me.boost - dt);
  me.damage = Math.max(0, me.damage - dt * 1.2);
  me.lunge = Math.max(0, me.lunge - dt * 4);

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
    GEN_TILES.forEach((t, i) => {
      if (game.gens[i].done) return;
      const d = Math.hypot(me.pos.x - (t.x + 0.5) * TILE, me.pos.z - (t.z + 0.5) * TILE);
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
  if (!me.isMonster && game.gateOpen && !me.escapeSent && cell(Math.floor(me.pos.x / TILE), Math.floor(me.pos.z / TILE)) === 'X') {
    me.escapeSent = true; sendToHost({ t: 'escape' });
  }

  const targetEye = me.isMonster ? 2.3 : me.crouch ? 1.0 : 1.6;
  me.eye = damp(me.eye, targetEye, 10, dt);
  me.bob += moving ? dt * speed * 2.2 : 0;
  applyCamera(dt, moving ? (me.isMonster ? 0.06 : 0.04) * (speed / 3.4) : 0);
}
function applyCamera(dt, bobAmp) {
  camera.position.set(me.pos.x, me.eye + Math.sin(me.bob) * bobAmp, me.pos.z);
  if (me.lunge > 0) { camera.position.x -= Math.sin(me.yaw) * me.lunge * 0.3; camera.position.z -= Math.cos(me.yaw) * me.lunge * 0.3; }
  camera.rotation.set(me.pitch, me.yaw, Math.sin(me.bob * 0.5) * bobAmp * 0.3);
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
    const rig = a.userData.rig;
    const mixer = a.userData.mixer, acts = a.userData.acts;
    if (mixer && acts?.walk) {
      // Blend idle <-> walk by speed; play the walk faster when sprinting.
      const w = clamp(r.speed / 1.5, 0, 1);
      acts.walk.setEffectiveWeight(w); acts.idle.setEffectiveWeight(1 - w);
      acts.walk.timeScale = clamp(r.speed / 3.2, 0.5, 2);
      mixer.update(dt);
    } else rig.position.y = Math.abs(Math.sin(r.walkT)) * 0.05 * Math.min(r.speed, 2);
    rig.scale.y = damp(rig.scale.y, r.crouch ? 0.68 : 1, 10, dt);
    if (r.isMonster) {
      // The monster model is static, so give it a hunched, lurching gait procedurally.
      const gait = Math.min(r.speed, 6);
      rig.rotation.x = 0.1 + gait * 0.025 + Math.sin(time * 1.3) * 0.03;
      rig.rotation.z = Math.sin(r.walkT * 0.5) * 0.05 * Math.min(gait, 1.5);
      rig.position.y = Math.abs(Math.sin(r.walkT * 0.5)) * 0.08 * Math.min(gait, 1.5) + Math.sin(time * 2) * 0.015;
      const al = rig.getObjectByName('armL'), ar = rig.getObjectByName('armR');
      if (al) { al.rotation.x = -0.25 + Math.sin(r.walkT) * 0.4; ar.rotation.x = -0.25 - Math.sin(r.walkT) * 0.4; }
    }
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
  // Lamps flicker
  for (const l of world.lamps) {
    if (!l.light) continue;
    let k = 1;
    if (l.bad) { const f = Math.sin(time * 13 + l.phase) * Math.sin(time * 4.7 + l.phase * 2); k = f > 0.6 ? 0.05 : 0.85 + Math.random() * 0.15; }
    else k = 0.92 + Math.sin(time * 40 + l.phase) * 0.04;
    l.light.intensity = l.base * k;
    l.fx.material.emissiveIntensity = 2.5 * k;
  }
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
  if (world.gate) world.gate.position.y = damp(world.gate.position.y, game.gateOpen ? WALL_H * 1.5 + 0.05 : WALL_H / 2, 0.8, dt);
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
  if (me.status !== 'alive' && !me.isMonster) prompt = `Spectating · WASD fly · Space/C up/down · V ${viewMode === 'monster' ? 'normal' : 'monster'} vision`;
  if (me.isMonster) {
    $('#sonar-fill').style.width = `${(1 - me.sonarCD / CFG.SONAR_CD) * 100}%`;
    $('#attack-fill').style.width = `${(1 - me.attackCD / CFG.ATTACK_CD) * 100}%`;
    $('#mstamina-fill').style.width = `${me.stamina * 100}%`;
    let prey = 0; for (const r of players.values()) if (!r.isMonster && r.status === 'alive') prey++;
    $('#prey-count').textContent = prey;
  } else {
    $('#hp-pips').innerHTML = Array.from({ length: CFG.MAX_HP }, (_, i) => `<span class="${i < me.hp ? 'on' : ''}"></span>`).join('');
    $('#stamina-fill').style.width = `${me.stamina * 100}%`;
    $('#stamina-fill').style.background = me.exhausted ? '#ff3b3b' : '';
    $('#noise-fill').style.width = `${me.noise * 100}%`;
    if (me.status === 'alive') {
      if (me.repairGen >= 0) prompt = `${me.repairing ? 'Repairing' : 'Hold E to repair'} — ${Math.floor(game.gens[me.repairGen].progress * 100)}%`;
      else if (game.gateOpen && cell(Math.floor(me.pos.x / TILE), Math.floor(me.pos.z / TILE)) !== 'X') prompt = '';
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
  const cx = (MW * TILE) / 2, cz = (MH * TILE) / 2;
  const a = time * 0.05;
  camera.position.set(cx + Math.cos(a) * 55, 48, cz + Math.sin(a) * 45);
  camera.lookAt(cx, 0, cz);
  lobbyPingT -= dt;
  if (lobbyPingT <= 0) {
    lobbyPingT = 0.35 + Math.random() * 0.6;
    const t = FLOOR_TILES[Math.floor(Math.random() * FLOOR_TILES.length)];
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

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
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
window.BLINDSIGHT = { CFG, game, me, players, hs, net, setViewMode, addRipple, ASSETS, THREE, hostUpdate };
