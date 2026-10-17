import { workbenchPanels } from '@agnes/web-client'
import { Banner, Button, Segmented, SettingsBlock, SettingsItem, useUiText } from '@agnes/web-ui'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { catalog } from './locales.mjs'

/** @param {unknown} v
 * @returns {Record<string, unknown> | undefined} */
const object = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? /** @type {Record<string, unknown>} */ (v)
    : void 0
const number = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : void 0)
const inject = ['agnes', 'session', 'locale']
/** @param {import('@agnes/web-client').ClientContext} ctx */
function apply(ctx) {
  function Panel() {
    const { t } = useUiText('context-doctor', catalog)
    const sessionId = useSyncExternalStore(ctx.session.subscribe, ctx.session.getSnapshot)
    const [attempt, retry] = useState(0)
    const [view, setView] = useState('overview')
    const [read, setRead] = useState(
      /** @type {{id: string | undefined, value?: Record<string, unknown>, failed?: boolean}} */ ({
        id: void 0,
      }),
    )
    const [loading, setLoading] = useState(false)
    // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the authorized query.
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
          const value2 = object(await ctx.agnes.services.call('context.read', {}))
          if (value2?.version !== 1 || !['live', 'unknown'].includes(String(value2.status)))
            throw new Error('Invalid diagnostics')
          if (current) setRead({ id: sessionId, value: value2 })
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
      const off2 = ctx.session.projection.subscribe(() => {
        void refresh()
      })
      if (sessionId) void refresh()
      return () => {
        current = false
        off2()
      }
    }, [sessionId, attempt])
    const value = read.id === sessionId ? read.value : void 0
    const snapshot = object(value?.snapshot)
    const observed = object(snapshot?.context)
    const request = object(snapshot?.request)
    const before = object(snapshot?.beforeCompact)
    const compact = object(snapshot?.compact)
    const groups = object(observed?.groups)
    const surface = object(observed?.surface)
    const metric = (label, v) =>
      /* @__PURE__ */ jsx(
        SettingsItem,
        { label: t(label), children: /* @__PURE__ */ jsx('span', { children: number(v) ?? t('unknown') }) },
        label,
      )
    return /* @__PURE__ */ jsxs(SettingsBlock, {
      label: t('title'),
      'aria-busy': loading,
      children: [
        /* @__PURE__ */ jsx(Banner, { tone: 'info', children: t('estimates') }),
        /* @__PURE__ */ jsx('p', { children: t('scope') }),
        /* @__PURE__ */ jsx(Button, {
          disabled: loading || !sessionId,
          onClick: () => retry(attempt + 1),
          children: t('refresh'),
        }),
        !sessionId && /* @__PURE__ */ jsx('p', { role: 'status', children: t('session') }),
        read.id === sessionId &&
          read.failed &&
          /* @__PURE__ */ jsx(Banner, { tone: 'error', role: 'alert', children: t('failed') }),
        loading && !value && /* @__PURE__ */ jsx('p', { role: 'status', children: t('loading') }),
        value?.status === 'unknown' && /* @__PURE__ */ jsx('p', { role: 'status', children: t('empty') }),
        /* @__PURE__ */ jsx(Segmented, {
          label: t('view'),
          value: view,
          onChange: (v) => setView(String(v)),
          options: [
            { value: 'overview', label: t('overview') },
            { value: 'compact', label: t('compact') },
          ],
        }),
        view === 'overview'
          ? /* @__PURE__ */ jsxs(Fragment, {
              children: [
                ['rules', 'memory', 'other'].map((group) => {
                  const row = object(groups?.[group])
                  return /* @__PURE__ */ jsxs(
                    SettingsBlock,
                    {
                      label: t(group),
                      children: [
                        metric('characters', row?.characters),
                        metric('heuristicTokens', row?.heuristicTokens),
                        metric('configuredBudget', void 0),
                      ],
                    },
                    group,
                  )
                }),
                metric('surfaceTokens', observed?.digestTokensEstimate),
                metric('nodes', surface?.nodes),
                metric('missing', surface?.missingEstimates),
                metric('pinned', surface?.pinned),
                metric('results', surface?.results),
                /* @__PURE__ */ jsx(SettingsItem, {
                  label: t('slot'),
                  children: /* @__PURE__ */ jsx('span', {
                    children: typeof request?.slot === 'string' ? request.slot : t('unknown'),
                  }),
                }),
                metric('tools', request?.toolNamesCount),
                metric('messages', request?.messageCount),
                metric('window', request?.contextWindow),
              ],
            })
          : /* @__PURE__ */ jsxs(Fragment, {
              children: [
                /* @__PURE__ */ jsx('p', { children: t('windowScope') }),
                metric('previousWindow', before?.previousContextWindow),
                metric('window', before?.contextWindow),
                metric('reserve', before?.reserveTokens),
                metric('beforeTokens', compact?.tokensBeforeEstimate),
                metric('afterTokens', compact?.tokensAfterEstimate),
                metric('replace', compact?.replaceSeq),
                /* @__PURE__ */ jsx(SettingsItem, {
                  label: t('range'),
                  children: /* @__PURE__ */ jsx('span', {
                    children:
                      Array.isArray(compact?.range) && compact.range.length === 2
                        ? compact.range.map((v) => number(v) ?? t('unknown')).join(' \u2013 ')
                        : t('unknown'),
                  }),
                }),
                metric('pairs', compact?.retainedPairs),
                metric('pins', compact?.retainedPins),
                metric('offload', compact?.offloadedBytes),
                metric('omissions', compact?.omissions),
                /* @__PURE__ */ jsx('p', { children: t('retention') }),
              ],
            }),
      ],
    })
  }
  const off = []
  try {
    off.push(
      workbenchPanels.register({
        id: 'context-doctor',
        edge: 'right',
        order: 75,
        titleKey: 'context-doctor.title',
        component: Panel,
      }),
    )
    off.push(ctx.locale.register('context-doctor', catalog))
  } catch (error) {
    for (const dispose of off.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of off.reverse()) dispose()
  }
}

export { apply, inject }
