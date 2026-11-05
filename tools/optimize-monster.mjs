// Builds the game-ready, fully rigged wendigo from the 23 MB Sketchfab source:
//   1. joins the body (exported as eight interleaved 65k-vertex chunks) back into one mesh,
//      welds it and simplifies it to roughly 12% of the triangles,
//   2. bakes node transforms and rescales it to 7 ft (2.13 m), feet on y = 0, facing +Z,
//   3. builds a humanoid skeleton (spine, neck, head, clavicles, arms, hands, claws,
//      legs, feet, toes) at joint positions measured from the T-posed mesh,
//   4. skins every vertex to up to four bones, blending smoothly across each joint,
//   5. regenerates normals, resizes textures to 1024 px WebP and quantizes normals/UVs.
// The game builds its animation clips (idle, walk, run, stalk, swipes, kill, shriek)
// at runtime against these bone names.
//
// Usage (needs @gltf-transform/{core,extensions,functions}, meshoptimizer and sharp):
//   node tools/optimize-monster.mjs assets/source/wendigo-original.glb assets/monster.glb
import { NodeIO, Accessor } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, normals, dedup, prune, quantize, textureCompress, join, flatten, clearNodeTransform } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const [,, inp, out] = process.argv;
const HEIGHT = 2.13; // 7 ft

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const root = doc.getRoot();
const buffer = root.listBuffers()[0];

// Per-face normals/tangents stop coincident vertices from merging; they are rebuilt later.
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
  p.setAttribute('NORMAL', null); p.setAttribute('TANGENT', null);
}
await MeshoptSimplifier.ready;
await doc.transform(dedup(), flatten(), join({ keepNamed: false }), weld());
for (const node of root.listNodes()) if (node.getMesh()) clearNodeTransform(node);
await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: 0.12, error: 0.004 }));

// ---- Rescale to 7 ft, feet at y = 0, centred on x/z ----------------------------
const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
let minY = Infinity, maxY = -Infinity;
for (const p of prims) {
  const a = p.getAttribute('POSITION'), v = [0, 0, 0];
  for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]); }
}
const S = HEIGHT / (maxY - minY);
for (const p of prims) {
  const a = p.getAttribute('POSITION'), v = [0, 0, 0];
  for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); a.setElement(i, [v[0] * S, (v[1] - minY) * S, v[2] * S]); }
}

// ---- Skeleton ------------------------------------------------------------------
// Joint positions (metres, model faces +Z, +X is the creature's left), measured by
// slicing the T-posed mesh: the legs separate below 1.22 m, the arms run level at
// 1.76 m, thinnest at the elbow (0.56) and wrist (0.88), and the long claws start at 1.08.
const J = {
  Hips: [0, 1.22, -0.065], Spine: [0, 1.40, -0.06], Chest: [0, 1.62, -0.055], Neck: [0, 1.84, -0.045], Head: [0, 1.93, 0.0],
};
for (const [side, s] of [['L', 1], ['R', -1]]) {
  J['Clavicle' + side] = [0.04 * s, 1.74, -0.06];
  J['UpperArm' + side] = [0.13 * s, 1.76, -0.065];
  J['Forearm' + side] = [0.56 * s, 1.76, -0.07];
  J['Hand' + side] = [0.88 * s, 1.75, -0.085];
  J['Claws' + side] = [1.08 * s, 1.75, -0.09];
  J['UpLeg' + side] = [0.075 * s, 1.18, -0.065];
  J['Leg' + side] = [0.12 * s, 0.66, -0.075];
  J['Foot' + side] = [0.19 * s, 0.11, -0.165];
  J['Toe' + side] = [0.2 * s, 0.03, -0.05];
}
const PARENT = { Hips: null, Spine: 'Hips', Chest: 'Spine', Neck: 'Chest', Head: 'Neck' };
for (const side of ['L', 'R']) {
  Object.assign(PARENT, {
    ['Clavicle' + side]: 'Chest', ['UpperArm' + side]: 'Clavicle' + side, ['Forearm' + side]: 'UpperArm' + side,
    ['Hand' + side]: 'Forearm' + side, ['Claws' + side]: 'Hand' + side,
    ['UpLeg' + side]: 'Hips', ['Leg' + side]: 'UpLeg' + side, ['Foot' + side]: 'Leg' + side, ['Toe' + side]: 'Foot' + side,
  });
}
const names = Object.keys(J);
const index = Object.fromEntries(names.map((n, i) => [n, i]));
const scene = root.listScenes()[0];
const armature = doc.createNode('Armature');
scene.addChild(armature);
const nodes = {};
for (const n of names) {
  const p = J[n], par = PARENT[n];
  const local = par ? [p[0] - J[par][0], p[1] - J[par][1], p[2] - J[par][2]] : p;
  nodes[n] = doc.createNode(n).setTranslation(local);
}
for (const n of names) (PARENT[n] ? nodes[PARENT[n]] : armature).addChild(nodes[n]);
const skin = doc.createSkin('WendigoSkin').setSkeleton(nodes.Hips);
const ibm = new Float32Array(names.length * 16);
names.forEach((n, i) => {
  skin.addJoint(nodes[n]);
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -J[n][0], -J[n][1], -J[n][2], 1]; // inverse of a pure translation
  ibm.set(m, i * 16);
});
skin.setInverseBindMatrices(doc.createAccessor('ibm').setType(Accessor.Type.MAT4).setArray(ibm).setBuffer(buffer));
for (const node of root.listNodes()) if (node.getMesh()) node.setSkin(skin);

