// Demonstrates the "addition" scenario (third-party-transform-directive-hooks design §2.1): a brand
// new plugin row registers on a *transform*-category event through `ctx.hooks.register`. This plugin replaces
// nothing: it just adds its own section to the prompt, after every built-in context contributor has
// already run, and its return value genuinely reaches the model (observe-only events discard it).
export const contextNoteHook = {
  inject: ['hooks'],
  apply(ctx) {
    ctx.hooks.register('context', () => ({
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
