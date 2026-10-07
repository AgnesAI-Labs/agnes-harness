import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JsonValue } from '@agnes/protocol'
import { copyPackageTreeSync } from './copy-tree.js'
import { hashDirectory } from './sources.js'

export type RuntimeGenerationResourceInput = Readonly<{ data: JsonValue; directories: readonly string[] }>
export type RuntimeGenerationResourceSnapshot = RuntimeGenerationResourceInput
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

/** Private resource bodies and SecretRefs, never resolved credentials. */
export function writeGenerationResources(directory: string, input: RuntimeGenerationResourceInput): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const trees = input.directories.map((source, index) => {
    const destination = join(directory, String(index))
    const before = hashDirectory(source, { exclude: [] })
    copyPackageTreeSync(source, destination)
    const integrity = hashDirectory(destination, { exclude: [] })
    if (before !== integrity) throw new Error('E_GENERATION_RESOURCE_CHANGED: resource changed while copying')
    return { path: String(index), integrity }
  })
  const text = JSON.stringify({ version: 1, data: input.data, trees })
  writeFileSync(join(directory, 'resources.json'), text, { mode: 0o600, flag: 'wx', flush: true })
  return digest(text)
}

export function readGenerationResources(directory: string, expectedDigest: string): RuntimeGenerationResourceSnapshot {
  try {
    const text = readFileSync(join(directory, 'resources.json'), 'utf8')
    if (digest(text) !== expectedDigest) throw new Error('digest')
    const record = JSON.parse(text) as { version: number; data: JsonValue; trees: { path: string; integrity: string }[] }
    if (record.version !== 1 || !Array.isArray(record.trees)) throw new Error('record')
    const directories = record.trees.map((tree, index) => {
      if (tree.path !== String(index)) throw new Error('path')
      const path = join(directory, tree.path)
      if (hashDirectory(path, { exclude: [] }) !== tree.integrity) throw new Error('tree')
      return path
    })
    return { data: record.data, directories }
  } catch {
    throw new Error('E_GENERATION_RESOURCE_MISSING: private resource snapshot is missing or changed')
  }
}
