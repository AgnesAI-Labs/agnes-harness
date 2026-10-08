import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

// runAgnesd would start a real daemon; this only checks what the wrapper leaves in the environment
// that the daemon and every worker it spawns resolve their home from.
const runAgnesd = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@agnes/daemon', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agnes/daemon')>()),
  runAgnesd,
}))

import {
  readStartupDiagnostic,
  STARTUP_DIAGNOSTIC_ENV,
  startupDiagnosticPath,
} from '../src/boot/startup-diagnostic.js'
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

it('publishes the real startup refusal in a private, write-once launcher receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-startup-refusal-'))
  const daemonDir = join(directory, 'daemon')
  mkdirSync(daemonDir)
  const path = startupDiagnosticPath(daemonDir)
  vi.stubEnv(STARTUP_DIAGNOSTIC_ENV, path)
  const refusal = new Error('daemon or package mutation lock is held')
  runAgnesd.mockRejectedValueOnce(refusal)
  try {
    await expect(runDaemonEntry(['--data-dir', directory])).rejects.toBe(refusal)
    expect(readStartupDiagnostic(path)).toBe(refusal.message)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    runAgnesd.mockRejectedValueOnce(new Error('later failure'))
    await expect(runDaemonEntry(['--data-dir', directory])).rejects.toThrow('later failure')
    expect(readStartupDiagnostic(path)).toBe(refusal.message)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
