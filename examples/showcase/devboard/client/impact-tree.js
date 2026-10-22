import { Badge } from '@agnes/web-ui'
import { h } from './board.js'

/**
 * The impact of a change laid out down the requirement chain, CUS → SYS → SWR → DES / TC. The lists come
 * from the snapshot's live trace of the change; the links are the requirements' own `parent` ids. A
 * design item answering several requirements appears under each of them.
 */
export function ImpactTree({ data, change }) {
  const trace = change.trace
  if (!trace) return null
  const inSet = new Set([...trace.reqs, ...trace.tests])
  const items = data.reqs.filter((r) => r.projectId === change.projectId && inSet.has(r.id))
  const parents = (r) => (r.parent ?? []).filter((p) => inSet.has(p))
  const roots = items.filter((r) => !parents(r).length)
  const below = (id) => items.filter((r) => parents(r).includes(id))
  const node = (r, path) =>
    h(
      'li',
      { key: `${path}/${r.id}` },
      h('strong', null, r.id),
      ` ${r.title}`,
      r.module ? h('code', { style: { marginLeft: 6 } }, r.module) : null,
      r.status === 'CHANGED' ? h(Badge, { tone: 'warn', style: { marginLeft: 6 } }, '已变更') : null,
      below(r.id).length
        ? h(
            'ul',
            null,
            below(r.id).map((c) => node(c, `${path}/${r.id}`)),
          )
        : null,
    )
  return h(
    'section',
    { className: 'devboard-impact', 'aria-label': `${change.id} 影响树` },
    h('h2', null, '影响树（沿追溯链推算）'),
    roots.length
      ? h(
          'ul',
          null,
          roots.map((r) => node(r, '')),
        )
      : h('p', { className: 'devboard-muted' }, '没有可追溯的下游条目'),
    h(
      'p',
      { className: 'devboard-muted' },
      `受影响交付物：${trace.artifacts.join('、') || '—'}；受影响代码模块：${trace.modules.join('、') || '—'}`,
    ),
  )
}
