import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { seams as baseSeams, sandboxWorkspaceProbe } from '@agnes/base'
import type { Host, HostSession } from '@agnes/host'
import { attachTestSeamPlugins } from '@agnes/host/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { bootLocal, hostRootFrom } from '../src/boot/local.js'
import { BootError, UsageError } from '../src/errors.js'
import { testDeps, writeScratchProfile } from './boot-host.js'

/** Minimal presets for both platform defaults, before assembly reaches the seam step. */
const PRESETS = {
  base: {
    name: 'base',
    tools: { core: [], timeout_ms: 1000 },
    approval: { on_unavailable: 'deny', timeout_ms: 1000, pending_ttl_ms: 1000, command_policy: [] },
    budget: { preflight: 'estimate', per_request_cap: null, on_exceed: 'quote', max_steps: 4 },
  },
  standard: {
    name: 'standard',
    extends: 'base',
    disclosure: 'standard',
    model: { route: { primary: 'default' } },
  },
  'standard-windows': { name: 'standard-windows', extends: 'standard' },
}

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

const home = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-home-'))
  tmp.push(d)
  return d
}

describe('bootLocal', () => {
  it('resolves a profile, builds a host and a local endpoint, and round-trips one prompt', async () => {
    const dir = home()
    const b = await bootLocal(parseArgs(['-p', 'hi']), testDeps(dir))
    try {
      expect(b.form).toBe('local')
      expect(b.profileName).toBe('local-dev')
      expect(b.bootMs).toBeGreaterThanOrEqual(0)
      expect(b.resolvedProfileHash).toEqual(expect.any(String))
      await b.client.workspace.add(dir)
      const s = await b.client.session.new({ cwd: dir })
      const r = await s.prompt('hi')
      expect(r.reason).toBe('completed')
    } finally {
      await b.close()
    }
  })

  it('is closed for good afterwards: a call on the closed client is refused, not answered', async () => {
    const dir = home()
    const b = await bootLocal(parseArgs(['-p', 'hi']), testDeps(dir))
    await b.close()
    await expect(b.client.session.new({ cwd: dir })).rejects.toMatchObject({ kind: 'transport-closed' })
  })

  it('close is idempotent, so the signal ladder and the run can both call it', async () => {
    const dir = home()
    const b = await bootLocal(parseArgs(['-p', 'hi']), testDeps(dir))
    await b.close()
    await expect(b.close()).resolves.toBeUndefined()
  })

  it('restores an explicitly registered session workspace after a fresh local boot', async () => {
    const dir = home()
    const canonicalDir = realpathSync(dir)
    const sessionKey = 'agnes:local:local-dev:cli:workspace:durable-authority'
    const opened: Array<Parameters<Host['createSession']>[0]> = []
    const baseCreateHost = testDeps(dir).createHostImpl
    if (!baseCreateHost) throw new Error('test host factory is unavailable')
    const createHostImpl = async (...args: Parameters<typeof baseCreateHost>): Promise<Host> => {
      const host = await baseCreateHost(...args)
      return {
        ...host,
        createSession: async (options) => {
          opened.push(options)
          return {
            key: options.key ?? sessionKey,
            writerRunId: `writer-${opened.length}`,
            lastSeq: 0,
            preset: { name: options.preset ?? 'standard' },
            d: { cwd: options.cwd, log: {} },
            scan: async () => [],
            onPreview: () => () => undefined,
            latest: () => undefined,
            close: async () => undefined,
          } as unknown as HostSession
        },
      }
    }

    const first = await bootLocal(parseArgs([]), testDeps(dir, { createHostImpl }))
    try {
      await first.client.workspace.add(dir)
      await first.client.session.new({ cwd: dir, sessionKey })
    } finally {
      await first.close()
    }

    const second = await bootLocal(parseArgs(['--resume', sessionKey]), testDeps(dir, { createHostImpl }))
    try {
      await expect(second.client.session.load(sessionKey, { cwd: dir })).resolves.toMatchObject({
        id: sessionKey,
      })
      expect(opened).toHaveLength(2)
      expect(opened[1]).toMatchObject({
        key: sessionKey,
        cwd: canonicalDir,
        binding: { canonicalRoot: canonicalDir },
      })
    } finally {
      await second.close()
    }
  })

  // Retitled after the review: this case never reached profile resolution. profileNameFrom runs
  // before the try, so a name with a separator is a UsageError, and asserting only `{code: 2}`
  // passed whichever of the two classes came back. Both classes are now named, in two cases.
  it('a profile name that is not one path segment is a UsageError, raised before boot begins', async () => {
    const dir = home()
    const e = await bootLocal(parseArgs(['--profile', 'a/b']), testDeps(dir)).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(UsageError)
    expect((e as Error).message).toContain('a/b is not a single path segment')
    expect((e as UsageError).code).toBe(2)
  })

  it('a profile that does not resolve is a BootError naming what host refused', async () => {
    const dir = home()
    const e = await bootLocal(parseArgs(['--profile', 'nope']), testDeps(dir)).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(BootError)
    expect((e as Error).message).toBe('E_DEP_MISSING: no builtin template nope')
    expect((e as BootError).code).toBe(2)
  })

  // The code used to be printed twice -- `E_DEP_MISSING: E_DEP_MISSING: ...` -- because HostError's
  // own constructor already puts it in front of the message and asBootError put it there again.
  // The refusal the real path reaches today is the empty provider-route contract, which exercises
  // the same wrapping after I6 supplied the Base seam factories.
  // The real jiti loader + real packageDirs resolution this now exercises (see the comment on the
  // next real-path test) is genuine disk I/O and TypeScript transpilation - comfortably under the
  // 5000ms default in isolation, but the full repo suite runs 350+ files as concurrent workers, and
  // under that contention this test has been observed to exceed the default. Hosted macOS runners
  // can also exceed 15s while four isolated workers transpile the package graph, so allow 30s for
  // this real-path integration boundary without changing the timeout of injected unit paths.
  it('a host refusal carries its code exactly once', async () => {
    const dir = home()
    writeScratchProfile(dir)
    const { createHostImpl: _drop, ...deps } = testDeps(dir)
    const e = await bootLocal(parseArgs(['-p', 'x']), deps).catch((x: unknown) => x)
    expect((e as Error).message.match(/E_PRESET_UNRESOLVED/g)).toHaveLength(1)
  }, 30_000)

  it('a BootError from reading the profile inputs is not wrapped a second time', async () => {
    const dir = home()
    mkdirSync(join(dir, 'profiles', 'local-dev'), { recursive: true })
    writeFileSync(join(dir, 'profiles', 'local-dev', 'profile.yaml'), '  : not: yaml :\n', 'utf8')
    const e = await bootLocal(parseArgs(['-p', 'x']), testDeps(dir)).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(BootError)
    expect((e as Error).message.startsWith('profile: ')).toBe(false)
    expect((e as Error).message).toContain('is not valid yaml')
  })

  it('turns a host that will not assemble into a BootError, and names host rather than leaking it', async () => {
    const dir = home()
    const deps = testDeps(dir, {
      createHostImpl: async () => {
        throw new Error('no loader')
      },
    })
    const err = await bootLocal(parseArgs(['-p', 'x']), deps).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'BootError', code: 2 })
    expect((err as Error).message).toContain('host: no loader')
  })

  // The real path is the one nobody injects into. Before host shipped a loader it stopped at
  // `createHost needs a package loader`; now boot builds host's jiti loader and the packageDirs
  // map itself and loads the real @agnes/base off the workspace. I6 supplied the remaining Base
  // seam factories, so the scratch profile now reaches its next honest boundary: it declares no
  // provider route. This pins where the remaining work is rather than leaving the untested branch
  // to be discovered on a first run.
  // See the timeout comment on the previous test - same real jiti/packageDirs work, same
  // contention-under-full-suite-parallelism reason for the explicit 30s.
  it('without an injected host and without a loader, the real path reaches provider routing', async () => {
    const dir = home()
    writeScratchProfile(dir)
    const { createHostImpl: _drop, ...deps } = testDeps(dir)
    const err = await bootLocal(parseArgs(['-p', 'x']), deps).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'BootError', code: 2 })
    expect((err as Error).message).toContain('E_PRESET_UNRESOLVED')
    expect((err as Error).message).toContain('provider.routes')
    expect((err as Error).message).not.toContain('createHost needs a package loader')
  }, 30_000)

  it('an injected loader replaces the whole default wiring, the lockfile read included', async () => {
    const dir = home()
    writeScratchProfile(dir)
    // A lockfile that is not valid JSON: the default wiring reads it through readLock and would
    // throw E_LOCK_MISMATCH before assembly started; the injected loader must skip that read.
    writeFileSync(join(dir, 'profiles', 'local-dev', 'agnes-lock.json'), 'not json', 'utf8')
    const { createHostImpl: _drop, ...deps } = testDeps(dir)
    const loader = {
      importPackage: async (id: string) => ({
        id,
        ...(id === '@agnes/code' ? { presets: PRESETS } : {}),
      }),
    }
    const err = await bootLocal(parseArgs(['-p', 'x']), {
      ...deps,
      loader: loader as unknown as NonNullable<typeof deps.loader>,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BootError)
    expect((err as Error).message).not.toContain('E_LOCK_MISMATCH')
  })

  it('hostRootFrom points at this package, not at the process working directory', () => {
    expect(hostRootFrom().endsWith(join('packages', 'cli'))).toBe(true)
  })

  it('uses the executable directory as hostRoot inside a single executable', () => {
    const builtin = process.getBuiltinModule
    const spy = vi
      .spyOn(process, 'getBuiltinModule')
      .mockImplementation((id) =>
        id === 'node:sea'
          ? ({ isSea: () => true } as ReturnType<typeof process.getBuiltinModule>)
          : builtin(id),
      )
    try {
      expect(hostRootFrom()).toBe(dirname(process.execPath))
    } finally {
      spy.mockRestore()
    }
  })

  /**
   * host emits no log lines of its own; it hands the Logger to every seam factory, to every
   * operation and to the kernel. Four noops therefore silenced core and every seam for the whole
   * life of the process -- a warning or an error with nowhere to be seen, which is the same shape as
   * the projection bug this session found in daemon. Pinned through the real createHost, with a seam
   * factory that says something on its way up.
   */
  it('forwards what host hands its seams and its kernel, rather than discarding it', async () => {
    const dir = home()
    writeScratchProfile(dir)
    const said: string[] = []
    const { createHostImpl: _drop, ...deps } = testDeps(dir)
    const loader = {
      importPackage: async (id: string) => {
        const loaded = {
          id,
          ...(id === '@agnes/base'
            ? {
                sandboxWorkspaceProbe,
                seams: {
                  ...baseSeams,
                  approval: async (ctx: { log: { warn(m: string): void } }) => {
                    ctx.log.warn('a seam said something on its way up')
                    throw new Error('fixture stopped after forwarding the seam warning')
                  },
                },
              }
            : {}),
          ...(id === '@agnes/code' ? { presets: PRESETS } : {}),
        }
        return id === '@agnes/base' ? attachTestSeamPlugins(loaded) : loaded
      },
    }
    const startup = await bootLocal(parseArgs(['-p', 'x']), {
      ...deps,
      log: (line) => said.push(line),
      loader: loader as unknown as NonNullable<typeof deps.loader>,
    }).catch((error: unknown) => error)
    expect(said, String(startup)).toContain('host warn: a seam said something on its way up')
    expect(String(startup)).toContain('fixture stopped after forwarding the seam warning')
  })
})
