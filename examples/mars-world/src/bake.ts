import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

const MAPS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
  'alphaMap',
  'bumpMap',
]

/** Materials that look the same share a key, so their meshes can become one. */
function materialKey(material: THREE.Material): string {
  const m = material as THREE.MeshStandardMaterial
  if (!m.isMeshStandardMaterial || MAPS.some((k) => (m as unknown as Record<string, unknown>)[k]))
    return material.uuid
  return [
    m.type,
    m.color.getHex(),
    m.emissive.getHex(),
    m.emissiveIntensity,
    m.roughness,
    m.metalness,
    m.side,
    m.transparent,
    m.opacity,
    m.envMapIntensity,
  ].join('|')
}

/**
 * Merges the static meshes under `root` into one mesh per look. Every mesh is a draw call, and in
 * every pass (colour, ambient occlusion, shadows), so a model of hundreds of parts costs far more
 * main-thread time than its triangles. Meshes under any of `keep` (they move, or anchor a tag) stay.
 */
export function bake(root: THREE.Object3D, keep: THREE.Object3D[] = []): void {
  root.updateMatrixWorld(true)
  const inverse = root.matrixWorld.clone().invert()
  const groups = new Map<string, { material: THREE.Material; meshes: THREE.Mesh[] }>()
  const skip = (o: THREE.Object3D) => keep.includes(o)
  const visit = (o: THREE.Object3D) => {
    if (skip(o)) return
    const mesh = o as THREE.Mesh
    if (
      mesh.isMesh &&
      mesh.children.length === 0 &&
      !(mesh as THREE.SkinnedMesh).isSkinnedMesh &&
      !(mesh as THREE.InstancedMesh).isInstancedMesh &&
      !Array.isArray(mesh.material) &&
      Object.keys(mesh.geometry.morphAttributes).length === 0
    ) {
      const g = mesh.geometry
      const key = `${materialKey(mesh.material)}#${Object.keys(g.attributes).sort().join(',')}#${g.index ? 'i' : 'n'}`
      const group = groups.get(key) ?? { material: mesh.material, meshes: [] }
      group.meshes.push(mesh)
      groups.set(key, group)
    }
    for (const child of o.children) visit(child)
  }
  visit(root)
  for (const { material, meshes } of groups.values()) {
    if (meshes.length < 2) continue
    const geometries = meshes.map((m) =>
      m.geometry.clone().applyMatrix4(inverse.clone().multiply(m.matrixWorld)),
    )
    const merged = mergeGeometries(geometries)
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, material)
    mesh.castShadow = meshes.some((m) => m.castShadow)
    mesh.receiveShadow = meshes.some((m) => m.receiveShadow)
    for (const m of meshes) m.removeFromParent()
    root.add(mesh)
  }
}
