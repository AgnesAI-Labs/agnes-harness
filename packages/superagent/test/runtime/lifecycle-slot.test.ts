import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfileManagedDefinition, ProfileManagedInit } from '@agnes/extension-api'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { type SuperagentService, superagentPlugin } from '../../src/runtime/index.js'
import type { Lifecycle, StopReason } from '../../src/runtime/lifecycle.js'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sa-slot-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** Applies the plugin with stand-in facets and starts its service with a stand-in grant. */
async function startService() {
  let definition: ProfileManagedDefinition<SuperagentService> | undefined
  superagentPlugin.apply({
    hooks: { register: () => () => {} },
    profileRuntime: {
      register: (value: ProfileManagedDefinition<SuperagentService>) => {
        definition = value
        return { get: async () => undefined as never }
      },
    },
  } as never)
  let shutdown: ((reason: 'disable' | 'upgrade' | 'exit') => Promise<unknown>) | undefined
  const client = { initialize() {}, close() {}, clientId() {}, session: {} }
  const init = {
    bundledApp: {
      stateDirectory: directory,
      client,
      channels: { subscribe: () => () => {} },
      assertCurrent() {},
    },
    ready() {},
    onShutdown: (handler: typeof shutdown) => {
      shutdown = handler
    },
  } as unknown as ProfileManagedInit
  const service = await definition!.start(init)
  return { service, shutdown: (reason: 'disable' | 'upgrade' | 'exit') => shutdown!(reason) }
}

function fakeLifecycle(log: string[]): Lifecycle {
  return {
    async start() {
      log.push('start')
    },
    async stop(reason: StopReason) {
      log.push(`stop ${reason}`)
    },
    settled: async () => {},
    status: () => ({ state: 'running' }),
    ticketEnded: async () => {},
  }
}

it.each([
  ['disable', 'disable'],
  ['upgrade', 'generation'],
  ['exit', 'shutdown'],
] as const)(
  'starts a registered lifecycle at once and stops it on a %s shutdown as %s',
  async (reason, expected) => {
    const { service, shutdown } = await startService()
    const log: string[] = []
    service.register('lifecycle', fakeLifecycle(log))
    expect(log).toEqual(['start'])
    await expect(shutdown(reason)).resolves.toEqual({ state: 'settled' })
    expect(log).toEqual(['start', `stop ${expected}`])
  },
)

it('refuses a lifecycle part without start and stop', async () => {
  const { service, shutdown } = await startService()
  expect(() => service.register('lifecycle', {})).toThrow(TypeError)
  await shutdown('exit')
})

it('shuts down without a registered lifecycle', async () => {
  const { shutdown } = await startService()
  await expect(shutdown('disable')).resolves.toEqual({ state: 'settled' })
})
