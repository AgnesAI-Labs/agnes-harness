import { describe, expect, it } from 'vitest'
import {
  type CanonicalPath,
  canonicalPath,
  compileL0Policy,
  createPathPolicy,
  decidePath,
  type PathPolicy,
  readSandboxConfig,
  resolvePolicy,
} from '../src/policy.js'

const POSIX = { flavor: 'posix', caseSensitive: true } as const
const p = (value: string): CanonicalPath => canonicalPath(value, POSIX)

function policy() {
  return compileL0Policy({
    workspaceRoot: p('/work/project'),
    dataDir: p('/home/u/.agh'),
    dataTmp: p('/home/u/.agh/tmp'),
    homeSsh: p('/home/u/.ssh'),
    dataSecrets: p('/home/u/.agh/secrets'),
    hostIntegrityDeny: [
      p('/work/project/.git'),
      p('/work/project/.agh/secrets'),
      p('/work/project/.agnes/secrets'),
    ],
    extraAllow: [
      p('/opt/data'),
      p('/vault/denied/reopened'),
      p('/home/u/.ssh/reopened'),
      p('/home/u/.agh/secrets/reopened'),
    ],
    configuredDeny: [p('/home/u/.agh/tmp/nope'), p('/opt/data/blocked'), p('/vault/denied')],
  })
}

describe('canonical path model', () => {
  it('accepts only normalized absolute paths and copies their segment identity', () => {
    const path = p('/work/project/file.txt')
    expect(path).toEqual({
      value: '/work/project/file.txt',
      root: '/',
      segments: ['work', 'project', 'file.txt'],
      flavor: 'posix',
      caseSensitive: true,
    })
    expect(Object.isFrozen(path)).toBe(true)
    expect(Object.isFrozen(path.segments)).toBe(true)
  })

  it.each(['', 'relative/path', '/work/../etc', '/work/./file', '/work//file', '/work/file/'])(
    'rejects a non-canonical spelling: %j',
    (value) => expect(() => p(value)).toThrow(/E_SANDBOX_POLICY/),
  )

  it('rejects NUL without echoing the hostile path', () => {
    try {
      p('/work/secret\0tail')
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toMatchObject({ code: 'E_SANDBOX_POLICY' })
      expect((error as Error).message).not.toContain('secret')
    }
  })

  it('uses explicit win32 and case semantics without prefix aliasing', () => {
    const win = { flavor: 'win32', caseSensitive: false } as const
    const root = canonicalPath('C:\\Work', win)
    const rules = createPathPolicy([{ effect: 'allow', hard: false, path: root, source: 'workspace' }])
    expect(decidePath(rules, canonicalPath('c:\\WORK\\file.txt', win)).effect).toBe('allow')
    expect(decidePath(rules, canonicalPath('C:\\Workbook\\file.txt', win)).effect).toBe('deny')
  })
})

describe('L0 path precedence', () => {
  it('denies dataDir but allows the more-specific dataDir/tmp exception', () => {
    const rules = policy()
    expect(decidePath(rules, p('/home/u/.agh/state')).effect).toBe('deny')
    expect(decidePath(rules, p('/home/u/.agh/tmp/file')).effect).toBe('allow')
  })

  it('lets a still-more-specific configured deny close part of dataDir/tmp', () => {
    const decision = decidePath(policy(), p('/home/u/.agh/tmp/nope/file'))
    expect(decision).toMatchObject({ effect: 'deny', reason: 'rule', rule: { source: 'preset' } })
  })

  it('uses longest match for ordinary extra/deny overlap', () => {
    const rules = policy()
    expect(decidePath(rules, p('/opt/data/file')).effect).toBe('allow')
    expect(decidePath(rules, p('/opt/data/blocked/file')).effect).toBe('deny')
    expect(decidePath(rules, p('/vault/denied/file')).effect).toBe('deny')
    expect(decidePath(rules, p('/vault/denied/reopened/file')).effect).toBe('allow')
  })

  it('makes deny win when allow and deny match at equal depth', () => {
    const allow = createPathPolicy([{ effect: 'allow', hard: false, path: p('/same'), source: 'extra' }])
    // Policy construction rejects this ambiguity. Keep the decision function fail-closed even for
    // an object received across an untyped JavaScript boundary.
    const rules = Object.freeze([
      ...allow.rules,
      Object.freeze({ effect: 'deny' as const, hard: false, path: p('/same'), source: 'preset' as const }),
    ])
    const ambiguous: PathPolicy = Object.freeze({ ...allow, rules })
    const decision = decidePath(ambiguous, p('/same/file'))
    expect(decision).toMatchObject({ effect: 'deny', reason: 'rule', rule: { source: 'preset' } })
  })

  it('never lets a more-specific allow reopen a hard deny', () => {
    expect(decidePath(policy(), p('/home/u/.ssh/reopened/key'))).toMatchObject({
      effect: 'deny',
      reason: 'hard-deny',
      rule: { source: 'home-ssh' },
    })
    expect(decidePath(policy(), p('/home/u/.agh/secrets/reopened/key'))).toMatchObject({
      effect: 'deny',
      reason: 'hard-deny',
      rule: { source: 'data-secrets' },
    })
  })

  it('defaults to deny and compares complete path segments', () => {
    const rules = policy()
    expect(decidePath(rules, p('/outside/file'))).toEqual({ effect: 'deny', reason: 'no-match' })
    expect(decidePath(rules, p('/work/project-sibling/file'))).toEqual({
      effect: 'deny',
      reason: 'no-match',
    })
  })

  it('keeps host-integrity paths hard-denied', () => {
    expect(decidePath(policy(), p('/work/project/.git/config'))).toMatchObject({
      effect: 'deny',
      reason: 'hard-deny',
      rule: { source: 'host-integrity' },
    })
  })

  it('refuses a dataTmp identity outside canonical dataDir', () => {
    expect(() =>
      compileL0Policy({
        workspaceRoot: p('/work/project'),
        dataDir: p('/home/u/.agh'),
        dataTmp: p('/private/tmp/escaped'),
        homeSsh: p('/home/u/.ssh'),
        dataSecrets: p('/home/u/.agh/secrets'),
        hostIntegrityDeny: [],
        extraAllow: [],
        configuredDeny: [],
      }),
    ).toThrow(/E_SANDBOX_POLICY/)
  })

  it('rejects candidates with different path semantics', () => {
    const candidate = canonicalPath('C:\\work\\project', {
      flavor: 'win32',
      caseSensitive: false,
    })
    expect(() => decidePath(policy(), candidate)).toThrow(/E_SANDBOX_POLICY/)
  })
})

