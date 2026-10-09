import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { clustered } from '../src/terrain.js'

describe('coarse rocks', () => {
  it('clusters a detailed shape into far fewer triangles of about the same size', () => {
    const fine = new THREE.SphereGeometry(1, 96, 64)
    const coarse = clustered(fine, 9)
    const triangles = (g: THREE.BufferGeometry) =>
      (g.index ? g.index.count : g.getAttribute('position').count) / 3
    expect(triangles(coarse)).toBeLessThan(triangles(fine) / 10)
    expect(triangles(coarse)).toBeGreaterThan(50)
    coarse.computeBoundingBox()
    const size = (coarse.boundingBox as THREE.Box3).getSize(new THREE.Vector3())
    expect(size.x).toBeGreaterThan(1.7)
    expect(size.x).toBeLessThanOrEqual(2)
    expect(coarse.getAttribute('uv').count).toBe(coarse.getAttribute('position').count)
  })
})
