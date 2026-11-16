import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// A SKILL.md another program holds, as Windows refuses to replace it: the rename fails as told.
const held = vi.hoisted(() => ({ code: undefined as string | undefined, renames: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      if (to.endsWith('SKILL.md')) {
        held.renames++
        if (held.code)
          throw Object.assign(new Error(`${held.code}: operation not permitted`), { code: held.code })
      }
      return real.renameSync(from, to)
    },
  }
})

import { Prompts } from '../../src/app/prompts.js'
import { SkillFiles } from '../../src/runtime/prompt.js'
import type { Health } from '../../src/sources/host.js'
import { tempStore } from './helpers.js'

let temp: ReturnType<typeof tempStore>
let root: string
beforeEach(() => {
  temp = tempStore()
  root = join(mkdtempSync(join(tmpdir(), 'sa-skills-held-')), 'skills')
  Object.assign(held, { code: undefined, renames: 0 })
})
afterEach(() => {
  temp.close()
  rmSync(join(root, '..'), { recursive: true, force: true })
})
const prompts = () =>
  new Prompts(
    temp.store,
    () => 100_000,
    () => undefined,
    () => false,
  )

it('never waits in the prompt hook while a held file keeps failing the write on Windows, and reports it once', () => {
  const p = prompts()
  const reports: Health[] = []
  let now = 1_000_000
  const skills = new SkillFiles(p, root, {
    platform: 'win32',
    health: { set: (health) => reports.push(health) },
    now: () => now,
  })
  held.code = 'EPERM'
  const version = p.current()
  const started = performance.now()
  for (let request = 0; request < 1000; request++) skills.write(version)
  // A thousand requests: one attempt, no waiting, one report.
  expect(performance.now() - started).toBeLessThan(500)
  expect(held.renames).toBe(1)
  expect(reports).toMatchObject([{ state: 'error', detail: expect.stringContaining('EPERM') }])
  // After the pause a request tries once more; the pause doubles while the file stays held, and nothing is reported again.
  now += 1_000
  skills.write(version)
  skills.write(version)
  expect(held.renames).toBe(2)
  now += 1_999
  skills.write(version)
  expect(held.renames).toBe(2)
  now += 1
  skills.write(version)
  expect(held.renames).toBe(3)
  expect(reports).toHaveLength(1)
  // Once the file is let go, the next try writes the skills and reports them written.
  held.code = undefined
  now += 4_000
  skills.write(version)
  expect(readdirSync(root)).toEqual(['dsh-superagent-github'])
  expect(reports.at(-1)).toMatchObject({ state: 'ready' })
  const renames = held.renames
  skills.write(version)
  expect(held.renames, 'a written revision is not written again').toBe(renames)
})

it('fails the request on POSIX as it always has, and on Windows for an error that is not a held file', () => {
  const p = prompts()
  held.code = 'EPERM'
  const posix = new SkillFiles(p, root, { platform: 'linux', health: { set: () => {} } })
  expect(() => posix.write(p.current())).toThrow('EPERM')
  // A directory its first write left behind is Superagent's still, so the next request writes it again.
  expect(() => posix.write(p.current())).toThrow('EPERM')
  expect(held.renames).toBe(2)
  // Even a busy file fails a POSIX request, as before.
  held.code = 'EBUSY'
  expect(() => posix.write(p.current())).toThrow('EBUSY')
  held.code = 'ENOSPC'
  const windows = new SkillFiles(p, root, { platform: 'win32', health: { set: () => {} } })
  expect(() => windows.write(p.current())).toThrow('ENOSPC')
})