// ---- Skin weights ----------------------------------------------------------------
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// Weights along a chain of bones laid out on one scalar coordinate c (joint starts ascending).
function chain(c, starts, bones, blend, out, scale) {
  for (let k = 0; k < bones.length; k++) {
    const lo = k === 0 ? -Infinity : starts[k], hi = k === bones.length - 1 ? Infinity : starts[k + 1];
    const w = (k === 0 ? 1 : smooth(lo - blend, lo + blend, c)) * (hi === Infinity ? 1 : 1 - smooth(hi - blend, hi + blend, c));
    if (w > 1e-4) out[bones[k]] = (out[bones[k]] || 0) + w * scale;
  }
}
function weightsFor(x, y, z) {
  const w = {};
  const s = x >= 0 ? 'L' : 'R', ax = Math.abs(x);
  // Region masks: arms (outboard at shoulder height), legs (below the crotch), torso (rest).
  const armMask = smooth(0.08, 0.15, ax) * smooth(1.6, 1.68, y);
  const legMask = (1 - smooth(1.14, 1.3, y)) * (1 - armMask);
  const torsoMask = Math.max(0, 1 - armMask - legMask);
  if (armMask > 0) chain(ax, [0.04, 0.13, 0.56, 0.88, 1.08], ['Clavicle', 'UpperArm', 'Forearm', 'Hand', 'Claws'].map((b) => b + s), 0.04, w, armMask);
  if (torsoMask > 0) chain(y, [1.22, 1.40, 1.62, 1.84, 1.93], ['Hips', 'Spine', 'Chest', 'Neck', 'Head'], 0.06, w, torsoMask);
  if (legMask > 0) {
    // Down the leg: thigh, shin, then the foot, whose front splits off as the toes.
    const legW = {};
    chain(-y, [-1.22, -0.66, -0.11], ['UpLeg' + s, 'Leg' + s, 'Foot' + s], 0.05, legW, 1);
    const foot = legW['Foot' + s] || 0;
    if (foot > 0) { const toe = smooth(-0.09, -0.02, z); legW['Foot' + s] = foot * (1 - toe); legW['Toe' + s] = foot * toe; }
    for (const [b, v] of Object.entries(legW)) w[b] = (w[b] || 0) + v * legMask;
  }
  // Keep the four strongest and normalise.
  const top = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = top.reduce((a, [, v]) => a + v, 0) || 1;
  return top.map(([b, v]) => [index[b], v / sum]);
}
for (const p of prims) {
  const a = p.getAttribute('POSITION'), n = a.getCount(), v = [0, 0, 0];
  const joints = new Uint8Array(n * 4), weights = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    a.getElement(i, v);
    weightsFor(v[0], v[1], v[2]).forEach(([j, wt], k) => { joints[i * 4 + k] = j; weights[i * 4 + k] = wt; });
  }
  p.setAttribute('JOINTS_0', doc.createAccessor().setType(Accessor.Type.VEC4).setArray(joints).setBuffer(buffer));
  p.setAttribute('WEIGHTS_0', doc.createAccessor().setType(Accessor.Type.VEC4).setArray(weights).setBuffer(buffer));
}

await doc.transform(
  normals({ overwrite: true }),
  weld(),
  prune({ keepLeaves: true }), // keep leaf bones (head, claws, toes)
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
  quantize({ pattern: /^(NORMAL|TEXCOORD_\d+|WEIGHTS_\d+)$/ }),
);
await io.write(out, doc);
let verts = 0; for (const p of root.listMeshes().flatMap((m) => m.listPrimitives())) verts += p.getAttribute('POSITION').getCount();
console.log(`wrote ${out}: ${verts} vertices, ${names.length} bones, height ${HEIGHT} m`);
