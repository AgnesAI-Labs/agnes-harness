import { describe, expect, it } from 'vitest'
import { HOST_ERROR_CODES, HostError, looksLikeSecret } from '../src/errors.js'

describe('HostError', () => {
  it('has the twenty-nine codes of the closed set', () => {
    expect([...HOST_ERROR_CODES].sort()).toEqual([
      'E_API_RANGE',
      'E_CAPABILITY_UNDECLARED',
      'E_CEILING_EXCEEDED',
      'E_DEP_MISSING',
      'E_EXT_ISOLATION_UNAVAILABLE',
      'E_EXT_LOAD',
      'E_HOME_INVALID',
      'E_HOST_CLOSED',
      'E_LEASE_EXPIRED',
      'E_LOCK_MISMATCH',
      'E_MANAGED_POLICY_CORRUPT',
      'E_MODEL_UNSUPPORTED',
      'E_PACKAGE_DUPLICATE',
      'E_PACKAGE_QUARANTINED',
      'E_PRESET_UNRESOLVED',
      'E_PRESET_UNSUPPORTED',
      'E_PROFILE_CYCLE',
      'E_PROFILE_FRAGMENT_KEY',
      'E_REMOTE_WORKSPACE',
      'E_SANDBOX_WORKSPACE',
      'E_SEAM_EXPORT_MISSING',
      'E_SEAM_IMMUTABLE',
      'E_SEAM_INIT',
      'E_SEAM_MISSING',
      'E_SECRET_UNRESOLVED',
      'E_STATIC_COMPONENT',
      'E_WORKSPACE_CLOSED',
      'E_WORKSPACE_REQUIRED',
      'E_WORKSPACE_UNTRUSTED',
    ])
    expect(new Set(HOST_ERROR_CODES).size).toBe(29)
  })
  it('carries code, source and detail', () => {
    const e = new HostError(
      'E_PROFILE_FRAGMENT_KEY',
      'fragment may only set packages/policy.capabilityCeiling',
      { source: { file: 'profile/profile.yaml', line: 3, layer: 'workspace' }, detail: { key: 'runtime' } },
    )
    expect(e.message).toBe('E_PROFILE_FRAGMENT_KEY: fragment may only set packages/policy.capabilityCeiling')
    expect(e.source).toEqual({ file: 'profile/profile.yaml', line: 3, layer: 'workspace' })
    expect(e.detail).toEqual({ key: 'runtime' })
    expect(e instanceof Error).toBe(true)
  })
})

// Both directions, because a leak filter that only ever gets fed leaks is indistinguishable from a
// filter that returns true. The negatives are the strings this package actually passes around.
const LEAKS = [
  'value: sk-live-abc',
  'token sk-ant-api03-AbCdEf0123456789',
  '-----BEGIN RSA PRIVATE KEY-----',
  'ghp_abcdefghij0123456789abcdefghij',
  'creds AKIAIOSFODNN7EXAMPLE',
  'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij',
  'k9Xq2mZv7Lp0RtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIo',
  'xoxb-1234567890-abcdefghijkl',
]
const NOT_LEAKS = [
  `integrity sha256-${'a'.repeat(64)}`,
  `lock mismatch: sha512-${Buffer.alloc(64, 7).toString('base64')}`,
  `resolved_profile_hash sha256-${'f'.repeat(64)} differs from lockfile`,
  'package @agnes/base is not in the lockfile',
  'seam approval has no implementation package',
  '/Users/x/dev/agnes-harness/packages/host/templates/local-dev.yaml',
  'agnes:local:local-dev:cli:workspace:0123456789abcdef',
  '01J6ZM2Q3R4S5T6V7W8X9Y0Z11',
  'preset minimal-rl is not in presets.allowed',
  'fragment may only set packages/policy.capabilityCeiling',
  'secret://agnes/gateway not found in file store',
  'unsupported api-version 2024-01-01',
  'writer lease not held by run-1234567890',
]

