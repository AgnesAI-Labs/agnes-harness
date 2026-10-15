import { useReducedMotion } from '@agnes/web-ui'
import { useCallback, useEffect, useState } from 'react'

/** A pause survives clearing the draft while focused; only an empty, unfocused input resumes. */
export function useExampleHint(prompts: readonly string[], eligible: boolean) {
  const reduce = useReducedMotion()
  const [paused, setPaused] = useState(false)
  const [frame, setFrame] = useState({ text: '', complete: false })
  const active = eligible && !reduce && !paused && prompts.length > 0
  // Use the sentence values, not the caller's array identity: unrelated renders must not restart typing.
  const sentences = JSON.stringify(prompts)
  useEffect(() => {
    setFrame({ text: '', complete: false })
    if (!active) return
    const examples: string[] = JSON.parse(sentences)
    let index = 0
    let length = 0
    let deleting = false
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const chars = Array.from(examples[index] ?? '')
      length = deleting ? Math.max(0, length - 2) : length + 1
      const complete = !deleting && length >= chars.length
      setFrame({ text: chars.slice(0, length).join(''), complete })
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
    complete: active && frame.complete,
    pause: useCallback(() => setPaused(true), []),
    resume: useCallback(() => setPaused(false), []),
  }
}
