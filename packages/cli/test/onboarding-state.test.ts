import { describe, expect, it } from 'vitest'
import {
  initialOnboardingState,
  type OnboardingAction,
  type OnboardingResult,
  type OnboardingState,
  reduceOnboarding,
} from '../src/onboarding/state.js'

const result: OnboardingResult = {
  profile: 'subscription',
  route: 'agnes-subscription',
  model: 'deepseek-v4-pro',
  thinking: 'high',
  credentialRef: 'secret://agnes/subscription',
}

const step = (state: OnboardingState, action: OnboardingAction): OnboardingState =>
  reduceOnboarding(state, action)

describe('onboarding state machine', () => {
  it('moves from preflight to the root account flow and Escape returns without cancelling', () => {
    const checking = initialOnboardingState()
    const root = step(checking, {
      type: 'preflight-result',
      result: { kind: 'needs-auth', reason: 'no usable route', suggested: 'agnes-account' },
    })
    expect(root).toEqual({
      kind: 'auth-method',
      reason: 'no usable route',
      suggested: 'agnes-account',
    })

    const waiting = step(root, { type: 'choose-auth', choice: 'agnes-account' })
    expect(waiting).toMatchObject({ kind: 'account-waiting' })
    expect(step(waiting, { type: 'back' })).toEqual(root)
  })

  it('walks provider, key and model child screens without accepting a secret into state', () => {
    const root = step(initialOnboardingState(), {
      type: 'preflight-result',
      result: { kind: 'needs-auth', reason: 'missing credential' },
    })
    let state = step(root, { type: 'choose-auth', choice: 'api-key' })
    expect(state).toMatchObject({ kind: 'provider-select', providers: [] })

    state = step(state, {
      type: 'providers-available',
      providers: [
        { id: 'deepseek', label: 'DeepSeek' },
        { id: 'other', label: 'Other\u001b[2J' },
      ],
    })
    state = step(state, { type: 'choose-provider', providerId: 'deepseek' })
    expect(state).toMatchObject({ kind: 'key-input', provider: { id: 'deepseek', label: 'DeepSeek' } })

    state = step(state, {
      type: 'models-required',
      models: [
        { id: 'deepseek-chat', label: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
      ],
    })
    expect(state).toMatchObject({ kind: 'model-select' })
    expect('selectedModel' in state).toBe(false)
    state = step(state, { type: 'choose-model', modelId: 'deepseek-reasoner' })
    expect(state).toMatchObject({
      kind: 'model-select',
      selectedModel: { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
    })

    expect(JSON.stringify(state)).not.toContain('sk-state-must-never-contain-this')
    expect(step(state, { type: 'back' })).toMatchObject({ kind: 'key-input' })
  })

  it('supports safe error/retry, completion, root cancellation and terminal no-ops', () => {
    const root = step(initialOnboardingState(), {
      type: 'preflight-result',
      result: { kind: 'needs-auth', reason: 'missing credential' },
    })
    const waiting = step(root, { type: 'choose-auth', choice: 'agnes-account' })
    const failed = step(waiting, {
      type: 'operation-failed',
      failure: { code: 'AUTH_FAILED', message: 'Authentication failed. Try again.', retryable: true },
    })
    expect(failed).toMatchObject({ kind: 'error', previous: { kind: 'account-waiting' } })
    expect(step(failed, { type: 'retry' })).toEqual(waiting)
    expect(step(failed, { type: 'back' })).toEqual(root)

    const done = step(waiting, { type: 'complete', result })
    expect(done).toEqual({ kind: 'done', result })
    expect(step(done, { type: 'back' })).toBe(done)

    const cancelled = step(root, { type: 'back' })
    expect(cancelled).toEqual({ kind: 'cancelled' })
    expect(step(cancelled, { type: 'retry' })).toBe(cancelled)
  })

  it('whitelists completion metadata instead of copying extra callback fields', () => {
    const secret = 'oauth-access-sentinel-1328'
    const root = step(initialOnboardingState(), {
      type: 'preflight-result',
      result: { kind: 'needs-auth', reason: 'missing credential' },
    })
    const waiting = step(root, { type: 'choose-auth', choice: 'agnes-account' })
    const callbackValue = { ...result, accessToken: secret }
    const done = step(waiting, { type: 'complete', result: callbackValue })
    expect(JSON.stringify(done)).not.toContain(secret)
    expect(done).toEqual({ kind: 'done', result })
  })

  it('fails closed for unknown providers and models', () => {
    const root = step(initialOnboardingState(), {
      type: 'preflight-result',
      result: { kind: 'needs-auth', reason: 'missing credential' },
    })
    const providers = step(step(root, { type: 'choose-auth', choice: 'api-key' }), {
      type: 'providers-available',
      providers: [{ id: 'deepseek', label: 'DeepSeek' }],
    })
    expect(step(providers, { type: 'choose-provider', providerId: 'made-up' })).toBe(providers)
    const key = step(providers, { type: 'choose-provider', providerId: 'deepseek' })
    const models = step(key, {
      type: 'models-required',
      models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
    })
    expect(step(models, { type: 'choose-model', modelId: 'made-up' })).toBe(models)
  })

  it('retains unsafe credential metadata for a retry without treating it as ready', () => {
    const unsafe = step(initialOnboardingState(), {
      type: 'preflight-result',
      result: { kind: 'unsafe', ref: 'secret://deepseek/default', reason: 'unsafe mode' },
    })
    expect(unsafe).toMatchObject({
      kind: 'error',
      failure: { code: 'CREDENTIAL_STORE_UNSAFE', ref: 'secret://deepseek/default' },
    })
  })
})
