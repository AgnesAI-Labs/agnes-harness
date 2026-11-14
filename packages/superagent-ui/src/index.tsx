/** Browser entry of the Superagent panel: one primary home entry that shows the panel, with its own tabs inside. */
import type { ClientContext } from '@agnes/web-client'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { App } from './app.js'
import { en, zh } from './locales.js'
import { translator } from './text.js'

const NAMESPACE = '@agnes/superagent'
/** The navigation title, which the host reads from the catalog; every other text is the panel's own dictionary. */
const NAVIGATION = { en: { 'superagent.nav': 'Superagent' }, 'zh-CN': { 'superagent.nav': 'Superagent' } }

/** The session page of the worker the ticket page names; the host opens a session by its id. */
export const sessionPage = (sessionId: string) => `/?session=${encodeURIComponent(sessionId)}`

function Panel({ ctx }: { ctx: ClientContext }) {
  const language = useSyncExternalStore(ctx.locale.subscribe, () => ctx.locale.locale)
  const t = useMemo(() => translator(language === 'zh-CN' ? zh : en), [language])
  const openSession = useCallback(async (sessionId: string) => window.location.assign(sessionPage(sessionId)), [])
  return <App t={t} openSession={openSession} services={ctx.profile.services} />
}

export function apply(ctx: ClientContext) {
  const offLocale = ctx.locale.register(NAMESPACE, NAVIGATION)
  const offEntry = ctx.homeEntries.register({
    id: 'superagent',
    placement: 'primary',
    icon: 'list',
    titleKey: 'superagent.nav',
    order: 20,
    component: () => <Panel ctx={ctx} />,
  })
  return () => {
    offEntry()
    offLocale()
  }
}
