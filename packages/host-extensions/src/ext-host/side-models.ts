import { type ExtensionContext, ExtensionError, type SideModelEntry } from '@agnes/extension-api'
import type { HostCapabilityGrant } from '@agnes/package-manager'

export function sideModelsPort(
  grant: () => HostCapabilityGrant | undefined,
  declared: boolean | undefined,
  list: (() => readonly SideModelEntry[]) | undefined,
  alive: () => void,
  subscribe?: (listener: () => void) => () => void,
  signal?: AbortSignal,
): ExtensionContext['sideModels'] {
  if (!declared || !grant()?.sideCall || !list) return undefined
  const check = () => {
    alive()
    if (!grant()?.sideCall) throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'side-call grant unavailable')
  }
  return Object.freeze({
    ...(subscribe
      ? {
          subscribe(listener: () => void) {
            check()
            let active = true
            let queued = false
            let detach = () => {}
            const dispose = () => {
              active = false
              detach()
              signal?.removeEventListener('abort', dispose)
            }
            detach = subscribe(() => {
              if (!active || queued) return
              queued = true
              queueMicrotask(() => {
                queued = false
                if (!active) return
                try {
                  check()
                } catch {
                  dispose()
                  return
                }
                listener()
              })
            })
            signal?.addEventListener('abort', dispose, { once: true })
            return dispose
          },
        }
      : {}),
    async list() {
      check()
      return Object.freeze(list().map(({ route, model, api }) => Object.freeze({ route, model, api })))
    },
  })
}
