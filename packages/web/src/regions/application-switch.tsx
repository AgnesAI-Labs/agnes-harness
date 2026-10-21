import { applicationIdentity, type LocaleService } from '@agnes/web-client'
import { Button, Icon } from '@agnes/web-ui'
import { type MouseEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { canEffect, homeAdmin } from '../pages/admin-api.js'

/** Host-owned footer, outside every replaceable navigation slot. */
export function ApplicationSwitch({ locale }: { locale: LocaleService }) {
  const language = useSyncExternalStore(locale.subscribe, locale.getSnapshot)
  const state = useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const tr = (en: string, zh: string) => (language === 'zh-CN' ? zh : en)
  const adopted = !!state?.selection
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const restore = async () => {
    if (busy || !state) return
    setBusy(true)
    setError(false)
    try {
      const admin = await homeAdmin()
      if (!live.current) return
      if (!canEffect(admin, 'packages.activate')) throw new Error('CAPABILITY_DENIED')
      await admin.api.clearApplication(state.revision)
      if (live.current) location.reload()
    } catch {
      if (live.current) setError(true)
    } finally {
      if (live.current) setBusy(false)
    }
  }
  // The host owns navigation. Plain clicks ask it to open the settings page in place; modifier
  // clicks keep the href so a new tab still works, and a host that does not handle the event keeps
  // the link as its fallback.
  const requestSettings = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const request = new CustomEvent('agnes:open-settings', {
      bubbles: true,
      cancelable: true,
      detail: { section: 'application' },
    })
    if (!event.currentTarget.dispatchEvent(request)) event.preventDefault()
  }
  if (!adopted) return null
  return (
    <div className="application-footer">
      {adopted && (
        <Button
          appearance="ghost"
          className="application-footer-item"
          aria-label={tr('Return to official UI', '返回官方界面')}
          disabled={busy}
          onClick={() => void restore()}
          data-testid="application-return"
        >
          <Icon name="arrow-left" />
          <span>{tr('Return to official UI', '返回官方界面')}</span>
        </Button>
      )}
      <a
        className="application-footer-item"
        href="?settings=application"
        aria-label={tr('Switch application', '切换应用')}
        data-testid="application-switch"
        onClick={requestSettings}
      >
        <Icon name="puzzle" />
        <span>{tr('Switch application', '切换应用')}</span>
      </a>
      {error && (
        <p role="alert">
          {tr(
            'Could not restore the interface. Open Applications and retry.',
            '未能恢复界面，请打开应用设置后重试。',
          )}
        </p>
      )}
    </div>
  )
}
