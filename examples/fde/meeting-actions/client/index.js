import { createElement } from 'react'

/** A truncated preview is never exported as if it were the complete document. */
export function markdownDownload(block) {
  if (block?.status !== 'completed') return null
  try {
    const data = JSON.parse(block.resultPreview)
    if (data.filename !== 'meeting-actions.md' || typeof data.markdown !== 'string') return null
    return {
      href: `data:text/markdown;charset=utf-8,${encodeURIComponent(data.markdown)}`,
      download: data.filename,
    }
  } catch {
    return null
  }
}
export function apply(ctx) {
  for (const key of ['fde_meeting_extract', 'fde_meeting_export', 'fde_meeting_send']) {
    const off = ctx.slots.register(
      { name: 'tool.call.toolview', key, id: `meeting-${key}` },
      function MeetingPanel({ owner }) {
        const block = owner?.block,
          link = key === 'fde_meeting_export' ? markdownDownload(block) : null
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
          link ? createElement('a', link, 'Download markdown') : null,
        )
      },
    )
    ctx.effect(() => off)
  }
}
