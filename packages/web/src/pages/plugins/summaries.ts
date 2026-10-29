import { useEffect, useState } from 'react'
import type { HomePageData } from '../host.js'
import type { PluginView } from './admin-view.js'
import type { Capability } from './route.js'

export type CapabilitySummary = Readonly<{ text: string; attention?: boolean }>
export type CapabilitySummaries = Partial<Record<Capability, CapabilitySummary>>
type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

const SEARCH_NAMES: Readonly<Record<string, string>> = {
  brave: 'Brave',
  tavily: 'Tavily',
  exa: 'Exa',
  perplexity: 'Perplexity',
  searxng: 'SearXNG',
}

/**
 * One line of current state per built-in capability. Each read is independent and optional: a
 * capability whose state cannot be read simply shows no summary, and its own page reports why.
 */
export function useCapabilitySummaries(
  api: PluginView['api'],
  data: HomePageData,
  t: Text,
): CapabilitySummaries {
  const [summaries, setSummaries] = useState<CapabilitySummaries>({})
  useEffect(() => {
    if (!api) return
    const pending = new AbortController()
    const put = (id: Capability, value: CapabilitySummary | undefined) => {
      if (!pending.signal.aborted && value) setSummaries((current) => ({ ...current, [id]: value }))
    }
    const quiet = () => undefined
    void fetch('/admin/api/search', { credentials: 'same-origin', cache: 'no-store', signal: pending.signal })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((value: { configured?: unknown; defaultProvider?: unknown } | undefined) => {
        if (!value) return
        const name =
          typeof value.defaultProvider === 'string' ? SEARCH_NAMES[value.defaultProvider] : undefined
        put('search', {
          text: value.configured && name ? t('summary.search.ready', { name }) : t('summary.search.setup'),
        })
      })
      .catch(quiet)
    void data
      .call<{ status?: string; blockers?: readonly string[] }>('_agnes/v1/computerUse.status', {})
      .then((report) => {
        if (report.status === 'ready') return put('computer-use', { text: t('summary.computerUse.ok') })
        // Switched off or unsupported is a fact about this computer, not something to fix here.
        const settled = report.blockers?.some((item) =>
          ['feature-disabled', 'platform-unsupported'].includes(item),
        )
        if (!settled) put('computer-use', { text: t('summary.computerUse.attention'), attention: true })
      })
      .catch(quiet)
    if (api) {
      void api
        .childEngines()
        .then((value) => {
          const count = Object.values(value.engines).filter((engine) => engine.enabled).length
          put('subagents', {
            text: count ? t('summary.subagents.external', { count }) : t('summary.subagents.builtin'),
          })
        })
        .catch(quiet)
    }
    return () => pending.abort()
  }, [api, data, t])
  return summaries
}
