import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PackageContributionSummary } from '@agnes/protocol'
import { syncDirectorySync } from '@agnes/system-node'
import { PackageError } from './errors.js'

export function readStaticJson(file: string): Record<string, unknown> {
  try {
    if (statSync(file).size > 1048576) throw new Error('size')
    const text = readFileSync(file, 'utf8')
    if (Buffer.byteLength(text) > 1048576) throw new Error('size')
    const data: unknown = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('object')
    return data as Record<string, unknown>
  } catch {
    throw new PackageError('E_EXT_LOAD', 'package static JSON is invalid or too large', {
      detail: { reason: 'static-json' },
    })
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export function snapshotHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}
export function freezeData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child)
    Object.freeze(value)
  }
  return value
}

export function syncDirectory(directory: string): void {
  syncDirectorySync(resolve(directory))
}

export function capabilityHash(entry: {
  contributions?: PackageContributionSummary[]
  dependencies: Record<string, string>
}): string {
  return snapshotHash({
    contributions: (entry.contributions ?? []).map((c) =>
      c.kind === 'extension' ? { ...c, runtimeSupports: c.runtimeSupports ?? ['in-process'] } : c,
    ),
    dependencies: entry.dependencies,
  })
}
