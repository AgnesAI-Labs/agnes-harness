import React from 'react'
import { Button, Chart, Drawer, Table, Tag } from '@agnes/web-ui'
export const h = React.createElement
export const card = (title, children, key) =>
  h('section', { className: 'ph-card', key }, h('h2', null, title), children)
export const text = (value, locale) => value?.[locale] ?? value?.en ?? String(value ?? '')
export const badge = (value, t) =>
  h(
    Tag,
    {
      tone: ['critical', 'blocked', 'suspended', 'findings', 'action'].includes(value)
        ? 'bad'
        : ['major', 'pending', 'open', 'alert', 'review'].includes(value)
          ? 'warn'
          : 'info',
    },
    t[value] ?? value,
  )
export const button = (label, onClick, props = {}) => h(Button, { onClick, ...props }, label)
export const table = (rows, columns, caption, props = {}) =>
  h(Table, { rowKey: 'id', dataSource: rows, columns, caption, captionRepeatsHeading: true, ...props })
export const column = (title, dataIndex, render, width = 150) => ({
  title,
  dataIndex,
  key: dataIndex,
  width,
  ...(render ? { render } : {}),
})
export const chart = (title, rows, t, particle = false) =>
  h(Chart, {
    title,
    chartType: 'line',
    categoryKey: t.date,
    dataLabel: t.source,
    rows: rows.map((row) => ({ ...row, [t.date]: row.day })),
    series: [
      { key: particle ? 'particles' : 'value', label: t.value },
      { key: 'alert', label: t.alert },
      { key: 'action', label: t.action },
    ],
  })
export function measurements(rows, locale, t) {
  return h(
    'div',
    { className: 'ph-measurements' },
    ...rows.map((m) =>
      h(
        'div',
        { key: m.id, className: m.value < m.min || m.value > m.max ? 'ph-measure ph-out' : 'ph-measure' },
        h('span', null, text(m.name, locale)),
        h('strong', null, `${m.value} ${m.unit}`),
        h('small', null, `${m.min}–${m.max} ${m.unit}`),
        h('small', null, m.source),
      ),
    ),
  )
}
export function BatchDrawer({ batch, dossier, deviations, t, locale, close, mutate, busy }) {
  if (!batch) return null
  return h(
    Drawer,
    {
      open: true,
      title: batch.id,
      description: text(batch.product, locale),
      onClose: close,
      size: 'min(760px, 100vw)',
    },
    h('p', { className: 'ph-note' }, t.original),
    card(
      t.step,
      h(
        'ol',
        { className: 'ph-steps' },
        ...batch.steps.map((s) =>
          h(
            'li',
            { key: s.id },
            h(
              'div',
              { className: 'ph-step-head' },
              h('strong', null, text(s.name, locale)),
              h('span', null, `${s.equipment} · ${s.room}`),
            ),
            measurements(s.cpp, locale, t),
            h(
              'small',
              null,
              `${t.operator}: ${s.operator.actor} · ${s.operator.at} / ${s.verifier?.actor ?? '—'} · ${s.verifier?.at ?? '—'}`,
            ),
          ),
        ),
      ),
    ),
    card(
      t.deviations,
      h(
        'ul',
        null,
        ...deviations.map((d) =>
          h(
            'li',
            { key: d.id },
            d.id,
            ' · ',
            text(d.title, locale),
            ' ',
            badge(d.severity, t),
            ' ',
            badge(d.stage, t),
          ),
        ),
      ),
    ),
    card(t.qc, measurements(batch.qc, locale, t)),
    card(t.retests, batch.retests.length ? measurements(batch.retests, locale, t) : h('p', null, t.noRetest)),
    card(
      t.findingsTitle,
      dossier.findings.length
        ? h(
            'ul',
            null,
            ...dossier.findings.map((f, i) =>
              h(
                'li',
                { key: `${f.source}-${i}` },
                badge(f.severity, t),
                ' ',
                text(f.text, locale),
                h('small', null, ` · ${f.source}`),
              ),
            ),
          )
        : h('p', null, t.noFindings),
    ),
    batch.status !== 'released' &&
      button(t.reviewAction, () => mutate('pharma.change', { action: 'review', batch: batch.id }), {
        disabled: busy,
      }),
  )
}
