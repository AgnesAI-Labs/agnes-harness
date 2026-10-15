// Convert licensed glTF/GLB assets to interleaved position/color triangles for the offline renderer.
// Usage: node tools/bake-models.mjs /path/to/draco3dgltf@1.5.7/draco3dgltf.js
// Draco is a conversion tool only; no runtime decoder or network request is shipped.
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const root = new URL('../client/assets/', import.meta.url)
const draco = (await import(pathToFileURL(process.argv[2]).href)).default
const decoder = await draco.createDecoderModule({})
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const multiply = (a, b) =>
  Array.from({ length: 16 }, (_, i) =>
    Array.from({ length: 4 }, (_, k) => a[k * 4 + (i % 4)] * b[Math.floor(i / 4) * 4 + k]).reduce(
      (s, v) => s + v,
      0,
    ),
  )
function transform(n) {
  if (n.matrix) return n.matrix
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1],
    s = n.scale ?? [1, 1, 1],
    t = n.translation ?? [0, 0, 0]
  return [
    (1 - 2 * y * y - 2 * z * z) * s[0],
    (2 * x * y + 2 * w * z) * s[0],
    (2 * x * z - 2 * w * y) * s[0],
    0,
    (2 * x * y - 2 * w * z) * s[1],
    (1 - 2 * x * x - 2 * z * z) * s[1],
    (2 * y * z + 2 * w * x) * s[1],
    0,
    (2 * x * z + 2 * w * y) * s[2],
    (2 * y * z - 2 * w * x) * s[2],
    (1 - 2 * x * x - 2 * y * y) * s[2],
    0,
    ...t,
    1,
  ]
}
async function bake(path, out) {
  const url = new URL(path, root),
    bytes = await readFile(url)
  let json,
    buffers = []
  if (path.endsWith('.glb')) {
    const length = bytes.readUInt32LE(12)
    json = JSON.parse(bytes.subarray(20, 20 + length).toString())
    buffers = [bytes.subarray(28 + length)]
  } else {
    json = JSON.parse(bytes.toString())
    buffers = await Promise.all(json.buffers.map((b) => readFile(new URL(b.uri, url))))
  }
  function accessor(index) {
    const a = json.accessors[index],
      v = json.bufferViews[a.bufferView],
      b = buffers[v.buffer],
      size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type],
      unit = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType]
    return Array.from({ length: a.count * size }, (_, i) => {
      const offset =
        (v.byteOffset ?? 0) +
        (a.byteOffset ?? 0) +
        Math.floor(i / size) * (v.byteStride ?? size * unit) +
        (i % size) * unit
      return a.componentType === 5126
        ? b.readFloatLE(offset)
        : unit === 4
          ? b.readUInt32LE(offset)
          : unit === 2
            ? b.readUInt16LE(offset)
            : b[offset]
    })
  }
  const vertices = []
  function visit(index, parent) {
    const node = json.nodes[index],
      m = multiply(parent, transform(node))
    if (node.bin !== undefined)
      for (const primitive of json.bines[node.bin].primitives) {
        let positions, indices
        const compressed = primitive.extensions?.KHR_draco_mesh_compression
        if (compressed) {
          const v = json.bufferViews[compressed.bufferView],
            b = buffers[v.buffer].subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength),
            dec = new decoder.Decoder(),
            input = new decoder.DecoderBuffer(),
            mesh = new decoder.Mesh()
          input.Init(new Int8Array(b), b.length)
          const status = dec.DecodeBufferToMesh(input, mesh)
          if (!status.ok()) throw new Error('Draco decode failed')
          const attr = dec.GetAttributeByUniqueId(mesh, compressed.attributes.POSITION),
            values = new decoder.DracoFloat32Array(),
            faces = new decoder.DracoInt32Array()
          dec.GetAttributeFloatForAllPoints(mesh, attr, values)
          positions = Array.from({ length: values.size() }, (_, i) => values.GetValue(i))
          indices = []
          for (let i = 0; i < mesh.num_faces(); i++) {
            dec.GetFaceFromMesh(mesh, i, faces)
            for (let k = 0; k < 3; k++) indices.push(faces.GetValue(k))
          }
          for (const obj of [values, faces, mesh, input, dec]) decoder.destroy(obj)
        } else {
          positions = accessor(primitive.attributes.POSITION)
          indices =
            primitive.indices === undefined
              ? Array.from({ length: positions.length / 3 }, (_, i) => i)
              : accessor(primitive.indices)
        }
        const color = json.materials?.[primitive.material]?.pbrMetallicRoughness?.baseColorFactor ?? [
          0.6, 0.58, 0.53,
        ]
        for (let i = 0; i < indices.length; i += 3) {
          const points = indices
            .slice(i, i + 3)
            .map((j) =>
              [0, 1, 2].map(
                (r) =>
                  m[r] * positions[j * 3] +
                  m[4 + r] * positions[j * 3 + 1] +
                  m[8 + r] * positions[j * 3 + 2] +
                  m[12 + r],
              ),
            )
          const a = points[1].map((v, k) => v - points[0][k]),
            b = points[2].map((v, k) => v - points[0][k]),
            normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
          const light = 0.45 + (0.55 * Math.abs(normal[1])) / (Math.hypot(...normal) || 1)
          for (const p of points) vertices.push(...p, ...color.slice(0, 3).map((c) => c * light))
        }
      }
    for (const child of node.children ?? []) visit(child, m)
  }
  for (const index of json.scenes[json.scene ?? 0].nodes) visit(index, identity)
  const data = new Float32Array(vertices),
    bytesOut = new Uint8Array(data.buffer)
  await writeFile(new URL(out, root), bytesOut)
  console.log(out, bytesOut.length)
}
await bake('nasa/perseverance.glb', 'rover.bin')
await bake('nasa/mark3_suit.glb', 'suit.bin')
for (const name of ['moon_rock_01', 'moon_rock_03', 'moon_rock_05', 'moon_rock_07', 'namaqualand_boulder_02'])
  await bake(`models/${name}/${name}.gltf`, `${name}.bin`)
