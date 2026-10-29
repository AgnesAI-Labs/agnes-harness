import type { SessionImpl } from '../step/session.js'
import type { AuxiliaryVisionEffectPort } from './auxiliary-vision-executor.js'
import { createMediaEffectPort } from './side-call-effect-port.js'

/**
 * Adapts the session ledger to the executor's effect port. Intent and terminal transactions are
 * serialized with all other session writes; recovery never admits a second dispatch for an
 * in-progress or durably terminal effect. The rows are the `media` purpose of the shared ledger-row
 * layer.
 */
export function createAuxiliaryVisionEffectPort(session: SessionImpl): AuxiliaryVisionEffectPort {
  return createMediaEffectPort(session)
}
