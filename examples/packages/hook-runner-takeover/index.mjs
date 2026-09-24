// Demonstrates the "replacement" scenario (third-party-transform-directive-hooks design §2.2): a
// plugin row claims a builtin extension's own row id (`ext:agnes/hooks-runner`) and takes over its
// hook events. Before this design shipped, `hooks-runner` could never actually be replaced in
// practice: replacing a governance builtin requires registering every hook event it declared
// (row-extension-host.ts's assertReplacements), and `registerHook` was flatly refused to plugin rows
// - a third party could never gather all 12 of hooks-runner's events. Seven of those twelve
// (before_step, tool_call, turn_stopping, context, tool_result, before_compact, approval_request) are
// transform/directive-category events `agnes.on` still cannot register at all.
//
// Every event below is a safe no-op pass-through *except* `tool_call`, which blocks one specific,
// clearly-marked demo call so the takeover's real effect is directly observable: the return value
// genuinely reaches the kernel, not just "the row mounted without throwing".
export const hooksRunnerReplacement = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()

    // Observe-only events hooks-runner also declares: on() would work for these five, but
    // registerHook is used uniformly here since the row must register all twelve to satisfy the
    // governance check regardless of which entry point each individual event could use.
    agnes.registerHook('session_start', () => undefined)
    agnes.registerHook('shutdown', () => undefined)
    agnes.registerHook('subagent_start', () => undefined)
    agnes.registerHook('subagent_end', () => undefined)
    agnes.registerHook('compact', () => undefined)

    // Directive (intercept) category: before_step and turn_stopping pass through unchanged;
    // tool_call blocks the one marked demo call.
    agnes.registerHook('before_step', () => ({}))
    agnes.registerHook('turn_stopping', () => ({ action: 'stop' }))
    agnes.registerHook('tool_call', (payload) => {
      if (payload.name === 'demo_text_stats' && payload.args?.text === 'BLOCK_ME') {
        return { allow: false, reason: 'blocked by the hook-runner-takeover demo policy' }
      }
      return { allow: true }
    })

    // Transform (chain) category: pass through unchanged.
    agnes.registerHook('context', () => ({}))
    agnes.registerHook('tool_result', () => ({}))
    agnes.registerHook('approval_request', () => ({}))
    agnes.registerHook('before_compact', () => null)
  },
}
