import { homeNavigation, type UiExtensionContext } from '@agnes/web-client'
import { useEffect, useState } from 'react'
import { resolveMhsSiteUrl } from './mhs-site-url.js'

/** Full-area embedded host rendering the MHS website and Hub console inside AGH. */
export function MhsPage({ context }: { context: UiExtensionContext }) {
  const locale = context.t('home.entries.nav') === '主页' ? 'zh-CN' : 'en'
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(
    () =>
      homeNavigation.subscribe(() => {
        if (homeNavigation.getSnapshot()?.id === 'mhs') setReloadKey((value) => value + 1)
      }),
    [],
  )
  useEffect(() => {
    const narrow = window.matchMedia?.('(max-width: 900px)')
    const isNarrow = Boolean(narrow?.matches)
    const wasCollapsed = document.body.classList.contains('sidebar-collapsed')
    if (!isNarrow && !wasCollapsed) {
      document.body.classList.add('sidebar-collapsed')
      document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', 'false')
    }
    return () => {
      if (!wasCollapsed) {
        document.body.classList.remove('sidebar-collapsed')
        if (!narrow?.matches) document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', 'true')
      }
    }
  }, [])
  const href = resolveMhsSiteUrl(locale)
  return (
    <section className="mhs-embed-page" data-testid="home-page-mhs">
      <iframe
        key={`${locale}:${reloadKey}`}
        className="mhs-embed-frame"
        data-testid="mhs-embed-frame"
        src={href}
        title={context.t('home.entry.mhs')}
        referrerPolicy="no-referrer"
      />
    </section>
  )
}
