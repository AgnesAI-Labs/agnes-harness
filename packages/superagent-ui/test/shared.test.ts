import { expect, it } from 'vitest'
import { ADMISSION_DEFAULTS, ADMISSION_OPTIONS } from '../../superagent/src/admission.js'
import { THREAD_FILTERS } from '../../superagent/src/app/views/threads.js'
import { REASONS, USER_ERRORS } from '../../superagent/src/core/index.js'
import { LIMITS } from '../../superagent/src/limits.js'
import { TICKET_FILTERS } from '../../superagent/src/runtime/services.js'
import { SETUP_PROBLEMS } from '../../superagent/src/setup.js'
import { HEALTH_TEXT } from '../../superagent/src/sources/host.js'
import * as shared from '../src/shared.js'

// The panel bundle carries no other package, so it copies these by value; each copy must stay what its source is.
it('keeps every value the panel copies identical to the Superagent source', () => {
  expect(shared.LIMITS).toEqual(LIMITS)
  expect(shared.USER_ERRORS).toEqual(USER_ERRORS)
  expect(shared.REASONS).toEqual(REASONS)
  expect(shared.SETUP_PROBLEMS).toEqual(SETUP_PROBLEMS)
  expect(shared.HEALTH_TEXT).toEqual(HEALTH_TEXT)
  expect(shared.ADMISSION_OPTIONS).toEqual(ADMISSION_OPTIONS)
  expect(shared.ADMISSION_DEFAULTS).toEqual(ADMISSION_DEFAULTS)
  expect(shared.TICKET_FILTERS).toEqual(TICKET_FILTERS)
  expect(shared.THREAD_FILTERS).toEqual(THREAD_FILTERS)
})
