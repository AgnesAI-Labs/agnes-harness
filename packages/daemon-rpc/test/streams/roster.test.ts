import type { ClientModuleRosterRow, PluginStreamOpen } from '@agnes/protocol'
import { expect, it } from 'vitest'
import type { StreamPrincipal, StreamRegistration } from '../../src/streams/broker.js'
import { createRosterStreamAuthorizer } from '../../src/streams/roster.js'

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
  current = row
  inScope = false
  expect(() => admission.assertCurrent()).toThrow('scope refused')
  inScope = true
  const control = {
    ...registration,
    declaration: { ...registration.declaration, directions: ['inbound' as const], lane: 'control' as const },
  }
  await expect(authorize(principal, request, control)).rejects.toThrow()
})
