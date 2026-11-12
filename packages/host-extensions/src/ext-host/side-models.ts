import { type ExtensionContext, ExtensionError, type SideModelEntry } from '@agnes/extension-api'
import type { HostCapabilityGrant } from '@agnes/package-manager'

export function sideModelsPort(
  grant: () => HostCapabilityGrant | undefined,
  declared: boolean | undefined,
  list: (() => readonly SideModelEntry[]) | undefined,
  alive: () => void,
): ExtensionContext['sideModels'] {
  if (!declared || !grant()?.sideCall || !list) return undefined
  return Object.freeze({
    async list() {
      alive()
      if (!grant()?.sideCall)
        throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'side-call grant unavailable')
      return Object.freeze(list().map(({ route, model, api }) => Object.freeze({ route, model, api })))
    },
  })
}
