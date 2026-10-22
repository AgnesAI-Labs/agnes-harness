import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConfigurationService, ResolvedProfile } from '@agnes/host'
import { AGH_DIR } from '@agnes/protocol'

/** Static admin views only. Execution/configuration writes keep using the fresh resolver. */
export function createProfileInspection(options: {
  profileDir: string
  workspace: string
  configuration: Pick<ConfigurationService, 'profileInput'>
  resolve(bundles?: readonly string[]): Promise<ResolvedProfile>
}) {
  const files = [
    ...[
      'profile.yaml',
      'agnes-lock.json',
      'bundle-selection.json',
      'plugin-capabilities.json',
      'package-sources.json',
      '.agnes-runtime-snapshots.json',
    ].map((name) => join(options.profileDir, name)),
    join(options.workspace, AGH_DIR, 'profile.local.yaml'),
  ]
  const revision = async () => {
    const [configuration, ...bytes] = await Promise.all([
      options.configuration.profileInput().then((value) => JSON.stringify(value)),
      ...files.map(async (file) => {
        try {
          return await readFile(file)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
      }),
    ])
    const hash = createHash('sha256').update(configuration!)
    for (const value of bytes) {
      if (value === undefined) hash.update('missing;')
      else hash.update(`file:${value.length}:`).update(value)
    }
    return hash.digest('hex')
  }
  const views = new Map<string, { revision: string; value: Promise<ResolvedProfile> }>()
  return async (bundles?: readonly string[]) => {
    const key = JSON.stringify(bundles ?? null)
    const before = await revision()
    const existing = views.get(key)
    if (existing?.revision === before) return existing.value
    // The two admin reads use undefined and []; never retain arbitrary selection combinations.
    if (views.size >= 2) views.clear()
    const value = options.resolve(bundles)
    const view = { revision: before, value }
    views.set(key, view)
    try {
      const result = await value
      if ((await revision()) !== before && views.get(key) === view) views.delete(key)
      return result
    } catch (error) {
      if (views.get(key) === view) views.delete(key)
      throw error
    }
  }
}
