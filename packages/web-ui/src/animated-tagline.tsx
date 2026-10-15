import { useEffect, useState } from 'react'
import { useReducedMotion } from './ui/overlay.js'

/** Animated children must leave before background-clip paints the sentence's sheen. */
export function AnimatedTagline({ text, className }: { text: string; className?: string }) {
  const reduce = useReducedMotion()
  const [introduced, setIntroduced] = useState(reduce)
  useEffect(() => {
    if (reduce) {
      setIntroduced(true)
      return
    }
    if (introduced) return
    const timer = window.setTimeout(
      () => setIntroduced(true),
      Math.max(0, Array.from(text).length - 1) * 45 + 600,
    )
    return () => window.clearTimeout(timer)
  }, [reduce, introduced, text])
  const intro = !reduce && !introduced
  return (
    <span
      className={className}
      data-phase={reduce ? 'static' : intro ? 'intro' : 'sheen'}
      {...(intro ? { role: 'img', 'aria-label': text } : {})}
    >
      {intro
        ? Array.from(text).map((char, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: character positions are fixed during this one-shot intro.
            <span key={`${index}-${char}`} aria-hidden="true" style={{ animationDelay: `${index * 45}ms` }}>
              {char}
            </span>
          ))
        : text}
    </span>
  )
}