describe('looksLikeSecret', () => {
  it.each(LEAKS)('flags %s', (m) => {
    expect(looksLikeSecret(m)).toBe(true)
  })
  it.each(NOT_LEAKS)('passes %s', (m) => {
    expect(looksLikeSecret(m)).toBe(false)
  })
  it('is not order-dependent (the digest scrubber is the only /g regex and it is used via replace)', () => {
    const m = `integrity sha256-${'a'.repeat(64)}`
    expect(looksLikeSecret(m)).toBe(false)
    expect(looksLikeSecret(m)).toBe(false)
  })
})

// Cases found by attacking looksLikeSecret directly rather than by reading it. Each one is a
// message shape this package really produces or a credential shape a filter of this kind is meant
// to stop, and each was answered wrongly before the two rules above were tightened.
describe('looksLikeSecret, attacked', () => {
  it('flags a long hex token: a bare run of hex used to be exempted as if it were a digest', () => {
    // Every hex character is also a digest character, so the bare-hex exemption covered API keys.
    expect(looksLikeSecret(`token ${'0123456789abcdef'.repeat(3)}`)).toBe(true)
    expect(looksLikeSecret(`token ${'A'.repeat(48)}9`)).toBe(true)
  })
  it('still passes every digest this package quotes, which all carry an algorithm prefix', () => {
    expect(looksLikeSecret(`integrity sha256-${'a'.repeat(64)}`)).toBe(false)
    expect(looksLikeSecret(`integrity sha384-${'0'.repeat(96)}`)).toBe(false)
    expect(looksLikeSecret(`two sha256-${'a'.repeat(64)} and sha512-${'b'.repeat(88)}`)).toBe(false)
  })
  it('passes a long hyphenated package id, which E_PACKAGE_QUARANTINED quotes verbatim', () => {
    expect(
      looksLikeSecret('package @acme/some-really-long-hyphenated-package-name-here is quarantined'),
    ).toBe(false)
    expect(
      looksLikeSecret('package @acme/tool-v2-connector-for-the-analytics-thing-here is quarantined'),
    ).toBe(false)
    expect(looksLikeSecret('PackageIdentifierThatIsQuiteLongIndeedAndKeepsGoingForty')).toBe(false)
  })
  it('passes the other messages this package builds out of long identifiers', () => {
    for (const m of [
      'extension file:///Users/x/p/extensions/my-extension/index.ts failed to load',
      'writer lease not held by run-01J6ZM2Q3R4S5T6V7W8X9Y0Z11',
      'profile chain builtin:local-dev,user:mine,workspace:overlay',
      'capabilityCeiling does not admit tools.invoke for @agnes/base',
      'secret://agnes/anthropic-gateway-production not found in file store',
      'task-runner refused, risk-averse policy, disk-usage exceeded, work-tree is dirty',
    ])
      expect(looksLikeSecret(m), m).toBe(false)
  })
  it('flags the vendor prefixes the table does not enumerate', () => {
    for (const m of [
      `npm token npm_${'a'.repeat(36)}`,
      `stripe rk_live_${'A'.repeat(24)}`,
      `gcp AIza${'B'.repeat(35)}`,
      `hf hf_${'c'.repeat(34)}`,
      `gitlab glpat-${'d'.repeat(20)}`,
      `gh github_pat_${'e'.repeat(30)}`,
      'private key -----BEGIN OPENSSH PRIVATE KEY-----',
      'cert -----BEGIN CERTIFICATE-----',
    ])
      expect(looksLikeSecret(m), m).toBe(true)
  })
  it('answers a pathological input in linear time and holds no regex state between calls', () => {
    const started = Date.now()
    looksLikeSecret(`-----BEGIN${' A'.repeat(4000)}`)
    expect(Date.now() - started).toBeLessThan(1000)
    const m = 'ghp_abcdefghij0123456789abcdefghij'
    expect([looksLikeSecret(m), looksLikeSecret(m), looksLikeSecret(m)]).toEqual([true, true, true])
  })
})

