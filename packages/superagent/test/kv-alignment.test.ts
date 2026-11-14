/** Records and horizons that two modules must agree on. */
import { expect, expectTypeOf, it } from 'vitest'
import type { PromptConfig as Parsed, PromptVersion as ParsedVersion } from '../src/app/prompts.js'
import { ARCHIVE_AFTER_MS } from '../src/app/store-retention.js'
import type {
  PromptConfig as Stored,
  Retry as StoredRetry,
  PromptVersion as StoredVersion,
} from '../src/kv.js'
import type { Retry } from '../src/sources/github.js'
import { POLL_HORIZON_MS } from '../src/sources/poll.js'

it('stores the prompt configuration and the GitHub retry record exactly as the modules that parse them see them', () => {
  expectTypeOf<Parsed>().toExtend<Stored>()
  expectTypeOf<Stored>().toExtend<Parsed>()
  expectTypeOf<ParsedVersion>().toEqualTypeOf<StoredVersion>()
  expectTypeOf<Retry>().toEqualTypeOf<StoredRetry>()
})

it('polls a thread for as long as its conversation stays out of the archive', () => {
  expect(POLL_HORIZON_MS).toBe(ARCHIVE_AFTER_MS)
})