describe('stable policy identity', () => {
  const entries = () => [
    { effect: 'deny' as const, hard: false, path: p('/work/project/private'), source: 'preset' as const },
    { effect: 'allow' as const, hard: false, path: p('/work/project'), source: 'workspace' as const },
    { effect: 'deny' as const, hard: true, path: p('/work/project/.git'), source: 'host-integrity' as const },
  ]

  it('sorts before hashing, so input order cannot change the digest', () => {
    const forward = createPathPolicy(entries())
    const reversed = createPathPolicy(entries().reverse())
    expect(forward.rules).toEqual(reversed.rules)
    expect(forward.digest).toBe(reversed.digest)
    expect(forward.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('pins the canonical serialization and includes path semantics in its SHA-256', () => {
    const sensitive = createPathPolicy([
      { effect: 'allow', hard: false, path: p('/work'), source: 'workspace' },
    ])
    expect(sensitive.digest).toBe('aa51392b24bcffad1ba957d740cb95bf8553c762ec860c1316f3bbfad267e970')
    const insensitive = createPathPolicy([
      {
        effect: 'allow',
        hard: false,
        path: canonicalPath('/work', { flavor: 'posix', caseSensitive: false }),
        source: 'workspace',
      },
    ])
    expect(insensitive.digest).not.toBe(sensitive.digest)
  })

  it('changes the digest when a real rule changes', () => {
    const before = createPathPolicy(entries())
    const after = createPathPolicy([
      ...entries().slice(0, -1),
      {
        effect: 'deny',
        hard: true,
        path: p('/work/project/.agh/secrets'),
        source: 'host-integrity',
      },
    ])
    expect(after.digest).not.toBe(before.digest)
  })

  it('deduplicates a completely identical rule before hashing', () => {
    const one = entries()[0]
    expect(one).toBeDefined()
    const single = createPathPolicy([one as NonNullable<typeof one>])
    const repeated = createPathPolicy([one as NonNullable<typeof one>, one as NonNullable<typeof one>])
    expect(repeated.rules).toHaveLength(1)
    expect(repeated.digest).toBe(single.digest)
  })

  it('rejects conflicting effect or hard at one canonical path with a coded failure', () => {
    const path = p('/work/project/private')
    for (const conflicting of [
      [
        { effect: 'allow' as const, hard: false, path, source: 'extra' as const },
        { effect: 'deny' as const, hard: false, path, source: 'preset' as const },
      ],
      [
        { effect: 'deny' as const, hard: false, path, source: 'preset' as const },
        { effect: 'deny' as const, hard: true, path, source: 'host-integrity' as const },
      ],
    ]) {
      const error = (() => {
        try {
          createPathPolicy(conflicting)
        } catch (cause) {
          return cause
        }
        return undefined
      })()
      expect(error).toMatchObject({ code: 'E_SANDBOX_POLICY' })
      expect((error as Error).message).not.toContain(path.value)
    }
  })

  it('uses the declared case semantics consistently for identity and digest', () => {
    const insensitive = { flavor: 'win32', caseSensitive: false } as const
    const upper = canonicalPath('C:\\Work\\Private', insensitive)
    const lower = canonicalPath('c:\\work\\private', insensitive)
    const upperRule = { effect: 'deny' as const, hard: false, path: upper, source: 'preset' as const }
    const lowerRule = { ...upperRule, path: lower }
    const one = createPathPolicy([upperRule])
    const variants = createPathPolicy([upperRule, lowerRule])
    expect(variants.rules).toHaveLength(1)
    expect(variants.digest).toBe(one.digest)
    expect(() => createPathPolicy([upperRule, { ...lowerRule, effect: 'allow', source: 'extra' }])).toThrow(
      /E_SANDBOX_POLICY/,
    )

    const sensitive = { flavor: 'win32', caseSensitive: true } as const
    const exactUpper = createPathPolicy([
      { ...upperRule, path: canonicalPath('C:\\Work\\Private', sensitive) },
    ])
    const exactLower = createPathPolicy([
      { ...upperRule, path: canonicalPath('c:\\work\\private', sensitive) },
    ])
    expect(exactLower.digest).not.toBe(exactUpper.digest)
  })
})

/**
 * A lexical canonicalize double: no I/O, so these cases prove compilation only. The real one is
 * the host's filesystem canonicalizer, exercised by the host-side integration tests. Relative
 * paths resolve against `base`; `..` climbing above the volume root is rejected, as is NUL.
 */
const lexCanonicalize = (path: string, opts?: { base?: string }): string => {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0'))
    throw Object.assign(new Error('invalid path'), { code: 'E_FS_DENIED' })
  const abs = path.startsWith('/') ? path : `${opts?.base ?? '/'}/${path}`
  const parts: string[] = []
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) throw Object.assign(new Error('escapes root'), { code: 'E_FS_DENIED' })
      parts.pop()
    } else parts.push(seg)
  }
  return `/${parts.join('/')}`
}

