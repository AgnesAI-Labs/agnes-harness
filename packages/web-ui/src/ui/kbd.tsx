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

/** Each key as the current platform names it: `⌘ ⇧ O` on Apple keyboards, `Ctrl Shift O` elsewhere. */
export function shortcutKeys(
  keys: readonly ShortcutKey[],
  apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform),
): string[] {
  return keys.map((key) => (apple ? APPLE : OTHER)[key] ?? key)
}

export type KbdProps = HTMLAttributes<HTMLElement> & {
  /** Keys spelled for the current platform, one keycap each; takes the place of children. */
  keys?: readonly ShortcutKey[]
}
/**
 * A quiet keyboard hint: one rounded keycap per key, side by side (`⇧` `⌘` `O`). Children render as
 * a single keycap. The keys are read aloud by the owning control's shortcut text.
 */
export function Kbd({ className, children, keys, ...props }: KbdProps) {
  const caps = keys ? shortcutKeys(keys) : [children]
  return (
    <kbd {...props} className={['agh-kbd', className].filter(Boolean).join(' ')} translate="no">
      {caps.map((cap, index) => (
        // Keys repeat only in different positions, so the position is the identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: a chord's keys never reorder
        <span key={index} className="agh-kbd-key">
          {cap}
        </span>
      ))}
    </kbd>
  )
}
