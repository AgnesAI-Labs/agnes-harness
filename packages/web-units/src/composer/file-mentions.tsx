import {
  Button,
  type FileMention,
  fileMentionBlock,
  fileMentionIcon,
  fileMentionOf,
  Icon,
} from '@agnes/web-ui'
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { Translate } from '../locales/index.js'

/** A mention as the draft holds it: its chip reads `@label` in the text. */
export type DraftMention = FileMention & { label: string }
export type MentionToken = { start: number; end: number; mention: DraftMention }

/** Characters that continue a name; a token must not run on into them. */
const NAME_CHAR = /[\p{L}\p{N}_.\-/\\]/u

/** Where each mention's `@label` stands in the draft, in text order, never overlapping. */
export function mentionTokens(draft: string, mentions: readonly DraftMention[]): MentionToken[] {
  const found: MentionToken[] = []
  // Longer labels first, so `@a.md` inside `@a.md.bak` is not mistaken for the shorter one.
  for (const mention of [...mentions].sort((a, b) => b.label.length - a.label.length)) {
    const token = `@${mention.label}`
    let at = draft.indexOf(token)
    while (at >= 0) {
      const end = at + token.length
      const free = !found.some((other) => at < other.end && end > other.start)
      if (free && !NAME_CHAR.test(draft[end] ?? '')) found.push({ start: at, end, mention })
      at = draft.indexOf(token, at + 1)
    }
  }
  return found.sort((a, b) => a.start - b.start)
}

/** A label no other mention uses: the name, then as much of the path as tells them apart. */
function labelFor(mention: FileMention, others: readonly DraftMention[]): string {
  const segments = mention.path.split(/[\\/]/u).filter(Boolean)
  for (let count = 1; count <= segments.length; count++) {
    const label = count === 1 ? mention.name : segments.slice(-count).join('/')
    if (!others.some((other) => other.label === label && other.path !== mention.path)) return label
  }
  return mention.path
}

/** Keep inline reference blocks visually distinct without shifting their overlay away from the textarea caret. */
function spacingBefore(text: string): string {
  if (!text) return ''
  const existing = /[ \t]*$/u.exec(text)?.[0].length ?? 0
  return ' '.repeat(Math.max(0, 2 - existing))
}

function spacingAfter(text: string): string {
  const existing = /^[ \t]*/u.exec(text)?.[0].length ?? 0
  return ' '.repeat(Math.max(0, 2 - existing))
}

/**
 * The files and folders the draft names. A mention lives in the text as `@label` and is sent as a
 * `resource_link` beside it; deleting its text drops it, and Backspace or Delete takes it whole.
 */
export function useFileMentions({
  prompt,
  draftRef,
  editDraft,
  initial = [],
}: {
  prompt: RefObject<HTMLTextAreaElement | null>
  draftRef: RefObject<string>
  editDraft(start: number, end: number, text: string): void
  initial?: readonly FileMention[]
}) {
  const [mentions, setMentions] = useState<readonly DraftMention[]>(() => {
    const rebuilt: DraftMention[] = []
    for (const mention of initial) rebuilt.push({ ...mention, label: labelFor(mention, rebuilt) })
    return rebuilt
  })
  const mentionsRef = useRef(mentions)
  mentionsRef.current = mentions
  const publish = useCallback((next: readonly DraftMention[]) => {
    mentionsRef.current = next
    setMentions(next)
  }, [])

  const insert = useCallback(
    (mention: FileMention, range?: { start: number; end: number }) => {
      const current = mentionsRef.current
      const known = current.find((item) => item.path === mention.path)
      const entry = known ?? { ...mention, label: labelFor(mention, current) }
      if (!known) publish([...current, entry])
      const draft = draftRef.current ?? ''
      const input = prompt.current
      const start = range?.start ?? (input ? input.selectionStart : draft.length)
      const end = range?.end ?? (input ? input.selectionEnd : draft.length)
      const before = draft.slice(0, start)
      const after = draft.slice(end)
      const text = `${spacingBefore(before)}@${entry.label}${spacingAfter(after)}`
      editDraft(start, end, text)
    },
    [draftRef, editDraft, prompt, publish],
  )

  /** The links to send with the draft: one per mention still in the text, in text order. */
  const blocks = useCallback((draft: string) => {
    const seen = new Set<string>()
    return mentionTokens(draft, mentionsRef.current).flatMap(({ mention }) => {
      if (seen.has(mention.path)) return []
      seen.add(mention.path)
      return [fileMentionBlock(mention)]
    })
  }, [])

  /** Take back the mentions among restored blocks; the rest are attachments. */
  const restore = useCallback(
    <T extends { type: string; uri?: string }>(restored: readonly T[]) => {
      const rest: T[] = []
      let next = mentionsRef.current
      for (const block of restored) {
        const mention = fileMentionOf(block)
        if (!mention) {
          rest.push(block)
          continue
        }
        if (!next.some((item) => item.path === mention.path))
          next = [...next, { ...mention, label: labelFor(mention, next) }]
      }
      if (next !== mentionsRef.current) publish(next)
      return rest
    },
    [publish],
  )

  const clear = useCallback(() => {
    if (mentionsRef.current.length > 0) publish([])
  }, [publish])
  const replace = useCallback(
    (next: readonly FileMention[]) => {
      const current = mentionsRef.current
      if (
        current.length === next.length &&
        current.every(
          (mention, index) =>
            mention.path === next[index]?.path &&
            mention.name === next[index]?.name &&
            mention.directory === next[index]?.directory,
        )
      )
        return
      const rebuilt: DraftMention[] = []
      for (const mention of next) rebuilt.push({ ...mention, label: labelFor(mention, rebuilt) })
      publish(rebuilt)
    },
    [publish],
  )

  /** Reference tokens are atomic: delete and left/right navigation never leave the caret inside one. */
  const keydown = useCallback(
    (event: { key: string; preventDefault(): void; isComposing?: boolean }) => {
      const input = prompt.current
      if (!input || event.isComposing || input.selectionStart !== input.selectionEnd) return
      const caret = input.selectionStart
      const tokens = mentionTokens(draftRef.current ?? '', mentionsRef.current)
      const token = tokens.find((item) =>
        event.key === 'ArrowLeft' || event.key === 'Backspace'
          ? caret > item.start && caret <= item.end
          : event.key === 'ArrowRight' || event.key === 'Delete'
            ? caret >= item.start && caret < item.end
            : false,
      )
      if (!token) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const position = event.key === 'ArrowLeft' ? token.start : token.end
        input.setSelectionRange(position, position)
        return
      }
      if (event.key !== 'Backspace' && event.key !== 'Delete') return
      event.preventDefault()
      editDraft(token.start, token.end, '')
    },
    [draftRef, editDraft, prompt],
  )

  const remove = useCallback(
    (token: MentionToken) => {
      editDraft(token.start, token.end, '')
    },
    [editDraft],
  )

  /** Immediate snapshot for host persistence during the same event that inserts a mention. */
  const snapshot = useCallback(() => mentionsRef.current, [])

  return { mentions, snapshot, insert, blocks, restore, clear, replace, keydown, remove }
}

