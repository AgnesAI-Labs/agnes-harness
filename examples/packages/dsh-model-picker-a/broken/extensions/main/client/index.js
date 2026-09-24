function BrokenModelPickerA() {
  throw new Error('DSH model picker A render failure')
}

export function apply(ctx) {
  ctx.slots.register(
    { name: 'conversation.input.model', id: 'dsh-model-picker-a', priority: 10 },
    BrokenModelPickerA,
  )
}
