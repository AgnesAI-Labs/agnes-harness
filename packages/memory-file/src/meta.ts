import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fault } from './content.js'
import { missing, safe } from './paths.js'
import type { MemoryStore } from './store.js'

export const META_MAX_BYTES = 256 * 1024
const META_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,63}\.json$/
const META_FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}\.(?:json|jsonl|sqlite)$/

function assertName(filename: string, pattern: RegExp): string {
  if (!pattern.test(filename) || filename.includes('..')) throw fault('MEMORY_INVALID_METADATA')
  return filename
}

/** Atomic, bounded metadata storage under `<memoryRoot>/meta/*`. Never auto-creates directories on read. */
export class MetaStore {
  readonly dir: string

  constructor(readonly store: MemoryStore) {
    this.dir = join(store.root, 'meta')
  }

  ensureDir(): void {
    this.store.ensure()
    safe(this.store.protectedRoot, this.dir)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  pathOf(filename: string): string {
    assertName(filename, META_FILE_NAME)
    const target = join(this.dir, filename)
    safe(this.store.protectedRoot, target)
    return target
  }

  readJson<T>(filename: string): T | undefined {
    assertName(filename, META_JSON_NAME)
    const target = join(this.dir, filename)
    safe(this.store.protectedRoot, target)
    try {
      if (statSync(target).size > META_MAX_BYTES) return undefined
      return JSON.parse(readFileSync(target, 'utf8')) as T
    } catch (error) {
      if (missing(error)) return undefined
      return undefined
    }
  }

  writeJson(filename: string, value: unknown, verify?: () => void): void {
    assertName(filename, META_JSON_NAME)
    this.ensureDir()
    const payload = JSON.stringify(value)
    if (Buffer.byteLength(payload) > META_MAX_BYTES) throw fault('MEMORY_INVALID_METADATA')
    const target = join(this.dir, filename)
    safe(this.store.protectedRoot, target)
    this.store.atomic(target, payload, verify)
  }

  remove(filename: string): void {
    const target = this.pathOf(filename)
    rmSync(target, { force: true })
  }
}