const resolveInput = (over: Record<string, unknown> = {}) => ({
  config: readSandboxConfig({}),
  workspaceRoot: '/work/project',
  dataDir: '/home/u/.agh',
  homeDir: '/home/u',
  semantics: { flavor: 'posix', caseSensitive: true } as const,
  canonicalize: async (path: string, opts?: { base?: string }) => lexCanonicalize(path, opts),
  ...over,
})

describe('readSandboxConfig fails closed', () => {
  it('defaults an absent sandbox key to the deny posture', () => {
    expect(readSandboxConfig({})).toEqual({
      level: 'L0',
      required: false,
      onUnavailable: 'deny',
      extraPaths: [],
      denyPaths: [],
      networkAllow: [],
    })
  })

  it('reads a fully spelled config verbatim', () => {
    expect(
      readSandboxConfig({
        sandbox: {
          level: 'L1',
          required: true,
          on_unavailable: 'allow',
          extra_paths: ['/opt/data'],
          deny_paths: ['vendor'],
          network_allow: ['api.example.com'],
        },
      }),
    ).toEqual({
      level: 'L1',
      required: true,
      onUnavailable: 'allow',
      extraPaths: ['/opt/data'],
      denyPaths: ['vendor'],
      networkAllow: ['api.example.com'],
    })
  })

  it.each([
    ['a non-object sandbox key', { sandbox: 'L1' }],
    ['an unknown level', { sandbox: { level: 'L2' } }],
    ['a non-boolean required', { sandbox: { required: 'yes' } }],
    ['an unknown on_unavailable', { sandbox: { on_unavailable: 'maybe' } }],
    ['a non-array extra_paths', { sandbox: { extra_paths: '/opt/data' } }],
    ['a non-string extra path', { sandbox: { extra_paths: [42] } }],
    ['a non-string network_allow entry', { sandbox: { network_allow: [42] } }],
    // A private key is how an extension manifest would smuggle network hosts into the policy.
    // The sandbox config is a closed set of keys; anything else is a refusal, not a passthrough.
    ['a private smuggled key', { sandbox: { __extNetworkHosts: ['evil.example'] } }],
  ])('rejects %s with E_SEAM_INIT', (_name, preset) => {
    expect(() => readSandboxConfig(preset)).toThrow(
      expect.objectContaining({ code: 'E_SEAM_INIT' }) as unknown as Error,
    )
  })
})

