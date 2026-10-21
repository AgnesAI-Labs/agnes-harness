import { posix } from 'node:path'
import { decideFsPath, validateFsPolicy } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { privateStateRoots } from '../src/paths.js'
import {
  compileWorkspacePolicy,
  intersectWorkspacePlan,
  memoryRequiresFileIsolation,
  normalizeSandboxStaticConfig,
  sandboxStaticConfigHash,
} from '../src/workspace-policy.js'

const canonicalize = async (path: string, options?: { base?: string }) =>
  posix.normalize(posix.resolve(options?.base ?? '/', path))

const compile = (root = '/work', preset: Record<string, unknown> = {}, protectedPaths: string[] = []) =>
  compileWorkspacePolicy({
    canonicalRoot: root,
    dataDir: '/data',
    homeDir: '/home/user',
    protectedPaths,
    semantics: { flavor: 'posix', caseSensitive: true },
    staticConfig: normalizeSandboxStaticConfig(preset),
    canonicalize,
  })

describe('Host workspace policy compiler', () => {
  it('normalizes the closed static config and hashes the normalized value stably', () => {
    const a = normalizeSandboxStaticConfig({
      sandbox: { required: true, level: 'L1', deny_paths: ['secret'], extra_paths: ['vendor'] },
    })
    const b = normalizeSandboxStaticConfig({
      sandbox: { extra_paths: ['vendor'], deny_paths: ['secret'], level: 'L1', required: true },
    })
    expect(a).toEqual(b)
    expect(sandboxStaticConfigHash(a)).toBe(sandboxStaticConfigHash(b))
    expect(sandboxStaticConfigHash(a)).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(a)).toBe(true)
    const conditional = normalizeSandboxStaticConfig({
      sandbox: { level: 'L1', on_unavailable: 'allow-if-unimplemented' },
    })
    expect(conditional.onUnavailable).toBe('allow-if-unimplemented')
    expect(() =>
      normalizeSandboxStaticConfig({ sandbox: { level: 'L0', on_unavailable: 'allow-if-unimplemented' } }),
    ).toThrow('E_SANDBOX_WORKSPACE')
  })

  it.each(['implemented', 'unknown', 'unimplemented'] as const)(
    'preserves memory isolation for %s except explicitly permitted missing local implementation',
    (support) => {
      const l0 = normalizeSandboxStaticConfig({ sandbox: { level: 'L0', on_unavailable: 'allow' } })
      const conditional = normalizeSandboxStaticConfig({
        sandbox: { level: 'L1', on_unavailable: 'allow-if-unimplemented' },
      })
      for (const config of [l0, conditional]) {
        expect(memoryRequiresFileIsolation(true, support, config)).toBe(support !== 'unimplemented')
        expect(memoryRequiresFileIsolation(true, support, { ...config, required: true })).toBe(true)
        expect(memoryRequiresFileIsolation(false, support, config)).toBe(false)
      }
      expect(memoryRequiresFileIsolation(true, support, { ...l0, onUnavailable: 'deny' })).toBe(true)
    },
  )

  it('rejects unknown config instead of silently compiling a weaker plan', () => {
    expect(() => normalizeSandboxStaticConfig({ sandbox: { raw_exec: true } })).toThrow('E_SANDBOX_WORKSPACE')
  })

  it('freezes one policy carrying the workspace allow and integrity floor', async () => {
    const plan = await compile('/work', {
      sandbox: { extra_paths: ['vendor'], deny_paths: ['secret'], network_allow: [] },
    })
    expect(plan.policy.workspaceRoot).toBe('/work')
    expect(plan.policy.rules).toContainEqual({
      effect: 'deny',
      path: '/work/.git',
      source: 'host-integrity',
      hard: true,
    })
    expect(plan.policy.rules).toContainEqual({
      effect: 'deny',
      path: '/work/.agh/secrets',
      source: 'host-integrity',
      hard: true,
    })
    expect(plan.policy.rules.some((rule) => rule.path === '/work/.agnes/secrets')).toBe(false)
    expect(plan.policy.rules.filter((rule) => rule.source === 'host-integrity')).toHaveLength(2)
    expect(plan.backendOptions.allowPaths).toContain('/work/vendor')
    expect(plan.backendOptions.denyPaths).toContain('/work/secret')
    expect(Object.isFrozen(plan.policy)).toBe(true)
    expect(Object.isFrozen(plan.policy.rules)).toBe(true)
  })

  it('binds permission presets to write roots and distinct readiness identities', async () => {
    const protectedPaths = privateStateRoots({
      home: '/installation',
      dataDir: '/data',
      workspace: '/work',
    }).map((path) => path.replaceAll('\\', '/'))
    const readOnly = await compile(
      '/work',
      {
        providers: { 'tool-policy': { provider: 'read-only' } },
        sandbox: { level: 'L1', required: true },
      },
      protectedPaths,
    )
    const writable = await compile(
      '/work',
      {
        providers: { 'tool-policy': { provider: 'default' } },
        sandbox: { level: 'L1', required: true },
      },
      protectedPaths,
    )
    const full = await compile(
      '/work',
      {
        providers: { 'tool-policy': { provider: 'full-access' } },
        sandbox: { level: 'L0', on_unavailable: 'allow' },
      },
      protectedPaths,
    )
    for (const plan of [readOnly, writable, full])
      for (const path of [
        '/installation/memory',
        '/installation/secrets',
        '/installation/profiles',
        '/data/daemon',
      ])
        expect(plan.backendOptions.denyPaths).toContain(path)
    expect(readOnly.backendOptions.allowPaths).toEqual([])
    expect(writable.backendOptions.allowPaths).toContain('/work')
    expect(full.policy.rules.some((rule) => rule.effect === 'allow' && rule.path === '/')).toBe(false)
    expect(full.backendOptions.denyPaths).toContain('/work/.git')
    expect(new Set([readOnly.staticConfigHash, writable.staticConfigHash, full.staticConfigHash]).size).toBe(
      3,
    )
  })

  it('captures file and network scope as a conjunction, retaining hard denials and read-only writes', async () => {
    const parent = await compile('/work', {
      sandbox: {
        extra_paths: ['/parent', '/shared'],
        deny_paths: ['/work/private'],
        network_allow: ['shared.test', 'parent.test'],
      },
    })
    const role = await compile('/work', {
      sandbox: { extra_paths: ['/role', '/shared'], network_allow: ['shared.test', 'role.test'] },
    })
    const joined = intersectWorkspacePlan(role, parent.policy)
    expect(() => validateFsPolicy(joined.policy)).not.toThrow()
    for (const [path, effect] of [
      ['/work/a', 'allow'],
      ['/shared/a', 'allow'],
      ['/parent/a', 'deny'],
      ['/role/a', 'deny'],
      ['/work/private/a', 'deny'],
      ['/work/.git/a', 'deny'],
    ] as const)
      expect(decideFsPath(joined.policy, path, { caseSensitive: true }).effect).toBe(effect)
    expect(joined.backendOptions.networkAllow).toEqual(['shared.test'])
    expect(joined.backendOptions.fullAccess).toBeUndefined()
    expect(joined.backendOptions.network).toBe('deny')
    expect(joined.staticConfigHash).not.toBe(role.staticConfigHash)
    expect(joined.staticConfigHash).toBe(sandboxStaticConfigHash(joined.staticConfig))
    expect(intersectWorkspacePlan(role, { ...parent.policy, networkAllow: [] }).staticConfigHash).not.toBe(
      joined.staticConfigHash,
    )
    const readOnly = await compile('/work', { providers: { 'tool-policy': { provider: 'read-only' } } })
    expect(intersectWorkspacePlan(readOnly, parent.policy).backendOptions.allowPaths).toEqual([])
    expect(() => intersectWorkspacePlan(role, { ...parent.policy, workspaceRoot: '/different' })).toThrow(
      'root differs',
    )
  })

  it('refuses a canonical root whose identity changes during live canonicalization', async () => {
    await expect(
      compileWorkspacePolicy({
        canonicalRoot: '/link',
        dataDir: '/data',
        homeDir: '/home/user',
        semantics: { flavor: 'posix', caseSensitive: true },
        staticConfig: normalizeSandboxStaticConfig({}),
        canonicalize: async (path, options) =>
          path === '/link' ? '/real' : posix.resolve(options?.base ?? '/', path),
      }),
    ).rejects.toMatchObject({ code: 'E_SANDBOX_WORKSPACE' })
  })

  it('uses the root-specific case semantics for identity and digest', async () => {
    const config = normalizeSandboxStaticConfig({})
    const insensitive = await compileWorkspacePolicy({
      canonicalRoot: '/Work',
      dataDir: '/Data',
      homeDir: '/Home/User',
      semantics: { flavor: 'posix', caseSensitive: false },
      staticConfig: config,
      canonicalize: async (path, options) => posix.resolve(options?.base ?? '/', path).toLowerCase(),
    })
    expect(insensitive.policy.workspaceRoot).toBe('/work')
    const sensitive = await compile('/work')
    expect(insensitive.policy.digest).not.toBe(sensitive.policy.digest)
  })
})
