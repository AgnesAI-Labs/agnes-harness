import type { StreamPrincipal, StreamRegistration } from '@agnes/plugin-streams'
import { createRosterStreamAuthorizer } from '@agnes/plugin-streams'
import type { ClientModuleRosterRow, PluginStreamOpen } from '@agnes/protocol'
import { expect, it } from 'vitest'

it('uses the real contribution binding and exact row allowlist, revoking stale profile and pinned clients', async () => {
  const signal = new AbortController().signal
  const principal: StreamPrincipal = {
    subject: 'synthetic',
    connectionId: 'connection',
    profileId: 'one',
    source: 'web',
    signal,
    actor: { id: 'synthetic', role: 'user', org: 'synthetic', deptPath: [], attrs: {} },
  }
  const registration: StreamRegistration = {
    owner: 'sample/plugin',
    profileId: 'one',
    activationId: 'active',
    signal,
    handler() {},
    validateInput: () => true,
    declaration: {
      name: 'sample.events',
      scope: 'profile',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      directions: ['outbound'],
      lane: 'events',
      maxFrameBytes: 4096,
      maxBufferedBytes: 32768,
      maxBytesPerSecond: 65536,
    },
  }
  const row = {
    rowId: 'web:sample',
    moduleName: 'sample/plugin',
    packageId: 'sample-package',
    enabled: true,
    phase: 'ready' as const,
    revision: 'revision',
    contentDigest: `sha256-${'a'.repeat(64)}`,
    extIds: ['sample/plugin'],
    streams: ['sample.events'],
    binding: {
      lifetime: 'profile' as const,
      owner: 'web:sample',
      packageId: 'sample-package',
      integrity: 'revision',
      profileId: 'one',
      activationId: 'active',
      availability: 'active' as const,
    },
  }
  const request: PluginStreamOpen = {
    owner: registration.owner,
    name: registration.declaration.name,
    scope: { kind: 'profile', profileId: 'one' },
    input: {},
    client: { rowId: row.rowId, revision: row.revision, contentDigest: row.contentDigest },
  }
  let current: ClientModuleRosterRow = row
  let inScope = true
  const authorize = createRosterStreamAuthorizer({
    async resolve() {
      return {
        current: () => current,
        signal,
        assertScope() {
          if (!inScope) throw new Error('scope refused')
        },
      }
    },
  })
  const admission = await authorize(principal, request, registration)
  admission.assertCurrent()
  for (const patch of [
    { enabled: false },
    { phase: 'disabled' as const },
    { revision: 'other' },
    { contentDigest: `sha256-${'b'.repeat(64)}` },
    { moduleName: 'other/plugin', extIds: ['sample/plugin'] },
    { streams: [] },
    { binding: { ...row.binding, profileId: 'two' } },
    { binding: { ...row.binding, activationId: 'old' } },
    { binding: { ...row.binding, availability: 'history-only' as const } },
  ]) {
    current = { ...row, ...patch }
    expect(() => admission.assertCurrent()).toThrow()
    await expect(authorize(principal, request, registration)).rejects.toThrow()
  }
  current = { ...row, binding: { ...row.binding, activationId: 'ui-epoch' } }
  let backendEpoch = 'active'
  const independent = createRosterStreamAuthorizer({
    async resolve() {
      return { current: () => current, backendActivationId: () => backendEpoch, signal, assertScope() {} }
    },
  })
  const bridged = await independent(principal, request, registration)
  bridged.assertCurrent()
  backendEpoch = 'revoked'
  expect(() => bridged.assertCurrent()).toThrow()
  current = row
  const sessionRequest: PluginStreamOpen = {
    ...request,
    scope: { kind: 'session', profileId: 'one', sessionId: 'session-one', laneId: 'main' },
  }
  const sessionRegistration = {
    ...registration,
    declaration: { ...registration.declaration, scope: 'session' as const },
  }
  await expect(authorize(principal, sessionRequest, sessionRegistration)).rejects.toThrow()
  const sessionBridge = createRosterStreamAuthorizer({
    async resolve() {
      return {
        current: () => current,
        consumerLifetime: 'profile',
        signal,
        assertScope() {
          if (!inScope) throw new Error('session scope refused')
        },
      }
    },
  })
  const scoped = await sessionBridge(principal, sessionRequest, sessionRegistration)
  scoped.assertCurrent()
  inScope = false
  expect(() => scoped.assertCurrent()).toThrow('session scope refused')
  inScope = false
  expect(() => admission.assertCurrent()).toThrow('scope refused')
  inScope = true
  const control = {
    ...registration,
    declaration: { ...registration.declaration, directions: ['inbound' as const], lane: 'control' as const },
  }
  await expect(authorize(principal, request, control)).rejects.toThrow()
})
