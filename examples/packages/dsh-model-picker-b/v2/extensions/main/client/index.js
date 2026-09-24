import { createElement } from 'react'

function ModelPickerB() {
  return createElement(
    'button',
    { type: 'button', 'data-demo-model': 'b', 'data-demo-version': 'v2' },
    '模型插件 B · v2',
  )
}

export function apply(ctx) {
  ctx.slots.register(
    { name: 'conversation.input.model', id: 'dsh-model-picker-b', priority: 20 },
    ModelPickerB,
  )
}
