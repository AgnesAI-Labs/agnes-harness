import type { Plugin } from '@agnes/cordis'
import { createPluginTestHost as mount, type PluginTestOptions } from '@agnes/plugin-runtime/testkit'
import { createPluginTestRegistration } from '../plugin-registration.js'

export { fakeModel, fakeRequest, ScriptedProvider } from '@agnes/ai/testkit'
export type { LoopTestOptions, ModelAdapterTestOptions, ModelReply } from '@agnes/plugin-runtime/testkit'
export { driveLoop, runModelAdapter, scriptedModel } from '@agnes/plugin-runtime/testkit'
export { createPluginTestRegistration } from '../plugin-registration.js'
export type { FaultServer, ModelFault } from './fault-server.js'
export { startModelFaultServer } from './fault-server.js'
export type { ModelFixture, RecordingOptions } from './model-replay.js'
export { recordModelFixture, replayModelFixture } from './model-replay.js'

/** Small tool contract fixture. Full session authorization lives in createAuthorTestkit. */
export function createPluginTestHost(
  plugin: Plugin,
  options: Omit<PluginTestOptions, 'registration'> & {
    registration?: PluginTestOptions['registration']
    /** Explicit public service doubles for lightweight Loop/Skills/Policy contract tests. */
    services?: Readonly<Record<string, unknown>>
  } = {},
) {
  const { services, ...input } = options
  const bridge = input.registration ?? createPluginTestRegistration()
  return mount(plugin, {
    ...input,
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
