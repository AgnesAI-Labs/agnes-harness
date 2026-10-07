import type { ToolPolicy } from '@agnes/extension-api'

/** Preset policy denial still applies when a session skips human approvals. */
export const sandboxToolPolicies: readonly ToolPolicy[] = [
  {
    id: 'read-only',
    version: '1.0.0',
    decide(input) {
      return input.policy.isReadOnly && !input.policy.isDestructive
        ? { effect: 'allow', reason: 'read-only preset permits reads' }
        : { effect: 'deny', reason: 'read-only preset refuses changes and unclassified effects' }
    },
  },
  {
    id: 'full-access',
    version: '1.0.0',
    decide() {
      return { effect: 'allow', reason: 'explicit full-access preset' }
    },
  },
]