describe('HostError message guard', () => {
  it('keeps the typed code when the message looks like a credential', () => {
    const e = new HostError('E_SECRET_UNRESOLVED', 'value: sk-live-abc')
    expect(e).toBeInstanceOf(HostError)
    expect(e.code).toBe('E_SECRET_UNRESOLVED')
    expect(e.message).toBe('E_SECRET_UNRESOLVED: error message omitted: looks like a secret')
    expect(e.detail).toEqual({ redacted: true })
    expect(`${e.message} ${JSON.stringify({ ...e })}`).not.toContain('sk-live-abc')
  })
  it('keeps the typed code when an account route is a false-positive secret', () => {
    const route = 'account-acct-01234567-89ab-cdef-0123-456789abcdef'
    const e = new HostError('E_MODEL_UNSUPPORTED', `unknown model on route ${route}/no-such`)
    expect(e).toBeInstanceOf(HostError)
    expect(e.code).toBe('E_MODEL_UNSUPPORTED')
    expect(e.message).toBe('E_MODEL_UNSUPPORTED: error message omitted: looks like a secret')
    expect(`${e.message} ${JSON.stringify({ ...e })}`).not.toContain(route)
  })
  it('constructs normally for a message quoting an integrity digest', () => {
    const e = new HostError(
      'E_LOCK_MISMATCH',
      `@agnes/base integrity sha512-${Buffer.alloc(64, 7).toString('base64')} does not match`,
    )
    expect(e.code).toBe('E_LOCK_MISMATCH')
  })
})

describe('isHostError', () => {
  it('narrows by class and optionally by code', async () => {
    const { isHostError } = await import('../src/errors.js')
    const e = new HostError('E_SEAM_MISSING', 'seam approval has no implementation package')
    expect(isHostError(e)).toBe(true)
    expect(isHostError(e, 'E_SEAM_MISSING')).toBe(true)
    expect(isHostError(e, 'E_SEAM_INIT')).toBe(false)
    expect(isHostError(new Error('x'))).toBe(false)
  })
})

// Fourth pass. Each case here is one an earlier revision of this predicate answered wrongly, and
// the numbers are measured rather than asserted from reading the regexes.
describe('looksLikeSecret, fourth pass', () => {
  it('passes a bare digest in a message that says it is about a digest, both runs of it', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    expect(looksLikeSecret(`integrity mismatch: expected ${a}, got ${b}`)).toBe(false)
    expect(looksLikeSecret(`lock hash ${'c'.repeat(40)} does not match ${'d'.repeat(40)}`)).toBe(false)
    expect(looksLikeSecret(`resolved_profile_hash ${a}`)).toBe(false)
    // E_LOCK_MISMATCH is the message this exists for, and it has to be constructible.
    expect(new HostError('E_LOCK_MISMATCH', `integrity: expected ${a}, got ${b}`).code).toBe(
      'E_LOCK_MISMATCH',
    )
  })
  it('still flags a long hex run that nothing calls a digest', () => {
    expect(looksLikeSecret(`token ${'0123456789abcdef'.repeat(4)}`)).toBe(true)
    // The 32-character example the previous write-up presented as fixed, which was not.
    expect(looksLikeSecret('key 0123456789abcdef0123456789abcdef')).toBe(true)
  })
  it('does not let a digest prefix launder what follows it', () => {
    expect(looksLikeSecret('sha256-sk-live-abcdefghijklmnopqrstuvwxyz')).toBe(true)
    expect(looksLikeSecret(`integrity sha256-${'a'.repeat(64)} then sk-live-abcdef`)).toBe(true)
  })
  it('passes a long generated identifier, and still flags key material of the same length', () => {
    expect(looksLikeSecret('export Kernel1SessionRegisterMaterializationStrategyFactory2 is missing')).toBe(
      false,
    )
    expect(looksLikeSecret('k9Xq2mZv7Lp0RtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIo')).toBe(true)
  })
  it('flags the two named shapes that were deferred last round', () => {
    expect(looksLikeSecret('Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l')).toBe(true)
    expect(looksLikeSecret('postgres://user:s3cretPassw0rd@host/db')).toBe(true)
    expect(looksLikeSecret('endpoint https://svc:hunter2@example.com/v1')).toBe(true)
    // Neither can fire on a URL without credentials or on a path.
    expect(looksLikeSecret('endpoint https://example.com/v1/models')).toBe(false)
    expect(looksLikeSecret('file:///Users/x/p/extensions/basic-tools/index.ts failed to load')).toBe(false)
  })
  it('catches an opaque token that a single hyphen or underscore used to split below the threshold', () => {
    expect(looksLikeSecret('token xK3-pQ9zRt7vWm2bN5cH8jL4dF6gS1aY0eU3iO7pZq2')).toBe(true)
    expect(looksLikeSecret('token xK3_pQ9zRt7vWm2bN5cH8jL4dF6gS1aY0eU3iO7pZq2')).toBe(true)
  })
  // The numbers the residual-gap list quotes. A predicate whose miss rate is asserted rather than
  // measured is a claim, not a result.
  it('catches ~100 % of random base64url tokens and the stated share of standard base64', () => {
    const pick = (alphabet: string, n: number) =>
      Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const rate = (alphabet: string, n: number, len: number) => {
      let hit = 0
      for (let i = 0; i < n; i++) if (looksLikeSecret(`token ${pick(alphabet, len)}`)) hit++
      return hit / n
    }
    expect(rate(`${letters}-_`, 4000, 43)).toBeGreaterThan(0.99)
    expect(rate('0123456789abcdef', 2000, 64)).toBe(1)
    // `/` is the accepted gap: 46 % of standard-base64 strings contain one and escape.
    expect(rate(`${letters}+/`, 4000, 40)).toBeGreaterThan(0.45)
  })
  it('answers in linear time on the runs that used to be quadratic', () => {
    const timed = (n: number) => {
      const started = Date.now()
      looksLikeSecret(`package @acme/${'a'.repeat(n)} is quarantined`)
      return Date.now() - started
    }
    // Measured before this pass: 2 ms / 37 ms / 584 ms / 2401 ms at these four sizes.
    expect([timed(2_000), timed(8_000), timed(32_000), timed(64_000)].every((ms) => ms < 50)).toBe(true)
    const started = Date.now()
    looksLikeSecret(`x${'y'.repeat(200_000)}1`)
    expect(Date.now() - started).toBeLessThan(200)
  })
})

