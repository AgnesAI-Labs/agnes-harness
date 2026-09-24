import { afterEach, expect, it, vi } from 'vitest'

// runAgnesd would start a real daemon; this only checks what the wrapper leaves in the environment
// that the daemon and every worker it spawns resolve their home from.
const runAgnesd = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@agnes/daemon', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agnes/daemon')>()),
  runAgnesd,
}))

import { runDaemonEntry } from './daemon-entry.js'

afterEach(() => {
  vi.unstubAllEnvs()
  runAgnesd.mockClear()
})

// Under the legacy name, `--home` would lose to any AGH_HOME already in the environment and make
// every worker print the AGNES_HOME deprecation notice for a value nobody set by that name.
it('--home becomes AGH_HOME for the daemon and its workers, over one already set', async () => {
  vi.stubEnv('AGH_HOME', '/tmp/agnes-inherited-home')
  vi.stubEnv('AGNES_HOME', undefined)
  await runDaemonEntry(['start', '--home', '/tmp/agnes-flag-home'])
  expect(runAgnesd).toHaveBeenCalledOnce()
  expect(process.env.AGH_HOME).toBe('/tmp/agnes-flag-home')
  expect(process.env.AGNES_HOME).toBeUndefined()
})

it('leaves the environment alone without --home', async () => {
  vi.stubEnv('AGH_HOME', '/tmp/agnes-inherited-home')
  await runDaemonEntry(['start'])
  expect(process.env.AGH_HOME).toBe('/tmp/agnes-inherited-home')
})
