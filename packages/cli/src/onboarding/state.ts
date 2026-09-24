import type { ThinkingLevel } from '@agnes/protocol'

export type AuthChoice = 'agnes-account' | 'api-key'

export type Preflight =
  | { readonly kind: 'ready' }
  | { readonly kind: 'needs-auth'; readonly reason: string; readonly suggested?: AuthChoice }
  | { readonly kind: 'unsafe'; readonly ref: string; readonly reason: string }

/** Deliberately contains metadata only. Credential material is written behind the dependency seam. */
export type OnboardingResult = {
  readonly profile: string
  readonly route: string
  readonly model: string
  readonly thinking: ThinkingLevel
  readonly credentialRef: string
}

export type OnboardingOption = { readonly id: string; readonly label: string }
export type OnboardingFailure = {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly ref?: string
}

export type CheckingState = { readonly kind: 'checking' }
export type ReadyState = { readonly kind: 'ready' }
export type AuthMethodState = {
  readonly kind: 'auth-method'
  readonly reason: string
  readonly suggested?: AuthChoice
}
export type AccountWaitingState = {
  readonly kind: 'account-waiting'
  readonly root: AuthMethodState
}
export type ProviderSelectState = {
  readonly kind: 'provider-select'
  readonly root: AuthMethodState
  readonly providers: readonly OnboardingOption[]
}
export type KeyInputState = {
  readonly kind: 'key-input'
  readonly root: AuthMethodState
  readonly providers: readonly OnboardingOption[]
  readonly provider: OnboardingOption
}
export type ModelSelectState = {
  readonly kind: 'model-select'
  readonly root: AuthMethodState
  readonly providers: readonly OnboardingOption[]
  readonly provider: OnboardingOption
  readonly models: readonly OnboardingOption[]
  readonly selectedModel?: OnboardingOption
}
export type OnboardingStep =
  | AuthMethodState
  | AccountWaitingState
  | ProviderSelectState
  | KeyInputState
  | ModelSelectState
export type ErrorState = {
  readonly kind: 'error'
  readonly failure: OnboardingFailure
  readonly previous: OnboardingStep
}
export type DoneState = { readonly kind: 'done'; readonly result: OnboardingResult }
export type CancelledState = { readonly kind: 'cancelled' }

export type OnboardingState =
  | CheckingState
  | ReadyState
  | OnboardingStep
  | ErrorState
  | DoneState
  | CancelledState

export type OnboardingAction =
  | { readonly type: 'restart' }
  | { readonly type: 'preflight-result'; readonly result: Preflight }
  | { readonly type: 'choose-auth'; readonly choice: AuthChoice }
  | { readonly type: 'providers-available'; readonly providers: readonly OnboardingOption[] }
  | { readonly type: 'choose-provider'; readonly providerId: string }
  | { readonly type: 'models-required'; readonly models: readonly OnboardingOption[] }
  | { readonly type: 'choose-model'; readonly modelId: string }
  | { readonly type: 'operation-failed'; readonly failure: OnboardingFailure }
  | { readonly type: 'retry' }
  | { readonly type: 'complete'; readonly result: OnboardingResult }
  | { readonly type: 'back' }
  | { readonly type: 'cancel' }

const DEFAULT_REASON = 'Authentication is required.'

export function initialOnboardingState(): OnboardingState {
  return { kind: 'checking' }
}

function rootState(reason: string, suggested?: AuthChoice): AuthMethodState {
  return suggested === undefined
    ? { kind: 'auth-method', reason }
    : { kind: 'auth-method', reason, suggested }
}

function copyOption(option: OnboardingOption): OnboardingOption {
  return { id: option.id, label: option.label }
}

function copyResult(result: OnboardingResult): OnboardingResult {
  // Whitelisting fields is intentional. A callback is a runtime boundary and may return an object
  // with extra credential fields despite its TypeScript annotation.
  return {
    profile: result.profile,
    route: result.route,
    model: result.model,
    thinking: result.thinking,
    credentialRef: result.credentialRef,
  }
}

