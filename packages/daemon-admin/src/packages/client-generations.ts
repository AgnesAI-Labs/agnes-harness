import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  checkedArchiveClientTree,
  RuntimeGenerationSnapshotStore,
  type VerifiedClientTree,
} from '@agnes/package-manager'
import type { ClientModuleRegistry, ClientModuleRegistryOptions } from './client-modules.js'
import type { ClientRegistryPackage } from './contribution-roster.js'

type Input = Parameters<ClientModuleRegistry['list']>[0]
const generationId = /^[a-f0-9-]{36}$/

/** Historical assets own separate publication queues, not the profile's mutable publication queue. */
export function createClientGenerations(
  options: ClientModuleRegistryOptions,
  createRegistry: (options: ClientModuleRegistryOptions) => ClientModuleRegistry,
) {
  const registries = new Map<string, ClientModuleRegistry>()
  const pending = new Map<string, ReturnType<RuntimeGenerationSnapshotStore['readAsync']>>()
  let closed = false
  const requireOpen = () => {
    if (closed) throw new Error('Client module registry is closed')
  }
  const read = async (directory: string, id: string) => {
    const store = new RuntimeGenerationSnapshotStore(directory)
    if (!generationId.test(id)) return store.readAsync(id)
    const bytes = await readFile(join(store.root, id, 'generation.json'), 'utf8').catch(() => undefined)
    if (bytes === undefined) return store.readAsync(id)
    const key = JSON.stringify([directory, id, bytes])
    const found = pending.get(key)
    if (found) return found
    let promise: ReturnType<typeof store.readAsync>
    const clear = () => {
      if (pending.get(key) === promise) pending.delete(key)
    }
    promise = store.readAsync(id).then(
      (value) => {
        clear()
        return value
      },
      (error) => {
        clear()
        throw error
      },
    )
    pending.set(key, promise)
    return promise
  }
  return {
    async prune(input: Input) {
      requireOpen()
      const referenced = new Set(
        new RuntimeGenerationSnapshotStore(input.profileDirectory).sessions().map((pin) => pin.generationId),
      )
      const root = join(options.snapshotDirectory(input.profile, input.profileDirectory), 'generations')
      const directories = await readdir(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [] as string[]
        throw error
      })
      for (const id of directories) {
        if (!generationId.test(id) || referenced.has(id)) continue
        const key = `${input.profile}:${id}`
        registries.get(key)?.close()
        registries.delete(key)
        await rm(join(root, id), { recursive: true, force: true })
      }
    },
    async input(input: Input, id: string) {
      requireOpen()
      const store = new RuntimeGenerationSnapshotStore(input.profileDirectory)
      const pinned = () => store.sessions().some((pin) => pin.generationId === id)
      if (!generationId.test(id) || !pinned()) throw new Error('Client module generation is not retained')
      const recordPath = join(store.root, id, 'generation.json')
      const record = await readFile(recordPath, 'utf8')
      const snapshot = await read(input.profileDirectory, id)
      requireOpen()
      if ((await readFile(recordPath, 'utf8')) !== record || !pinned())
        throw new Error('Client module generation changed')
      const trees = new Map<string, VerifiedClientTree>()
      const packages: ClientRegistryPackage[] = []
      const sourceIds = new Set<string>()
      for (const { snapshot: archived } of snapshot.sources) {
        if (sourceIds.has(archived.packageId) || archived.profile !== input.profile)
          throw new Error('Invalid client module generation binding')
        sourceIds.add(archived.packageId)
        const checked = checkedArchiveClientTree(archived)
        if (!checked) continue
        trees.set(archived.packageId, archived)
        packages.push({
          id: archived.packageId,
          directory: archived.directory,
          entry: {
            version: archived.version,
            integrity: archived.integrity,
            previous: null,
            ...(checked.declaredCapabilities ? { declaredCapabilities: checked.declaredCapabilities } : {}),
            ...(archived.metadata ? { metadata: archived.metadata } : {}),
          },
          contributions: archived.contributions,
          capabilityHash: archived.capabilityHash,
          trusted: true,
          enabled: true,
          blockers: [],
        })
      }
      let registry = registries.get(`${input.profile}:${id}`)
      if (!registry) {
        registry = createRegistry({
          ...options,
          snapshotDirectory: (profile, directory) =>
            join(options.snapshotDirectory(profile, directory), 'generations', id),
          runtimeArtifacts: () => undefined,
          composition: () => undefined,
          changed: () => undefined,
        })
        registries.set(`${input.profile}:${id}`, registry)
      }
      return {
        registry,
        input: {
          profile: input.profile,
          profileDirectory: input.profileDirectory,
          inventory: input.inventory,
          archive: {
            id,
            artifact: snapshot.artifact,
            trees,
            packages,
            current: async () => (await readFile(recordPath, 'utf8')) === record && pinned(),
          },
          refreshInventory: input.refreshInventory,
          actual: async (packageId: string) => {
            const tree = trees.get(packageId)
            return tree
              ? { actual: 'running' as const, actualIntegrity: tree.integrity, actualVersion: tree.version }
              : undefined
          },
        },
      }
    },
    close() {
      closed = true
      for (const registry of registries.values()) registry.close()
      registries.clear()
      pending.clear()
    },
  }
}
