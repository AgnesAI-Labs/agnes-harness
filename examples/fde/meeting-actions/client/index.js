import { createElement } from 'react'

export function apply(ctx) {
  for (const key of ['fde_meeting_extract', 'fde_meeting_send']) {
    const off = ctx.slots.register(
      { name: 'tool.call.toolview', key, id: `meeting-${key}` },
      function MeetingPanel({ owner }) {
        const block = owner?.block
        return createElement(
          'section',
          { 'aria-label': 'Meeting actions' },
          createElement('strong', null, 'Meeting actions'),
          createElement('p', { role: 'status' }, block?.status ?? 'planned'),
          createElement(
            'pre',
            { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
            block?.resultPreview ?? block?.summary ?? 'Waiting for transcript evidence',
          ),
        )
      },
    )
    ctx.effect(() => off)
  }
}