describe('resolvePolicy compiles the full L0 rule set through the injected canonicalizer', () => {
  it('emits the seven rule kinds with the three host-integrity paths under the workspace', async () => {
    const { policy, fsPolicy } = await resolvePolicy(resolveInput())
    const bySource = new Map(policy.rules.map((r) => [r.source, r]))
    expect(bySource.get('workspace')).toMatchObject({ effect: 'allow', path: { value: '/work/project' } })
    expect(bySource.get('data')).toMatchObject({ effect: 'deny', path: { value: '/home/u/.agh' } })
    expect(bySource.get('data-tmp')).toMatchObject({
      effect: 'allow',
      path: { value: '/home/u/.agh/tmp' },
    })
    expect(bySource.get('home-ssh')).toMatchObject({
      effect: 'deny',
      hard: true,
      path: { value: '/home/u/.ssh' },
    })
    expect(bySource.get('data-secrets')).toMatchObject({
      effect: 'deny',
      hard: true,
      path: { value: '/home/u/.agh/secrets' },
    })
    const integrity = policy.rules.filter((r) => r.source === 'host-integrity')
    expect(integrity.map((r) => r.path.value).sort()).toEqual([
      '/work/project/.agh/secrets',
      '/work/project/.agnes/secrets',
      '/work/project/.git',
    ])
    expect(integrity.every((r) => r.hard && r.effect === 'deny')).toBe(true)
    // The projection is the whole contract: plain strings, one digest, no CanonicalPath wrappers.
    expect(fsPolicy.workspaceRoot).toBe('/work/project')
    expect(fsPolicy.digest).toBe(policy.digest)
    expect(fsPolicy.rules.length).toBe(policy.rules.length)
    for (const r of fsPolicy.rules) expect(typeof r.path).toBe('string')
    expect(fsPolicy.networkAllow).toEqual([])
  })

  it('hard-denies the workspace secrets directory under both .agh and the legacy .agnes name', async () => {
    const { policy } = await resolvePolicy(resolveInput())
    for (const dir of ['.agh', '.agnes']) {
      expect(decidePath(policy, p(`/work/project/${dir}/secrets/token`))).toMatchObject({
        effect: 'deny',
        reason: 'hard-deny',
        rule: { source: 'host-integrity' },
      })
    }
  })

  it('resolves relative extra and deny paths against the workspace root, and keeps absolute ones', async () => {
    const config = readSandboxConfig({
      sandbox: { extra_paths: ['shared', '/opt/data'], deny_paths: ['vendor', '/etc/ssl'] },
    })
    const { policy } = await resolvePolicy(resolveInput({ config }))
    expect(decidePath(policy, p('/work/project/shared/x')).effect).toBe('allow')
    expect(decidePath(policy, p('/opt/data/x')).effect).toBe('allow')
    expect(decidePath(policy, p('/work/project/vendor/x')).effect).toBe('deny')
    expect(decidePath(policy, p('/etc/ssl/x')).effect).toBe('deny')
  })

  it('takes homeDir from the profile, never derived from the dataDir string', async () => {
    const { policy } = await resolvePolicy(resolveInput({ dataDir: '/var/lib/agnes', homeDir: '/home/u' }))
    expect(decidePath(policy, p('/home/u/.ssh/id_ed25519'))).toMatchObject({
      effect: 'deny',
      reason: 'hard-deny',
    })
  })

  it.each([
    ['an empty workspace root', { workspaceRoot: '' }],
    ['a NUL in an extra path', { config: readSandboxConfig({ sandbox: { extra_paths: ['/ok\0x'] } }) }],
    ['an empty deny path', { config: readSandboxConfig({ sandbox: { deny_paths: [''] } }) }],
    ['an empty homeDir', { homeDir: '' }],
  ])('refuses %s with E_SEAM_INIT', async (_name, over) => {
    await expect(resolvePolicy(resolveInput(over))).rejects.toThrow(
      expect.objectContaining({ code: 'E_SEAM_INIT' }) as unknown as Error,
    )
  })

  it('refuses a config whose allow and deny collide on one canonical path', async () => {
    const config = readSandboxConfig({
      sandbox: { extra_paths: ['/opt/data'], deny_paths: ['/opt/data'] },
    })
    await expect(resolvePolicy(resolveInput({ config }))).rejects.toThrow(
      expect.objectContaining({ code: 'E_SEAM_INIT' }) as unknown as Error,
    )
  })

  it('keeps the digest stable against config ordering and sensitive to rule changes', async () => {
    const a = await resolvePolicy(
      resolveInput({
        config: readSandboxConfig({ sandbox: { extra_paths: ['/a', '/b'], deny_paths: ['/c'] } }),
      }),
    )
    const b = await resolvePolicy(
      resolveInput({
        config: readSandboxConfig({ sandbox: { extra_paths: ['/b', '/a'], deny_paths: ['/c'] } }),
      }),
    )
    expect(a.policy.digest).toBe(b.policy.digest)
    const c = await resolvePolicy(
      resolveInput({
        config: readSandboxConfig({ sandbox: { extra_paths: ['/a', '/b'], deny_paths: ['/d'] } }),
      }),
    )
    expect(c.policy.digest).not.toBe(a.policy.digest)
  })
})
