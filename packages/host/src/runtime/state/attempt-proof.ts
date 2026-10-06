import type { ActionRecordValue, AttemptRecordValue } from '@agnes/protocol/runtime'
import { digestOf } from './records.js'
import { integrity } from './refusal.js'

/**
 * What an attempt must be given the action and run it names, whichever command wrote it. A leaf
 * attempt carries the request identity it was admitted with; a composite attempt never does; a
 * control attempt is the zero-effect settlement and never ran. Anything else is refused by name
 * rather than shown as a record the caller could mistake for State's own.
 */
export function proveAttempt(attempt: AttemptRecordValue, action: ActionRecordValue, runBindingId: string) {
  const input = (action.intent as { input?: unknown }).input
  const sameInput = input !== undefined && attempt.inputDigest === digestOf(input)
  const controlled =
    attempt.kind === 'control'
      ? attempt.number === 0 &&
        attempt.state === 'settled' &&
        attempt.requestIdentity === null &&
        attempt.authorizationRef === null &&
        attempt.receiptIds.length === 1
      : attempt.number >= 1 &&
        (attempt.kind === 'leaf'
          ? attempt.requestIdentity !== null &&
            attempt.requestIdentity.requestDigest === attempt.inputDigest &&
            attempt.authorizationRef !== null
          : attempt.requestIdentity === null && attempt.authorizationRef === null)
  if (!sameInput || !controlled || attempt.bindingId !== runBindingId)
    integrity('an attempt record does not fit its action and run')
}