describe('isPublicErrorReason', () => {
  it('accepts a short identifier and rejects prose, overflow, and secret-shaped tokens', async () => {
    const { isPublicErrorReason } = await import('@agnes/package-manager')
    expect(isPublicErrorReason('no-routes')).toBe(true)
    expect(isPublicErrorReason('No-Routes')).toBe(false)
    expect(isPublicErrorReason(`x${'a'.repeat(64)}`)).toBe(false)
    expect(isPublicErrorReason('sk-live-abcdef')).toBe(false)
    expect(isPublicErrorReason('has space')).toBe(false)
  })
})

describe('domainFailureFromUnknown', () => {
  it('carries a whitelist reason from detail and redacts a secret-shaped message', async () => {
    const { domainFailureFromUnknown, REDACTED_ERROR_MESSAGE } = await import('@agnes/package-manager')
    const error = new HostError('E_PRESET_UNRESOLVED', 'value: sk-live-abc', {
      detail: { reason: 'no-routes', extra: 'drop-me' },
    })
    expect(domainFailureFromUnknown(error)).toEqual({
      code: 'E_PRESET_UNRESOLVED',
      message: `E_PRESET_UNRESOLVED: ${REDACTED_ERROR_MESSAGE}`,
      reason: 'no-routes',
    })
  })
  it('omits a secret-shaped reason instead of scanning the message', async () => {
    const { domainFailureFromUnknown } = await import('@agnes/package-manager')
    expect(
      domainFailureFromUnknown({
        code: 'E_PRESET_UNRESOLVED',
        message: 'E_PRESET_UNRESOLVED: no-routes: the profile declares no provider.routes',
        detail: { reason: 'sk-live-abcdef' },
      }),
    ).toEqual({
      code: 'E_PRESET_UNRESOLVED',
      message: 'E_PRESET_UNRESOLVED: no-routes: the profile declares no provider.routes',
    })
  })
  it('defaults an untyped error to E_WORKER and redacts its message when needed', async () => {
    const { domainFailureFromUnknown, REDACTED_ERROR_MESSAGE } = await import('@agnes/package-manager')
    expect(domainFailureFromUnknown(new Error('value: sk-live-abc'))).toEqual({
      code: 'E_WORKER',
      message: `E_WORKER: ${REDACTED_ERROR_MESSAGE}`,
    })
  })
})
