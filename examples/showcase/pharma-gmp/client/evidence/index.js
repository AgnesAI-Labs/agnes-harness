import { Tag } from '@agnes/web-ui'
import React from 'react'
import { confirmationLabel } from '../locale.js'

const h = React.createElement

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
  for (const name of ['pharma_inspect', 'pharma_dossier', 'pharma_record', 'pharma_release']) {
    const remove = ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register(
        { name: 'tool.call.toolview', key: name, id: `${name}-evidence` },
        function EvidenceCard({ owner }) {
          const locale = React.useSyncExternalStore(ctx.locale.subscribe, () => ctx.locale.locale)
          const zh = locale === 'zh-CN',
            block = owner?.block
          const output = useOutput(ctx, block)
          const check = output?.dossier ?? output
          const proofs = output?.signature
            ? [output.signature]
            : [
                ...(check?.evidence?.recordApprovals ?? []).map((entry) => ({
                  ...entry,
                  signer: entry.recordedBy,
                })),
                ...(check?.certificate ? [check.certificate] : []),
              ]
          return h(
            'section',
            { className: 'ph-evidence-card', 'aria-label': zh ? '质量证据' : 'Quality evidence' },
            h('strong', null, output?.batch ?? name),
            ...proofs.map((proof, i) =>
              h(
                'p',
                { key: i, 'data-business-confirmation': true },
                `${confirmationLabel(proof.confirmationMode, proof.signer, locale)} · r${proof.reviewedRevision ?? proof.dossierRevision}`,
              ),
            ),
            check?.rows
              ? h(
                  'ul',
                  null,
                  ...check.rows.map((row) =>
                    h(
                      'li',
                      { key: row.key },
                      h(Tag, { tone: row.pass ? 'info' : 'bad' }, row.pass ? '✓' : '○'),
                      ' ',
                      row.title?.[locale] ?? row.title?.en,
                    ),
                  ),
                )
              : output?.findings
                ? h(
                    React.Fragment,
                    null,
                    h('p', null, `${zh ? '档案版本' : 'Dossier revision'} ${output.revision}`),
                    h(
                      'ul',
                      null,
                      ...output.findings.map((finding) =>
                        h(
                          'li',
                          { key: `${finding.code}:${finding.source}` },
                          h(Tag, { tone: 'bad' }, finding.code),
                          ' ',
                          finding.text?.[locale] ?? finding.text?.en,
                          ' · ',
                          finding.source,
                        ),
                      ),
                    ),
                    ...output.em.map((sample) => {
                      const room = output.rooms?.find((row) => row.id === sample.room)
                      return h(
                        'p',
                        { key: sample.id },
                        h(Tag, { tone: sample.viable > room?.viableAction ? 'bad' : 'warn' }, sample.id),
                        ` ${sample.room} · ${sample.viable} CFU/m³ · ${zh ? '警戒 / 行动限' : 'Alert / action'} ${room?.viableAlert ?? '—'} / ${room?.viableAction ?? '—'}`,
                      )
                    }),
                    h(
                      'p',
                      null,
                      `${zh ? '关联批次' : 'Related batches'}: ${output.relatedBatches.join(' · ')}`,
                    ),
                    h('p', null, output.hypothesis?.[locale] ?? output.hypothesis?.en),
                  )
                : h(
                    'pre',
                    null,
                    block?.resultPreview ??
                      block?.summary ??
                      (zh ? '等待工具证据' : 'Waiting for tool evidence'),
                  ),
            h(
              'small',
              null,
              zh
                ? '使用宿主工具记录查看完整证据和溯源。'
                : 'Open the Host tool record for complete evidence and provenance.',
            ),
          )
        },
      ),
    )
    ctx.effect(() => remove)
  }
}
