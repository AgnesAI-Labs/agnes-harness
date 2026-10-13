import type { HTMLAttributes } from 'react'

export type ShortcutKey = 'mod' | 'shift' | 'alt' | 'enter' | 'esc' | (string & {})

const APPLE: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥', enter: '↵', esc: 'Esc' }
const OTHER: Record<string, string> = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter', esc: 'Esc' }

/** Platform spelling of a shortcut: `⌘N` on Apple keyboards, `Ctrl+N` elsewhere. */
export function shortcutLabel(
  keys: readonly ShortcutKey[],
  apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform),
): string {
  const names = keys.map((key) => (apple ? APPLE : OTHER)[key] ?? key)
  // Apple modifier glyphs read as one cluster; a spelled-out key keeps its separator.
  return apple
    ? names.reduce((label, name, index) => {
        const previous = names[index - 1] ?? ''
        return label + (index > 0 && (name.length > 1 || previous.length > 1) ? ' ' : '') + name
      }, '')
    : names.join('+')
}

export type KbdProps = HTMLAttributes<HTMLElement> & {
  /** Keys spelled for the current platform; takes the place of children. */
  keys?: readonly ShortcutKey[]
}
/** A quiet keyboard hint chip; the keys are read aloud by the owning control's shortcut text. */
export function Kbd({ className, children, keys, ...props }: KbdProps) {
  return (
    <kbd {...props} className={['agh-kbd', className].filter(Boolean).join(' ')} translate="no">
      {keys ? shortcutLabel(keys) : children}
    </kbd>
  )
}
