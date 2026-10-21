import { expect, it } from 'vitest'
import { type PermissionContext, permissionEffectAdmission } from '../src/index.js'

const context: PermissionContext = {
  sessionKey: 'session',
  sessionId: 'backend',
  epoch: 0,
  policy: 'full-access',
  actor: { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} },
}

it.each(['revocation', 'abort', 'expiry', 'invalid-deadline', 'epoch', 'object', 'version'])(
  'seals a proof after %s, even when the condition later recovers',
  async (loss) => {
    let current = structuredClone(context),
      active = true,
      now = 0,
      object = 'one',
      version = 1
    const controller = new AbortController()
    const admission = permissionEffectAdmission({
      context: { expected: context, current: () => current },
      signals: [controller.signal],
      expiresAt: loss === 'invalid-deadline' ? NaN : 10,
      clock: () => now,
      unavailable: () => Error('unavailable'),
      assertBound: () => {
        if (!active || object !== 'one' || version !== 1) throw Error('unavailable')
      },
    })
    if (loss !== 'invalid-deadline') await admission.verify()
    if (loss === 'revocation') active = false
    if (loss === 'abort') controller.abort()
    if (loss === 'expiry') now = 10
    if (loss === 'epoch') current = { ...current, epoch: 1 }
    if (loss === 'object') object = 'two'
    if (loss === 'version') version = 2
    expect(() => admission.assertActive()).toThrow('unavailable')
    current = structuredClone(context)
    active = true
    now = 0
    object = 'one'
    version = 1
    await expect(admission.verify()).rejects.toThrow('unavailable')
    expect(() => admission.assertActive()).toThrow('unavailable')
  },
)

it.each(['parent', 'verifier'])(
  'seals a proof when its %s fails during async verification',
  async (failure) => {
    let fail = true
    const check = async () => {
      if (fail) throw Error('verification unavailable')
    }
    const admission = permissionEffectAdmission({
      ...(failure === 'parent' ? { parent: { verify: check, assertActive() {} } } : { verify: check }),
      assertBound() {},
      unavailable: () => Error('unavailable'),
    })
    await expect(admission.verify()).rejects.toThrow('verification unavailable')
    fail = false
    expect(() => admission.assertActive()).toThrow('verification unavailable')
  },
)

it('rechecks cancellation after an asynchronous verifier and owns the expected context snapshot', async () => {
  const expected = { ...structuredClone(context) },
    current = structuredClone(context)
  const controller = new AbortController()
  const admission = permissionEffectAdmission({
    context: { expected, current: () => current },
    signals: [controller.signal],
    assertBound() {},
    unavailable: () => Error('unavailable'),
    verify: async () => {
      controller.abort()
    },
  })
  expected.epoch = 9
  admission.assertActive()
  await expect(admission.verify()).rejects.toThrow('unavailable')
})
