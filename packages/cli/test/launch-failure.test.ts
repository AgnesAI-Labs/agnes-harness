import { expect, it } from 'vitest'
import { launchFailure } from '../launch/launch-failure.js'

it.each([
  [new Error('CAPABILITY_DENIED'), 403, 'CAPABILITY_DENIED'],
  [{ code: -32006, data: { code: 'CAPABILITY_DENIED' } }, 403, 'CAPABILITY_DENIED'],
  [{ code: -32008, data: { code: 'E_PRESET_UNRESOLVED' } }, 409, 'E_PRESET_UNRESOLVED'],
  [new Error('E_PACKAGE_PREVIEW_STALE'), 409, 'E_PACKAGE_PREVIEW_STALE'],
  [{ code: 'E_PACKAGE_BUSY' }, 409, 'E_PACKAGE_BUSY'],
  [{ data: { code: 'E_PACKAGE_BUSY' } }, 409, 'E_PACKAGE_BUSY'],
  [new Error('OUTCOME_UNKNOWN'), 409, 'OUTCOME_UNKNOWN'],
  [new Error('INVALID_REQUEST'), 409, 'INVALID_REQUEST'],
  [new Error('OVERLOADED'), 409, 'OVERLOADED'],
  [new Error('private path or credential in exception'), 500, 'INTERNAL_ERROR'],
  [{ code: 'private-data', data: { code: '__proto__' } }, 500, 'INTERNAL_ERROR'],
  [null, 500, 'INTERNAL_ERROR'],
])('classifies launch failures without exposing exception content (%s)', (error, status, code) => {
  expect(launchFailure(error)).toEqual({ status, code })
})