function backFrom(state: OnboardingStep): OnboardingState {
  switch (state.kind) {
    case 'auth-method':
      return { kind: 'cancelled' }
    case 'account-waiting':
    case 'provider-select':
      return state.root
    case 'key-input':
      return { kind: 'provider-select', root: state.root, providers: state.providers }
    case 'model-select':
      return {
        kind: 'key-input',
        root: state.root,
        providers: state.providers,
        provider: state.provider,
      }
  }
}

export function reduceOnboarding(state: OnboardingState, action: OnboardingAction): OnboardingState {
  if (action.type === 'restart') return { kind: 'checking' }
  if (action.type === 'cancel')
    return state.kind === 'ready' || state.kind === 'done' || state.kind === 'cancelled'
      ? state
      : { kind: 'cancelled' }

  if (action.type === 'preflight-result') {
    if (state.kind !== 'checking') return state
    if (action.result.kind === 'ready') return { kind: 'ready' }
    if (action.result.kind === 'needs-auth') return rootState(action.result.reason, action.result.suggested)
    const root = rootState(action.result.reason)
    return {
      kind: 'error',
      failure: {
        code: 'CREDENTIAL_STORE_UNSAFE',
        message: action.result.reason,
        retryable: true,
        ref: action.result.ref,
      },
      previous: root,
    }
  }

  if (action.type === 'back') {
    if (state.kind === 'error') return backFrom(state.previous)
    if (
      state.kind === 'auth-method' ||
      state.kind === 'account-waiting' ||
      state.kind === 'provider-select' ||
      state.kind === 'key-input' ||
      state.kind === 'model-select'
    )
      return backFrom(state)
    return state
  }

  if (action.type === 'retry') return state.kind === 'error' ? state.previous : state

  if (action.type === 'choose-auth' && state.kind === 'auth-method') {
    if (action.choice === 'agnes-account') return { kind: 'account-waiting', root: state }
    return { kind: 'provider-select', root: state, providers: [] }
  }

  if (action.type === 'providers-available' && state.kind === 'provider-select')
    return {
      ...state,
      providers: action.providers.map(copyOption),
    }

  if (action.type === 'choose-provider' && state.kind === 'provider-select') {
    const provider = state.providers.find((option) => option.id === action.providerId)
    if (!provider) return state
    return {
      kind: 'key-input',
      root: state.root,
      providers: state.providers,
      provider: copyOption(provider),
    }
  }

  if (action.type === 'models-required' && state.kind === 'key-input')
    return {
      kind: 'model-select',
      root: state.root,
      providers: state.providers,
      provider: state.provider,
      models: action.models.map(copyOption),
    }

  if (action.type === 'choose-model' && state.kind === 'model-select') {
    const selected = state.models.find((option) => option.id === action.modelId)
    if (!selected) return state
    return { ...state, selectedModel: copyOption(selected) }
  }

  if (action.type === 'operation-failed') {
    let previous: OnboardingStep
    if (state.kind === 'checking') previous = rootState(DEFAULT_REASON)
    else if (
      state.kind === 'auth-method' ||
      state.kind === 'account-waiting' ||
      state.kind === 'provider-select' ||
      state.kind === 'key-input' ||
      state.kind === 'model-select'
    )
      previous = state
    else return state
    const failure: OnboardingFailure =
      action.failure.ref === undefined
        ? {
            code: action.failure.code,
            message: action.failure.message,
            retryable: action.failure.retryable,
          }
        : {
            code: action.failure.code,
            message: action.failure.message,
            retryable: action.failure.retryable,
            ref: action.failure.ref,
          }
    return {
      kind: 'error',
      failure,
      previous,
    }
  }

  if (action.type === 'complete') {
    if (
      state.kind !== 'account-waiting' &&
      state.kind !== 'provider-select' &&
      state.kind !== 'key-input' &&
      state.kind !== 'model-select'
    )
      return state
    return { kind: 'done', result: copyResult(action.result) }
  }

  return state
}
