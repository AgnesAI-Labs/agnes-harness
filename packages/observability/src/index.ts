import type { ProviderPluginContext, ServiceProvider } from '@agnes/extension-api'
import {
  type ObservabilityHealth,
  type ObservabilityProvider,
  type ObservabilitySession,
  observabilityKind,
} from '@agnes/observability/contract'
import type { ObservabilityConfig } from './config.js'
import { acquireObservability } from './runtime.js'

export { type ObservabilityConfig, observabilityConfig, observabilityHome } from './config.js'
export { createObservability } from './provider.js'
export { type ObservabilityHealth, type ObservabilityProvider, type ObservabilitySession, observabilityKind }

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
