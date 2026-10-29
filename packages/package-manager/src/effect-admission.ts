import { AsyncLocalStorage } from 'node:async_hooks'
import type { PermissionEffectAdmission } from '@agnes/protocol'

// An explicit operation option opens this scope; nested ordinary calls clear rather than inherit it.
const scope = new AsyncLocalStorage<PermissionEffectAdmission | undefined>()
export const packageAdmission = () => {
  const admission = scope.getStore()
  return admission ? { admission } : {}
}
export const withPackageAdmission = <T>(
  admission: PermissionEffectAdmission | undefined,
  work: () => Promise<T>,
) => scope.run(admission, work)
