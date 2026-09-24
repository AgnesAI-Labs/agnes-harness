import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ExtensionFactory, Logger } from '@agnes/extension-api'
import { HostError } from '../errors.js'
import { buildExtensionApi, type ToolPort } from './api.js'
import { diagnostic, type LoadStage, loadError } from './diagnostics.js'
import { DisposerBag } from './disposers.js'
import { readBundledExtensionDirs, readExtensionManifest, resolveEntry } from './manifest.js'

export type ExtStatus = {
  id: string
  loaded: boolean
  /** The package that bundles it, and the directory its manifest was read from. */
  package: string
  dir: string
  /** What the manifest allows, and what the entry actually claimed. The two are not the same. */
  declared: readonly string[] | null
  registered: readonly string[]
  error?: { code: string; message: string }
}
export type ExtHost = {
  status(): ExtStatus[]
  disposeAll(): Promise<void>
  residue(id: string): string[]
}

/** How an entry file becomes a module. Injected so a test can load one without touching a disk. */
export type ModuleImporter = (file: string) => Promise<Record<string, unknown>>

export type ExtHostOptions = {
  /** Package id to package directory, for the packages the profile enabled. */
  packages: ReadonlyMap<string, string>
  tools: ToolPort
  log: Logger
  audit?: (kind: string, detail: Record<string, unknown>) => void
  importModule?: ModuleImporter
}

const nativeImport: ModuleImporter = async (file) =>
  (await import(pathToFileURL(file).href)) as Record<string, unknown>

type Held = { bag: DisposerBag; names: Set<string>; cleanupFailed: boolean }
type Rec = {
  id: string
  package: string
  dir: string
  declared: readonly string[] | null
  held: Held
  error?: { code: string; message: string }
}

/** Reverse order, and one throwing disposer does not strand the ones under it. */
async function release(held: Held, log: Logger): Promise<void> {
  held.cleanupFailed = (await held.bag.disposeAllAsync()).failed > 0
  if (held.cleanupFailed) {
    try {
      void Promise.resolve(log.warn('extension cleanup incomplete')).catch(() => undefined)
    } catch {
      /* keep cleaning */
    }
  }
}

/**
 * Loads the extensions the enabled packages bundle and registers their tools on the kernel.
 *
 * One extension failing is one extension not loaded: its partial registrations are disposed in
 * reverse, the failure is recorded in `status()` and written to the audit stream, and every other
 * extension and the kernel itself are untouched. Nothing here refuses startup, which is why a
 * package that declares its extensions wrongly voids that package's extensions rather than the
 * host.
 *
 * Hooks, slots, resources, extension events, leases, reload and any trust tier other than builtin
 * are not here. They need registration entry points the kernel does not have yet.
 */
export async function createExtHost(o: ExtHostOptions): Promise<ExtHost> {
  const importModule = o.importModule ?? nativeImport
  const say = (kind: string, detail: Record<string, unknown>) => diagnostic(() => o.audit?.(kind, detail))
  const records: Rec[] = []
  const live = new Map<string, Held>()

  const loadOne = async (packageId: string, dir: string): Promise<void> => {
    let stage: LoadStage = 'manifest'
    let id = basename(dir)
    let declared: readonly string[] | null = null
    const held: Held = { bag: new DisposerBag(), names: new Set(), cleanupFailed: false }
    try {
      const m = readExtensionManifest(dir)
      id = m.id
      declared = m.tools.names
      stage = 'identity'
      if (live.has(id) || records.some((record) => record.id === id && record.held.bag.size > 0))
        throw new HostError('E_EXT_LOAD', `${id}: a second extension claims this id`, {
          detail: { id, dir, reason: 'duplicate-id' },
        })
      stage = 'entry'
      const entryFile = resolveEntry(dir, m.entry)
      // Claimed before the entry runs, so a factory that throws halfway still has its partial
      // registrations in hand to undo.
      live.set(id, held)
      stage = 'import'
      const mod = await importModule(entryFile)
      stage = 'export'
      const factory = mod.default
      if (typeof factory !== 'function')
        throw new HostError('E_EXT_LOAD', `${id}: ${m.entry} has no default export to call`, {
          detail: { id, entry: m.entry, reason: 'no-default-export' },
        })
      stage = 'factory'
      let registering = true
      const api = buildExtensionApi(
        m,
        o.tools,
        (name, off) => {
          held.names.add(name)
          return held.bag.add(async () => {
            await off()
            held.names.delete(name)
          })
        },
        () => registering,
      )
      let returned: Awaited<ReturnType<ExtensionFactory>>
      try {
        const result = (factory as ExtensionFactory)(api)
        // A synchronous return must close before a queued microtask can use the retained API.
        returned = result && typeof result === 'object' ? await result : result
      } finally {
        registering = false
      }
      // Pushed last so it runs first: an extension's own disposer is written expecting its
      // registrations to still be there.
      if (typeof returned === 'function') held.bag.add(returned)
      records.push({ id, package: packageId, dir, declared, held })
      say('extension.loaded', { id, package: packageId, tools: [...held.names] })
    } catch (e) {
      // Identity, not the id: a second extension claiming an id already taken must not unregister
      // the one that took it.
      if (live.get(id) === held) live.delete(id)
      await release(held, o.log)
      const error = loadError(e, stage)
      records.push({ id, package: packageId, dir, declared, held, error })
      diagnostic(() =>
        o.log.error(`extension ${id} failed to load: ${error.message}`, { id, package: packageId }),
      )
      say('extension.failed', { id, package: packageId, ...error })
    }
  }

  for (const [packageId, pkgDir] of o.packages) {
    let dirs: string[]
    try {
      // This unexported compatibility host is retained for its old loader security fixtures only.
      dirs = readBundledExtensionDirs(pkgDir, true)
    } catch (e) {
      const error = loadError(e, 'package')
      const held: Held = { bag: new DisposerBag(), names: new Set(), cleanupFailed: false }
      records.push({ id: packageId, package: packageId, dir: pkgDir, declared: null, held, error })
      diagnostic(() =>
        o.log.error(`package ${packageId} declares its extensions wrongly: ${error.message}`, { packageId }),
      )
      say('extension.failed', { id: packageId, package: packageId, ...error })
      continue
    }
    for (const dir of dirs) await loadOne(packageId, dir)
  }

  return {
    status: () =>
      records.map(({ held, ...r }) => ({
        ...r,
        loaded: live.get(r.id) === held && r.error === undefined,
        registered: [...held.names],
      })),
    residue: (id) =>
      records
        .filter((record) => record.id === id)
        .flatMap(({ held }) => [
          ...held.names,
          ...(held.cleanupFailed && held.bag.size > 0 ? ['disposer:pending'] : []),
        ]),
    async disposeAll() {
      for (const { held } of records) await release(held, o.log)
      live.clear()
      if (records.some(({ held }) => held.bag.size > 0))
        throw new HostError('E_EXT_LOAD', 'extension cleanup incomplete')
    },
  }
}
