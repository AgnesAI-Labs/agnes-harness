import { Tag } from '@agnes/web-ui'
import React from 'react'

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
          const labels = {
            awaiting_approval: ['等待人工审批', 'Awaiting human approval'],
            pending: ['待执行', 'Pending'],
            planned: ['待执行', 'Planned'],
            running: ['执行中', 'Running'],
            success: ['已完成', 'Completed'],
            completed: ['已完成', 'Completed'],
            error: ['未成功', 'Failed'],
            failed: ['未成功', 'Failed'],
            refused: ['已拒绝', 'Refused'],
            cancelled: ['已取消', 'Cancelled'],
          }
          const state = labels[block?.status]
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
                {
                  tone: ['error', 'failed'].includes(block?.status)
                    ? 'bad'
                    : block?.status === 'awaiting_approval'
                      ? 'warn'
                      : 'info',
                },
                state ? state[zh ? 0 : 1] : zh ? '待执行' : 'Pending',
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
