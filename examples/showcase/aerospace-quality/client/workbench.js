import { applicationIdentity, homeNavigation, openApplicationWork } from '@agnes/web-client'
import { Button, EmptyState, Icon, Tag } from '@agnes/web-ui'
import React from 'react'
import { section, status } from './views.js'

const h = React.createElement
export const WorkOwner = React.createContext(undefined)
export function WorkButton({ action, object, t, label, appearance }) {
  const owner = React.useContext(WorkOwner)
  const application = React.useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const available = application?.status === 'active' && application.selection?.packageId === owner && application.effective?.workbench?.actions?.some((item) => item.id === action)
  const labels = {
    investigate: ['调查', 'Investigate'],
    mrb: ['起草处置', 'Draft disposition'],
    configuration: ['发起评审', 'Start review'],
    report: ['生成报告', 'Generate report'],
  }
  return h(Button, { disabled: !available, disabledReason: available ? undefined : t.choose('先采用此应用，再开始业务会话。', 'Adopt this application before starting its work.'), ...(appearance ? { appearance } : {}), onClick: () => openApplicationWork(action, object) }, label ?? labels[action][t.zh ? 0 : 1])
}
export function ObjectDossier({ data, t, context }) {
  const object = context?.selection?.object
  if (!object)
    return h(EmptyState, {
      icon: h(Icon, { name: 'file' }),
      title: t.choose('从业务对象或快捷操作开始工作', 'Start from a business object or work action'),
      description: t.choose(
        '选择调查、处置或更改评审，档案会跟随会话更新。',
        'Choose investigation, disposition or change review; the dossier follows the conversation.',
      ),
    })
  const record =
    object.type === 'anomaly'
      ? data.anomaly.id === object.id ? data.anomaly : undefined
      : object.type === 'ncr'
        ? data.ncrs.find((r) => r.id === object.id)
        : object.type === 'ecr'
          ? data.ecrs.find((r) => r.id === object.id)
          : object.type === 'zeroing'
            ? data.zeroing.find((r) => r.id === object.id)
            : undefined
  if (!record)
    return h(EmptyState, {
      icon: h(Icon, { name: 'file' }),
      title: t.choose('对象不存在或当前不可用', 'Object missing or unavailable'),
      description: object.id,
    })
  return h(
    'div',
    { className: 'aero-dossier', 'data-testid': 'aero-object-dossier' },
    h('h2', null, object.id),
    h(Tag, { tone: 'info' }, `${t.choose('项目修订', 'Programme revision')} ${data.revision}`),
    record.status && status(t, record.status),
    record.title && h('h3', null, t.value(record.title)),
    record.peakA !== undefined &&
      h(
        'p',
        null,
        `${t.choose('峰值 / 上限', 'Peak / limit')} ${record.peakA.toFixed(3)} / ${record.limitA.toFixed(2)} A`,
      ),
    record.hypothesis && h('p', null, t.value(record.hypothesis)),
    record.rationale && h('p', null, record.rationale),
    record.disposition && h('p', null, `${t.choose('处置', 'Disposition')}: ${t.status(record.disposition)}`),
    record.evidence &&
      section(t.evidence, h('ul', null, ...record.evidence.map((id) => h('li', { key: id }, id)))),
    record.criteria &&
      section(
        t.choose('归零准则', 'Closure criteria'),
        h(
          'ul',
          null,
          ...record.criteria.map((c) =>
            h('li', { key: c.id }, `${c.id} · ${t.value(c.title)} · ${c.accepted ? '✓' : '—'}`),
          ),
        ),
      ),
    h(WorkButton, {
      action:
        object.type === 'anomaly'
          ? 'investigate'
          : object.type === 'ncr'
            ? 'mrb'
            : object.type === 'ecr'
              ? 'configuration'
              : 'report',
      object,
      t,
    }),
    h(
      'p',
      null,
      t.choose(
        '证据与状态随工具执行更新；正式决定经宿主签署流程处理，回执记录确认方式。',
        'Evidence and state update as tools run; consequential decisions use the Host signature path and receipts record the confirmation mode.',
      ),
    ),
  )
}
export function Tasks({ data, t }) {
  const groups = [
    ['ncr', 'mrb', data.ncrs.filter((r) => ['open', 'review'].includes(r.status))],
    ['ecr', 'configuration', data.ecrs.filter((r) => ['open', 'draft', 'review'].includes(r.status))],
    ['zeroing', 'report', data.zeroing.filter((r) => r.status !== 'closed')],
  ]
  return h(
    'div',
    null,
    h(
      'p',
      null,
      t.choose(
        '选择对象开展工作，会话右侧可签署当前请求。',
        'Choose an object to work on; sign the current request beside the conversation.',
      ),
    ),
    ...groups.map(([type, action, rows]) =>
      section(
        type.toUpperCase(),
        h(
          'div',
          { className: 'aero-task-list' },
          ...rows.map((r) =>
            h(
              'article',
              { key: r.id },
              h('strong', null, r.id),
              h('span', { className: 'aero-task-title' }, r.title ? t.value(r.title) : ''),
              status(t, r.status),
              h(WorkButton, { action, object: { type, id: r.id }, t }),
            ),
          ),
        ),
      ),
    ),
    h(
      Button,
      { onClick: () => homeNavigation.open('aero-zeroing') },
      t.choose('查看归零与规则', 'View closure and rules'),
    ),
  )
}
