// Turns the 23 MB Sketchfab wendigo into a light, game-ready model:
//   1. joins the body (exported as eight interleaved 65k-vertex chunks) back into one mesh,
//   2. welds and simplifies it to roughly 12% of the triangles,
//   3. bakes node transforms into world space and swings the T-posed arms down to hang
//      by its sides (the source has no skeleton, so this is a one-off vertex bend),
//   4. stores a per-vertex arm weight (_ARM: -1 one arm, +1 the other, 0 body) and the
//      shoulder pivot (scene extras.armPivot) so the game can swing the arms in a shader,
//   5. regenerates smooth normals, resizes textures to 1024 px WebP, and quantizes.
//
// Usage (needs @gltf-transform/{core,extensions,functions}, meshoptimizer and sharp):
//   node tools/optimize-monster.mjs assets/source/wendigo-original.glb assets/monster.glb
import { NodeIO, Accessor } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, normals, dedup, prune, quantize, textureCompress, join, flatten, clearNodeTransform } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const [,, inp, out] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const root = doc.getRoot();

// Per-face normals/tangents stop coincident vertices from merging; they are rebuilt later.
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
  p.setAttribute('NORMAL', null); p.setAttribute('TANGENT', null);
}
await MeshoptSimplifier.ready;
await doc.transform(dedup(), flatten(), join({ keepNamed: false }), weld());
// Bake every mesh node's transform into its vertices so we can edit in world space (Y up).
for (const node of root.listNodes()) if (node.getMesh()) clearNodeTransform(node);
await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: 0.12, error: 0.004 }));

// ---- Arm bend --------------------------------------------------------------
const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
let minY = Infinity, maxY = -Infinity, maxX = 0;
for (const p of prims) {
  const a = p.getAttribute('POSITION'), v = [0, 0, 0];
  for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]); maxX = Math.max(maxX, Math.abs(v[0])); }
}
const H = maxY - minY;
// Arm height: mean Y of the outermost vertices. Torso half-width: widest point a little below that.
let sy = 0, n = 0, torso = 0;
for (const p of prims) {
  const a = p.getAttribute('POSITION'), v = [0, 0, 0];
  for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); if (Math.abs(v[0]) > maxX * 0.6) { sy += v[1]; n++; } }
}
const armY = sy / n;
for (const p of prims) {
  const a = p.getAttribute('POSITION'), v = [0, 0, 0];
  for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); if (Math.abs(v[1] - (armY - H * 0.12)) < H * 0.02) torso = Math.max(torso, Math.abs(v[0])); }
}
const px = torso * 0.9, py = armY, blend = H * 0.07;
const theta = (72 * Math.PI) / 180;       // how far the arms swing down
const reach = (14 * Math.PI) / 180;       // and a little forward (+Z, the model's front)
const smooth = (t) => t * t * (3 - 2 * t);
// Shoulder depth: mean Z of the torso at shoulder height.
let pzSum = 0, pzN = 0;
for (const p of prims) {
  const a = p.getAttribute('POSITION'), v = [0, 0, 0];
  for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); if (Math.abs(v[0]) < px && Math.abs(v[1] - py) < H * 0.03) { pzSum += v[2]; pzN++; } }
}
const pz = pzN ? pzSum / pzN : 0;
const buffer = root.listBuffers()[0];
for (const p of prims) {
  const a = p.getAttribute('POSITION'), v = [0, 0, 0];
  const arm = new Float32Array(a.getCount());
  p.setAttribute('_ARM', doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(arm).setBuffer(buffer));
  for (let i = 0; i < a.getCount(); i++) {
    a.getElement(i, v);
    const s = Math.sign(v[0]), u = Math.abs(v[0]) - px;
    if (u <= 0 || v[1] < py - H * 0.25) continue; // only the arms, never the legs
    const k = smooth(Math.min(1, u / blend));
    arm[i] = s * k;
    const t = theta * k, w = v[1] - py;
    const u2 = u * Math.cos(t) + w * Math.sin(t);
    const w2 = -u * Math.sin(t) + w * Math.cos(t);
    v[0] = s * (px + u2); v[1] = py + w2; v[2] += Math.max(0, u) * Math.sin(reach) * k;
    a.setElement(i, v);
  }
}
root.listScenes()[0].setExtras({ armPivot: [0, py, pz] });
console.log({ H: +H.toFixed(2), armY: +armY.toFixed(2), torso: +torso.toFixed(2), span: +(maxX * 2).toFixed(2), pz: +pz.toFixed(3) });

await doc.transform(
  normals({ overwrite: true }),
  weld(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
  // Positions stay float so the vertex space matches extras.armPivot (no dequantize transform).
  quantize({ pattern: /^(NORMAL|TEXCOORD_\d+)$/ }),
);
await io.write(out, doc);
let verts = 0; for (const p of root.listMeshes().flatMap((m) => m.listPrimitives())) verts += p.getAttribute('POSITION').getCount();
console.log('vertices', verts);
