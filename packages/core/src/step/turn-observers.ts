import type { HookPayloadMap } from '@agnes/extension-api'
import { loopEventContext } from '../loop/events.js'
import type { SessionImpl } from './session.js'

/** Observers run after the terminal transaction and cannot undo its committed outcome. */
export async function notifyCommittedTurnHook(
  session: SessionImpl,
  payload: HookPayloadMap['turn_end'],
): Promise<void> {
  try {
    await session.hooks.turnEnd?.(payload)
  } catch (error) {
    session.d.logger.warn('turn_end hook failed', { message: String(error) })
  }
}

export async function notifyLoopTurnEnd(
  session: SessionImpl,
  payload: Pick<HookPayloadMap['turn_end'], 'turn' | 'reason'>,
): Promise<void> {
  await session.loopEvents
    .dispatch('turn_end', payload, loopEventContext(session, new AbortController().signal))
    .catch((error) => session.d.logger.warn('turn_end observer failed', { message: String(error) }))
}
