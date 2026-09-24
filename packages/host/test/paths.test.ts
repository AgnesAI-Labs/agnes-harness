import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isHostError } from '../src/errors.js'
import {
  agnesHome,
  cacheDir,
  dataDir,
  hasLegacySessionsDb,
  inDataDir,
  legacySessionsDbPath,
} from '../src/paths.js'

const roots: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-paths-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('agnesHome', () => {
  it.runIf(process.platform === 'win32')(
    'refuses drive-dependent homes from every environment variable',
    () => {
      for (const path of ['/shared-agnes', '\\shared-agnes', 'C:shared-agnes', 'relative']) {
        expect(() => agnesHome({ AGH_HOME: path }), path).toThrow(/AGH_HOME/)
        expect(() => agnesHome({ AGNES_HOME: path }), path).toThrow(/AGNES_HOME/)
        expect(() => agnesHome({ HOME: path }), path).toThrow(/HOME/)
      }
    },
  )
  it.runIf(process.platform === 'win32')('accepts qualified Windows homes and ignores an unused HOME', () => {
    for (const path of ['C:\\用户 空格\\agnes', 'D:/agnes', '\\\\server\\share\\agnes']) {
      expect(agnesHome({ AGH_HOME: path, HOME: '/unused' })).toBe(path)
      expect(agnesHome({ HOME: path })).toBe(join(path, '.agh'))
    }
  })
  it('falls back to <os home>/.agh when neither AGH_HOME nor AGNES_HOME is set', () => {
    const home = scratch()
    expect(agnesHome({ HOME: home })).toBe(join(home, '.agh'))
  })

  it('falls back to node:os homedir() when no home variable is set at all', () => {
    expect(agnesHome({})).toBe(join(homedir(), '.agh'))
  })

  it('treats an empty AGH_HOME or AGNES_HOME as unset rather than as the root directory', () => {
    const home = scratch()
    expect(agnesHome({ AGH_HOME: '', AGNES_HOME: '', HOME: home })).toBe(join(home, '.agh'))
  })

  it('honours an explicit absolute AGH_HOME verbatim', () => {
    expect(agnesHome({ AGH_HOME: resolve('/srv/agh'), HOME: '/ignored' })).toBe(resolve('/srv/agh'))
  })

  it('still honours the legacy AGNES_HOME when AGH_HOME is unset', () => {
    expect(agnesHome({ AGNES_HOME: resolve('/srv/agnes'), HOME: '/ignored' })).toBe(resolve('/srv/agnes'))
  })

  it('prefers AGH_HOME over AGNES_HOME when both are set', () => {
    expect(agnesHome({ AGH_HOME: resolve('/srv/agh'), AGNES_HOME: resolve('/srv/agnes') })).toBe(
      resolve('/srv/agh'),
    )
  })

  // The regression this module exists to make impossible to reintroduce silently: a relative
  // home used to resolve against whatever the process's cwd happened to be, so a daemon and a
  // one-shot CLI invocation with different working directories would quietly pick different homes.
  it.each(['AGH_HOME', 'AGNES_HOME'])('refuses a relative %s and names that variable', (variable) => {
    const e = (() => {
      try {
        agnesHome({ [variable]: 'relative/agnes' })
        return undefined
      } catch (error) {
        return error
      }
    })()
    expect(isHostError(e, 'E_HOME_INVALID')).toBe(true)
    expect((e as Error).message).toContain(variable)
    expect((e as Error).message).toContain('relative/agnes')
  })

  it('refuses a bare relative segment and a dot-relative home alike', () => {
    for (const bad of ['relative', './relative', '../relative', '~/relative']) {
      expect(() => agnesHome({ AGH_HOME: bad }), bad).toThrow(/E_HOME_INVALID/)
      expect(() => agnesHome({ AGNES_HOME: bad }), bad).toThrow(/E_HOME_INVALID/)
    }
  })
})

describe('the AGNES_HOME deprecation notice', () => {
  // The notice is once per process, so each case loads its own copy of the module; the copy imported
  // at the top of this file has already seen AGNES_HOME in the cases above.
  const freshAgnesHome = async () => {
    vi.resetModules()
    return (await import('../src/paths.js')).agnesHome
  }
  const spyWarnings = () => vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is emitted exactly once per process when the legacy AGNES_HOME is the one in use', async () => {
    const warnings = spyWarnings()
    const fresh = await freshAgnesHome()
    const legacy = resolve('/srv/legacy')
    expect(fresh({ AGNES_HOME: legacy })).toBe(legacy)
    expect(fresh({ AGNES_HOME: legacy })).toBe(legacy)
    expect(warnings).toHaveBeenCalledTimes(1)
    expect(String(warnings.mock.calls[0]?.[0])).toMatch(/AGNES_HOME is deprecated; set AGH_HOME instead/)
    expect(warnings.mock.calls[0]?.[1]).toMatchObject({
      type: 'DeprecationWarning',
      code: 'AGH_DEP_AGNES_HOME',
    })
  })

  it('is not emitted when AGH_HOME is set, even alongside AGNES_HOME, nor when neither is set', async () => {
    const warnings = spyWarnings()
    const fresh = await freshAgnesHome()
    fresh({ AGH_HOME: resolve('/srv/agh'), AGNES_HOME: resolve('/srv/legacy') })
    fresh({ HOME: scratch() })
    expect(warnings).not.toHaveBeenCalled()
  })

  it('is not emitted for an AGNES_HOME that is refused', async () => {
    const warnings = spyWarnings()
    const fresh = await freshAgnesHome()
    expect(() => fresh({ AGNES_HOME: 'relative' })).toThrow(/E_HOME_INVALID/)
    expect(warnings).not.toHaveBeenCalled()
  })
})

describe('dataDir, cacheDir and inDataDir', () => {
  it('are always one level below the home root, never the root itself', () => {
    expect(dataDir('/srv/agnes')).toBe(join('/srv/agnes', 'data'))
    expect(cacheDir('/srv/agnes')).toBe(join('/srv/agnes', 'cache'))
  })

  it('inDataDir joins inside dataDir, not inside the home root', () => {
    expect(inDataDir('/srv/agnes', 'sessions.db')).toBe(join('/srv/agnes', 'data', 'sessions.db'))
  })
})

describe('legacy session database detection', () => {
  it('is not found when nothing sits at the home root', () => {
    const home = scratch()
    expect(hasLegacySessionsDb(home)).toBe(false)
  })

  it('is found when a database sits directly under the home root, and never touches it', () => {
    const home = scratch()
    const legacy = legacySessionsDbPath(home)
    expect(legacy).toBe(join(home, 'sessions.db'))
    writeFileSync(legacy, 'not-actually-sqlite-but-detection-does-not-care')
    expect(hasLegacySessionsDb(home)).toBe(true)
    // Detection only: the file this test wrote is still exactly what this test wrote.
    expect(readFileSync(legacy, 'utf8')).toBe('not-actually-sqlite-but-detection-does-not-care')
  })

  it('is not fooled by a database that already lives under data/, only by one at the root', () => {
    const home = scratch()
    mkdirSync(dataDir(home), { recursive: true })
    writeFileSync(join(dataDir(home), 'sessions.db'), 'current')
    expect(hasLegacySessionsDb(home)).toBe(false)
  })
})