/** Text styles the overlay copies so its glyphs land exactly on the textarea's. */
const MIRRORED = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'fontFeatureSettings',
  'letterSpacing',
  'wordSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'boxSizing',
  'direction',
] as const

/**
 * Chips drawn over the textarea where its mentions stand. The overlay repeats the draft with the
 * textarea's own text metrics, so each chip covers exactly its `@label`: the `@` gives way to the
 * file's type icon. Typing and the caret stay the textarea's; the chips only take the pointer.
 */
export function FileMentionLayer({
  prompt,
  draft,
  tokens,
  remove,
  t,
}: {
  prompt: RefObject<HTMLTextAreaElement | null>
  draft: string
  tokens: readonly MentionToken[]
  remove(token: MentionToken): void
  t: Translate
}) {
  const layer = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const [, relayout] = useState(0)
  useLayoutEffect(() => {
    const input = prompt.current
    const box = layer.current
    const inner = text.current
    if (!input || !box || !inner || tokens.length === 0) return
    const place = () => {
      const host = box.offsetParent as HTMLElement | null
      const at = input.getBoundingClientRect()
      const origin = host?.getBoundingClientRect() ?? { left: 0, top: 0 }
      box.style.left = `${at.left - origin.left}px`
      box.style.top = `${at.top - origin.top}px`
      box.style.width = `${at.width}px`
      box.style.height = `${at.height}px`
      const style = getComputedStyle(input)
      for (const name of MIRRORED) inner.style[name] = style[name]
      // The textarea's scrollbar narrows its text; the copy wraps at the same width.
      inner.style.width = `${input.clientWidth + Number.parseFloat(style.borderLeftWidth || '0') + Number.parseFloat(style.borderRightWidth || '0')}px`
      inner.style.transform = `translateY(${-input.scrollTop}px)`
    }
    place()
    input.addEventListener('scroll', place)
    window.addEventListener('resize', place)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    observer?.observe(input)
    return () => {
      input.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
      observer?.disconnect()
    }
  })
  if (tokens.length === 0) return null
  const pieces: Array<{ start: number; text: string } | MentionToken> = []
  let at = 0
  for (const token of tokens) {
    if (token.start > at) pieces.push({ start: at, text: draft.slice(at, token.start) })
    pieces.push(token)
    at = token.end
  }
  pieces.push({ start: at, text: draft.slice(at) })
  return (
    <div ref={layer} className="composer-mention-layer" aria-hidden="true" data-testid="file-mention-layer">
      <div ref={text} className="composer-mention-text">
        {pieces.map((piece) =>
          'text' in piece ? (
            <span key={`text:${piece.start}`}>{piece.text}</span>
          ) : (
            // biome-ignore lint/a11y/noStaticElementInteractions: a pointer convenience over the textarea, which owns the keyboard.
            <span
              key={`mention:${piece.start}`}
              className="composer-mention"
              data-testid="composer-file-mention"
              data-directory={piece.mention.directory || undefined}
              title={piece.mention.path}
              onMouseDown={(event) => {
                // A press on the chip puts the caret after it, as if the chip were one character.
                event.preventDefault()
                const input = prompt.current
                input?.focus()
                input?.setSelectionRange(piece.end, piece.end)
                relayout((value) => value + 1)
              }}
            >
              {/* The fixed-width prefix replaces the literal `@` without shifting the textarea caret. */}
              <span className="composer-mention-at">
                <Icon
                  name={fileMentionIcon(piece.mention.name, piece.mention.directory)}
                  size={16}
                  className="composer-mention-icon"
                />
              </span>
              {piece.mention.label}
              <Button
                htmlType="button"
                appearance="ghost"
                size="small"
                className="composer-mention-remove"
                data-testid="composer-file-mention-remove"
                tabIndex={-1}
                aria-label={t('composer.mention.remove', { name: piece.mention.name })}
                title={t('composer.mention.remove', { name: piece.mention.name })}
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  remove(piece)
                }}
                icon={<Icon name="x" size={16} />}
              />
            </span>
          ),
        )}
        {/* A trailing newline needs a character after it to take its line in the copy. */}
        {draft.endsWith('\n') ? ' ' : null}
      </div>
    </div>
  )
}
