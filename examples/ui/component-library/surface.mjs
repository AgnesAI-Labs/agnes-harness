/** The same bounded structured surface is used by the public Loop and acceptance tests. */
export function reviewSurface(id = 'component-review') {
  return {
    id,
    revision: 1,
    title: 'Review / 审阅',
    placement: { inline: true, workbench: true },
    data: { gauge: { value: 42 }, note: { text: '<script>never executes</script>' } },
    components: [
      {
        id: 'gauge',
        kind: '@example/ui-components/gauge@1',
        dataKey: 'gauge',
        fallback: 'Completion: 42%',
        actionIds: [],
      },
      {
        id: 'note',
        kind: '@example/ui-components/note@1',
        dataKey: 'note',
        fallback: 'Read the review note.',
        actionIds: [],
      },
      { id: 'actions', kind: 'button-group', actionIds: ['confirm'] },
    ],
    actions: [
      {
        id: 'confirm',
        label: 'Confirm / 确认',
        tool: 'ui_example_ack',
        confirm: 'Record this review? / 记录本次审阅？',
        argsTemplate: { message: { literal: 'reviewed' } },
        paramsSchema: {
          type: 'object',
          required: ['message'],
          properties: { message: { type: 'string', maxLength: 64 } },
          additionalProperties: false,
        },
      },
    ],
  }
}
