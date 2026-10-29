import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { JsonValue } from '@agnes/protocol'
import { mkdirDurablySync, syncTreeBatchedSync } from '@agnes/system-node'
import { collectRead, directoryDigestSteps, type ReadSteps } from './cooperative-read.js'
import { copyPackageTreeSync } from './copy-tree.js'
import { hashDirectory } from './sources.js'

export type RuntimeGenerationResourceInput = Readonly<{ data: JsonValue; directories: readonly string[] }>
export type RuntimeGenerationResourceSnapshot = RuntimeGenerationResourceInput
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

const resourcesText = (data: JsonValue, trees: readonly { path: string; integrity: string }[]) =>
  JSON.stringify({ version: 1, data, trees })

/** The digest `writeGenerationResources` would record, without writing anything. */
export function generationResourcesDigest(input: RuntimeGenerationResourceInput): string {
  return digest(
    resourcesText(
      input.data,
      input.directories.map((source, index) => ({
        path: String(index),
        integrity: hashDirectory(source, { exclude: [] }),
      })),
    ),
  )
}

/**
 * Private resource bodies and SecretRefs, never resolved credentials. The directory's parent must exist.
 * Returns once the directory, every tree under it and `resources.json` are durable, so a digest that
 * names them never outlives their content.
 */
export function writeGenerationResources(directory: string, input: RuntimeGenerationResourceInput): string {
  mkdirDurablySync(directory, dirname(directory))
  const trees = input.directories.map((source, index) => {
    const destination = join(directory, String(index))
    const before = hashDirectory(source, { exclude: [] })
    copyPackageTreeSync(source, destination)
    const integrity = hashDirectory(destination, { exclude: [] })
    if (before !== integrity) throw new Error('E_GENERATION_RESOURCE_CHANGED: resource changed while copying')
    return { path: String(index), integrity }
  })
  const text = resourcesText(input.data, trees)
  writeFileSync(join(directory, 'resources.json'), text, { mode: 0o600, flag: 'wx', flush: true })
  syncTreeBatchedSync(directory)
  return digest(text)
}

export function readGenerationResources(
  directory: string,
  expectedDigest: string,
): RuntimeGenerationResourceSnapshot {
  return collectRead(readGenerationResourcesSteps(directory, expectedDigest))
}

export function* readGenerationResourcesSteps(
  directory: string,
  expectedDigest: string,
): ReadSteps<RuntimeGenerationResourceSnapshot> {
  try {
    const text = readFileSync(join(directory, 'resources.json'), 'utf8')
    if (digest(text) !== expectedDigest) throw new Error('digest')
    const record = JSON.parse(text) as {
      version: number
      data: JsonValue
      trees: { path: string; integrity: string }[]
    }
    if (record.version !== 1 || !Array.isArray(record.trees)) throw new Error('record')
    const directories: string[] = []
    for (const [index, tree] of record.trees.entries()) {
      if (tree.path !== String(index)) throw new Error('path')
      const path = join(directory, tree.path)
      // Composition and generation owners inspect the same archive in one admission. Share only
      // its verified tree digest in that operation, bound to this exact resource manifest.
      const integrity = yield* directoryDigestSteps(path, {
        version: '1',
        integrity: expectedDigest,
        treeIntegrity: tree.integrity,
        capabilityHash: '',
      })
      if (integrity !== tree.integrity) throw new Error('tree')
      directories.push(path)
    }
    return { data: record.data, directories }
  } catch {
    throw new Error('E_GENERATION_RESOURCE_MISSING: private resource snapshot is missing or changed')
  }
}
