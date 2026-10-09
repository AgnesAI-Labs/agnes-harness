// Copies the Draco decoder that ships with three into dist/draco/: NASA's models are Draco-compressed.
import { cpSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export function copyDraco(root) {
  const three = dirname(createRequire(join(root, 'package.json')).resolve('three'))
  const from = join(three, '..', 'examples', 'jsm', 'libs', 'draco', 'gltf')
  mkdirSync(join(root, 'dist'), { recursive: true })
  cpSync(from, join(root, 'dist', 'draco'), { recursive: true })
}
