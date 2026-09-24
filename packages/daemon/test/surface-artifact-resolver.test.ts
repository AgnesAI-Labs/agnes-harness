import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createSurfaceArtifactResolver } from '../src/surfaces/artifact-resolver.js'

let root: string, pkgDir: string
const signal = new AbortController().signal

const surface = {
  package: 'agnes/demo-surface',
  descriptor: { id: 'demo', artifact: { kind: 'node', entry: './dist/server.mjs' } },
} as never

function inventory(dir: string) {
  return { packages: [{ id: 'agnes/demo-surface', directory: dir }] } as never
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-artifact-'))
  pkgDir = join(root, 'store/agnes-demo-surface')
  mkdirSync(join(pkgDir, 'dist'), { recursive: true })
  writeFileSync(join(pkgDir, 'dist/server.mjs'), 'process.exit(0)')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('maps a node descriptor entry to an absolute entry and cwd', async () => {
  const resolver = createSurfaceArtifactResolver(inventory(pkgDir))
  const artifact = await resolver.resolveNodeArtifact({} as never, surface, signal)
  expect(artifact.entry).toBe(join(pkgDir, 'dist/server.mjs'))
  expect(artifact.cwd).toBe(pkgDir)
})

it('refuses a package that is not in the inventory', async () => {
  const resolver = createSurfaceArtifactResolver({ packages: [] } as never)
  await expect(resolver.resolveNodeArtifact({} as never, surface, signal)).rejects.toThrow(
    'surface package is not installed',
  )
})

it('refuses an entry that escapes the package directory', async () => {
  const resolver = createSurfaceArtifactResolver(inventory(pkgDir))
  const escaping = {
    package: 'agnes/demo-surface',
    descriptor: { id: 'demo', artifact: { kind: 'node', entry: '../../etc/passwd' } },
  } as never
  await expect(resolver.resolveNodeArtifact({} as never, escaping, signal)).rejects.toThrow(
    'surface artifact entry escapes the package directory',
  )
})
