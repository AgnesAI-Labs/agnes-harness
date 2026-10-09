import type { Plugin } from '@agnes/cordis'
import { createPluginTestHost as mount, type PluginTestOptions } from '@agnes/plugin-runtime/testkit'
import { createPluginTestRegistration } from '../plugin-registration.js'

export { driveLoop, runModelAdapter, scriptedModel } from '@agnes/plugin-runtime/testkit'
export type { LoopTestOptions, ModelReply, ModelAdapterTestOptions } from '@agnes/plugin-runtime/testkit'
export { fakeModel, fakeRequest, ScriptedProvider } from '@agnes/ai/testkit'
export { createPluginTestRegistration } from '../plugin-registration.js'
export { recordModelFixture, replayModelFixture } from './model-replay.js'
export type { RecordingOptions, ModelFixture } from './model-replay.js'
export { startModelFaultServer } from './fault-server.js'
export type { ModelFault, FaultServer } from './fault-server.js'

/** Small tool contract fixture. Full session authorization lives in createAuthorTestkit. */
export function createPluginTestHost(
  plugin: Plugin,
  options: Omit<PluginTestOptions, 'registration'> & {
    registration?: PluginTestOptions['registration']
  } = {},
) {
  return mount(plugin, { ...options, registration: options.registration ?? createPluginTestRegistration() })
}

/** Load the full Host only when a test needs durable sessions and runtime generations. */
export async function createAuthorTestkit(
  ...args: Parameters<typeof import('./session.js').createAuthorTestkit>
) {
  return (await import('./session.js')).createAuthorTestkit(...args)
}
export type { AuthorTestOptions, AuthorSession, AuthorTestkit, AuthorPluginVersion } from './session.js'
