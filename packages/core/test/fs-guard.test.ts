import { describe, expect, it } from 'vitest'
import {
  assertFsEnforces,
  decideFsPath,
  enforcementProbes,
  type FsPolicy,
  type FsRule,
  isDenial,
  validateFsPolicy,
} from '../src/effects/fs-guard.js'
import type { FsOps } from '../src/effects/tool-context.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { presetDefaults } from '../src/step/preset.js'
import { CoreError } from '../src/types.js'
import { fencedFs, testFsPolicy } from '../testkit/fenced-fs.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers } from './helpers/open-session.js'

const bare: FsOps = {
  read: async () => new Uint8Array(),
  write: async () => undefined,
  list: async () => [],
  stat: async () => ({ kind: 'file' as const, size: 0, mtimeMs: 0 }),
}

const rule = (effect: 'allow' | 'deny', path: string, hard = false): FsRule => ({
  effect,
  path,
  source: 'preset',
  hard,
})
const policyWith = (rules: FsRule[]): FsPolicy => ({
  workspaceRoot: '/w',
  rules: [rule('allow', '/w'), ...rules],
  networkAllow: [],
  digest: '0'.repeat(64),
})

describe('validateFsPolicy holds the contract before any probe runs', () => {
  it('accepts the policy the testkit builds', () => {
    expect(() => validateFsPolicy(testFsPolicy('/w', { deny: ['secrets'] }))).not.toThrow()
  })

  it.each([
    ['a non-object', null],
    ['a relative workspace root', { ...testFsPolicy('/w'), workspaceRoot: 'w' }],
    ['a missing workspace allow rule', { ...testFsPolicy('/w'), rules: [rule('deny', '/w/.git', true)] }],
    ['a relative rule path', testFsPolicy('/w', { rules: [rule('deny', 'secrets')] })],
    ['an empty rule path', testFsPolicy('/w', { rules: [rule('deny', '')] })],
    ['a NUL in a rule path', testFsPolicy('/w', { rules: [rule('deny', '/w/a\0b')] })],
    ['a hard rule that allows', testFsPolicy('/w', { rules: [rule('allow', '/w/open', true)] })],
    ['a digest that is not sha256 hex', { ...testFsPolicy('/w'), digest: 'vault' }],
    ['a non-string networkAllow entry', { ...testFsPolicy('/w'), networkAllow: [42] as never }],
  ])('refuses %s with E_FS_POLICY_INVALID', (_name, policy) => {
    const err = (() => {
      try {
        validateFsPolicy(policy as FsPolicy)
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(err).toBeInstanceOf(CoreError)
    expect((err as CoreError).code).toBe('E_FS_POLICY_INVALID')
  })
})

describe('decideFsPath precedence over the plain policy data', () => {
  const policy = policyWith([
    rule('deny', '/data'),
    rule('allow', '/data/tmp'),
    rule('deny', '/data/tmp/nope'),
    rule('deny', '/home/u/.ssh', true),
    rule('allow', '/home/u/.ssh/reopened'),
    rule('allow', '/extra'),
    rule('deny', '/extra/blocked'),
  ])

  it('matches the longest rule, so a deeper allow reopens a broad deny and a deeper deny closes it again', () => {
    expect(decideFsPath(policy, '/data/file', { caseSensitive: true })).toMatchObject({ effect: 'deny' })
    expect(decideFsPath(policy, '/data/tmp/file', { caseSensitive: true })).toMatchObject({
      effect: 'allow',
    })
    expect(decideFsPath(policy, '/data/tmp/nope/file', { caseSensitive: true })).toMatchObject({
      effect: 'deny',
    })
  })

  it('never lets a more-specific allow reopen a hard deny', () => {
    expect(decideFsPath(policy, '/home/u/.ssh/reopened/key', { caseSensitive: true })).toMatchObject({
      effect: 'deny',
      reason: 'hard-deny',
    })
  })

  it('lets deny win when allow and deny match at the same depth', () => {
    expect(decideFsPath(policy, '/extra/blocked/x', { caseSensitive: true })).toMatchObject({
      effect: 'deny',
    })
    expect(decideFsPath(policy, '/extra/ok', { caseSensitive: true })).toMatchObject({ effect: 'allow' })
  })

  it('compares whole segments, never string prefixes, and defaults to deny', () => {
    expect(decideFsPath(policy, '/workspace-sibling/x', { caseSensitive: true })).toEqual({
      effect: 'deny',
      reason: 'no-match',
    })
    expect(decideFsPath(policy, '/datax/tmp/file', { caseSensitive: true })).toEqual({
      effect: 'deny',
      reason: 'no-match',
    })
    expect(decideFsPath(policy, '/elsewhere', { caseSensitive: true })).toEqual({
      effect: 'deny',
      reason: 'no-match',
    })
  })

  it('folds case only when the volume is declared case-insensitive', () => {
    // A case variant of a denied name under the root: on a folded volume it is the same file and
    // stays denied; on a case-sensitive volume it names a different file, which the workspace
    // allow then covers. A variant of the root itself matches nothing on a sensitive volume, and
    // no match is a refusal - never a licence.
    const withDeny = policyWith([rule('deny', '/w/secrets')])
    expect(decideFsPath(withDeny, '/w/SECRETS', { caseSensitive: false }).effect).toBe('deny')
    expect(decideFsPath(withDeny, '/w/SECRETS', { caseSensitive: true }).effect).toBe('allow')
    expect(decideFsPath(withDeny, '/W/secrets', { caseSensitive: true })).toEqual({
      effect: 'deny',
      reason: 'no-match',
    })
  })
})

describe('what the probe asks', () => {
  const policy = testFsPolicy('/w', { deny: ['secrets'], denyAbsolute: ['/data'] })

  it('asks every spelling that gets past a comparison made on the raw string', () => {
    const probes = enforcementProbes(policy)
    for (const p of [
      'secrets',
      'secrets/agnes-fs-enforcement-probe',
      './secrets/agnes-fs-enforcement-probe',
      'agnes-fs-enforcement-probe-elsewhere/../secrets/agnes-fs-enforcement-probe',
      '/w/secrets/agnes-fs-enforcement-probe',
    ])
      expect(probes, p).toContain(p)
    // The root fence, asked three ways because an implementation may resolve a relative path against
    // its own root, against a working directory, or not at all.
    expect(probes).toContain('../agnes-fs-enforcement-probe')
    expect(probes).toContain('/w/../agnes-fs-enforcement-probe')
    expect(probes).toContain('/agnes-fs-enforcement-probe')
    // A sibling whose name shares the root's string prefix: a startsWith fence allows it.
    expect(probes).toContain('/w-sibling/agnes-fs-enforcement-probe')
    // A deny rule outside the workspace is probed absolutely, never relativised.
    expect(probes).toContain('/data')
    expect(probes).toContain('/data/agnes-fs-enforcement-probe')
    // Apart from the deny entries themselves, every probe names a file that cannot exist, so a
    // conforming file system answers from the policy rather than from a disk.
    expect(probes.filter((p) => !p.includes('agnes-fs-enforcement-probe')).sort()).toEqual(
      [
        '.agh/secrets',
        '.agnes/secrets',
        '.git',
        '/data',
        '/w/.agh/secrets',
        '/w/.agnes/secrets',
        '/w/.git',
        '/w/secrets',
        'secrets',
      ].sort(),
    )
  })

  it('probes nothing for an allow rule: a policy is held to its denials, not its openings', () => {
    const probes = enforcementProbes(testFsPolicy('/w', { extraAllowAbsolute: ['/data/tmp'] }))
    expect(probes.filter((p) => p.startsWith('/data'))).toEqual([])
  })
})

describe('telling a refusal apart from a missing file', () => {
  it('counts only an error that says policy, never one that says missing', () => {
    expect(isDenial(new Error('E_FS_DENIED: nope'))).toBe(true)
    expect(isDenial(Object.assign(new Error('nope'), { code: 'E_FS_DENIED' }))).toBe(true)
    expect(isDenial(Object.assign(new Error('ENOENT: /w/x'), { code: 'ENOENT' }))).toBe(false)
    expect(isDenial('E_FS_DENIED')).toBe(false)
    expect(isDenial(null)).toBe(false)
  })

  // The whole reason a refusal has to be marked. Every probe path names a file that does not
  // exist, so a file system that enforces nothing still throws on each one - and would pass a check
  // that only asked whether something was thrown.
  it('a file system that only throws ENOENT does not pass', async () => {
    const enoent: FsOps = {
      ...bare,
      stat: async (p) => {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      },
    }
    await expect(assertFsEnforces(enoent, testFsPolicy('/w'))).rejects.toThrow('E_FS_UNENFORCED')
  })
})

describe('assertFsEnforces', () => {
  it('accepts a file system that refuses every spelling', async () => {
    const policy = testFsPolicy('/w', { deny: ['secrets'] })
    await expect(assertFsEnforces(fencedFs(bare, policy), policy)).resolves.toBeUndefined()
  })

  it('refuses an invalid policy before asking the file system anything', async () => {
    const policy = { ...testFsPolicy('/w'), rules: [rule('deny', 'relative')] }
    const err = await assertFsEnforces(bare, policy).catch((e: unknown) => e)
    expect((err as CoreError).code).toBe('E_FS_POLICY_INVALID')
  })

  it('refuses one that enforces nothing, and names the path that got through', async () => {
    const err = await assertFsEnforces(bare, testFsPolicy('/w')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CoreError)
    expect((err as CoreError).code).toBe('E_FS_UNENFORCED')
    expect((err as CoreError).detail?.path).toBe('../agnes-fs-enforcement-probe')
  })

  // The defect this whole change is about, stated as an obligation on the file system rather than
  // as a comparison in the kernel: raw-string matching lets three of the five spellings through.
  it('refuses one that compares the deny list against the raw string', async () => {
    const raw: FsOps = {
      ...bare,
      stat: async (p) => {
        if (['secrets'].some((d) => p === d || p.startsWith(`${d}/`))) throw new Error(`E_FS_DENIED: ${p}`)
        const parts: string[] = []
        for (const seg of (p.startsWith('/') ? p : `/w/${p}`).split('/')) {
          if (seg === '' || seg === '.') continue
          if (seg === '..') parts.pop()
          else parts.push(seg)
        }
        const real = `/${parts.join('/')}`
        if (real !== '/w' && !real.startsWith('/w/')) throw new Error(`E_FS_DENIED: ${p}`)
        return { kind: 'file', size: 0, mtimeMs: 0 }
      },
    }
    const err = await assertFsEnforces(raw, testFsPolicy('/w', { deny: ['secrets'] })).catch(
      (e: unknown) => e,
    )
    expect((err as CoreError).code).toBe('E_FS_UNENFORCED')
    expect((err as CoreError).detail?.path).toBe('/w/secrets')
  })

  // A file system that refuses everything would satisfy every probe above while being useless, and
  // a check it passes is a check that proves nothing.
  it('refuses one that refuses its own workspace root', async () => {
    const shut: FsOps = {
      ...bare,
      stat: async (p) => {
        throw new Error(`E_FS_DENIED: ${p}`)
      },
    }
    await expect(assertFsEnforces(shut, testFsPolicy('/w'))).rejects.toThrow('refuses its own workspace root')
  })

  // A root that has not been created yet is not the question being asked; only a refusal is.
  it('accepts one whose root does not exist yet', async () => {
    const policy = testFsPolicy('/w')
    const missing: FsOps = {
      ...fencedFs(bare, policy),
      stat: async (p) => {
        if (p === '.') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return fencedFs(bare, policy).stat(p)
      },
    }
    await expect(assertFsEnforces(missing, policy)).resolves.toBeUndefined()
  })
})

describe('no session opens against a file system that enforces no policy', () => {
  const kernel = (fsOps: FsOps) =>
    Kernel.create({
      storage: new MemoryStorage(),
      seams: fakeSeams(),
      provider: fakeProvider([]),
      contract: { contract_id: null, parser_version: '1' },
      preset: presetDefaults(),
      fsOps,
      netFetch: async () => new Response(''),
      timers: noTimers,
      clock: () => 1_757_203_200_000,
    })
  const opts = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }

  it('refuses at open, before the writer lease is taken', async () => {
    const k = kernel(bare)
    const err = await k.session('s1', opts).catch((e: unknown) => e)
    expect((err as CoreError).code).toBe('E_FS_UNENFORCED')
    // Nothing was opened, so the key is free and a second attempt is not an E_LANE_BUSY.
    expect(k.get('s1')).toBeUndefined()
    const again = await k.session('s1', opts).catch((e: unknown) => e)
    expect((again as CoreError).code).toBe('E_FS_UNENFORCED')
    await k.close()
  })

  it('opens against one that enforces', async () => {
    const k = kernel(fencedFs(bare, testFsPolicy('/w')))
    const s = await k.session('s2', opts)
    expect(s.key).toBe('s2')
    await k.close()
  })

  // The per-session override is the policy that will actually answer, so it is the one probed.
  it('probes the policy the session will run under, not the one the kernel was built with', async () => {
    const k = kernel(fencedFs(bare, testFsPolicy('/w')))
    const sandbox = {
      exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
      confine: async (a: string[]) => a,
      fsPolicy: () => testFsPolicy('/w', { deny: ['secrets'] }),
      enforcement: () => ({ level: 'none' as const, scope: [] }),
    }
    const err = await k.session('s3', { ...opts, seams: { sandbox } as never }).catch((e: unknown) => e)
    expect((err as CoreError).code).toBe('E_FS_UNENFORCED')
    expect((err as CoreError).detail?.path).toBe('/w/secrets')
    await k.close()
  })
})
