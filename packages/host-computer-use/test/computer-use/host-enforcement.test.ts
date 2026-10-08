import { describe, expect, it, vi } from 'vitest'
import {
  type ComputerUseEnforcementRequest,
  type ComputerUseHostAuthority,
  createComputerUseHostEnforcer,
  evaluateComputerUseAttempt,
  evaluateComputerUseHostPolicy,
  evaluateComputerUseMutationClaim,
} from '../../src/computer-use/host-enforcement.js'

const hash = (digit: string) => digit.repeat(64)

function request(overrides: Partial<ComputerUseEnforcementRequest> = {}): ComputerUseEnforcementRequest {
  return {
    session: { key: 'session-a', lane: 'main', ownerId: 'owner-a' },
    profileHash: hash('a'),
    callId: 'call-a',
    effectId: 'effect-a',
    argsHash: hash('c'),
    action: 'click',
    deliveryMode: 'background',
    bringToFront: false,
    ...overrides,
  }
}

function authority(
  input: ComputerUseEnforcementRequest,
  overrides: Partial<ComputerUseHostAuthority> = {},
): ComputerUseHostAuthority {
  return {
    decision: 'allowed',
    sessionKey: input.session.key,
    lane: input.session.lane,
    ownerId: input.session.ownerId,
    profileHash: input.profileHash,
    callId: input.callId,
    effectId: input.effectId,
    argsHash: input.argsHash,
    action: input.action,
    deliveryMode: input.deliveryMode,
    bringToFront: input.bringToFront,
    executionDomain: 'host-computer-use',
    source: 'agnes/computer-use',
    trust: 'builtin',
    definitionFingerprint: hash('d'),
    policyHash: hash('b'),
    generation: 1,
    mode: 'standard',
    authorization: 'driver-standard',
    approval: 'approved',
    approvalScopes: [`cua:${input.action}:${input.deliveryMode}`],
    ...overrides,
  }
}

