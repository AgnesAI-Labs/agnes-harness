import type { WindowsWriteBoundary } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import {
  isWindowsWriteBoundary,
  resolveWindowsExecution,
  WINDOWS_WRITE_BOUNDARY,
  type WindowsExecutionInput,
} from '../src/windows-acl/policy.js'

const trustedWriteInput: WindowsExecutionInput = {
  access: 'workspace-write',
  windowsMode: 'write-restricted',
  required: false,
  extraReadIsolation: false,
  customFsDeny: false,
  networkMode: 'allow',
  providerId: 'builtin',
  localProviderId: 'builtin',
  availableBoundary: WINDOWS_WRITE_BOUNDARY,
}

const { availableBoundary: _proof, ...unproven } = trustedWriteInput

const refusal = (input: WindowsExecutionInput) => {
  const decision = resolveWindowsExecution(input)
  if (decision.kind !== 'refusal') throw new Error(`expected a refusal, got ${decision.kind}`)
  return decision.reason
}

describe('Windows execution decision', () => {
  it('freezes the exact boundary label', () => {
    expect(WINDOWS_WRITE_BOUNDARY).toEqual({
      contract: 'windows-write-restricted-v1',
      fileWrite: 'acl-partial',
      fileRead: 'unrestricted',
      network: 'unrestricted',
      processTree: 'job-object',
    })
    expect(Object.isFrozen(WINDOWS_WRITE_BOUNDARY)).toBe(true)
    expect(isWindowsWriteBoundary({ ...WINDOWS_WRITE_BOUNDARY })).toBe(true)
  })

  it.each([
    undefined,
    null,
    'windows-write-restricted-v1',
    [],
    { ...WINDOWS_WRITE_BOUNDARY, contract: 'windows-write-restricted-v2' },
    { ...WINDOWS_WRITE_BOUNDARY, fileWrite: 'acl-full' },
    { ...WINDOWS_WRITE_BOUNDARY, fileRead: 'denied' },
    { ...WINDOWS_WRITE_BOUNDARY, network: 'denied' },
    { ...WINDOWS_WRITE_BOUNDARY, processTree: 'none' },
    { ...WINDOWS_WRITE_BOUNDARY, extra: true },
    { contract: WINDOWS_WRITE_BOUNDARY.contract },
  ])('rejects any other boundary shape: %j', (value) => {
    expect(isWindowsWriteBoundary(value)).toBe(false)
  })

  it('required isolation never becomes a Windows partial grant', () => {
    expect(resolveWindowsExecution({ ...trustedWriteInput, required: true }).kind).toBe('refusal')
    expect(resolveWindowsExecution(trustedWriteInput).kind).toBe('windows-write-restricted-v1')
  })

  it.each(['read-only', 'workspace-write'] as const)('selects the partial contract for %s', (access) => {
    const decision = resolveWindowsExecution({ ...trustedWriteInput, access })
    expect(decision).toEqual({
      kind: 'windows-write-restricted-v1',
      boundary: WINDOWS_WRITE_BOUNDARY,
      mode: access,
    })
  })

  it('runs full access without extra isolation unconfined and never modifies anything', () => {
    for (const windowsMode of ['write-restricted', 'require-full'] as const)
      expect(
        resolveWindowsExecution({
          ...unproven,
          access: 'full-access',
          windowsMode,
        }),
      ).toEqual({ kind: 'unconfined' })
  })

  it('does not downgrade a stronger requirement on full access to unconfined', () => {
    const full: WindowsExecutionInput = { ...trustedWriteInput, access: 'full-access' }
    expect(refusal({ ...full, required: true })).toBe('required-isolation')
    expect(refusal({ ...full, extraReadIsolation: true })).toBe('read-isolation')
    expect(refusal({ ...full, customFsDeny: true })).toBe('read-deny')
    expect(refusal({ ...full, networkMode: 'deny' })).toBe('network-restriction')
  })

  it('refuses the file read protections and network restrictions the partial contract cannot honour', () => {
    expect(refusal({ ...trustedWriteInput, extraReadIsolation: true })).toBe('read-isolation')
    expect(refusal({ ...trustedWriteInput, customFsDeny: true })).toBe('read-deny')
    for (const networkMode of ['deny', 'hosts', 'loopback-serve'] as const)
      expect(refusal({ ...trustedWriteInput, networkMode })).toBe('network-restriction')
  })

  it('keeps the stronger requirement visible when several apply', () => {
    expect(
      refusal({
        ...trustedWriteInput,
        required: true,
        extraReadIsolation: true,
        customFsDeny: true,
        networkMode: 'deny',
      }),
    ).toBe('required-isolation')
  })

  it('needs an explicit write-restricted choice; require-full never becomes partial', () => {
    expect(refusal({ ...trustedWriteInput, windowsMode: 'require-full' })).toBe('windows-mode-require-full')
    expect(refusal({ ...trustedWriteInput, access: 'read-only', windowsMode: 'require-full' })).toBe(
      'windows-mode-require-full',
    )
  })

  it('needs a trusted provider that proves the exact boundary', () => {
    expect(refusal(unproven)).toBe('boundary-unavailable')
    for (const wrong of [
      { ...WINDOWS_WRITE_BOUNDARY, fileWrite: 'acl-full' },
      { ...WINDOWS_WRITE_BOUNDARY, extra: 1 },
      { contract: 'windows-write-restricted-v1' },
      'windows-write-restricted-v1',
    ])
      expect(
        refusal({
          ...trustedWriteInput,
          availableBoundary: wrong as unknown as WindowsWriteBoundary,
        }),
      ).toBe('boundary-mismatch')
  })

  it('leaves another provider to its own contract instead of substituting the local one', () => {
    for (const access of ['read-only', 'workspace-write', 'full-access'] as const)
      for (const providerId of ['remote-box', 'acme.container', ''])
        expect(refusal({ ...trustedWriteInput, access, providerId })).toBe('provider-not-local')
  })

  it('refuses unknown or contradictory input rather than guessing', () => {
    const bad = (patch: Record<string, unknown>) =>
      refusal({ ...trustedWriteInput, ...patch } as unknown as WindowsExecutionInput)
    expect(bad({ access: 'admin' })).toBe('invalid-input')
    expect(bad({ access: undefined })).toBe('invalid-input')
    expect(bad({ windowsMode: 'maybe' })).toBe('invalid-input')
    expect(bad({ networkMode: 'open' })).toBe('invalid-input')
    expect(bad({ required: 'false' })).toBe('invalid-input')
    expect(bad({ extraReadIsolation: undefined })).toBe('invalid-input')
    expect(bad({ customFsDeny: 0 })).toBe('invalid-input')
    expect(bad({ providerId: 7 })).toBe('invalid-input')
    expect(bad({ localProviderId: '' })).toBe('invalid-input')
    expect(bad({ localProviderId: undefined })).toBe('invalid-input')
  })

  it('decides each of three sessions on one Host independently', () => {
    const decisions = (['read-only', 'workspace-write', 'full-access'] as const).map((access) =>
      resolveWindowsExecution({ ...trustedWriteInput, access }),
    )
    expect(decisions.map((d) => d.kind)).toEqual([
      'windows-write-restricted-v1',
      'windows-write-restricted-v1',
      'unconfined',
    ])
    // A stronger requirement on one session does not change a sibling.
    expect(resolveWindowsExecution({ ...trustedWriteInput, access: 'read-only', required: true }).kind).toBe(
      'refusal',
    )
    expect(resolveWindowsExecution({ ...trustedWriteInput, access: 'workspace-write' }).kind).toBe(
      'windows-write-restricted-v1',
    )
  })
})
