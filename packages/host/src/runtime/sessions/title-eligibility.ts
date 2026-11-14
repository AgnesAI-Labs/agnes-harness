export type AutoTitleEligibility = (sessionKey: string, signal?: AbortSignal) => Promise<boolean>
const authorities = new WeakMap<AutoTitleEligibility, ReturnType<typeof create>>()
function create(fallback?: AutoTitleEligibility) {
  const bindings: Array<{ check: AutoTitleEligibility }> = []
  const check: AutoTitleEligibility = async (key, signal) => {
    if (signal?.aborted) return false
    try {
      return (await (bindings.at(-1)?.check ?? fallback)?.(key, signal)) === true
    } catch {
      return false
    }
  }
  return {
    check,
    bind(next: AutoTitleEligibility) {
      const binding = { check: next }
      bindings.push(binding)
      return () => {
        const index = bindings.indexOf(binding)
        if (index >= 0) bindings.splice(index, 1)
      }
    },
  }
}
/** The same checker survives generation construction and reaches the actual preference owner. */
export function titleEligibilityAuthority(check?: AutoTitleEligibility) {
  const existing = check && authorities.get(check)
  if (existing) return existing
  const authority = create(check)
  authorities.set(authority.check, authority)
  return authority
}
