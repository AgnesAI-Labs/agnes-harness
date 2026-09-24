import { createElement } from 'react'

function BrokenToolView() {
  throw new Error('DSH bash tool view render failure')
}

export function apply(ctx) {
  for (const key of ['bash', 'shell']) {
    ctx.slots.register(
      { name: 'tool.call.toolview', key, id: `dsh-tool-view-${key}`, priority: 20 },
      BrokenToolView,
    )
  }
}

void createElement
