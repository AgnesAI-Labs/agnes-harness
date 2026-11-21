import { createExternalStore } from '@agnes/web-ui'

// Back and settings remounts leave submitted writes running in the same workbench.
export const pendingCredentialMutations = createExternalStore<ReadonlySet<string>>(new Set())

export function beginCredentialMutation(id: string): (() => void) | undefined {
  const pending = pendingCredentialMutations.getSnapshot()
  if (pending.has(id)) return undefined
  pendingCredentialMutations.set(new Set([...pending, id]))
  return () => {
    const next = new Set(pendingCredentialMutations.getSnapshot())
    next.delete(id)
    pendingCredentialMutations.set(next)
  }
}

export function credentialReplacementScopes(id: string) {
  return {
    success: `credentials-replacement:${id}`,
    unconfirmed: `credentials-replacement-unconfirmed:${id}`,
    refusal: `credentials-replacement-refusal:${id}`,
  }
}
