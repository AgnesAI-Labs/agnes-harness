import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compileWorkspacePolicy,
  normalizeSandboxStaticConfig,
  sandboxStaticConfigHash,
} from '../src/workspace-policy.js'

const canonicalize = async (path: string, options?: { base?: string }) =>
  posix.normalize(posix.resolve(options?.base ?? '/', path))

const compile = (root = '/work', preset: Record<string, unknown> = {}) =>
  compileWorkspacePolicy({
    canonicalRoot: root,
    dataDir: '/data',
    homeDir: '/home/user',
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
  })

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
    // `.agnes/secrets` is the secrets directory's name from before the `.agh` rename; both stay denied.
    for (const path of ['/work/.agh/secrets', '/work/.agnes/secrets'])
      expect(plan.policy.rules).toContainEqual({ effect: 'deny', path, source: 'host-integrity', hard: true })
    expect(plan.policy.rules.filter((rule) => rule.source === 'host-integrity')).toHaveLength(3)
    expect(plan.backendOptions.allowPaths).toContain('/work/vendor')
    expect(plan.backendOptions.denyPaths).toContain('/work/secret')
    expect(Object.isFrozen(plan.policy)).toBe(true)
    expect(Object.isFrozen(plan.policy.rules)).toBe(true)
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
