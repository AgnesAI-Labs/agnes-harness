import { expect, it } from 'vitest'
import { assertInstallPath, validInstallPathPolicy } from '../../src/resources/skill-install-files.js'
import type { SkillInstallInvocation } from '../../src/resources/skill-install-port.js'

it.each([true, false])('preserves filesystem case sensitivity=%s', (caseSensitive) => {
  const pathPolicy = {
    caseSensitive,
    policy: {
      workspaceRoot: '/data/tmp',
      digest: '0'.repeat(64),
      networkAllow: [],
      rules: [
        { effect: 'deny' as const, path: '/data', hard: false, source: 'data' as const },
        { effect: 'allow' as const, path: '/data/tmp', hard: false, source: 'data-tmp' as const },
      ],
    },
  }
  const invocation: SkillInstallInvocation = {
    packageId: 'test',
    snapshotId: 'test',
    rowId: 'test',
    leaseId: 'test',
    toolUseId: 'test',
    sessionKey: 'test',
    pathPolicy,
    deniedPaths: ['/data'],
    input: { action: 'prepare', sourceDirectory: '/data/tmp/demo', scope: 'user', enable: false },
  }
  expect(validInstallPathPolicy(pathPolicy)).toBe(true)
  expect(() => assertInstallPath(invocation, '/data/tmp/demo')).not.toThrow()
  const mixed = () => assertInstallPath(invocation, '/data/TMP/demo')
  if (caseSensitive) expect(mixed).toThrow('SKILL_PATH_DENIED')
  else expect(mixed).not.toThrow()
  expect(() => assertInstallPath(invocation, '/data/tmp-sibling/demo')).toThrow('SKILL_PATH_DENIED')
  // No-match is only eligible for the separate explicit read approval.
  expect(() => assertInstallPath(invocation, '/outside/demo')).not.toThrow()
  const { pathPolicy: _policy, deniedPaths: _denied, ...missingPolicy } = invocation
  expect(() => assertInstallPath(missingPolicy, '/outside/demo')).toThrow('SKILL_PATH_DENIED')
})