describe('Computer Use Host enforcement', () => {
  it('keeps the only transport wrapper behind the real P0 gate with fixed errors', async () => {
    const attempt = vi.fn()
    const result = await createComputerUseHostEnforcer({}).dispatch(request(), attempt)
    expect(result).toEqual({
      status: 'refused',
      code: 'production_driver_admission_blocked',
      message: 'Computer Use driver admission is blocked.',
    })
    expect(attempt).not.toHaveBeenCalled()

    const malicious = new Proxy(
      {},
      {
        get: () => {
          throw new Error('Bearer sk-secret')
        },
      },
    )
    const hidden = await createComputerUseHostEnforcer(malicious).dispatch(request(), attempt)
    expect(JSON.stringify(hidden)).not.toContain('sk-secret')
    expect(attempt).not.toHaveBeenCalled()
  })

  it('returns a frozen mutation binding without executing transport I/O', () => {
    const input = request()
    const decision = evaluateComputerUseHostPolicy(input, authority(input))
    expect(decision).toMatchObject({ allowed: true, mutation: true })
    if (!decision.allowed) throw new Error('expected allow')
    expect(decision.binding).toMatchObject({
      effectId: input.effectId,
      argsHash: input.argsHash,
      generation: 1,
      mode: 'standard',
    })
    expect(Object.isFrozen(decision)).toBe(true)
    expect(Object.isFrozen(decision.binding)).toBe(true)
  })

  it('treats application launch as an approved, never-replayed mutation', () => {
    const input = request({ action: 'launch_app', effectId: 'launch-effect' })
    expect(evaluateComputerUseHostPolicy(input, authority(input))).toMatchObject({
      allowed: true,
      mutation: true,
    })
  })

  it.each([
    ['extra request key', { ...request(), extra: true }],
    ['custom request prototype', Object.assign(Object.create({ inherited: true }), request())],
    ['proxy request', new Proxy(request(), {})],
    ['extra session key', { ...request(), session: { ...request().session, extra: true } }],
    [
      'custom session prototype',
      { ...request(), session: Object.assign(Object.create({ inherited: true }), request().session) },
    ],
  ])('rejects non-exact caller data: %s', (_label, input) => {
    expect(evaluateComputerUseHostPolicy(input, authority(request()))).toMatchObject({
      allowed: false,
      code: 'invalid_host_binding',
    })
  })

  it('rejects request accessors and symbols without invoking them', () => {
    const getter = vi.fn(() => 'click')
    const input = { ...request() }
    Object.defineProperty(input, 'action', { enumerable: true, get: getter })
    Object.defineProperty(input, Symbol('hidden'), { enumerable: true, value: true })
    expect(evaluateComputerUseHostPolicy(input, authority(request()))).toMatchObject({
      allowed: false,
      code: 'invalid_host_binding',
    })
    expect(getter).not.toHaveBeenCalled()
  })

  it.each(['effectId', 'argsHash', 'action', 'deliveryMode', 'bringToFront'] as const)(
    'binds authority field %s back to the caller snapshot',
    (field) => {
      const input = request()
      const changed: Record<string, unknown> = { ...authority(input) }
      changed[field] = field === 'bringToFront' ? true : field === 'deliveryMode' ? 'foreground' : 'different'
      expect(evaluateComputerUseHostPolicy(input, changed)).toMatchObject({
        allowed: false,
        code: 'untrusted_host_authority',
      })
    },
  )

  it('strictly rejects coerced, sparse, accessor, proxy, symbol and extra authority data', () => {
    const input = request()
    const samples: unknown[] = []
    samples.push({ ...authority(input), generation: { toString: () => '1' } })
    const sparse = [...authority(input).approvalScopes]
    sparse.length = 2
    samples.push({ ...authority(input), approvalScopes: sparse })
    samples.push({ ...authority(input), approvalScopes: new Proxy([...authority(input).approvalScopes], {}) })
    samples.push({ ...authority(input), extra: true })
    samples.push(Object.assign(Object.create({ inherited: true }), authority(input)))
    const accessor = { ...authority(input) }
    Object.defineProperty(accessor, 'policyHash', { enumerable: true, get: () => hash('b') })
    samples.push(accessor)
    const symbol = { ...authority(input) }
    Object.defineProperty(symbol, Symbol('hidden'), { enumerable: true, value: true })
    samples.push(symbol)
    for (const sample of samples)
      expect(evaluateComputerUseHostPolicy(input, sample)).toMatchObject({
        allowed: false,
        code: 'untrusted_host_authority',
      })
  })

  it.each([
    ['standard capture', 'standard', 'driver-standard'],
    ['bounded list_apps', 'bounded', 'reviewed-manifest'],
    ['session-yolo wait', 'unrestricted', 'session-yolo'],
    ['profile-off list_windows', 'unrestricted', 'trusted-profile-off'],
  ] as const)('allows no-approval reads: %s', (_label, mode, authorization) => {
    const action = _label.split(' ').at(-1) as ComputerUseEnforcementRequest['action']
    const input = request({ action, effectId: `read-${action}` })
    const digest = hash('e')
    const resolved = authority(input, {
      mode,
      authorization,
      approval: 'not-required',
      approvalScopes: [],
      ...(mode === 'bounded'
        ? {
            capabilityManifestDigest: digest,
            capability: { manifestDigest: digest, action, deliveryMode: 'background' },
          }
        : {}),
    })
    expect(evaluateComputerUseHostPolicy(input, resolved)).toMatchObject({
      allowed: true,
      mutation: false,
    })
  })

  it('rejects approval on reads and missing bounded capability identity', () => {
    const input = request({ action: 'capture' })
    expect(evaluateComputerUseHostPolicy(input, authority(input))).toMatchObject({ allowed: false })
    expect(
      evaluateComputerUseHostPolicy(
        input,
        authority(input, {
          mode: 'bounded',
          authorization: 'reviewed-manifest',
          approval: 'not-required',
          approvalScopes: [],
        }),
      ),
    ).toMatchObject({ allowed: false })
  })

  it('rejects ignored capability data outside the bounded authority variant', () => {
    const input = request()
    const capability = {
      manifestDigest: hash('e'),
      action: input.action,
      deliveryMode: input.deliveryMode,
    } as const
    expect(evaluateComputerUseHostPolicy(input, authority(input, { capability }))).toMatchObject({
      allowed: false,
      code: 'untrusted_host_authority',
    })
    expect(
      evaluateComputerUseHostPolicy(
        input,
        authority(input, {
          mode: 'unrestricted',
          authorization: 'session-yolo',
          approval: 'bypassed',
          capability,
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'untrusted_host_authority' })
    expect(
      evaluateComputerUseHostPolicy(input, {
        ...authority(input),
        capability: undefined,
        capabilityManifestDigest: undefined,
      }),
    ).toMatchObject({ allowed: false, code: 'untrusted_host_authority' })
  })

  it('hard-blocks sensitive mutations and missing visible side-effect scopes', () => {
    const input = request({ deliveryMode: 'foreground', bringToFront: true })
    expect(
      evaluateComputerUseHostPolicy(
        input,
        authority(input, {
          surface: { reliable: false, twoFactor: true },
          approvalScopes: ['cua:click:foreground', 'cua:bring_to_front'],
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'secure_surface_blocked' })
    expect(
      evaluateComputerUseHostPolicy(
        input,
        authority(input, {
          approvalScopes: ['cua:click:foreground'],
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'approval_scope_missing' })
  })

  it('purely accepts only a fresh durable mutation claim', () => {
    expect(evaluateComputerUseMutationClaim({ status: 'claimed' })).toEqual({ dispatch: true })
    expect(evaluateComputerUseMutationClaim({ status: 'terminal', phase: 'responded' })).toEqual({
      dispatch: false,
      code: 'mutation_already_dispatched',
    })
    expect(evaluateComputerUseMutationClaim({ status: 'terminal', phase: 'dispatching' })).toEqual({
      dispatch: false,
      code: 'mutation_outcome_unknown',
    })
    expect(evaluateComputerUseMutationClaim({ status: 'conflict' })).toEqual({
      dispatch: false,
      code: 'effect_identity_collision',
    })
    expect(evaluateComputerUseMutationClaim({ status: 'claimed', extra: true })).toMatchObject({
      dispatch: false,
    })
    expect(evaluateComputerUseMutationClaim({ status: 'claimed', phase: undefined })).toMatchObject({
      dispatch: false,
    })
    expect(evaluateComputerUseMutationClaim({ status: 'conflict', phase: undefined })).toMatchObject({
      dispatch: false,
    })
    expect(evaluateComputerUseMutationClaim({ status: 'terminal' })).toMatchObject({
      dispatch: false,
    })
    expect(
      evaluateComputerUseMutationClaim({ status: 'terminal', phase: 'responded', extra: true }),
    ).toMatchObject({ dispatch: false })

    const statusGetter = vi.fn(() => 'claimed')
    const accessor = {}
    Object.defineProperty(accessor, 'status', { enumerable: true, get: statusGetter })
    const proxyGet = vi.fn(() => 'claimed')
    expect(evaluateComputerUseMutationClaim(accessor)).toMatchObject({ dispatch: false })
    expect(
      evaluateComputerUseMutationClaim(new Proxy({ status: 'claimed' }, { get: proxyGet })),
    ).toMatchObject({
      dispatch: false,
    })
    expect(statusGetter).not.toHaveBeenCalled()
    expect(proxyGet).not.toHaveBeenCalled()
  })

  it('snapshots a responded receipt before an asynchronous finish can mutate it', async () => {
    const receipt = { phase: 'responded', result: { text: 'original', nested: ['first'] } }
    const observed = evaluateComputerUseAttempt<{ text: string; nested: string[] }>(receipt)
    const finish = Promise.resolve().then(() => {
      receipt.phase = 'may_have_sent'
      receipt.result.text = 'mutated-secret'
      receipt.result.nested[0] = 'mutated-secret'
    })
    await finish
    expect(observed).toEqual({ phase: 'responded', result: { text: 'original', nested: ['first'] } })
    expect(Object.isFrozen(observed)).toBe(true)
    expect(observed.phase === 'responded' && Object.isFrozen(observed.result)).toBe(true)
    expect(JSON.stringify(observed)).not.toContain('mutated-secret')
  })

  it('rejects hostile nested responded results without invoking accessors', () => {
    const getter = vi.fn(() => 'Bearer sk-secret')
    const nested = {}
    Object.defineProperty(nested, 'token', { enumerable: true, get: getter })
    expect(evaluateComputerUseAttempt({ phase: 'responded', result: { nested } })).toEqual({
      phase: 'may_have_sent',
    })
    expect(evaluateComputerUseAttempt({ phase: 'responded', result: new Proxy({}, {}) })).toEqual({
      phase: 'may_have_sent',
    })
    expect(getter).not.toHaveBeenCalled()
  })

  it('normalizes hostile or malformed attempt receipts to unknown without reading errors', () => {
    const errorGetter = vi.fn(() => new Error('Bearer sk-secret'))
    const accessor = { phase: 'may_have_sent' }
    Object.defineProperty(accessor, 'error', { enumerable: true, get: errorGetter })
    const phaseGetter = vi.fn(() => 'responded')
    const phaseAccessor = { result: 'forged' }
    Object.defineProperty(phaseAccessor, 'phase', { enumerable: true, get: phaseGetter })
    const proxyGet = vi.fn(() => {
      throw new Error('Bearer sk-proxy-secret')
    })
    const samples: unknown[] = [
      accessor,
      phaseAccessor,
      new Proxy({ phase: 'responded', result: 'forged' }, { get: proxyGet }),
      { phase: 'responded', result: 'forged', extra: true },
      { phase: 'not_sent', error: new Error('Bearer sk-secret'), extra: true },
      Object.assign(Object.create({ inherited: true }), { phase: 'responded', result: 'forged' }),
      { phase: 'responded', error: new Error('wrong variant') },
      { phase: 'not_sent', result: 'wrong variant' },
    ]
    const symbol = { phase: 'responded', result: 'forged' }
    Object.defineProperty(symbol, Symbol('hidden'), { enumerable: true, value: true })
    samples.push(symbol)

    for (const sample of samples) {
      const observed = evaluateComputerUseAttempt(sample)
      expect(observed).toEqual({ phase: 'may_have_sent' })
      expect(JSON.stringify(observed)).not.toContain('secret')
    }
    expect(errorGetter).not.toHaveBeenCalled()
    expect(phaseGetter).not.toHaveBeenCalled()
    expect(proxyGet).not.toHaveBeenCalled()
  })

  it('discards transport errors from exact not-sent and may-have-sent receipts', () => {
    const notSent = evaluateComputerUseAttempt({
      phase: 'not_sent',
      error: new Error('Authorization: Bearer sk-not-sent'),
    })
    const unknown = evaluateComputerUseAttempt({
      phase: 'may_have_sent',
      error: new Error('Authorization: Bearer sk-unknown'),
    })
    expect(notSent).toEqual({ phase: 'not_sent' })
    expect(unknown).toEqual({ phase: 'may_have_sent' })
    expect(JSON.stringify([notSent, unknown])).not.toContain('Bearer')
  })
})
