import { describe, expect, it } from 'vitest'
import { lessonNotePlaceholder } from '../src/refinement.js'

describe('lessonNotePlaceholder', () => {
  const data = (head: string) => ({ kind: 'runtime_context', content: [{ type: 'text', text: head }] })

  it('stands in for the experience note', () => {
    expect(lessonNotePlaceholder(data('[task-experience]\nTask experience update'))).toBe(
      '[task experience note omitted]',
    )
  })

  it('leaves every other message alone, nested-result notes included', () => {
    expect(
      lessonNotePlaceholder(
        data('[nested result]\nThe user rejected the nested call harness_propose inside x'),
      ),
    ).toBeUndefined()
    expect(lessonNotePlaceholder(data('[hook context]\nx'))).toBeUndefined()
    // Typed by a person, the same words are an ordinary prompt.
    expect(
      lessonNotePlaceholder({ kind: 'prompt', content: [{ type: 'text', text: '[task-experience]\nhi' }] }),
    ).toBeUndefined()
    expect(lessonNotePlaceholder('text')).toBeUndefined()
    expect(lessonNotePlaceholder(null)).toBeUndefined()
  })
})
