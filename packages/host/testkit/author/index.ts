import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Plugin } from '@agnes/cordis'
import { parseAgnesPluginEntries } from '@agnes/package-manager'
import type { PluginInjectDeclaration } from '@agnes/plugin-runtime/host'
import { createPluginTestHost as mount, type PluginTestOptions } from '@agnes/plugin-runtime/testkit'
import { createPluginTestRegistration } from '../plugin-registration.js'

export { fakeModel, fakeRequest, ScriptedProvider } from '@agnes/ai/testkit'
export type { LoopTestOptions, ModelAdapterTestOptions, ModelReply } from '@agnes/plugin-runtime/testkit'
export { driveLoop, runModelAdapter, scriptedModel } from '@agnes/plugin-runtime/testkit'
export { createPluginTestRegistration } from '../plugin-registration.js'
export type { FaultServer, ModelFault } from './fault-server.js'
export { startModelFaultServer } from './fault-server.js'
export { type LoopContractReport, verifyLoopExecutionContract } from './loop-contract.js'
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
    /** Directory holding the package.json that declares the plugin; defaults to the working directory. */
    packageDir?: string
    /** The `agnes.plugins[].export` under test; defaults to `main`. */
    exportName?: string
  } = {},
) {
  const { services, packageDir, exportName, ...input } = options
  const bridge = input.registration ?? createPluginTestRegistration()
  const inject = await declaredInject(packageDir ?? process.cwd(), exportName ?? 'main')
  return mount(plugin, {
    ...input,
    inject,
    registration: {
      tools: bridge.tools,
      assertLoaded: () => bridge.assertLoaded(),
      install(root, origins) {
        bridge.install(root, origins)
        for (const [name, service] of Object.entries(services ?? {})) root.provide(name, service)
      },
    },
  })
}

/** Load the full Host only when a test needs durable sessions and runtime generations. */
export async function createAuthorTestkit(
  ...args: Parameters<typeof import('./session.js').createAuthorTestkit>
) {
  return (await import('./session.js')).createAuthorTestkit(...args)
}
export type { AuthorPluginVersion, AuthorSession, AuthorTestkit, AuthorTestOptions } from './session.js'
