import { type HomeEntryBadge, homeEntries, homeNavigation } from '@agnes/web-client'
import { homeAdmin } from './admin-api.js'
import { deferHomePage } from './deferred.js'

const AgentsPage = deferHomePage(async () => ({ default: (await import('./agents-page.js')).AgentsPage }))
const AutomationPage = deferHomePage(async () => ({
  default: (await import('./automation-page.js')).AutomationPage,
}))
const PluginsPage = deferHomePage(async () => ({ default: (await import('./plugins-page.js')).PluginsPage }))

/** Built-in IDs for callers that need labels; placement follows the shared registry. */
export const BUILTIN_HOME_ENTRIES: readonly string[] = ['plugins', 'agents', 'automation']

/** Drafts waiting for review: the count beside the plugins entry. */
function pendingReviewBadge(): HomeEntryBadge & { refresh(): void } {
  let count = 0
  let reading = false
  const listeners = new Set<() => void>()
  const refresh = () => {
    if (reading) return
    reading = true
    void homeAdmin()
      .then(({ api }) => api.candidatesList())
      .then((list) => {
        const next = list.candidates.filter((item) => item.state === 'review').length
        if (next === count) return
        count = next
        for (const listener of listeners) listener()
      })
      // Without admin access there is nothing to review; the entry shows no count.
      .catch(() => undefined)
      .finally(() => {
        reading = false
      })
  }
  return {
    refresh,
    getSnapshot: () => count,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Register the built-in home entries the way a plugin registers its own. */
export function registerBuiltinHomeEntries(): () => void {
  const pending = pendingReviewBadge()
  const disposers = [
    homeEntries.register({
      id: 'agents',
      order: 20,
      placement: 'primary',
      icon: 'bot',
      titleKey: 'home.entry.agents',
      component: AgentsPage,
    }),
    homeEntries.register({
      id: 'plugins',
      order: 10,
      placement: 'primary',
      icon: 'puzzle',
      titleKey: 'home.entry.plugins',
      badge: pending,
      component: PluginsPage,
    }),
    homeEntries.register({
      id: 'automation',
      order: 30,
      placement: 'primary',
      icon: 'clock',
      titleKey: 'home.entry.automation',
      component: AutomationPage,
    }),
    // Reviewing happens on a page, so leaving any page is when the count may have changed.
    homeNavigation.subscribe(pending.refresh),
  ]
  const onVisible = () => {
    if (document.visibilityState === 'visible') pending.refresh()
  }
  document.addEventListener('visibilitychange', onVisible)
  pending.refresh()
  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    for (const dispose of disposers) dispose()
  }
}
