import type { UITimeline, UITurn } from '@agnes/protocol'
import { type ClientContext, conversationCards, workbenchPanels } from '@agnes/web-client'
import { Button, Segmented, SettingsCard, SettingsPage, SettingsRow, SettingsState } from '@agnes/web-ui'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { catalog } from './locales.js'
import { SelectedUsage, usageSnapshot } from './model.js'

export const inject = ['session', 'locale']
export function apply(ctx: ClientContext) {
  const collectors = new Set<SelectedUsage>()
  function Panel({ embedded = false }: { embedded?: boolean }) {
    const collector = useMemo(() => new SelectedUsage(), [])
    useEffect(() => {
      collectors.add(collector)
      return () => {
        collector.invalidate()
        collectors.delete(collector)
      }
    }, [collector])
    const sessionId = useSyncExternalStore(ctx.session.subscribe, ctx.session.getSnapshot)
    useSyncExternalStore(ctx.locale.subscribe, ctx.locale.getSnapshot)
    const t = (key: string) => ctx.locale.t(`usage.${key}`)
    const [view, setView] = useState<'total' | 'calls'>('total')
    const [refresh, setRefresh] = useState(0)
    const [state, setState] = useState<{
      id?: string
      value?: ReturnType<typeof usageSnapshot>
      error?: boolean
    }>({})
    useEffect(() => {
      let active = true
      let revision = refresh
      let reading = false
      let dirty = false
      const read = async () => {
        if (!active) return
        if (reading) {
          dirty = true
          return
        }
        const request = ++revision
        if (!sessionId) return
        reading = true
        try {
          const value = await collector.read(sessionId, async () => {
            const result = await ctx.session.projection.read()
            const envelope = result as { status?: string; value?: UITimeline }
            if (envelope.status !== 'available' || !envelope.value) throw new Error('Unavailable')
            return envelope.value
          })
          if (active && request === revision && value) setState({ id: sessionId, value })
        } catch {
          if (active && request === revision) setState({ id: sessionId, error: true })
        } finally {
          reading = false
          if (active && dirty) {
            dirty = false
            void read()
          }
        }
      }
      setState({})
      void read()
      const off = ctx.session.projection.subscribe(() => void read())
      return () => {
        active = false
        off()
      }
    }, [sessionId, refresh, collector])
    const value = state.id === sessionId ? state.value : undefined
    const usd = (micros?: number) =>
      micros === undefined ? t('unknown') : `$${(micros / 1_000_000).toFixed(6)}`
    const body = (
      <>
        <Button onClick={() => setRefresh((n) => n + 1)}>{t('retry')}</Button>
        {!sessionId ? (
          <SettingsState>{t('empty')}</SettingsState>
        ) : state.error && state.id === sessionId ? (
          <SettingsState tone="error">{t('error')}</SettingsState>
        ) : !value ? (
          <SettingsState tone="loading">{t('loading')}</SettingsState>
        ) : (
          <>
            <p>
              {sessionId} · {t('cut')}: {value.upto}
            </p>
            <Segmented
              label={t('views')}
              value={view}
              options={[
                { value: 'total', label: t('total') },
                { value: 'calls', label: t('calls') },
              ]}
              onChange={setView}
            />
            {view === 'total' ? (
              <SettingsCard>
                {!value.usage?.billingComplete && <SettingsState>{t('partial')}</SettingsState>}
                <SettingsRow title={t('model')}>
                  {value.usage ? `${value.usage.model.id} · ${value.usage.model.route}` : t('unknown')}
                </SettingsRow>
                <SettingsRow title={t('tokens')}>
                  {value.usage
                    ? [
                        value.usage.totals.input,
                        value.usage.totals.output,
                        value.usage.totals.cacheRead,
                        value.usage.totals.cacheWrite,
                      ].join(' / ')
                    : t('unknown')}
                </SettingsRow>
                <SettingsRow title={t('cost')}>
                  {usd(value.usage?.cost?.usdMicros)} ·{' '}
                  {value.usage?.cost
                    ? t(value.usage.cost.source === 'gateway' ? 'actual' : 'estimated')
                    : t('unknown')}
                </SettingsRow>
                <SettingsRow title={t('credits')}>
                  {value.usage?.credits
                    ? `${value.usage.credits.amount} · ${t(value.usage.credits.source === 'gateway' ? 'reportedSource' : 'estimatedSource')}${value.usage.credits.complete ? '' : ` · ${t('partial')}`}`
                    : t('unknown')}
                </SettingsRow>
              </SettingsCard>
            ) : (
              <>
                <p>{t('attribution')}</p>
                <SettingsRow title={t('actual')}>{usd(value.observed.actual)}</SettingsRow>
                <SettingsRow title={t('estimated')}>{usd(value.observed.estimated)}</SettingsRow>
                <SettingsRow title={t('missing')}>{value.observed.unknown}</SettingsRow>
                <SettingsRow title={t('adjustments')}>{value.observed.unattributed}</SettingsRow>
                <SettingsRow title={t('linked')}>{value.observed.adjustments}</SettingsRow>
                {value.groups.map((group) => (
                  <SettingsCard key={group.name} title={t(group.name)}>
                    {group.rows.length === 0 ? (
                      <p>{t('noCalls')}</p>
                    ) : (
                      group.rows.map((row) => (
                        <SettingsRow key={row.id} title={`${row.model ?? t('unknown')} · #${row.seq}`}>
                          {usd(row.billing?.usdMicros)} ·{' '}
                          {row.billing
                            ? t(row.billing.source === 'gateway' ? 'actual' : 'estimated')
                            : t('unknown')}
                          <p>
                            {t('tokens')}:{' '}
                            {row.tokens
                              ? [
                                  row.tokens.input,
                                  row.tokens.output,
                                  row.tokens.cacheRead,
                                  row.tokens.cacheWrite,
                                ].join(' / ')
                              : t('unknown')}
                          </p>
                          {row.interrupted && <p>{t('interrupted')}</p>}
                        </SettingsRow>
                      ))
                    )}
                  </SettingsCard>
                ))}
              </>
            )}
          </>
        )}
        <SettingsCard title={t('coverage')}>
          <p>{t('gap')}</p>
          <p>{t('headless')}</p>
        </SettingsCard>
      </>
    )
    return embedded ? (
      <section aria-label={t('title')}>{body}</section>
    ) : (
      <SettingsPage title={t('title')} description={t('scope')}>
        {body}
      </SettingsPage>
    )
  }
  const registrations = [
    () => ctx.locale.register('usage-cockpit', catalog),
    () =>
      ctx.homeEntries.register({
        id: 'usage-cockpit',
        icon: 'chart',
        order: 40,
        placement: 'primary',
        titleKey: 'usage.title',
        component: () => <Panel />,
      }),
    () =>
      workbenchPanels.register({
        id: 'usage-cockpit',
        order: 65,
        edge: 'right',
        titleKey: 'usage.title',
        component: () => <Panel embedded />,
      }),
    () =>
      conversationCards.register({
        id: 'usage-cockpit',
        order: 90,
        matches: (card) => card.kind === 'conversation.turn-tail',
        component: ({ card, context }) => {
          const { turn, nodes } = card.data as { turn: UITurn; nodes: UITimeline['nodes'] }
          const costs = nodes.filter((node) => node.kind === 'cost' && turn.nodeIds.includes(node.id))
          const groups = usageSnapshot({ sessionId: '', upto: 0, nodes: costs, turns: [turn] }).groups
          return turn.usage.calls.length ? (
            <SettingsCard title={context.t('usage.title')}>
              <p>{context.t('usage.attribution')}</p>
              {groups.map((group) => (
                <SettingsRow key={group.name} title={context.t(`usage.${group.name}`)}>
                  {group.rows.length
                    ? group.rows.map((row) => (
                        <p key={row.id}>
                          {row.model ?? context.t('usage.unknown')} ·{' '}
                          {row.billing
                            ? `$${(row.billing.usdMicros / 1_000_000).toFixed(6)} · ${context.t(row.billing.source === 'gateway' ? 'usage.actual' : 'usage.estimated')}`
                            : context.t('usage.unknown')}
                          {row.interrupted ? ` · ${context.t('usage.interrupted')}` : ''}
                        </p>
                      ))
                    : context.t('usage.unknown')}
                </SettingsRow>
              ))}
            </SettingsCard>
          ) : null
        },
      }),
  ]
  const off: (() => void)[] = []
  try {
    for (const register of registrations) off.push(register())
  } catch (error) {
    for (const stop of off.reverse()) stop()
    throw error
  }
  return () => {
    for (const collector of collectors) collector.dispose()
    for (const stop of off.splice(0).reverse()) stop()
  }
}
