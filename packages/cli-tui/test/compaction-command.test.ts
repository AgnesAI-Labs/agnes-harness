import { describe, expect, it } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { runSlash } from '../src/commands.js'

const app = (
  outcome:
    | { state: 'completed'; endSeq: number }
    | { state: 'failed'; endSeq: number }
    | { state: 'unknown' },
) => ({ cwd: '/w', session: { compactDetailed: async () => outcome } }) as unknown as TuiApp

describe('/compact result display', () => {
  it('calls a completed compaction completed', async () => {
    await expect(runSlash(app({ state: 'completed', endSeq: 9 }), '/compact')).resolves.toEqual({
      text: 'compaction completed at seq 9',
    })
  })

  it.each([
    [{ state: 'failed', endSeq: 9 } as const, 'compaction failed; session history was preserved'],
    [{ state: 'unknown' } as const, 'compaction result is unknown; session history was preserved'],
  ])('never calls %s a completion', async (outcome, text) => {
    await expect(runSlash(app(outcome), '/compact')).resolves.toEqual({ text })
  })
})
