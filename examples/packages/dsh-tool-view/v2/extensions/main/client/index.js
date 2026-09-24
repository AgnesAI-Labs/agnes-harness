import { createElement } from 'react'

function ToolView({ owner }) {
  const callId = typeof owner?.callId === 'string' ? owner.callId : 'unknown-call'
  const toolName = typeof owner?.toolName === 'string' ? owner.toolName : 'shell'
  return createElement(
    'div',
    {
      className: 'dsh-tool-view',
      'data-demo-tool-view': toolName,
      'data-demo-version': 'v2',
    },
    createElement('strong', {}, '工具调用视图 · v2'),
    createElement('span', {}, `工具 ${toolName}`),
    createElement('span', {}, `调用 ${callId}`),
  )
}

export function apply(ctx) {
  for (const key of ['bash', 'shell']) {
    ctx.slots.register(
      { name: 'tool.call.toolview', key, id: `dsh-tool-view-${key}`, priority: 20 },
      ToolView,
    )
  }
}
