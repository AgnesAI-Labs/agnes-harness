import { TASK_EXPERIENCE_NOTE_PREFIX } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { EXPERIENCE_PREFIX } from '../src/request/experience.js'

// The default compaction engine recognises a delivered experience note by this first line. Core writes the
// note and protocol reads it, so the two must be one string, and changing either is a format change.
it('pins the first line of the experience note', () => {
  expect(EXPERIENCE_PREFIX).toBe('[task-experience]\n')
  expect(EXPERIENCE_PREFIX).toBe(TASK_EXPERIENCE_NOTE_PREFIX)
})
