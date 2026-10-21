import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { constants } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agnesHome } from '@agnes/host'
import { AGH_DIR } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { compileCacheHome, enableLocalCompileCache } from './bootstrap.js'

const roots: string[] = []
function initializedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'agh-compile-cache-'))
  roots.push(home)
  mkdirSync(join(home, 'cache'), { mode: 0o700 })
  return home
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(join(root, 'cache'), 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

const enabled = () => ({ status: constants.compileCacheStatus.ENABLED })

it.each([
  {},
  { HOME: '/users/a' },
  { HOME: '/users/a', AGH_HOME: '/srv/agh' },
  { HOME: '/users/a', AGH_HOME: '/srv/agh', AGNES_HOME: '/srv/legacy' },
  { HOME: '/users/a', AGH_HOME: ' ', AGNES_HOME: '/srv/legacy' },
  { HOME: '/users/a', AGH_HOME: '', AGNES_HOME: '' },
  { HOME: '/users/a', AGH_HOME: 'relative' },
  { HOME: '/users/a', AGNES_HOME: 'relative' },
  { HOME: 'relative' },
])('selects the same home as the CLI for %j', (env) => {
  vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  let expected: string | undefined
  try {
    expected = agnesHome(env)
  } catch {
    expected = undefined
  }
  expect(compileCacheHome(env, AGH_DIR)).toBe(expected)
})

it.skipIf(process.platform === 'win32')('creates a private cache directory in an initialized home', () => {
  const home = initializedHome()
  const enable = vi.fn(enabled)
  expect(enableLocalCompileCache({ AGH_HOME: home }, enable)).toBe(join(home, 'cache', 'compile'))
  expect(enable).toHaveBeenCalledWith(join(home, 'cache', 'compile'))
  expect(statSync(join(home, 'cache', 'compile')).mode & 0o777).toBe(0o700)
})

it('leaves an uninitialized home untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'agh-compile-fresh-'))
  const enable = vi.fn(enabled)
  try {
    expect(enableLocalCompileCache({ AGH_HOME: home }, enable)).toBeUndefined()
    expect(existsSync(join(home, 'cache'))).toBe(false)
    expect(enable).not.toHaveBeenCalled()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('does not use an existing directory that is not private', () => {
  const home = initializedHome()
  mkdirSync(join(home, 'cache', 'compile'), { mode: 0o755 })
  chmodSync(join(home, 'cache', 'compile'), 0o755)
  const enable = vi.fn(enabled)
  expect(enableLocalCompileCache({ AGH_HOME: home }, enable)).toBeUndefined()
  expect(enable).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'starts without the cache when the home cache is not writable',
  () => {
    const home = initializedHome()
    chmodSync(join(home, 'cache'), 0o500)
    const enable = vi.fn(enabled)
    expect(enableLocalCompileCache({ AGH_HOME: home }, enable)).toBeUndefined()
    expect(enable).not.toHaveBeenCalled()
  },
)

it.skipIf(process.platform === 'win32')('treats a refused or throwing enable as no cache', () => {
  const home = initializedHome()
  expect(
    enableLocalCompileCache({ AGH_HOME: home }, () => ({ status: constants.compileCacheStatus.FAILED })),
  ).toBeUndefined()
  expect(
    enableLocalCompileCache({ AGH_HOME: home }, () => {
      throw new Error('unwritable')
    }),
  ).toBeUndefined()
})
