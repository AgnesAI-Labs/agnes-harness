import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  validateLockfile,
  validateSurfaceDescriptor,
  validateSurfaceInstance,
  validateSurfacePackageMetadata,
} from '../src/index.js'
import { runFixtureFiles } from '../tools/conformance-core.js'

const path = fileURLToPath(new URL('../fixtures/surface/surface.jsonl', import.meta.url))
const rows = readFileSync(path, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const valid = (name: string) =>
  structuredClone(rows.find((row) => row.name === name && row.kind === 'valid').payload)

describe('F1 Surface contracts', () => {
  it('runs all checked-in positive and negative fixtures through public validators', () => {
    const result = runFixtureFiles([path])
    expect(result.failed).toEqual([])
    expect(result.total).toBe(65)
    expect(result.skipped).toBe(0)
  })

  it('rejects duplicate business identities even when other fields differ', () => {
    const descriptor = valid('SurfaceDescriptor'),
      grant = descriptor.requires.services[0]
    descriptor.requires.services.push({ ...grant, range: '^2.0' })
    expect(validateSurfaceDescriptor(descriptor).ok).toBe(false)
    const instance = valid('SurfaceInstance')
    instance.grants.push({ ...instance.grants[0], range: '^2.0' })
    expect(validateSurfaceInstance(instance).ok).toBe(false)
    const metadata = valid('SurfacePackageMetadata')
    metadata.surfaces.push({ ...metadata.surfaces[0], healthPath: '/ready' })
    expect(validateSurfacePackageMetadata(metadata).ok).toBe(false)
    const lock = valid('Lockfile')
    ;(Object.values(lock.packages)[0] as { surfaces: unknown[] }).surfaces = metadata.surfaces
    expect(validateLockfile(lock).ok).toBe(false)
  })

  it('rejects non-JSON, getters and cycles without executing accessors', () => {
    const instance = valid('SurfaceInstance')
    let reads = 0
    Object.defineProperty(instance.config, 'hidden', {
      enumerable: true,
      get() {
        reads++
        return 'private'
      },
    })
    expect(validateSurfaceInstance(instance).ok).toBe(false)
    expect(reads).toBe(0)
    const cyclic = valid('SurfaceInstance')
    cyclic.config.self = cyclic.config
    expect(validateSurfaceInstance(cyclic).ok).toBe(false)
    const fn = valid('SurfaceInstance')
    fn.config.callback = () => undefined
    expect(validateSurfaceInstance(fn).ok).toBe(false)
  })

  it('enforces total byte limits independently of individual string/array schema bounds', () => {
    const instance = valid('SurfaceInstance')
    instance.config = { rows: Array.from({ length: 10 }, () => 'x'.repeat(10000)) }
    expect(validateSurfaceInstance(instance).ok).toBe(false)
  })
})
