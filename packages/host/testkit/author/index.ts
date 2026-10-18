import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Plugin } from '@agnes/cordis'
import type { ServiceContext } from '@agnes/extension-api'
import { ownedStore } from '@agnes/host-extensions/profile/owned-store'
import { sqlitePersistenceProvider } from '@agnes/host-infrastructure/adapters/storage-provider'
import { parseAgnesPluginEntries } from '@agnes/package-manager'
import type { PluginInjectDeclaration } from '@agnes/plugin-runtime/host'
import { createPluginTestHost as mount, type PluginTestOptions } from '@agnes/plugin-runtime/testkit'
import type { JsonValue, PluginCapabilities } from '@agnes/protocol'
import { createPluginTestRegistration } from '../plugin-registration.js'

export { fakeModel, fakeRequest, ScriptedProvider } from '@agnes/ai/testkit'
export type { LoopTestOptions, ModelAdapterTestOptions, ModelReply } from '@agnes/plugin-runtime/testkit'
export { driveLoop, runModelAdapter, scriptedModel } from '@agnes/plugin-runtime/testkit'
export { createPluginTestRegistration } from '../plugin-registration.js'
export type { FaultServer, ModelFault } from './fault-server.js'
export { startModelFaultServer } from './fault-server.js'
export {
  type LoopContractOptions,
  type LoopContractReport,
  verifyLoopExecutionContract,
} from './loop-contract.js'
export type { ModelFixture, RecordingOptions } from './model-replay.js'
export { recordModelFixture, replayModelFixture } from './model-replay.js'

/**
 * The injected services of the plugin under test, read from the same `agnes.plugins` entry the Host
 * loads: the package.json in `packageDir` (default: the working directory, where `agh plugin test`
 * runs) and the entry whose `export` is `exportName` (default `main`).
 */
async function declaredInject(packageDir: string, exportName: string): Promise<PluginInjectDeclaration> {
  let manifest: { name?: string; agnes?: { plugins?: unknown } }
  try {
    manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
  const entries = parseAgnesPluginEntries(manifest.name ?? '@test/plugin', manifest.agnes?.plugins)
  const entry = entries.find((candidate) => candidate.export === exportName)
  if (!entry && entries.length)
    throw new Error(`package.json declares no agnes.plugins entry for export ${exportName}`)
  return entry ?? {}
}

/** Small tool contract fixture. Full session authorization lives in createAuthorTestkit. */
export async function createPluginTestHost(
  plugin: Plugin,
  options: Omit<PluginTestOptions, 'registration' | 'inject'> & {
    registration?: PluginTestOptions['registration']
    /** Explicit public service doubles for lightweight Loop/Skills/Policy contract tests. */
    services?: Readonly<Record<string, unknown>>
    /** Isolated fixture directory. Reuse it to test production owner-store restart retention. */
    storeDir?: string
    /** Directory holding the package.json that declares the plugin; defaults to the working directory. */
    packageDir?: string
    /** The `agnes.plugins[].export` under test; defaults to `main`. */
    exportName?: string
  } = {},
) {
  const { services, storeDir, packageDir, exportName, ...input } = options
  const directory = packageDir ?? process.cwd()
  const inject = await declaredInject(directory, exportName ?? 'main')
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8').catch(() => '{}'))
  const capabilities: PluginCapabilities =
    manifest.agnes?.plugins?.find((entry: { export: string }) => entry.export === (exportName ?? 'main'))
      ?.capabilities ?? {}
  const persistence = storeDir ? await sqlitePersistenceProvider.open({ dataDir: storeDir }) : undefined
  let disposed = false
  const assertLive = () => {
    if (disposed) throw new Error('Plugin test host disposed')
  }
  const store = (owner: string, writable: boolean, alive = assertLive) => {
    if (!persistence?.metadata || !capabilities.store) throw new Error('Store capability not configured')
    return ownedStore(persistence.metadata.namespace(owner, 'profile:author-test'), alive, writable)
  }
  const bridge = createPluginTestRegistration({
    describePackage: () => ({
      version: '1.0.0',
      integrity: 'sha256-author',
      declaredCapabilities: capabilities,
    }),
    ...(persistence ? { store: ({ owner, alive }) => store(owner, true, alive) } : {}),
  })
  const registration = input.registration ?? bridge
  let fixture: Awaited<ReturnType<typeof mount>>
  try {
    fixture = await mount(plugin, {
      ...input,
      inject,
      registration: {
        tools: registration.tools,
        assertLoaded: () => registration.assertLoaded(),
        install(root, origins) {
          registration.install(root, origins)
          for (const [name, service] of Object.entries(services ?? {})) root.provide(name, service)
        },
      },
    })
  } catch (error) {
    await persistence?.close()
    throw error
  }
  return {
    ...fixture,
    /** Handler contract test only: no native effect admission, journal or approval simulation. */
    async invokeProfileService(name: string, value: JsonValue) {
      assertLive()
      const binding = bridge.serviceRegistry.binding([name])
      const entry = binding && bridge.serviceRegistry.resolve(binding.extension, name)
      if (entry?.capability.scope !== 'profile') throw new Error('Profile service not registered')
      entry.assertAlive()
      if (!entry.input(value)) throw new TypeError('Invalid service input')
      const unavailable = () => {
        throw new Error('Test service port unavailable')
      }
      const blocked = new Proxy({}, { get: () => unavailable })
      const context: ServiceContext = {
        scope: { kind: 'profile', profileId: 'author-test', activationId: 'current' },
        actor: { id: 'author', org: 'test', role: 'tester', deptPath: [], attrs: {} },
        source: 'author-test',
        requestId: 'author-test',
        cwd: '/test',
        signal: entry.signal,
        timeoutMs: entry.capability.timeoutMs,
        exec: unavailable,
        authorize: unavailable,
        fs: blocked as ServiceContext['fs'],
        net: blocked as ServiceContext['net'],
        artifacts: blocked as ServiceContext['artifacts'],
        platform: {
          shell: 'posix',
          fs: { caseSensitive: true, pathSep: '/' },
          terminal: { color: false },
          capability: () => ({ level: 'unavailable', scope: [], reason: 'test' }),
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        ...(persistence && capabilities.store
          ? { store: store(entry.owner, entry.capability.kind === 'effect', entry.assertAlive) }
          : {}),
      }
      const result = await entry.handler(value, context)
      entry.assertAlive()
      if (!entry.output(result)) throw new TypeError('Invalid service output')
      return result
    },
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        await fixture.dispose()
      } finally {
        await persistence?.close()
      }
    },
  }
}

/** Load the full Host only when a test needs durable sessions and runtime generations. */
export async function createAuthorTestkit(
  ...args: Parameters<typeof import('./session.js').createAuthorTestkit>
) {
  return (await import('./session.js')).createAuthorTestkit(...args)
}
export type { AuthorPluginVersion, AuthorSession, AuthorTestkit, AuthorTestOptions } from './session.js'
