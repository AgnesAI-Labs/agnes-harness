import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// A ticket directory a program holds open, as Windows refuses to move it: `rename` fails as told.
const held = vi.hoisted(() => ({ failures: 0, code: 'EBUSY', calls: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (from.endsWith('held')) {
        held.calls++
        if (held.failures-- > 0)
          throw Object.assign(new Error(`${held.code}: resource busy`), { code: held.code })
      }
      return real.rename(from, to)
    },
  }
})

import { prepareArgv } from '../../src/app/execution-environment.js'
import { PrepareFailed, SessionRegistry, Sessions, type SessionsDeps } from '../../src/runtime/sessions.js'
import { fakeClient } from './fake-sdk.js'
import { tempStore, ticket } from './helpers.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
  Object.assign(held, { failures: 0, code: 'EBUSY', calls: 0 })
})
afterEach(() => temp.close())

function sessions(fields: Partial<SessionsDeps> = {}) {
  return new Sessions({
    client: fakeClient().client,
    registry: new SessionRegistry(temp.store),
    orchestratorDir: () => join(temp.dir, 'state'),
    prepareCommand: () => '',
    environment: () => ({}),
    lifetime: new AbortController().signal,
    busyDelaysMs: [1, 1, 1],
    ...fields,
  })
}
/** A ticket directory a stopped prepare left without its marker, which the next launch moves aside. */
function unprepared(): string {
  const dir = join(temp.dir, 'work', 'held')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'half'), '')
  return dir
}

it('runs the prepare command in PowerShell on Windows and in sh elsewhere', async () => {
  expect(prepareArgv('git clone x repo', 'win32')).toEqual([
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'git clone x repo',
  ])
  expect(prepareArgv('git clone x repo', 'linux')).toEqual(['sh', '-c', 'git clone x repo'])
  // On Windows PowerShell runs it and its exit code stands; elsewhere none exists, and the launch names the program.
  const failed = sessions({ platform: 'win32', prepareCommand: () => 'exit 3' }).ensureWorker(
    ticket('t1'),
    join(temp.dir, 'work', 't1'),
  )
  await expect(failed).rejects.toBeInstanceOf(PrepareFailed)
  await expect(failed).rejects.toThrow(process.platform === 'win32' ? /exit 3/ : /powershell/)
})

it('moves a held ticket directory aside once the program lets go of it', async () => {
  const dir = unprepared()
  held.failures = 2
  await sessions({ platform: 'win32' }).ensureWorker(ticket('t2'), dir)
  expect(held.calls).toBe(3)
  expect(existsSync(join(dir, '.superagent-prepared'))).toBe(true)
})

it('fails the ticket with the reason when the directory stays held, rather than waiting on it', async () => {
  const dir = unprepared()
  held.failures = 10
  held.code = 'EPERM'
  const failed = sessions({ platform: 'win32' }).ensureWorker(ticket('t3'), dir)
  await expect(failed).rejects.toBeInstanceOf(PrepareFailed)
  await expect(failed).rejects.toThrow(`The ticket directory ${dir} could not be moved aside`)
  expect(held.calls).toBe(4)
  expect(existsSync(join(dir, 'half')), 'nothing is deleted').toBe(true)
})
