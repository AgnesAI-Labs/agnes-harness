import { createElement } from 'react'

/** Host-provided UI previews contain bounded result text, not private ledger data. */
export function resultText(block) {
  return block?.resultPreview ?? block?.summary ?? 'Waiting for a tool result'
}

export function apply(ctx, config) {
  const remove = ctx.slots.register(
    { name: 'tool.call.toolview', key: 'plugin_tool_panel', id: 'echo-result' },
    function EchoResultPanel({ owner }) {
      const block = owner?.block
      return createElement('section', { 'aria-label': config?.publicConfig?.label ?? 'Echo result' },
        createElement('strong', null, 'Echo result'),
        createElement('p', { role: 'status' }, block?.status ?? 'planned'),
        createElement('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, resultText(block)),
      )
    },
  )
  ctx.effect(() => remove)
}
