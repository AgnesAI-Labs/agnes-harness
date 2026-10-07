import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { renameWriteThrough } from '@agnes/system-node'
import { ConfigurationError } from '../configuration.js'
import { withConfigurationLock } from '../configuration-lock.js'
import { mergeValue } from '../presets/merge.js'
import type { PresetDoc } from '../presets/types.js'
import { compositionDump, expandBundles, resolveComposition } from './composition.js'
import type { ResolvedProfile } from './types.js'

export type BundleSelection = Readonly<{ revision: number; bundles: string[] }>
export function isBundleSelection(value: unknown): value is BundleSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    Object.keys(item).length === 2 &&
    Number.isSafeInteger(item.revision) &&
    Number(item.revision) >= 0 &&
    Array.isArray(item.bundles) &&
    item.bundles.length <= 64 &&
    new Set(item.bundles).size === item.bundles.length &&
    item.bundles.every(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes at the identifier or path boundary.
      (id) => typeof id === 'string' && id.length <= 512 && /^[^\s\x00-\x1f]+#[a-z][a-z0-9-]{0,63}$/.test(id),
    )
  )
}
export function readBundleSelection(profileDir: string): BundleSelection {
  const file = join(profileDir, 'bundle-selection.json')
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, bundles: [] }
    throw new ConfigurationError('CONFIG_INVALID_STATE')
  }
  let bytes: Buffer
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 65_536) throw new ConfigurationError('CONFIG_INVALID_STATE')
    bytes = readFileSync(fd)
  } finally {
    closeSync(fd)
  }
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ConfigurationError('CONFIG_INVALID_STATE')
  }
  if (!isBundleSelection(value)) throw new ConfigurationError('CONFIG_INVALID_STATE')
  return value
}

/** Offline inspection walks composition inheritance without importing plugin entry modules. */
export function compositionPreset(profile: ResolvedProfile, name: string): PresetDoc {
  if (!profile.presets.allowed.includes(name)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const seen = new Set<string>()
  const visit = (id: string): PresetDoc => {
    if (seen.has(id)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
    seen.add(id)
    const doc = profile.bundlePresets?.[id] ?? { name: id }
    const result = doc.extends ? (mergeValue(visit(doc.extends), doc) as PresetDoc) : doc
    seen.delete(id)
    return { ...result, name: id }
  }
  return visit(name)
}

/** Local admin stores desired bundle selection. A restart assembles the next Host generation. */
export function createCompositionAdmin(options: {
  profileDir: string
  resolveProfile(bundles?: readonly string[]): Promise<ResolvedProfile>
}) {
  return {
    async bundles() {
      const profile = await options.resolveProfile([])
      return {
        ...readBundleSelection(options.profileDir),
        effect: 'restart-required' as const,
        catalog: Object.values(profile.bundleCatalog ?? {}).map(({ id, sourcePackage }) => ({
          id,
          sourcePackage,
        })),
      }
    },
    async dump(preset?: string) {
      const profile = await options.resolveProfile()
      const tree = resolveComposition(profile, {
        preset: compositionPreset(profile, preset ?? profile.presets.default),
      })
      return { status: 'desired' as const, validation: 'static' as const, ...compositionDump(tree) }
    },
    async saveBundles(input: BundleSelection) {
      if (!isBundleSelection(input)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
      await mkdir(options.profileDir, { recursive: true, mode: 0o700 })
      return withConfigurationLock(join(options.profileDir, 'bundle-selection-lock.sqlite'), async () => {
        const current = readBundleSelection(options.profileDir)
        if (input.revision !== current.revision) throw new ConfigurationError('CONFIG_REVISION_CONFLICT')
        const profile = await options.resolveProfile(input.bundles)
        try {
          expandBundles(input.bundles, profile.bundleCatalog ?? {})
        } catch {
          throw new ConfigurationError('CONFIG_INVALID_INPUT')
        }
        const next = { revision: current.revision + 1, bundles: [...input.bundles] }
        const temporary = join(options.profileDir, '.bundle-selection-' + randomUUID())
        const file = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        )
        try {
          await file.writeFile(JSON.stringify(next) + '\n')
          await file.sync()
          await file.close()
          await renameWriteThrough(temporary, join(options.profileDir, 'bundle-selection.json'), {
            noFollow: true,
          })
        } finally {
          await file.close().catch(() => undefined)
          await unlink(temporary).catch(() => undefined)
        }
        return { ...next, effect: 'restart-required' as const }
      })
    },
  }
}
