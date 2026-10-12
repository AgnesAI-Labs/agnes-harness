/** Deny writes even when the session has full access. Principal authorization still applies. */
export const policy = {
  id: 'read-only',
  version: '1.0.0',
  decide(input, signal) {
    signal.throwIfAborted()
    return input.policy.isReadOnly && !input.policy.isDestructive
      ? { effect: 'allow', reason: 'Read-only tool' }
      : { effect: 'deny', reason: 'The read-only policy refuses side effects' }
  },
}
