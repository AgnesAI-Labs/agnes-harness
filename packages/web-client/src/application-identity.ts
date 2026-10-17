import type { ApplicationState, ApplicationTemplate } from '@agnes/protocol'

/** Host-owned display projection. It never changes actors, personas, authority or execution. */
let state: ApplicationState | undefined
const listeners = new Set<() => void>()
export const applicationIdentity = {
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  set(next: ApplicationState | undefined) {
    if (JSON.stringify(next) === JSON.stringify(state)) return
    state = next
    for (const listener of listeners) listener()
  },
}
export function effectiveApplication(): ApplicationTemplate | undefined {
  return state?.status === 'active' ? (state.effective ?? undefined) : undefined
}
export function applicationBrand(locale = 'en') {
  return resolveApplicationBrand(effectiveApplication(), locale)
}
export function resolveApplicationBrand(application: ApplicationTemplate | undefined, locale = 'en') {
  const brand = application?.brand
  const text = (value: { en: string; 'zh-CN'?: string } | undefined, fallback: string) =>
    (locale === 'zh-CN' ? value?.['zh-CN'] : undefined) ?? value?.en ?? fallback
  return {
    name: text(brand?.name, 'Agnes Harness'),
    title: text(brand?.title, 'Agnes Harness'),
    assistantName: text(brand?.assistantName, 'Agnes'),
  }
}
/** URL > user > application > host; never persist an application default as a user preference. */
export function presentationDefault<T>(
  url: T | undefined,
  user: T | undefined,
  application: T | undefined,
  host: T,
): T {
  return url ?? user ?? application ?? host
}

/** Product catalogue filtering is display-only; session admission still resolves the chosen ref. */
export function applicationAgents<T extends { ref: string }>(
  agents: readonly T[],
  application = effectiveApplication(),
): T[] {
  const allowed = application?.agents
  return agents
    .filter((agent) => allowed === undefined || allowed.includes(agent.ref))
    .sort((a, b) => Number(b.ref === application?.defaultAgent) - Number(a.ref === application?.defaultAgent))
}
