import type { ProviderPluginContext, ServiceProvider } from '@agnes/extension-api'
import type { ObservabilityConfig } from './config.js'
import {
  observabilityKind,
  type ObservabilityHealth,
  type ObservabilityProvider,
  type ObservabilitySession,
} from './contract.js'
import { acquireObservability } from './runtime.js'

export { type ObservabilityConfig, observabilityConfig, observabilityHome } from './config.js'
export { observabilityKind, type ObservabilityHealth, type ObservabilityProvider, type ObservabilitySession }
export { createObservability } from './provider.js'

function asService(runtime: ObservabilityProvider): ServiceProvider<ObservabilityProvider> {
  return {
    id: runtime.id,
    version: runtime.version,
    open() {
      return runtime
    },
    // Registration lease. The opened instance shares this dispose, and a second call is a no-op.
    dispose() {
      return runtime.dispose()
    },
  }
}

export const observabilityPlugin = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext, config?: Partial<ObservabilityConfig>) {
    ctx.providers.register(
      observabilityKind,
      '@agnes/base',
      asService(acquireObservability(undefined, config)),
    )
  },
}
export { administerObservability, telemetrySnapshot } from './admin.js'
export { correlatedLogger, currentCorrelation, withObservedSession } from './correlation.js'
export { installDiagnosticJournal, readDiagnosticJournal } from './journal.js'
export { acquireObservability, exporterHealth } from './runtime.js'
