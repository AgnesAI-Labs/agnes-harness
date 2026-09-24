import {
  type AuthChoice,
  initialOnboardingState,
  type OnboardingResult,
  type OnboardingState,
  type Preflight,
  reduceOnboarding,
} from './state.js'

export interface OnboardingDeps {
  preflight(): Promise<Preflight>
  loginAgnes(signal: AbortSignal): Promise<OnboardingResult>
  loginApiKey(signal: AbortSignal): Promise<OnboardingResult>
}

const SAFE_FAILURE = {
  code: 'AUTH_FAILED',
  message: 'Authentication failed. Try again.',
  retryable: true,
} as const

const SAFE_PREFLIGHT_FAILURE = {
  code: 'AUTH_REQUIRED',
  message: 'Authentication check failed. Try again.',
  retryable: true,
} as const

/** Coordinates callbacks only; concrete Host, filesystem, browser and fetch work stays behind deps. */
export class OnboardingController {
  private current: OnboardingState = initialOnboardingState()
  private generation = 0
  private retryChoice: AuthChoice | undefined
  private active: AbortController | undefined

  constructor(
    private readonly deps: OnboardingDeps,
    private readonly changed: (state: OnboardingState) => void = () => {},
  ) {}

  get state(): OnboardingState {
    return this.current
  }

  async start(): Promise<OnboardingState> {
    const generation = ++this.generation
    this.stopActive()
    this.retryChoice = undefined
    this.set({ type: 'restart' })
    try {
      const result = await this.deps.preflight()
      if (generation === this.generation) this.set({ type: 'preflight-result', result })
    } catch {
      if (generation === this.generation)
        this.set({ type: 'operation-failed', failure: SAFE_PREFLIGHT_FAILURE })
    }
    return this.current
  }

  async choose(choice: AuthChoice, signal: AbortSignal): Promise<OnboardingState> {
    if (this.current.kind !== 'auth-method') return this.current
    this.set({ type: 'choose-auth', choice })
    return this.runChoice(choice, signal)
  }

  async retry(signal: AbortSignal): Promise<OnboardingState> {
    if (this.current.kind !== 'error') return this.current
    const choice = this.retryChoice
    this.set({ type: 'retry' })
    if (choice) return this.runChoice(choice, signal)
    return this.start()
  }

  /** Escape semantics: child states go back one level; the root becomes a clean cancellation. */
  back(): OnboardingState {
    this.generation++
    this.stopActive()
    this.retryChoice = undefined
    this.set({ type: 'back' })
    return this.current
  }

  cancel(): OnboardingState {
    this.generation++
    this.stopActive()
    this.retryChoice = undefined
    this.set({ type: 'cancel' })
    return this.current
  }

  private async runChoice(choice: AuthChoice, signal: AbortSignal): Promise<OnboardingState> {
    const generation = ++this.generation
    this.stopActive()
    const active = new AbortController()
    this.active = active
    const operationSignal = AbortSignal.any([signal, active.signal])
    try {
      signal.throwIfAborted()
      const result = await (choice === 'agnes-account'
        ? this.deps.loginAgnes(operationSignal)
        : this.deps.loginApiKey(operationSignal))
      operationSignal.throwIfAborted()
      if (generation === this.generation) {
        this.retryChoice = undefined
        this.set({ type: 'complete', result })
      }
    } catch {
      // Ctrl-C is owned by the process signal ladder. Do not turn its reason into visible state.
      signal.throwIfAborted()
      if (generation === this.generation) {
        this.retryChoice = choice
        this.set({ type: 'operation-failed', failure: SAFE_FAILURE })
      }
    } finally {
      if (this.active === active) this.active = undefined
    }
    return this.current
  }

  private stopActive(): void {
    this.active?.abort()
    this.active = undefined
  }

  private set(action: Parameters<typeof reduceOnboarding>[1]): void {
    const next = reduceOnboarding(this.current, action)
    if (next === this.current) return
    this.current = next
    this.changed(next)
  }
}
