// Demonstrates the "addition" scenario (third-party-transform-directive-hooks design §2.1): a brand
// new plugin row registers on a *transform*-category event through `registerHook`, not `on`. Before
// that design shipped, `agnes.on('context', ...)` was flatly refused for every plugin row — `context`
// is not one of the seven observe-only events `on` has always allowed. This plugin replaces nothing:
// it just adds its own section to the prompt, after every built-in context contributor has already
// run, and its return value genuinely reaches the model (unlike `on`, which discards it).
export const contextNoteHook = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    agnes.registerHook('context', () => ({
      sections: [
        {
          id: 'hook-context-note/reminder',
          order: 250,
          content:
            'Reminder from a third-party plugin: double-check any destructive shell command before running it.',
        },
      ],
    }))
  },
}
