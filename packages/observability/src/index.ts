import { observabilityKind, type ProviderPluginContext } from '@agnes/extension-api'
import { type ObservabilityConfig, observabilityConfig } from './config.js'
import { createObservability } from './provider.js'

export { type ObservabilityConfig, observabilityConfig, observabilityHome } from './config.js'
export { createObservability } from './provider.js'
export const observabilityPlugin = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext, config?: Partial<ObservabilityConfig>) {
    ctx.providers.register(observabilityKind, '@agnes/base', createObservability(observabilityConfig(config)))
  },
}
export type { ObservabilityProvider } from '@agnes/extension-api'
export { correlatedLogger, currentCorrelation, withObservedSession } from './correlation.js'
export { installDiagnosticJournal, readDiagnosticJournal } from './journal.js'
