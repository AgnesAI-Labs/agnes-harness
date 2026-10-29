import type { HostSession, PluginManageInvocation } from '@agnes/host'
import { expect, it, vi } from 'vitest'
import { requestPluginManage } from '../src/plugin-manage.js'
import type { SharedSessionChannel } from '../src/shared-session-channel.js'

const candidateTestSandbox = {
  policy: { workspaceRoot: '/synthetic', rules: [], networkAllow: [], digest: 'a'.repeat(64) },
  network: 'deny' as const,
  local: true,
}
const invocation: PluginManageInvocation = {
  packageId: '@agnes/skill-helper',
  snapshotId: 'snap',
  rowId: 'helper',
  sessionKey: 's',
  toolUseId: 'tool',
  turn: 1,
  leaseId: 'lease',
  input: { action: 'candidate.test', candidateId: 'candidate-1', expectedHash: 'hash' },
}
it('supplies the Host sandbox without minting a feature-specific permission override', async () => {
  const session = { key: 's', commandSandboxPolicy: () => candidateTestSandbox } as unknown as HostSession
  const request = vi.fn<SharedSessionChannel['request']>(async () => 'ran')
  expect(
    await requestPluginManage(session, invocation, new AbortController().signal, {
      request,
      currentSessionKey: () => 's',
    }),
  ).toBe('ran')
  expect(request.mock.calls[0]?.[1]).toEqual({ ...invocation, candidateTestSandbox })
})
it('refuses missing sessions, mismatched sessions and cancellation before sending a test request', async () => {
  const request = vi.fn<SharedSessionChannel['request']>(async () => undefined)
  await expect(
    requestPluginManage(undefined, invocation, new AbortController().signal, {
      request,
      currentSessionKey: () => 's',
    }),
  ).rejects.toThrow('not open')
  await expect(
    requestPluginManage(undefined, invocation, AbortSignal.abort(), {
      request,
      currentSessionKey: () => 's',
    }),
  ).rejects.toBeDefined()
  await expect(
    requestPluginManage(
      undefined,
      { ...invocation, input: { action: 'candidate.write' } },
      new AbortController().signal,
      {
        request,
        currentSessionKey: () => 'another-session',
      },
    ),
  ).rejects.toThrow('session mismatch')
  await expect(
    requestPluginManage(
      undefined,
      { ...invocation, input: { action: 'candidate.write' } },
      AbortSignal.abort(),
      {
        request,
        currentSessionKey: () => 's',
      },
    ),
  ).rejects.toBeDefined()
  expect(request).not.toHaveBeenCalled()
})
