import { useReducedMotion } from '@agnes/web-ui'
import { useCallback, useEffect, useState } from 'react'

/**
 * Ghost text for the home examples. `text` is the typing animation; `adoptText` is the complete
 * sentence it is typing, already known on the first frame so Tab never waits for the animation.
 * `eligible` already means "empty draft, no attachments, idle"; `dismiss` is the person closing it
 * on purpose and survives an emptied draft. Nothing else keeps the hint hidden, so clearing the
 * draft always offers it again.
 */
export function useExampleHint(prompts: readonly string[], eligible: boolean) {
  const reduce = useReducedMotion()
  const [dismissedByUser, setDismissedByUser] = useState(false)
  const [frame, setFrame] = useState({ text: '', sentence: '' })
  const active = eligible && !reduce && !dismissedByUser && prompts.length > 0
  // Use the sentence values, not the caller's array identity: unrelated renders must not restart typing.
  const sentences = JSON.stringify(prompts)
  useEffect(() => {
    const examples: string[] = JSON.parse(sentences)
    setFrame({ text: '', sentence: examples[0] ?? '' })
    if (!active) return
    let index = 0
    let length = 0
    let deleting = false
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const chars = Array.from(examples[index] ?? '')
      length = deleting ? Math.max(0, length - 2) : length + 1
      const complete = !deleting && length >= chars.length
      setFrame({ text: chars.slice(0, length).join(''), sentence: examples[index] ?? '' })
      let delay = deleting ? 18 : 55
      if (complete) {
        deleting = true
        delay = 2200
      } else if (deleting && length === 0) {
        deleting = false
        index = (index + 1) % examples.length
        delay = 350
      }
      timer = setTimeout(tick, delay)
    }
    timer = setTimeout(tick, 55)
    return () => clearTimeout(timer)
  }, [active, sentences])
  return {
    visible: active,
    text: active ? frame.text : '',
    // The first sentence is known before the typing effect runs, so the very first frame can adopt.
    adoptText: active ? frame.sentence || (prompts[0] ?? '') : '',
    dismiss: useCallback(() => setDismissedByUser(true), []),
  }
}
