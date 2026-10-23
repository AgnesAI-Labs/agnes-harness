/**
 * The few protocol values the command-line parser needs. They live behind their own export so
 * `agh --help` does not evaluate the whole protocol barrel (schemas and validators) to parse flags.
 */

export { closestNames, editDistance } from './closest-names.js'
export { parseLoopSpecifier } from './loop-selection.js'
export { SLOT_NAMES } from './provider.js'
export { parseAgentRef } from './session-composition.js'
