import type { SystemPromptConfig, SystemPromptSection } from '@agnes/protocol'
import { defineProviderKind, type ProviderIdentity } from './provider-kind.js'

/** Pure session-pinned composition. Core retains its untrusted-input safety section. */
export interface SystemPromptProvider extends ProviderIdentity {
  compose(
    config: Readonly<SystemPromptConfig>,
    sections: readonly SystemPromptSection[],
  ): readonly SystemPromptSection[]
  /** Shipped defaults only; runtime sections are available through the session preview. */
  defaults(): readonly SystemPromptSection[]
}
export const systemPromptKind = defineProviderKind<SystemPromptProvider>({
  kind: 'system-prompt',
  scope: 'generation',
  versioned: true,
  validate(provider) {
    if (typeof provider.compose !== 'function' || typeof provider.defaults !== 'function')
      throw new TypeError('Invalid system prompt provider')
  },
})
export type ModelRequestTraceHandle = {
  readonly id: string
  wire(body: unknown, attemptId?: string): Promise<void>
  attempt?(event: ModelAdapterAttemptObservation): Promise<void>
  event(event: unknown): void
  finish(): Promise<void>
}
/** Passive, local-only content sink. A failed sink must not change inference. */
export type ModelRequestTrace = {
  begin(
    request: import('@agnes/protocol').RequestBody,
    adapter?: import('@agnes/protocol').ModelRequestAttempt['adapter'],
  ): Promise<ModelRequestTraceHandle>
}

/** One real adapter attempt. Metadata contains neither headers nor credentials. */
export type ModelAdapterAttemptObservation = {
  attemptId: string
  index: number
  adapter: import('@agnes/protocol').ModelRequestAttempt['adapter']
  status: import('@agnes/protocol').ModelRequestAttempt['status']
  providerActualTokens?: import('@agnes/protocol').JsonValue
  response?: import('@agnes/protocol').JsonValue
}
