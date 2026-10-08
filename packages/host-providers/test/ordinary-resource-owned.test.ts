import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
import {
  createPluginRow,
  createTreeSnapshot,
  normalizePluginExport,
  RESOURCE_OWNED_ROW_IDS,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { buildOrdinaryRows } from '../src/assemble/ordinary-rows.js'

describe('ordinary row builder', () => {
  it.each(RESOURCE_OWNED_ROW_IDS)('refuses resource-owned id %s', (id) => {
    const profile = {
      packages: [{ id: 'pkg', enabled: true, trust: 'builtin', integrity: 'sha256' }],
    } as unknown as ResolvedProfile
    const module: PackageModule = {
      id: 'pkg',
      plugins: [
        {
          declaration: { id, export: 'default', runtime: 'in-process', default: true },
          entry: normalizePluginExport((() => undefined) as never),
        },
      ],
    }
    expect(() => buildOrdinaryRows(profile, new Map([['pkg', module]]))).toThrow(/resource-owned/)
  })

  it.each(RESOURCE_OWNED_ROW_IDS)('ordinary tree snapshot refuses resource-owned id %s', (id) => {
    const row = createPluginRow({
      id,
      plugin: `builtin:host/${id}`,
      snapshotDigest: 'builtin:host:v1',
      exportName: id,
      entryRevision: 'host-row:v1',
      extrasRevision: 'none',
      mountRevision: 'host-row:v1',
    })
    expect(() => createTreeSnapshot([row])).toThrow(/E_RESOURCE_OWNED_ROW/)
  })
})
