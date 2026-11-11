import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PersistenceMetadataPort } from '@agnes/extension-api'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import { parseAgnesPluginEntries, type RuntimePluginSnapshot } from '@agnes/package-manager'
import type { ProcessServices } from './process-services.js'

/** Host-owned index: package removal must not erase credentials or unrelated plugin stores. */
export function channelState(metadata: PersistenceMetadataPort, profile: string) {
  const index = metadata.namespace('host:channels', `profile:${profile}`)
  const remember = (packageId: string, owner: string) => {
    const owners = (index.get(packageId) ?? []) as string[]
    if (!owners.includes(owner)) index.set(packageId, [...owners, owner])
  }
  return {
    remember,
    rememberSources(sources: readonly Readonly<RuntimePluginSnapshot>[]) {
      for (const { snapshot, trusted } of sources) {
        if (!trusted) continue
        let manifest: { agnes?: { plugins?: unknown } }
        try {
          manifest = JSON.parse(readFileSync(join(snapshot.directory, 'package.json'), 'utf8'))
        } catch (error) {
          // A retired catalogue entry can outlive its collected snapshot directory.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        for (const row of parseAgnesPluginEntries(snapshot.packageId, manifest.agnes?.plugins))
          if (row.capabilities?.managedServices?.some((service) => service.id === 'channel'))
            remember(snapshot.packageId, pluginRowSource(row.id))
      }
    },
    clear(packageId: string) {
      const owners = (index.get(packageId) ?? []) as string[]
      for (const owner of owners) {
        const store = metadata.namespace(owner, `profile:${profile}:managed:channel`)
        store.transaction(() => {
          for (const { key } of store.entries())
            if (key === 'managed-config:channel' || key.startsWith('bindings:')) store.delete(key)
        })
      }
      index.delete(packageId)
    },
  }
}

export function channelControls(proc: ProcessServices, profile: string) {
  return {
    channelCatalog: () => ({
      providers: [...proc.channelDirectory.values()].flatMap((read) => {
        try {
          return [read()]
        } catch {
          return []
        }
      }),
    }),
    clearChannelState: (packageId: string) => {
      if (proc.profileManaged.statuses(packageId).some((row) => row.state !== 'stopped'))
        throw new Error('Channel package is not stopped')
      channelState(proc.adapters.storage.metadata, profile).clear(packageId)
    },
  }
}
