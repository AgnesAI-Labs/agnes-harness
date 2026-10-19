import { PageHeader } from '@agnes/web-ui'
import React from 'react'
import { BatchDrawer, button, h } from './components.js'
import { words } from './locale.js'
import { Audit, Batches, Deviations, EM, Home, Release } from './pages.js'

const pages = { home: Home, batches: Batches, deviations: Deviations, em: EM, release: Release, audit: Audit }
export function apply(ctx, config) {
  const offLocale = ctx.locale.register(
    'pharma-quality',
    Object.fromEntries(
      Object.entries(words).map(([locale, values]) => [
        locale,
        Object.fromEntries(Object.keys(pages).map((name) => [`pharma.page.${name}`, values[name]])),
      ]),
    ),
  )
  ctx.effect(() => offLocale)
  const services = ctx.profile.services
  const pendingKey = JSON.stringify(['pharma-operation', config.binding, config.revision])
  const pending = () => JSON.parse(window.sessionStorage.getItem(pendingKey) ?? 'null')
  function Page({ name }) {
    const locale = React.useSyncExternalStore(ctx.locale.subscribe, () => ctx.locale.locale)
    const t = words[locale] ?? words.en
    const [data, setData] = React.useState(null),
      [error, setError] = React.useState('')
    const [busy, setBusy] = React.useState(true),
      [operation, setOperation] = React.useState(pending)
    const [selectedBatch, setSelectedBatch] = React.useState(null)
    const live = React.useRef(false),
      locked = React.useRef(false)
    const load = React.useCallback(async () => {
      const next = await services.query('pharma.snapshot', {})
      if (live.current) setData(next)
    }, [])
    const request = React.useCallback(
      async (work) => {
        if (locked.current) return
        locked.current = true
        if (live.current) {
          setBusy(true)
          setError('')
        }
        try {
          await work()
        } catch (e) {
          if (live.current) setError(e instanceof Error ? e.message : t.failed)
        } finally {
          locked.current = false
          if (live.current) setBusy(false)
        }
      },
      [t.failed],
    )
    const receipt = React.useCallback(
      async (result) => {
        const final = ['completed', 'refused', 'cancelled', 'failed'].includes(result.state)
        if (final) window.sessionStorage.removeItem(pendingKey)
        if (!live.current) return
        if (final) setOperation(null)
        if (result.state === 'completed') await load()
        else
          setError(
            result.state === 'approval-required'
              ? t.operationPending
              : `${t.operationUnknown} (${result.state})`,
          )
      },
      [load, t.operationPending, t.operationUnknown],
    )
    const check = React.useCallback(
      async (resume = false) => {
        const saved = pending()
        if (!saved) return
        let next = await services.readOperation(saved.service, saved.operationId)
        if (resume && next.state === 'approval-required')
          next = await services.effect(saved.service, saved.input, { operationId: saved.operationId })
        await receipt(next)
      },
      [receipt],
    )
    React.useEffect(() => {
      live.current = true
      void request(async () => {
        await check()
        await load()
      })
      return () => {
        live.current = false
      }
    }, [check, load, request])
    function mutate(service, input) {
      if (locked.current || pending() || !data) return
      const saved = {
        service,
        input: { ...input, expectedRevision: data.plant.revision },
        operationId: crypto.randomUUID(),
      }
      void request(async () => {
        window.sessionStorage.setItem(pendingKey, JSON.stringify(saved))
        setOperation(saved)
        await receipt(await services.effect(service, saved.input, { operationId: saved.operationId }))
      })
    }
    const Component = pages[name]
    const batch = data?.plant.batches.find((b) => b.id === selectedBatch)
    return h(
      'main',
      { className: 'ph-app', 'data-pharma-page': name },
      h('div', { className: 'ph-eyebrow' }, 'SABLELEAF / QUALITY OPERATIONS'),
      h(PageHeader, {
        title: t[name],
        description: t.subtitle,
        actions: button(t.refresh, () => void request(load), { disabled: busy }),
      }),
      h(
        'div',
        { className: 'ph-context' },
        h('span', null, t.synthetic),
        data &&
          h('span', null, `${t.revision} ${data.plant.revision} · ${data.plant.batches.length} ${t.records}`),
      ),
      busy && h('p', { role: 'status' }, t.loading),
      error && h('p', { role: 'alert', className: 'ph-error' }, error),
      operation &&
        h(
          'section',
          { className: 'ph-operation' },
          h('p', null, t.operationPending),
          h('small', null, `${t.operationId}: ${operation.operationId}`),
          button(t.operationCheck, () => void request(() => check(true)), { disabled: busy }),
        ),
      data &&
        h(Component, {
          data,
          t,
          locale,
          selectBatch: setSelectedBatch,
          mutate,
          busy: busy || Boolean(operation),
        }),
      batch &&
        h(BatchDrawer, {
          batch,
          deviations: data.plant.deviations.filter(
            (d) => d.batch === batch.id || d.impact.includes(batch.id),
          ),
          dossier: data.dossiers.find((x) => x.batch === batch.id),
          t,
          locale,
          close: () => setSelectedBatch(null),
          mutate,
          busy: busy || Boolean(operation),
        }),
    )
  }
  for (const name of Object.keys(pages))
    ctx.homeEntries.register({
      id: `pharma-${name}`,
      placement: 'primary',
      icon: {
        home: 'activity',
        batches: 'file-text',
        deviations: 'circle-alert',
        em: 'activity',
        release: 'circle-check',
        audit: 'history',
      }[name],
      titleKey: `pharma.page.${name}`,
      order: 20 + Object.keys(pages).indexOf(name),
      component: () => h(Page, { name }),
    })
}
