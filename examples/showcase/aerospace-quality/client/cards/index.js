import { Tag } from '@agnes/web-ui'
import React from 'react'
import { confirmationLabel } from '../i18n.js'

const h = React.createElement
const titles = {
  aero_investigate: ['异常调查证据', 'Anomaly investigation'],
  aero_mrb_draft: ['MRB 处置草案', 'MRB disposition draft'],
  aero_decide: ['质量决策回执', 'Quality decision receipt'],
  aero_change_review: ['更改影响评审', 'Change impact review'],
  aero_report: ['证据报告', 'Evidence report'],
}

/** Read the full durable result; the transcript preview is deliberately truncated. */
function useOutput(ctx, block) {
  const readiness = React.useSyncExternalStore(
    ctx.session.readiness.subscribe,
    ctx.session.readiness.getSnapshot,
  )
  const [value, setValue] = React.useState()
  React.useEffect(() => {
    let live = true
    setValue(undefined)
    if (!['ready', 'history-only'].includes(readiness.status) || block?.resultSeq === undefined) return
    const session = ctx.agnes.sessions.get(readiness.sessionId)
    void session.readToolDetail(block.seq, block.resultSeq).then(
      (detail) => {
        if (!live || ctx.session.readiness.getSnapshot() !== readiness) return
        const output = detail.result?.structured
        if (output) setValue(output)
        else {
          try {
            setValue(
              JSON.parse(
                detail.result?.content
                  ?.filter((item) => item.type === 'text')
                  .map((item) => item.text)
                  .join('') ?? '',
              ),
            )
          } catch {
            /* Retain the honest preview fallback. */
          }
        }
      },
      () => {
        /* The Host tool record remains the recovery path. */
      },
    )
    return () => {
      live = false
    }
  }, [ctx, readiness, block?.seq, block?.resultSeq])
  if (value) return value
  try {
    return JSON.parse(block?.resultPreview ?? '')
  } catch {
    return undefined
  }
}
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
          const output = useOutput(ctx, block)
          const data = output?.data
          return h(
            'section',
            {
              className: 'aero-evidence-card',
              'aria-label': zh ? '质量证据回执' : 'Quality evidence receipt',
            },
            h(
              'div',
              { className: 'aero-row' },
              h('strong', null, titles[name][zh ? 0 : 1]),
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
            data?.signature &&
              h(
                'p',
                { 'data-business-confirmation': true },
                confirmationLabel(data.signature.confirmationMode, data.signature.signer, locale),
              ),
            data?.peakA !== undefined
              ? h(
                  React.Fragment,
                  null,
                  h('p', null, `${data.anomalyId} · ${data.campaign} · ${data.configuration} · ${data.lot}`),
                  h(
                    'p',
                    null,
                    h(Tag, { tone: 'bad' }, `${zh ? '峰值' : 'Peak'} ${data.peakA.toFixed(3)} A`),
                    ` / ${zh ? '上限' : 'Upper limit'} ${data.limitA.toFixed(2)} A · ${data.windowMinutes.join('–')} min`,
                  ),
                  h('p', null, data.hypothesis?.[locale] ?? data.hypothesis?.en),
                  h('p', null, `${zh ? '受控证据' : 'Controlled evidence'}: ${data.evidence.join(' · ')}`),
                  h(
                    'p',
                    null,
                    zh
                      ? '本结果只评估电流上限；未提供温度和真空度验收限值，不能判定其试验通过。'
                      : 'Only the current upper limit is assessed here. Temperature and pressure have no supplied acceptance limits; do not declare their tests passed.',
                  ),
                )
              : typeof data?.screeningRequired === 'boolean'
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'p',
                      null,
                      `${zh ? '受影响需求' : 'Affected requirements'}: ${data.requirements.join(' · ')}`,
                    ),
                    h('p', null, `${zh ? '复验' : 'Re-verification'}: ${data.tests.join(' · ')}`),
                    h(
                      'p',
                      null,
                      `${zh ? '规则版本' : 'Rule version'}: ${data.ruleVersion ?? '—'} · ${zh ? '追加筛选' : 'Additional screening'}: ${data.screeningRequired ? (zh ? '需要' : 'Required') : zh ? '未触发' : 'Not triggered'}`,
                    ),
                  )
                : data?.revision
                  ? h(
                      'p',
                      null,
                      `${zh ? '已记录质量决策，项目修订' : 'Quality decision recorded; programme revision'} ${data.revision}`,
                    )
                  : h(
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
