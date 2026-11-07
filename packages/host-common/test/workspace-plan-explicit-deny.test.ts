import { posix } from 'node:path'
import { expect, it } from 'vitest'
import {
  compileWorkspacePolicy,
  intersectWorkspacePlan,
  normalizeSandboxStaticConfig,
  planExplicitDeny,
} from '../src/workspace-policy.js'

const compile = (preset: Record<string, unknown>) =>
  compileWorkspacePolicy({
    canonicalRoot: '/work',
    dataDir: '/data',
    homeDir: '/srv/agent',
    protectedPaths: [],
    semantics: { flavor: 'posix', caseSensitive: true },
    staticConfig: normalizeSandboxStaticConfig(preset),
    canonicalize: async (path, options) => posix.normalize(posix.resolve(options?.base ?? '/', path)),
  })

it('tells an explicit deny of a narrowed plan from the default protected paths it lists', async () => {
  const own = await compile({ sandbox: { level: 'L1' } })
  const narrowed = intersectWorkspacePlan(own, own.policy)
  // Every deny rule, defaults included, lands in the narrowed deny paths; none of them is explicit.
  expect(narrowed.staticConfig.denyPaths).toContain('/work/.git')
  expect(planExplicitDeny(own)).toBe(false)
  expect(planExplicitDeny(narrowed)).toBe(false)
  // A delegating policy's own deny over a path this session allows is explicit.
  const strict = await compile({ sandbox: { level: 'L1', deny_paths: ['secret'] } })
  expect(planExplicitDeny(intersectWorkspacePlan(own, strict.policy))).toBe(true)
  // So is the session's own configured deny, before and after narrowing.
  expect(planExplicitDeny(strict)).toBe(true)
  expect(planExplicitDeny(intersectWorkspacePlan(strict, own.policy))).toBe(true)
})
