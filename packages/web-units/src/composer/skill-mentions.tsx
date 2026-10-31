import { Button, Icon, Popover } from '@agnes/web-ui'
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import type { Translate } from '../locales/index.js'
import type { ComposerSkill } from '../skill-picker.js'

export type SkillMentionToken = Readonly<{ start: number; end: number; name: string }>

/** A selected skill is only a display token when its complete explicit `$name` is still in the draft. */
const NAME_CHAR = /[\p{L}\p{N}_.\-/\\]/u

export function skillMentionTokens(draft: string, names: readonly string[]): SkillMentionToken[] {
  const found: SkillMentionToken[] = []
  for (const name of [...new Set(names)].sort((left, right) => right.length - left.length)) {
    const text = `$${name}`
    let start = draft.indexOf(text)
    while (start >= 0) {
      const end = start + text.length
      const before = draft[start - 1] ?? ''
      const free = !found.some((token) => start < token.end && end > token.start)
      if (free && (!before || /\s/u.test(before)) && !NAME_CHAR.test(draft[end] ?? ''))
        found.push({ start, end, name })
      start = draft.indexOf(text, start + 1)
    }
  }
  return found.sort((left, right) => left.start - right.start)
}

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

/** Draw selected `$skill` text as a recognisable, non-editable-looking skill marker. */
export function SkillMentionLayer({
  prompt,
  draft,
  tokens,
  skills,
  t,
}: {
  prompt: RefObject<HTMLTextAreaElement | null>
  draft: string
  tokens: readonly SkillMentionToken[]
  skills: readonly ComposerSkill[]
  t: Translate
}) {
  const layer = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLDivElement>(null)
  /** The draft offset of the marker whose details are open. */
  const [detail, setDetail] = useState<number>()
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
  const pieces: Array<{ start: number; text: string } | SkillMentionToken> = []
  let at = 0
  for (const token of tokens) {
    if (token.start > at) pieces.push({ start: at, text: draft.slice(at, token.start) })
    pieces.push(token)
    at = token.end
  }
  pieces.push({ start: at, text: draft.slice(at) })
  return (
    <div ref={layer} className="composer-mention-layer" data-testid="skill-mention-layer">
      <div ref={text} className="composer-mention-text">
        {pieces.map((piece) => {
          const skill =
            'text' in piece ? undefined : skills.find((candidate) => candidate.name === piece.name)
          return 'text' in piece || !skill ? (
            // The copy of the draft only lines the markers up; the textarea already carries its text.
            <span key={`text:${piece.start}`} aria-hidden="true">
              {'text' in piece ? piece.text : `$${piece.name}`}
            </span>
          ) : (
            <SkillMarker
              key={`skill:${piece.start}`}
              skill={skill}
              open={detail === piece.start}
              onOpenChange={(open) => setDetail(open ? piece.start : undefined)}
              t={t}
            />
          )
        })}
        {draft.endsWith('\n') ? <span aria-hidden="true"> </span> : null}
      </div>
    </div>
  )
}

/** A selected skill: a real button over its `$name` that opens the skill's details beside it. */
function SkillMarker({
  skill,
  open,
  onOpenChange,
  t,
}: {
  skill: ComposerSkill
  open: boolean
  onOpenChange(open: boolean): void
  t: Translate
}) {
  return (
    <Popover
      trigger="click"
      placement="top"
      open={open}
      onOpenChange={onOpenChange}
      title={t('composer.skill.details.title')}
      content={
        <section
          className="composer-skill-detail"
          data-testid="composer-skill-detail"
          aria-label={t('composer.skill.details.title')}
        >
          <div className="composer-skill-detail-mark" aria-hidden="true">
            <Icon name="sparkles" size={20} />
          </div>
          <h3>{skill.name}</h3>
          <dl>
            <div>
              <dt>{t('composer.skill.details.description')}</dt>
              <dd>{skill.description || t('composer.skill.details.emptyDescription')}</dd>
            </div>
            {skill.source && (
              <div>
                <dt>{t('composer.skill.details.source')}</dt>
                <dd>
                  {skill.source.scope} · {skill.source.rootKey}
                </dd>
              </div>
            )}
            {skill.priority !== undefined && (
              <div>
                <dt>{t('composer.skill.details.priority')}</dt>
                <dd>{skill.priority}</dd>
              </div>
            )}
          </dl>
        </section>
      }
    >
      <Button
        htmlType="button"
        className="composer-skill-mention"
        data-testid="composer-skill-mention"
        title={t('composer.skill.details.open')}
        aria-label={`${t('composer.skill.details.open')}: ${skill.name}`}
        // A press keeps the caret in the textarea; the click (or Enter / Space) opens the details.
        onMouseDown={(event) => event.preventDefault()}
      >
        <span className="composer-skill-mention-prefix">
          <Icon name="sparkles" size={16} className="composer-skill-mention-icon" />
        </span>
        {skill.name}
      </Button>
    </Popover>
  )
}
