import React from 'react'
import { Tag } from '@agnes/web-ui'
const h = React.createElement
export function apply(ctx) {
  for (const name of [
    'aero_investigate',
    'aero_mrb_draft',
    'aero_decide',
    'aero_change_review',
    'aero_report',
  ]) {
    const remove = ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register(
        { name: 'tool.call.toolview', key: name, id: `${name}-evidence` },
        function EvidenceCard({ owner }) {
          const locale = React.useSyncExternalStore(ctx.locale.subscribe, () => ctx.locale.locale)
          const zh = locale === 'zh-CN',
            block = owner?.block
          return h(
            'section',
            {
              className: 'aero-evidence-card',
              'aria-label': zh ? '质量证据回执' : 'Quality evidence receipt',
            },
            h(
              'div',
              { className: 'aero-row' },
              h('strong', null, name),
              h(
                Tag,
                { tone: block?.status === 'error' ? 'bad' : 'info' },
                block?.status ?? (zh ? '待执行' : 'Pending'),
              ),
            ),
            h(
              'pre',
              null,
              block?.resultPreview ??
                block?.summary ??
                (zh ? '等待宿主回执。' : 'Waiting for the Host receipt.'),
            ),
            h(
              'small',
              null,
              zh
                ? '受控证据 · 可在执行记录查看来源与审批'
                : 'Controlled evidence · Inspect execution records for provenance and approval',
            ),
          )
        },
      ),
    )
    ctx.effect(() => remove)
  }
}
