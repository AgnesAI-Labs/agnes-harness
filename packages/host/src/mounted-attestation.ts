import { FiberState } from '@agnes/cordis'
import { type CurrentSessionRuntime, canonicalJson, sha256Hex } from '@agnes/core'
import type { ComparisonPreparedConfiguration } from '@agnes/protocol'
import type { HostPluginTreeBase } from './assemble/seams-cordis.js'

export type MountedConfiguration = NonNullable<ComparisonPreparedConfiguration['effective']['mounted']>
export type MountedConfigurationSource = () => MountedConfiguration | null
const sources = new WeakMap<
  CurrentSessionRuntime,
  { source: MountedConfigurationSource; value: MountedConfiguration | null }
>()

/** Host-only binding: the Core runtime pointer exposes neither configuration nor this capability. */
export function bindMountedConfiguration(
  runtime: CurrentSessionRuntime,
  source: MountedConfigurationSource,
): void {
  sources.set(runtime, { source, value: source() })
}

export function readMountedConfiguration(
  runtime: CurrentSessionRuntime | undefined,
): MountedConfiguration | null {
  if (!runtime) return null
  const bound = sources.get(runtime)
  if (!bound?.value) return null
  const current = bound.source()
  // An in-place fiber mutation is not allowed to masquerade as the original published evidence.
  return current?.digest === bound.value.digest && current.count === bound.value.count ? bound.value : null
}

/** Actual mounted values stay private; only a bounded digest and row count leave this module. */
export function mountedConfigurationSource(
  tree: HostPluginTreeBase,
  preset: string,
): MountedConfigurationSource {
  return () => {
    try {
      const rows = tree
        .currentRows()
        .filter(
          (row) =>
            !row.disabled &&
            !row.id.startsWith('web:') &&
            (!row.id.startsWith('preset:') || row.id === `preset:${preset}`),
        )
        .sort((a, b) => a.id.localeCompare(b.id))
      if (rows.length > 4096 || !rows.some((row) => row.id === `preset:${preset}`)) return null
      const budget = { nodes: 0, characters: 0 }
      const values = rows.map((row) => {
        const fiber = tree.tree.fiber(row.id)
        if (!fiber || fiber.state !== FiberState.ACTIVE)
          throw new Error('Mounted configuration is unavailable')
        const config = jsonValue(fiber.config ?? null, budget, 0)
        if (
          row.id === `preset:${preset}` &&
          (!config || typeof config !== 'object' || (config as { name?: unknown }).name !== preset)
        )
          throw new Error('Mounted preset identity is unavailable')
        return {
          id: row.id,
          plugin: row.plugin,
          mountIdentity: row.mountIdentity,
          config,
        }
      })
      const material = canonicalJson({ version: 1, preset, rows: values })
      if (Buffer.byteLength(material, 'utf8') > 1024 * 1024) return null
      return Object.freeze({
        scope: 'active-host-rows-and-selected-preset' as const,
        digest: sha256Hex(material),
        count: rows.length,
      })
    } catch {
      // No partial hash and no error/config contents are published as proof.
      return null
    }
  }
}

function jsonValue(value: unknown, budget: { nodes: number; characters: number }, depth: number): unknown {
  if (++budget.nodes > 100_000 || depth > 64) throw new Error('Mounted configuration exceeds capture bounds')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    budget.characters += value.length
    if (budget.characters > 1024 * 1024) throw new Error('Mounted configuration exceeds capture bounds')
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new Error('Mounted configuration is not JSON')
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw new Error('Mounted configuration is not plain JSON')
  if (Object.getOwnPropertySymbols(value).length) throw new Error('Mounted configuration has symbol fields')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[index]
      if (!descriptor || !('value' in descriptor))
        throw new Error('Mounted configuration has non-JSON fields')
      result.push(jsonValue(descriptor.value, budget, depth + 1))
    }
    if (Object.keys(descriptors).some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))
      throw new Error('Mounted configuration array has extra fields')
    return result
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key]
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      throw new Error('Mounted configuration has non-JSON fields')
    budget.characters += key.length
    if (budget.characters > 1024 * 1024) throw new Error('Mounted configuration exceeds capture bounds')
    result[key] = jsonValue(descriptor.value, budget, depth + 1)
  }
  return result
}
