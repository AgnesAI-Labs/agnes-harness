import { refuseAppendSystemPromptMisuse } from './modes/append-system-prompt.js'
import { refusePrivateHostFlags } from './private-host-flags.js'
import { refuseToolFilterElsewhere } from './tool-filter.js'
import type { ParsedArgs } from './types.js'

/** Flag combinations that make no sense, refused by name before anything starts. */
export function refuseFlagConflicts(p: ParsedArgs): void {
  refuseToolFilterElsewhere(p)
  refusePrivateHostFlags(p)
  refuseAppendSystemPromptMisuse(p)
}
