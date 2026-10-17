import { type ClientContext, workbenchPanels } from '@agnes/web-client'
import { Banner, Button, Segmented, SettingsBlock, SettingsItem, useUiText } from '@agnes/web-ui'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { catalog } from './locales.mjs'

const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const number = (v: unknown): string | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : undefined

export const inject = ['agnes', 'session', 'locale']
export function apply(ctx: ClientContext) {
  function Panel() {
    const { t } = useUiText('context-doctor', catalog)
    const sessionId = useSyncExternalStore(ctx.session.subscribe, ctx.session.getSnapshot)
    const [attempt, retry] = useState(0)
    const [view, setView] = useState('overview')
    const [read, setRead] = useState<{
      id: string | undefined
      value?: Record<string, unknown>
      failed?: boolean
    }>({ id: undefined })
    const [loading, setLoading] = useState(false)
    // Projection notifications trigger a fresh authorized query, with one request in flight.
    // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries an authorized read.
    useEffect(() => {
      let current = true,
        pending = false,
        dirty = false
      const refresh = async () => {
        if (pending) {
          dirty = true
          return
        }
        pending = true
        setLoading(true)
        try {
          const value = object(await ctx.agnes.services.call('context.read', {}))
          if (value?.version !== 1 || !['live', 'unknown'].includes(String(value.status)))
            throw new Error('Invalid diagnostics')
          if (current) setRead({ id: sessionId, value })
        } catch {
          if (current) setRead({ id: sessionId, failed: true })
        } finally {
          pending = false
          if (current) {
            setLoading(false)
            if (dirty) {
              dirty = false
              void refresh()
            }
          }
        }
      }
      setRead({ id: sessionId })
      const off = ctx.session.projection.subscribe(() => {
        void refresh()
      })
      if (sessionId) void refresh()
      return () => {
        current = false
        off()
      }
    }, [sessionId, attempt])
    const value = read.id === sessionId ? read.value : undefined
    const snapshot = object(value?.snapshot)
    const observed = object(snapshot?.context)
    const request = object(snapshot?.request)
    const before = object(snapshot?.beforeCompact)
    const compact = object(snapshot?.compact)
    const groups = object(observed?.groups)
    const surface = object(observed?.surface)
    const metric = (label: string, v: unknown) => (
      <SettingsItem key={label} label={t(label)}>
        <span>{number(v) ?? t('unknown')}</span>
      </SettingsItem>
    )
    return (
      <SettingsBlock label={t('title')} aria-busy={loading}>
        <Banner tone="info">{t('estimates')}</Banner>
        <p>{t('scope')}</p>
        <Button disabled={loading || !sessionId} onClick={() => retry(attempt + 1)}>
          {t('refresh')}
        </Button>
        {!sessionId && <p role="status">{t('session')}</p>}
        {read.id === sessionId && read.failed && (
          <Banner tone="error" role="alert">
            {t('failed')}
          </Banner>
        )}
        {loading && !value && <p role="status">{t('loading')}</p>}
        {value?.status === 'unknown' && <p role="status">{t('empty')}</p>}
        <Segmented
          label={t('view')}
          value={view}
          onChange={(v) => setView(String(v))}
          options={[
            { value: 'overview', label: t('overview') },
            { value: 'compact', label: t('compact') },
          ]}
        />
        {view === 'overview' ? (
          <>
            {['rules', 'memory', 'other'].map((group) => {
              const row = object(groups?.[group])
              return (
                <SettingsBlock key={group} label={t(group)}>
                  {metric('characters', row?.characters)}
                  {metric('heuristicTokens', row?.heuristicTokens)}
                  {metric('configuredBudget', undefined)}
                </SettingsBlock>
              )
            })}
            {metric('surfaceTokens', observed?.digestTokensEstimate)}
            {metric('nodes', surface?.nodes)}
            {metric('missing', surface?.missingEstimates)}
            {metric('pinned', surface?.pinned)}
            {metric('results', surface?.results)}
            <SettingsItem label={t('slot')}>
              <span>{typeof request?.slot === 'string' ? request.slot : t('unknown')}</span>
            </SettingsItem>
            {metric('tools', request?.toolNamesCount)}
            {metric('messages', request?.messageCount)}
            {metric('window', request?.contextWindow)}
          </>
        ) : (
          <>
            <p>{t('windowScope')}</p>
            {metric('previousWindow', before?.previousContextWindow)}
            {metric('window', before?.contextWindow)}
            {metric('reserve', before?.reserveTokens)}
            {metric('beforeTokens', compact?.tokensBeforeEstimate)}
            {metric('afterTokens', compact?.tokensAfterEstimate)}
            {metric('replace', compact?.replaceSeq)}
            <SettingsItem label={t('range')}>
              <span>
                {Array.isArray(compact?.range) && compact.range.length === 2
                  ? compact.range.map((v) => number(v) ?? t('unknown')).join(' – ')
                  : t('unknown')}
              </span>
            </SettingsItem>
            {metric('pairs', compact?.retainedPairs)}
            {metric('pins', compact?.retainedPins)}
            {metric('offload', compact?.offloadedBytes)}
            {metric('omissions', compact?.omissions)}
            <p>{t('retention')}</p>
          </>
        )}
      </SettingsBlock>
    )
  }
  const off = [
    ctx.locale.register('context-doctor', catalog),
    workbenchPanels.register({
      id: 'context-doctor',
      edge: 'right',
      order: 75,
      titleKey: 'context-doctor.title',
      component: Panel,
    }),
  ]
  return () => {
    for (const dispose of off.reverse()) dispose()
  }
}
