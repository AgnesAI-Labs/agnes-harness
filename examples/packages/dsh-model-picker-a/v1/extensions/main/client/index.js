import { createElement } from 'react'

function ModelPickerA() {
  return createElement(
    'button',
    { type: 'button', 'data-demo-model': 'a', 'data-demo-version': 'v1' },
    '模型插件 A · v1',
  )
}

export function apply(ctx) {
  ctx.slots.register(
    { name: 'conversation.input.model', id: 'dsh-model-picker-a', priority: 10 },
    ModelPickerA,
  )
}
