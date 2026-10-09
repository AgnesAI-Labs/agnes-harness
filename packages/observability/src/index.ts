import { observabilityKind, type ProviderPluginContext } from '@agnes/extension-api'
import type { ObservabilityConfig } from './config.js'
import { acquireObservability } from './runtime.js'

export { type ObservabilityConfig, observabilityConfig, observabilityHome } from './config.js'
export { createObservability } from './provider.js'
export const observabilityPlugin = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext, config?: Partial<ObservabilityConfig>) {
    ctx.providers.register(observabilityKind, '@agnes/base', acquireObservability(undefined, config))
  },
}
export type { ObservabilityProvider } from '@agnes/extension-api'
export { correlatedLogger, currentCorrelation, withObservedSession } from './correlation.js'
export { installDiagnosticJournal, readDiagnosticJournal } from './journal.js'
export { acquireObservability, exporterHealth } from './runtime.js'
