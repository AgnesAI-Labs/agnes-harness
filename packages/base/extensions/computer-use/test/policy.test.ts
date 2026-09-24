import { describe, expect, it } from 'vitest'
import { type ComputerUseRuntimePolicy, validateComputerUseRuntimePolicy } from '../src/policy.js'

const session = { key: 'session-a', lane: 'main', workspaceRoot: '/work/proj' }
const digest = 'a'.repeat(64)

function validate(value: unknown) {
  return validateComputerUseRuntimePolicy(value, session)
}

describe('computer_use Host runtime policy', () => {
  it('accepts only explicit standard, reviewed bounded, and trusted unrestricted modes', () => {
    expect(
      validate({
        mode: 'standard',
        authorization: 'driver-standard',
        sessionKey: 'session-a',
        lane: 'main',
      }),
    ).toMatchObject({ policy: { mode: 'standard', authorization: 'driver-standard' } })
    expect(
      validate({
        mode: 'bounded',
        authorization: 'reviewed-manifest',
        sessionKey: 'session-a',
        lane: 'main',
        capabilityManifestDigest: digest,
      }),
    ).toMatchObject({
      policy: {
        mode: 'bounded',
        authorization: 'reviewed-manifest',
        capabilityManifestDigest: digest,
      },
    })
    for (const authorization of ['session-yolo', 'trusted-profile-off'] as const)
      expect(
        validate({
          mode: 'unrestricted',
          authorization,
          sessionKey: 'session-a',
          lane: 'main',
        }),
      ).toMatchObject({ policy: { mode: 'unrestricted', authorization } })
  })

  it.each([
    undefined,
    {},
    { mode: 'standard', sessionKey: 'session-a', lane: 'main' },
    {
      mode: 'bounded',
      authorization: 'reviewed-manifest',
      sessionKey: 'session-a',
      lane: 'main',
    },
    {
      mode: 'bounded',
      authorization: 'reviewed-manifest',
      sessionKey: 'session-a',
      lane: 'main',
      capabilityManifestDigest: 'A'.repeat(64),
    },
    {
      mode: 'unrestricted',
      authorization: 'driver-standard',
      sessionKey: 'session-a',
      lane: 'main',
    },
    {
      mode: 'unrestricted',
      authorization: 'session-yolo',
      sessionKey: 'session-b',
      lane: 'main',
    },
    {
      mode: 'standard',
      authorization: 'driver-standard',
      sessionKey: 'session-a',
      lane: 'main',
      dangerouslyBypassApprovals: true,
    },
  ])('fails closed on missing, malformed, cross-session, or ambiguous policy %#', (value) => {
    expect(validate(value)).toMatchObject({ code: 'runtime_policy_untrusted' })
  })

  it('gives every security-relevant mode field a distinct immutable identity', () => {
    const policies: ComputerUseRuntimePolicy[] = [
      {
        mode: 'standard',
        authorization: 'driver-standard',
        sessionKey: 'session-a',
        lane: 'main',
      },
      {
        mode: 'bounded',
        authorization: 'reviewed-manifest',
        sessionKey: 'session-a',
        lane: 'main',
        capabilityManifestDigest: digest,
      },
      {
        mode: 'bounded',
        authorization: 'reviewed-manifest',
        sessionKey: 'session-a',
        lane: 'main',
        capabilityManifestDigest: 'b'.repeat(64),
      },
      {
        mode: 'unrestricted',
        authorization: 'session-yolo',
        sessionKey: 'session-a',
        lane: 'main',
      },
    ]
    const validated = policies.map((policy) => validate(policy))
    const identities = validated.flatMap((item) => ('identity' in item ? [item.identity] : []))
    expect(new Set(identities).size).toBe(policies.length)
    expect(validated.every((item) => Object.isFrozen(item))).toBe(true)
  })

  it('rejects inherited, accessor-backed, and uninspectable policy objects', () => {
    const inherited = Object.assign(Object.create({ elevated: true }), {
      mode: 'standard',
      authorization: 'driver-standard',
      sessionKey: 'session-a',
      lane: 'main',
    })
    const accessor = {
      mode: 'standard',
      authorization: 'driver-standard',
      sessionKey: 'session-a',
      get lane(): string {
        throw new Error('must not execute policy accessors')
      },
    }
    const uninspectable = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('uninspectable')
        },
      },
    )

    for (const value of [inherited, accessor, uninspectable])
      expect(validate(value)).toMatchObject({ code: 'runtime_policy_untrusted' })
  })
})
