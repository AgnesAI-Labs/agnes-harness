import { AsyncLocalStorage } from 'node:async_hooks'
import type { Logger } from '@agnes/extension-api'
import type { ObservabilityProvider } from './contract.js'

const scopes = new AsyncLocalStorage<{ provider: ObservabilityProvider; key: string }>()
export function currentCorrelation(): { traceId: string; spanId: string } | undefined {
  const scope = scopes.getStore()
  return scope?.provider.correlation(scope.key)
}
export function withObservedSession<T>(
  provider: ObservabilityProvider | undefined,
  key: string,
  run: () => T,
): T {
  return provider ? scopes.run({ provider, key }, run) : run()
}
export function correlatedLogger(logger: Logger): Logger {
  return Object.fromEntries(
    (['debug', 'info', 'warn', 'error'] as const).map((level) => [
      level,
      (message: string, fields?: Parameters<Logger['info']>[1]) => {
        const correlation = currentCorrelation()
        logger[level](
          message,
          correlation
            ? {
                ...(fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}),
                ...correlation,
              }
            : fields,
        )
      },
    ]),
  ) as Logger
}
