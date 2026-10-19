import React from 'react'
import { Tag } from '@agnes/web-ui'
const h = React.createElement
export function apply(ctx) {
  for (const name of ['pharma_inspect', 'pharma_dossier', 'pharma_record', 'pharma_release']) {
    const remove = ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register(
        { name: 'tool.call.toolview', key: name, id: `${name}-evidence` },
        function EvidenceCard({ owner }) {
          const locale = React.useSyncExternalStore(ctx.locale.subscribe, () => ctx.locale.locale)
          const zh = locale === 'zh-CN',
            block = owner?.block
          let output
          try {
            output = JSON.parse(block?.resultPreview ?? '')
          } catch {
            /* Truncated preview retains its honest text fallback. */
          }
          const check = output?.dossier ?? output
          return h(
            'section',
            { className: 'ph-evidence-card', 'aria-label': zh ? '质量证据' : 'Quality evidence' },
            h('strong', null, output?.batch ?? name),
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
