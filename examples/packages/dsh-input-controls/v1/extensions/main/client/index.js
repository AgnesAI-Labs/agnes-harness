import { createElement, useState } from 'react'

function InputControls() {
  const [value, setValue] = useState(50)
  return createElement(
    'div',
    {
      className: 'dsh-input-controls',
      'data-demo-plugin': 'dsh-input-controls',
      'data-demo-version': 'v1',
    },
    createElement(
      'button',
      { type: 'button', onClick: () => setValue((current) => current + 5) },
      '调整插件参数',
    ),
    createElement(
      'label',
      {},
      `参数 ${value}`,
      createElement('input', {
        type: 'range',
        min: 0,
        max: 100,
        value,
        onChange: (event) => setValue(Number(event.currentTarget.value)),
      }),
    ),
  )
}

export function apply(ctx) {
  ctx.slots.register(
    { name: 'conversation.input.right', id: 'dsh-input-controls', priority: 0 },
    InputControls,
  )
}
