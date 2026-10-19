import { Field, Select, SettingsTextArea } from '@agnes/web-ui'
import React from 'react'
import { badge, button, card, chart, column, h, table, text } from './components.js'
import { meaning } from './locale.js'

const age = (opened) =>
  Math.max(0, Math.floor((Date.parse('2024-10-20T23:59:59Z') - Date.parse(opened)) / 86400000))
export function Home({ data, t, locale, selectBatch }) {
  const { plant: p, kpi: k } = data
  const tracked = p.batches.find((batch) => batch.id === 'B-2410-017')
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'ph-kpis' },
      ...['production', 'awaiting', 'released', 'rft', 'overdue', 'excursions'].map((key, i) =>
        h(
          'section',
          { className: 'ph-kpi', key },
          h('span', null, t[key]),
          h('strong', null, `${k[key]}${key === 'rft' ? '%' : ''}`),
          h('small', null, `0${i + 1} / GMP`),
        ),
      ),
    ),
    h(
      'div',
      { className: 'ph-two' },
      card(
        t.alerts,
        h(
          'div',
          null,
          h('p', { className: 'ph-alert-copy' }, t.attention),
          tracked &&
            h('p', { className: 'ph-alert-state' }, t.currentRecord, ' · ', badge(tracked.status, t)),
          button('B-2410-017 →', () => selectBatch('B-2410-017')),
          h('p', { className: 'ph-note' }, t.demoFlow),
        ),
      ),
      card(
        t.deviationSummary,
        h(
          'div',
          { className: 'ph-severity' },
          ...['critical', 'major', 'minor'].map((c) =>
            h('div', { key: c }, badge(c, t), h('strong', null, k.deviations[c])),
          ),
        ),
      ),
    ),
    card(
      t.timeline,
      table(
        p.batches.slice(11, 21),
        [
          column(t.batch, 'id', (id) => button(id, () => selectBatch(id), { appearance: 'link' })),
          column(t.product, 'product', (x) => text(x, locale), 220),
          column(
            t.step,
            'steps',
            (steps) =>
              h(
                'div',
                { className: 'ph-timeline' },
                ...steps.map((s) =>
                  h(
                    'span',
                    {
                      key: s.id,
                      title: text(s.name, locale),
                      className: s.cpp.some((m) => m.value > m.max || m.value < m.min)
                        ? 'ph-segment ph-segment-bad'
                        : 'ph-segment',
                    },
                    text(s.name, locale),
                  ),
                ),
              ),
            420,
          ),
          column(t.status, 'status', (s) => badge(s, t)),
        ],
        t.timeline,
      ),
    ),
    h('p', { className: 'ph-note' }, t.dashboardNote),
  )
}
export function Batches({ data, t, locale, selectBatch }) {
  return h(
    React.Fragment,
    null,
    card(
      t.batches,
      table(
        data.plant.batches,
        [
          column(t.batch, 'id', (id) => button(id, () => selectBatch(id), { appearance: 'link' })),
          column(t.product, 'product', (x) => text(x, locale), 230),
          column(t.units, 'size', (n) => n.toLocaleString()),
          column(t.date, 'date', (d) => d.slice(0, 10)),
          column(t.status, 'status', (s) => badge(s, t)),
          column(t.review, 'review', (s) => badge(s, t)),
        ],
        t.batches,
        { pagination: { pageSize: 12, showSizeChanger: false } },
      ),
    ),
    card(
      t.equipmentTitle,
      table(
        data.plant.equipment,
        [
          column(t.equipment, 'id'),
          column(t.product, 'name', (x) => text(x, locale), 260),
          column(t.calibration, 'due'),
          column(t.status, 'qualification', (s) => badge(s, t)),
        ],
        t.equipmentTitle,
      ),
    ),
  )
}
export function Deviations({ data, t, locale, mutate, busy }) {
  const [evidence, setEvidence] = React.useState('')
  const [selected, setSelected] = React.useState('DEV-2410-017')
  const d = data.plant.deviations.find((x) => x.id === selected)
  return h(
    React.Fragment,
    null,
    h('p', { className: 'ph-note' }, t.ageNote),
    h(
      'div',
      { className: 'ph-board' },
      ...['open', 'investigation', 'capa', 'effectiveness', 'closed'].map((stage) =>
        h(
          'section',
          { className: 'ph-lane', key: stage },
          h(
            'h2',
            null,
            t[stage],
            h('small', null, ` ${data.plant.deviations.filter((d) => d.stage === stage).length}`),
          ),
          ...data.plant.deviations
            .filter((d) => d.stage === stage)
            .map((dev) =>
              h(
                'article',
                { className: dev.id === selected ? 'ph-ticket ph-selected' : 'ph-ticket', key: dev.id },
                button(dev.id, () => setSelected(dev.id), { appearance: 'link' }),
                h('p', null, text(dev.title, locale)),
                badge(dev.severity, t),
                h('small', null, `${dev.batch} · ${age(dev.opened)} ${t.days}`),
              ),
            ),
        ),
      ),
    ),
    d &&
      card(
        `${d.id} · ${t.cause}`,
        h(
          'div',
          null,
          h('p', null, d.cause || t.noCause),
          h('p', null, `${t.impact}: ${d.impact.join(', ') || '—'}`),
          d.why.length > 0 &&
            h('div', null, h('h3', null, t.why), h('ol', null, ...d.why.map((x) => h('li', { key: x }, x)))),
          table(
            d.actions,
            [
              column(t.actions, 'text', (x) => text(x, locale), 360),
              column(t.owner, 'owner'),
              column(t.due, 'due'),
              column(t.evidence, 'evidence', undefined, 250),
              column(t.effectiveness, 'effective', (x) => (x ? t.pass : t.fail)),
            ],
            t.actions,
          ),
          d.id === 'DEV-2410-017' &&
            d.stage !== 'closed' &&
            h(
              'div',
              { className: 'ph-form' },
              h('p', { className: 'ph-note' }, t.evidenceHint),
              d.stage === 'open'
                ? button(
                    t.investigateAction,
                    () => mutate('pharma.change', { action: 'investigate', batch: d.batch }),
                    { disabled: busy },
                  )
                : h(
                    React.Fragment,
                    null,
                    h(
                      Field,
                      { label: t.evidence },
                      h(SettingsTextArea, {
                        value: evidence,
                        maxLength: 2000,
                        rows: 3,
                        onChange: (e) => setEvidence(e.target.value),
                        disabled: busy,
                      }),
                    ),
                    button(
                      t.advanceAction,
                      () => mutate('pharma.change', { action: 'advance', batch: d.batch, evidence }),
                      { disabled: busy || evidence.trim().length < 12 },
                    ),
                  ),
            ),
        ),
      ),
  )
}
export function EM({ data, t, locale }) {
  const p = data.plant,
    room = p.rooms.find((r) => r.id === 'C-201')
  const rows = Array.from({ length: 20 }, (_, i) => {
    const samples = p.samples.filter((s) => s.room === room.id && Number(s.at.slice(8, 10)) === i + 1)
    return {
      day: `10/${i + 1}`,
      value: Math.max(...samples.map((s) => s.viable)),
      particles: Math.max(...samples.map((s) => s.particles)),
      alert: room.viableAlert,
      action: room.viableAction,
    }
  })
  const excursions = p.samples.filter((s) => {
    const r = p.rooms.find((r) => r.id === s.room)
    return s.viable > r.viableAlert || s.particles > r.particleAlert
  })
  return h(
    React.Fragment,
    null,
    h('p', { className: 'ph-note' }, t.emNote),
    card(
      t.map,
      h(
        'div',
        { className: 'ph-rooms' },
        ...p.rooms.map((r) =>
          h(
            'section',
            { className: `ph-room ph-grade-${r.grade}`, key: r.id },
            h('strong', null, `${r.id} · ${r.grade}`),
            h('span', null, text(r.name, locale)),
            h('small', null, `CFU/m³: ${r.viableAlert} / ${r.viableAction}`),
          ),
        ),
      ),
    ),
    h(
      'div',
      { className: 'ph-two' },
      card(t.trend, chart(t.trend, rows, t)),
      card(
        t.particleTrend,
        chart(
          t.particleTrend,
          rows.map((r) => ({ ...r, alert: room.particleAlert, action: room.particleAction })),
          t,
          true,
        ),
      ),
    ),
    card(
      t.excursions,
      table(
        excursions,
        [
          column('ID', 'id'),
          column(t.room, 'room'),
          column(t.when, 'at', undefined, 200),
          column('CFU/m³', 'viable'),
          column(t.alert, 'room', (id) => p.rooms.find((r) => r.id === id).viableAlert),
          column(t.action, 'room', (id) => p.rooms.find((r) => r.id === id).viableAction),
          column(t.status, 'disposition', (s) => (s === 'assessed' ? t.assessed : t.emPending)),
        ],
        t.excursions,
      ),
    ),
  )
}
export function Release({ data, t, locale, mutate, busy }) {
  const [id, setId] = React.useState('B-2410-017')
  const check = data.dossiers.find((x) => x.batch === id),
    b = data.plant.batches.find((x) => x.id === id)
  const certificate = check.certificate
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'ph-release-grid' },
      card(
        t.releaseQueue,
        h(
          'div',
          null,
          h(
            Field,
            { label: t.batch },
            h(Select, {
              value: id,
              onChange: setId,
              options: data.plant.batches
                .filter((b) => b.status !== 'production')
                .map((b) => ({ value: b.id, label: b.id })),
            }),
          ),
          h('p', null, text(b.product, locale)),
          badge(certificate ? 'released' : check.ready ? 'ready' : 'blocked', t),
          h('p', { className: 'ph-note' }, `${t.revision}: ${check.revision}`),
          h('h3', null, t.signature),
          h('p', { className: 'ph-meaning' }, t.localizedMeaning),
          !certificate &&
            button(t.requestRelease, () => mutate('pharma.release', { batch: id, meaning }), {
              appearance: 'primary',
              disabled: busy || !check.ready,
              disabledReason: !check.ready ? t.blocked : undefined,
            }),
        ),
      ),
      card(
        t.checklist,
        h(
          'ul',
          { className: 'ph-checklist' },
          ...check.rows.map((r) =>
            h(
              'li',
              { key: r.key },
              h('span', null, text(r.title, locale)),
              h(
                'strong',
                { className: r.pass ? 'ph-pass' : 'ph-fail' },
                `${r.pass ? '✓' : '○'} ${r.pass ? t.pass : t.fail}`,
              ),
            ),
          ),
        ),
      ),
    ),
    certificate &&
      card(
        t.certificate,
        h(
          'div',
          { className: 'ph-certificate' },
          h('p', { className: 'ph-eyebrow' }, 'SABLELEAF / GMP'),
          h('h2', null, certificate.id),
          h('p', null, `${t.signer}: ${certificate.signer}`),
          h('p', null, `${t.when}: ${certificate.at}`),
          h('p', null, certificate.meaning),
          h('p', null, `${t.approval}: ${certificate.approvalId}`),
          h('small', null, certificate.subjectRevision),
        ),
      ),
    card(t.reports, h('p', null, t.reportsText)),
  )
}
export function Audit({ data, t }) {
  return h(
    React.Fragment,
    null,
    h('p', { className: 'ph-note' }, t.auditNote),
    card(
      t.audit,
      table(
        [...data.plant.audit].reverse(),
        [
          column(t.when, 'at', undefined, 200),
          column(t.actor, 'actor'),
          column(t.actionName, 'action'),
          column(t.record, 'record'),
          column(t.revision, 'toRevision'),
          column(t.reason, 'reason', undefined, 360),
          column(t.approval, 'approval', (x) => x ?? '—', 200),
          column(
            t.trace,
            'session',
            (x) => (x ? h('a', { href: `/?session=${encodeURIComponent(x)}` }, x) : t.noTrace),
            250,
          ),
        ],
        t.audit,
      ),
    ),
  )
}
