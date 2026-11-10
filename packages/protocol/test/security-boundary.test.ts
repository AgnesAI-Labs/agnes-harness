import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'
import { RuntimeSecurityStatus, SessionRuntimeDescriptor } from '../src/index.js'

const boundary = {
  contract: 'windows-write-restricted-v1',
  fileWrite: 'acl-partial',
  fileRead: 'unrestricted',
  network: 'unrestricted',
  processTree: 'job-object',
}
const partial = { level: 'partial', scope: ['file'], boundary }

const status = (over: { enforcement?: unknown; access?: unknown; policyBoundary?: unknown }) => ({
  platform: { os: 'win32', l1: { level: 'unavailable', scope: [] } },
  presetPolicies: [],
  permissionPolicies: [
    {
      id: 'workspace-write',
      level: 'L1',
      required: false,
      onUnavailable: 'allow-if-unimplemented',
      approvalPolicy: 'default',
      networkMode: 'unrestricted',
      ...(over.policyBoundary ? { boundary: over.policyBoundary } : {}),
    },
  ],
  workspaces: [
    {
      sessionId: 's',
      path: 'C:\\work',
      preset: 'standard',
      provider: 'local',
      state: 'ready',
      ...(over.access ? { access: over.access } : {}),
      ...(over.enforcement ? { enforcement: over.enforcement } : {}),
    },
  ],
})

const descriptor = (enforcement: unknown) => ({
  sessionKey: 's',
  loaded: true,
  generation: { current: true, state: 'active' },
  providers: [],
  seams: [],
  policy: {
    toolPolicy: 'default',
    toolRuntime: 'default',
    readOnly: false,
    sandbox: { provider: 'local', onUnavailable: 'allow-if-unimplemented', enforcement },
  },
  restartRequired: [],
})

describe('the Windows write boundary in admin status and the runtime descriptor', () => {
  it('carries the exact closed contract beside level and scope', () => {
    expect(
      Value.Check(
        RuntimeSecurityStatus,
        status({ enforcement: partial, access: 'workspace-write', policyBoundary: boundary }),
      ),
    ).toBe(true)
    expect(Value.Check(SessionRuntimeDescriptor, descriptor(partial))).toBe(true)
    // An older Host sends neither; the fields stay optional.
    expect(
      Value.Check(RuntimeSecurityStatus, status({ enforcement: { level: 'full', scope: ['file'] } })),
    ).toBe(true)
  })

  it.each([
    ['an extra key', { ...boundary, fileRead: 'unrestricted', extra: true }],
    ['another contract', { ...boundary, contract: 'windows-write-restricted-v2' }],
    ['a claimed network restriction', { ...boundary, network: 'deny' }],
    ['a missing field', { contract: boundary.contract, fileWrite: boundary.fileWrite }],
  ])('refuses %s', (_name, wrong) => {
    expect(Value.Check(RuntimeSecurityStatus, status({ enforcement: { ...partial, boundary: wrong } }))).toBe(
      false,
    )
    expect(Value.Check(RuntimeSecurityStatus, status({ policyBoundary: wrong }))).toBe(false)
    expect(Value.Check(SessionRuntimeDescriptor, descriptor({ ...partial, boundary: wrong }))).toBe(false)
  })

  it('names the workspace access with the three permission values only', () => {
    for (const access of ['read-only', 'workspace-write', 'full-access'])
      expect(Value.Check(RuntimeSecurityStatus, status({ access }))).toBe(true)
    expect(Value.Check(RuntimeSecurityStatus, status({ access: 'admin' }))).toBe(false)
  })
})
