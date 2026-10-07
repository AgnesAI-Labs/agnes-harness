import { createElement } from 'react'
export function apply(ctx) {
  for (const key of ['fde_support_ticket', 'fde_support_classify', 'fde_support_send']) {
    const off = ctx.slots.register(
      { name: 'tool.call.toolview', key, id: `triage-${key}` },
      function TriagePanel({ owner }) {
        const block = owner?.block
        return createElement(
          'section',
          { 'aria-label': 'Support triage' },
          createElement('strong', null, 'Support triage'),
          createElement('p', { role: 'status' }, block?.status ?? 'planned'),
          createElement(
            'pre',
            { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
            block?.resultPreview ?? block?.summary ?? 'Waiting for evidence',
          ),
        )
      },
    )
    ctx.effect(() => off)
  }
}
