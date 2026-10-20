import { applicationIdentity, homeNavigation, openApplicationWork } from '@agnes/web-client'
import { Button, EmptyState, Icon } from '@agnes/web-ui'
import React from 'react'
import { badge, card, h, measurements, text } from './components.js'
import { confirmationLabel } from './locale.js'

export const WorkOwner = React.createContext(undefined)
export function WorkButton({ action, object, locale }) {
  const owner = React.useContext(WorkOwner)
  const app = React.useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const available =
    app?.status === 'active' && app.selection?.packageId === owner
      ? app.effective?.workbench?.actions?.find((item) => item.id === action)
      : undefined
  const titles = {
    investigate: ['调查偏差', 'Investigate deviation'],
    capa: ['起草 CAPA', 'Draft CAPA'],
    em: ['评估 EM 超限', 'Assess EM excursion'],
    review: ['批记录复核', 'Review batch record'],
    release: ['发起 QA 放行', 'Request QA release'],
  }
  return h(
    Button,
    {
      disabled: !available,
      disabledReason: available
        ? undefined
        : locale === 'zh-CN'
          ? '先采用此应用，再开始业务会话。'
          : 'Adopt this application before starting its work.',
      onClick: () => openApplicationWork(action, object),
    },
    titles[action][locale === 'zh-CN' ? 0 : 1],
  )
}
export function ObjectDossier({ data, t, locale, context }) {
  const object = context?.selection?.object
  const p = data.plant
  const deviation =
    object?.type === 'deviation'
      ? p.deviations.find((d) => d.id === object.id)
      : object?.type === 'capa'
        ? p.deviations.find((d) => d.actions.some((a) => a.id === object.id))
        : undefined
  const capa = object?.type === 'capa' ? deviation?.actions.find((a) => a.id === object.id) : undefined
  const sample = object?.type === 'em' ? p.samples.find((s) => s.id === object.id) : undefined
  const batchId = object?.type === 'batch' ? object.id : (deviation?.batch ?? sample?.batch)
  const batch = p.batches.find((b) => b.id === batchId)
  const dossier = data.dossiers.find((d) => d.batch === batchId)
  if (
    !object ||
    !['batch', 'deviation', 'capa', 'em'].includes(object.type) ||
    !batch ||
    (object.type === 'capa' && !capa)
  )
    return h(EmptyState, {
      icon: h(Icon, { name: 'file' }),
      title:
        locale === 'zh-CN'
          ? object
            ? '对象不存在或当前不可用'
            : '从业务对象或快捷操作开始工作'
          : object
            ? 'Object missing or unavailable'
            : 'Start from a business object or work action',
      description:
        locale === 'zh-CN'
          ? '档案随当前会话的工具执行更新。'
          : 'The dossier follows tool writes in this conversation.',
    })
  const room = sample && p.rooms.find((r) => r.id === sample.room)
  return h(
    'div',
    { 'data-testid': 'pharma-object-dossier' },
    h('h2', null, object.id),
    h('p', null, `${t.revision} ${p.revision}`),
    h('p', null, text(batch.product, locale)),
    badge(batch.status, t),
    deviation &&
      card(
        deviation.id,
        h(
          React.Fragment,
          null,
          badge(deviation.stage, t),
          h('p', null, text(deviation.title, locale)),
          h('p', null, deviation.cause || t.noCause),
          h('p', null, `${t.impact}: ${deviation.impact.join(', ') || '—'}`),
          ...deviation.actions
            .filter((a) => !capa || a.id === capa.id)
            .map((a) =>
              h(
                'article',
                { key: a.id },
                h('h3', null, a.id),
                h('p', null, text(a.text, locale)),
                h('p', null, `${a.owner} · ${a.due}`),
                h('p', null, a.evidence || '—'),
                h('p', null, `${t.effectiveness}: ${a.effective ? t.pass : t.fail}`),
                h(WorkButton, { action: 'capa', object: { type: 'capa', id: a.id }, locale }),
              ),
            ),
          h(WorkButton, { action: 'capa', object: { type: 'deviation', id: deviation.id }, locale }),
        ),
      ),
    sample &&
      card(
        t.em,
        h(
          React.Fragment,
          null,
          h('p', null, `${sample.room} · ${sample.at}`),
          h(
            'p',
            null,
            `CFU/m³: ${sample.viable} · ${t.alert}: ${room.viableAlert} · ${t.action}: ${room.viableAction}`,
          ),
          h(
            'p',
            null,
            `≥0.5 µm / m³: ${sample.particles} · ${t.alert}: ${room.particleAlert} · ${t.action}: ${room.particleAction}`,
          ),
          h('p', null, `${t.batch}: ${sample.batch}`),
          h('p', null, sample.disposition === 'assessed' ? t.assessed : t.emPending),
          h('p', null, sample.evidence || '—'),
        ),
      ),
    object.type === 'batch' &&
      card(
        t.step,
        measurements(
          batch.steps.flatMap((s) => s.cpp),
          locale,
          t,
        ),
      ),
    object.type === 'batch' && card(t.qc, measurements(batch.qc, locale, t)),
    card(
      t.checklist,
      h(
        'ul',
        { className: 'ph-checklist' },
        ...dossier.rows.map((r) =>
          h(
            'li',
            { key: r.key },
            h('span', null, text(r.title, locale)),
            h('strong', null, r.pass ? t.pass : t.fail),
          ),
        ),
      ),
    ),
    ...(dossier.evidence?.recordApprovals ?? []).map((entry) =>
      h(
        'p',
        { key: entry.approvalId, 'data-business-confirmation': true },
        confirmationLabel(entry.confirmationMode, entry.recordedBy, locale),
      ),
    ),
    batch.certificate &&
      card(
        t.certificate,
        h(
          React.Fragment,
          null,
          h('h3', null, batch.certificate.id),
          h(
            'p',
            { 'data-business-confirmation': true },
            confirmationLabel(batch.certificate.confirmationMode, batch.certificate.signer, locale),
          ),
          h('p', null, batch.certificate.meaning),
          h('p', null, `${t.approval}: ${batch.certificate.approvalId}`),
        ),
      ),
    h(WorkButton, { action: sample ? 'em' : deviation ? 'investigate' : 'review', object, locale }),
    h(WorkButton, { action: 'release', object: { type: 'batch', id: batch.id }, locale }),
  )
}
export function Tasks({ data, t, locale }) {
  return h(
    'div',
    null,
    card(
      t.deviations,
      h(
        'div',
        { className: 'ph-work-list' },
        ...data.plant.deviations
          .filter((d) => d.stage !== 'closed')
          .map((d) =>
            h(
              'article',
              { key: d.id },
              h('strong', null, d.id),
              h('p', null, text(d.title, locale)),
              badge(d.stage, t),
              h(WorkButton, { action: 'investigate', object: { type: 'deviation', id: d.id }, locale }),
            ),
          ),
      ),
    ),
    card(
      t.releaseQueue,
      h(
        'div',
        { className: 'ph-work-list' },
        ...data.plant.batches
          .filter((b) => b.status === 'review')
          .map((b) =>
            h(
              'article',
              { key: b.id },
              h('strong', null, b.id),
              h(WorkButton, { action: 'release', object: { type: 'batch', id: b.id }, locale }),
            ),
          ),
      ),
    ),
  )
}
export function ModuleLinks({ t }) {
  return h(
    'nav',
    { className: 'ph-module-links', 'aria-label': t.home },
    ...['batches', 'deviations', 'em', 'release', 'audit'].map((name) =>
      h(Button, { key: name, onClick: () => homeNavigation.open(`pharma-${name}`) }, t[name]),
    ),
  )
}
