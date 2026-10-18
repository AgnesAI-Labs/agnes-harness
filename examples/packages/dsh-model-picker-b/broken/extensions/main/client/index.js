function BrokenModelPickerB() {
  throw new Error('DSH model picker B render failure')
}

export function apply(ctx) {
  return ctx.slots.inject('conversation.input.model', () =>
    ctx.slots.register(
      { name: 'conversation.input.model', id: 'dsh-model-picker-b', priority: 20 },
      BrokenModelPickerB,
    ),
  )
}
