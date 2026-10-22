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
// every worker reject AGNES_HOME for a value nobody set by that name.
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
  vi.stubEnv('AGH_HOME', directory)
  const refusal = new Error('daemon or package mutation lock is held')
  runAgnesd.mockRejectedValueOnce(refusal)
  try {
    await expect(runDaemonEntry(['--data-dir', join(directory, 'data')])).rejects.toBe(refusal)
    expect(readStartupDiagnostic(path)).toBe(refusal.message)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    runAgnesd.mockRejectedValueOnce(new Error('later failure'))
    await expect(runDaemonEntry(['--data-dir', join(directory, 'data')])).rejects.toThrow('later failure')
    expect(readStartupDiagnostic(path)).toBe(refusal.message)
    const foreign = startupDiagnosticPath(join(directory, 'foreign', 'daemon'))
    mkdirSync(join(directory, 'foreign', 'daemon'), { recursive: true })
    vi.stubEnv(STARTUP_DIAGNOSTIC_ENV, foreign)
    runAgnesd.mockRejectedValueOnce(new Error('foreign receipt refused'))
    await expect(runDaemonEntry(['--data-dir', join(directory, 'data')])).rejects.toThrow(
      'foreign receipt refused',
    )
    expect(readStartupDiagnostic(foreign)).toBeUndefined()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([false, true])(
  'formats a wrapped=%s old-home refusal without publishing a startup receipt into that home',
  async (wrapped) => {
    const directory = mkdtempSync(join(tmpdir(), 'agh-old-daemon-home-'))
    const path = startupDiagnosticPath(join(directory, 'daemon'))
    vi.stubEnv(STARTUP_DIAGNOSTIC_ENV, path)
    vi.stubEnv('AGNES_LOCALE', 'zh-CN')
    const refusal = Object.assign(new Error('private upstream body'), {
      code: 'E_HOME_VERSION',
      home: directory,
      reason: 'unversioned',
    })
    runAgnesd.mockRejectedValueOnce(wrapped ? new Error('private wrapper', { cause: refusal }) : refusal)
    try {
      await expect(runDaemonEntry(['--home', directory, '--data-dir', directory])).rejects.toThrow(
        `旧环境目录：${directory}`,
      )
      expect(readStartupDiagnostic(path)).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
