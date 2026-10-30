import type { ClientContext } from '@agnes/web-client'
import { Button, IconButton, Menu, SettingsInput, Tabs } from '@agnes/web-ui'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { BrowserClient, type BrowserPage } from './browser-client.js'
import { BrowserInteraction } from './browser-interaction.js'
import { browserCatalog } from './browser-locales.js'
import { BrowserScreen, type BrowserScreenHandle, type HumanControl } from './browser-screen.js'

export function apply(ctx: ClientContext) {
  const client = new BrowserClient(ctx)
  const t = (key: string) => ctx.locale.t('browser.' + key)
  const useBrowser = () => {
    useSyncExternalStore(ctx.locale.subscribe, ctx.locale.getSnapshot)
    return useSyncExternalStore(client.subscribe, client.getSnapshot)
  }
  function Panel() {
    useSyncExternalStore(ctx.locale.subscribe, ctx.locale.getSnapshot)
    const selected = useSyncExternalStore(ctx.session.readiness.subscribe, ctx.session.readiness.getSnapshot)
    if (selected.status === 'ready') return <LoadedPanel key={selected.epoch} />
    return (
      <section className="agh-browser-panel">
        <p>{t(!selected.sessionId ? 'noSession' : 'sessionUnavailable')}</p>
      </section>
    )
  }
  function LoadedPanel() {
    const state = useBrowser()
    useEffect(() => client.start(), [])
    const [selected, setSelected] = useState('')
    const [address, setAddress] = useState('')
    const [control, setControl] = useState<HumanControl>()
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [reconnect, setReconnect] = useState(0)
    const [showRecovery, setShowRecovery] = useState(false)
    const [copiedRecovery, setCopiedRecovery] = useState(false)
    const [showEvents, setShowEvents] = useState(false)
    const [actualSize, setActualSize] = useState(false)
    const [fixedSize, setFixedSize] = useState(false)
    const hasPages = state.pages.length > 0
    // biome-ignore lint/correctness/useExhaustiveDependencies: never reuse a channel across conversations or an empty page list.
    const interaction = useMemo(() => new BrowserInteraction(ctx), [state.sessionId, hasPages])
    useEffect(() => {
      if (state.sessionId && hasPages) void interaction.prepare().catch(() => {})
      return () => interaction.close()
    }, [interaction, state.sessionId, hasPages])
    const releaseControl = useCallback(() => setControl(undefined), [])
    const [events, setEvents] = useState<{ seq: number; kind: string; detail: string }[]>([])
    const screen = useRef<BrowserScreenHandle>(null)
    const preferred = control?.pageId ?? selected
    const page = state.pages.find((p) => p.pageId === preferred) ?? state.pages[0]
    // A user's selected tab stays put while the model works in another tab.
    const selectPage = (pageId: string) => setSelected(pageId)
    const pageId = page?.pageId
    const target = useRef(pageId)
    target.current = pageId
    const taking = useRef(false)
    useEffect(() => {
      setControl((current) => (current?.pageId === pageId ? current : undefined))
    }, [pageId])
    useEffect(() => {
      setAddress(page?.url ?? '')
      setError('')
    }, [page?.url])
    useEffect(() => {
      let active = true,
        pending = false,
        cursor = 0
      setEvents([])
      if (!pageId || !showEvents) return
      const refresh = async () => {
        if (pending) return
        pending = true
        try {
          const value = (await ctx.agnes.services.call('browser.events', {
            pageId,
            cursor,
          })) as { events: { seq: number; kind: string; detail: string }[]; cursor: number }
          if (active) {
            cursor = value.cursor
            setEvents((events) => [...events, ...value.events].slice(-20))
          }
        } catch {
          /* Connection errors are shown by the main session refresh. */
        } finally {
          pending = false
        }
      }
      const timer = setInterval(() => {
        void refresh()
      }, 2000)
      void refresh()
      return () => {
        active = false
        clearInterval(timer)
      }
    }, [pageId, showEvents])
    const effect = async (name: string, input: Record<string, unknown>) => {
      setBusy(true)
      setError('')
      try {
        return await client.effect(name, input)
      } catch (error) {
        const code = (error as { code?: string })?.code
        setError(
          code === 'PROTECTED_TARGET'
            ? t('protectedTarget')
            : code === 'INVALID_URL'
              ? t('invalidUrl')
              : code === 'FILE_DENIED'
                ? t('fileDenied')
                : code === 'UNSUPPORTED_FILE'
                  ? t('unsupportedFile')
                  : String(error),
        )
        return undefined
      } finally {
        setBusy(false)
      }
    }
    const takeControl = async (pageEpoch = page?.pageEpoch) => {
      if (control) return control
      if (!pageId || taking.current || busy) return undefined
      taking.current = true
      try {
        const result = await interaction.request({
          type: 'control',
          pageId,
          pageEpoch,
          mode: 'human',
        })
        if (target.current !== pageId) {
          void interaction
            .request({ type: 'pause', pageId, controlEpoch: result.controlEpoch })
            .catch(() => {})
          return undefined
        }
        const granted = {
          operationId: '',
          pageId,
          controlEpoch: Number(result.controlEpoch),
          channel: interaction,
        }
        setControl(granted)
        return granted
      } catch (error) {
        setError(String(error))
        return undefined
      } finally {
        taking.current = false
      }
    }
    if (!state.sessionId) return <p>{t('noSession')}</p>
    return (
      <section className="agh-browser-panel">
        {page && (
          <Tabs
            type="editable-card"
            locale={{ removeAriaLabel: t('close') }}
            hideAdd
            onEdit={(key, action) => {
              if (action !== 'remove' || busy) return
              void effect('browser.close', { pageId: String(key) }).then((reply) => {
                if (reply && control?.pageId === key) setControl(undefined)
              })
            }}
            className="agh-browser-tabs"
            size="small"
            activeKey={page.pageId}
            aria-label={t('tabs')}
            onChange={(pageId) => {
              setControl(undefined)
              selectPage(pageId)
            }}
            items={state.pages.map((entry) => {
              const url = new URL(entry.url)
              return {
                key: entry.pageId,
                closable: !busy,
                closeIcon: (
                  <span role="img" aria-label={`${t('close')}: ${url.host + url.pathname}`}>
                    ×
                  </span>
                ),
                label: <span title={entry.url}>{url.host + (url.pathname === '/' ? '' : url.pathname)}</span>,
              }
            })}
          />
        )}
        <form
          className="agh-browser-address"
          onSubmit={(event) => {
            event.preventDefault()
            if (busy || state.state !== 'ready') return
            if (page) {
              screen.current?.interact({ type: 'navigate', url: address })
              return
            }
            void effect('browser.open', { url: address }).then((reply) => {
              if (reply && typeof reply.result.pageId === 'string') selectPage(reply.result.pageId)
            })
          }}
        >
          <div className="agh-browser-navigation">
            {(['back', 'forward', 'reload'] as const).map((action) => (
              <IconButton
                key={action}
                name={action === 'back' ? 'arrow-left' : action === 'forward' ? 'arrow-right' : 'refresh-cw'}
                label={t(action)}
                disabled={!page || busy}
                onClick={() => screen.current?.interact({ type: action })}
              />
            ))}
          </div>
          <SettingsInput
            value={address}
            aria-label={t('address')}
            placeholder="http://127.0.0.1:5173/"
            onChange={(event) => setAddress(event.currentTarget.value)}
          />
          {(!page || address !== page.url) && (
            <IconButton
              name="arrow-right"
              label={t('open')}
              htmlType="submit"
              disabled={busy || state.state !== 'ready'}
            />
          )}
          {page && (
            <>
              <Menu
                label={t('more')}
                trigger={<IconButton name="ellipsis" label={t('more')} />}
                items={[
                  {
                    id: 'viewport',
                    label: t(fixedSize ? 'adaptiveViewport' : 'fixedViewport'),
                    onSelect: () => setFixedSize((value) => !value),
                  },
                  {
                    id: 'scale',
                    label: t(actualSize && fixedSize ? 'fit' : 'actualSize'),
                    onSelect: () => {
                      setActualSize(!(actualSize && fixedSize))
                      setFixedSize(true)
                    },
                  },
                  {
                    id: 'reconnect',
                    label: t('reconnect'),
                    onSelect: () => setReconnect((value) => value + 1),
                  },
                  {
                    id: 'events',
                    label: `${t('events')} (${events.length})`,
                    onSelect: () => setShowEvents((value) => !value),
                  },
                ]}
              />
            </>
          )}
        </form>
        {(error || state.error) && <p role="alert">{error || state.error}</p>}
        {state.pagesUnavailable && <p role={page ? 'alert' : 'status'}>{t('pagesUnavailable')}</p>}
        {state.error?.includes('Browser install lock ') && (
          <section>
            <Button onClick={() => setShowRecovery((shown) => !shown)}>{t('lockHelp')}</Button>
            {showRecovery && (
              <div>
                <p>{t('lockRecovery')}</p>
                <pre>{state.error}</pre>
                <Button
                  onClick={() => {
                    void navigator.clipboard.writeText(`${t('lockRecovery')}\n${state.error}`).then(
                      () => setCopiedRecovery(true),
                      () => setError(t('copyFailed')),
                    )
                  }}
                >
                  {t(copiedRecovery ? 'copied' : 'copyRecovery')}
                </Button>
              </div>
            )}
          </section>
        )}
        {client.pendingEffect() && (
          <Button
            disabled={busy}
            onClick={() => {
              const pending = client.pendingEffect()
              if (!pending) return
              void effect(pending.service, pending.input).then((reply) => {
                if (!reply) return
                if (pending.service === 'browser.open' && typeof reply.result.pageId === 'string')
                  selectPage(reply.result.pageId)
                if (pending.service === 'browser.control')
                  setControl(
                    pending.input.mode === 'human'
                      ? {
                          operationId: reply.operationId,
                          pageId: String(pending.input.pageId),
                          controlEpoch: Number(reply.result.controlEpoch),
                        }
                      : undefined,
                  )
              })
            }}
          >
            {t('checkAction')}
          </Button>
        )}
        {!page ? (
          !state.pagesUnavailable && <p>{t(state.state === 'preparing' ? 'preparing' : 'empty')}</p>
        ) : (
          <>
            <BrowserScreen
              ref={screen}
              key={state.sessionId}
              ctx={ctx}
              interaction={interaction}
              page={page}
              control={control}
              reconnect={reconnect}
              actualSize={actualSize && fixedSize}
              fixedSize={fixedSize}
              t={t}
              onError={setError}
              onRequestControl={takeControl}
              onControlLost={releaseControl}
            />
            {showEvents && (
              <section className="agh-browser-events" aria-label={t('events')}>
                {events.length ? (
                  <ul>
                    {events.map((entry) => (
                      <li key={entry.seq}>
                        {entry.kind}: {entry.detail}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t('noErrors')}</p>
                )}
              </section>
            )}
          </>
        )}
      </section>
    )
  }
  const offLocale = ctx.locale.register('browser', browserCatalog)
  const offPanel = ctx.workbenchPanels.register({
    id: 'browser',
    order: 65,
    edge: 'right',
    titleKey: 'browser.title',
    component: Panel,
  })
  const offSession = ctx.session.readiness.subscribe(() => client.clearSession())
  return () => {
    offSession()
    offPanel()
    offLocale()
    client.close()
  }
}
