import { Button, Icon } from '@agnes/web-ui'
import {
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { Translate } from './locales/index.js'

export type ComposerSkill = Readonly<{ name: string; description?: string }>

/** A host-owned catalogue: this surface only renders names the host has already admitted. */
export interface ComposerSkills {
  list(signal: AbortSignal): Promise<readonly ComposerSkill[]>
}

type SkillToken = Readonly<{ start: number; end: number; query: string }>

function tokenAt(input: HTMLTextAreaElement): SkillToken | undefined {
  const before = input.value.slice(0, input.selectionStart)
  const match = /(^|\s)\$([^\s$]*)$/u.exec(before)
  if (!match) return undefined
  const start = before.length - (match[2]?.length ?? 0) - 1
  return { start, end: input.selectionStart, query: match[2] ?? '' }
}

function matches(skill: ComposerSkill, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase('en-US')
  if (!needle) return true
  return (
    skill.name.toLocaleLowerCase('en-US').includes(needle) ||
    skill.description?.toLocaleLowerCase('en-US').includes(needle) === true
  )
}

/** `$` is a picker only: choosing a row writes an explicit skill mention into the draft. */
export function SkillPicker({
  textarea,
  edit,
  skills,
  onChoose,
  t,
  disabled,
}: {
  textarea: RefObject<HTMLTextAreaElement>
  edit(start: number, end: number, text: string): void
  skills?: ComposerSkills
  /** Lets the composer decorate only skills the user actually selected. */
  onChoose?(skill: ComposerSkill): void
  t: Translate
  disabled: boolean
}) {
  const listId = useId()
  const [opened, setOpened] = useState(false)
  const [catalogue, setCatalogue] = useState<readonly ComposerSkill[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const state = useRef({ opened, active, items: catalogue.filter((skill) => matches(skill, query)) })
  const catalogueRef = useRef(catalogue)
  catalogueRef.current = catalogue
  const statusRef = useRef(status)
  statusRef.current = status
  const editRef = useRef(edit)
  editRef.current = edit
  const onChooseRef = useRef(onChoose)
  onChooseRef.current = onChoose
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const items = catalogue.filter((skill) => matches(skill, query))
  state.current = { opened, active, items }

  useEffect(() => {
    const input = textarea.current
    if (!input || !skills) return
    let disposed = false
    let request: AbortController | undefined
    const close = () => {
      request?.abort()
      request = undefined
      setOpened(false)
      setActive(0)
    }
    const open = () => {
      const token = tokenAt(input)
      if (disabledRef.current || !token) {
        close()
        return
      }
      setQuery(token.query)
      setOpened(true)
      setActive(0)
      if (catalogueRef.current.length || statusRef.current === 'loading') return
      request = new AbortController()
      setStatus('loading')
      void skills.list(request.signal).then(
        (next) => {
          if (disposed || request?.signal.aborted) return
          setCatalogue(
            [...next]
              .filter((skill) => skill.name.length > 0)
              .sort((left, right) => left.name.localeCompare(right.name, 'en-US')),
          )
          setStatus('ready')
        },
        () => {
          if (!disposed && !request?.signal.aborted) setStatus('failed')
        },
      )
    }
    const choose = (skill: ComposerSkill) => {
      const token = tokenAt(input)
      if (!token || disabledRef.current) return
      editRef.current(token.start, token.end, `$${skill.name} `)
      onChooseRef.current?.(skill)
      close()
    }
    const keydown = (event: KeyboardEvent) => {
      if (!state.current.opened || disabledRef.current || event.isComposing) return
      const current = state.current.items
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setActive(current.length ? (state.current.active + (event.key === 'ArrowDown' ? 1 : current.length - 1)) % current.length : 0)
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        if (event.key === 'Tab' && event.shiftKey) return
        const skill = current[state.current.active]
        if (!skill) return
        event.preventDefault()
        event.stopPropagation()
        choose(skill)
      }
    }
    const blur = (event: FocusEvent) => {
      if (!disabledRef.current && !(event.relatedTarget as Element | null)?.closest('[data-testid="skill-picker"]')) close()
    }
    input.addEventListener('input', open)
    input.addEventListener('click', open)
    input.addEventListener('keydown', keydown, true)
    input.addEventListener('blur', blur)
    return () => {
      disposed = true
      request?.abort()
      for (const attr of [
        'role',
        'aria-autocomplete',
        'aria-haspopup',
        'aria-expanded',
        'aria-controls',
        'aria-activedescendant',
      ])
        input.removeAttribute(attr)
      input.removeEventListener('input', open)
      input.removeEventListener('click', open)
      input.removeEventListener('keydown', keydown, true)
      input.removeEventListener('blur', blur)
    }
  }, [skills, textarea])

  useLayoutEffect(() => {
    const input = textarea.current
    if (!input || !skills || !opened || disabled) {
      for (const attr of [
        'role',
        'aria-autocomplete',
        'aria-haspopup',
        'aria-expanded',
        'aria-controls',
        'aria-activedescendant',
      ])
        input?.removeAttribute(attr)
      return
    }
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-haspopup', 'listbox')
    input.setAttribute('aria-expanded', 'true')
    input.setAttribute('aria-controls', listId)
    const skill = items[active]
    if (skill) {
      input.setAttribute('aria-activedescendant', `${listId}-${active}`)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [skills, textarea, opened, disabled, listId, items, active])

  if (!skills) return null
  return (
    <section className="composer-skills" data-testid="skill-picker" aria-label={t('composer.skill.label')}>
      {opened && !disabled && (
        <div className="skill-popup">
          <div className="skill-popup-header">
            <Icon name="sparkles" size={18} />
            <div>
              <strong>{t('composer.skill.title')}</strong>
              <p>{t('composer.skill.subtitle')}</p>
            </div>
          </div>
          <ul id={listId} role="listbox" aria-label={t('composer.skill.label')} data-testid="skill-options">
            {items.map((skill, index) => (
              <li key={skill.name} id={`${listId}-${index}`} role="option" aria-selected={active === index}>
                <Button
                  htmlType="button"
                  data-testid="skill-option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const input = textarea.current
                    const token = input && tokenAt(input)
                    if (token) {
                      edit(token.start, token.end, `$${skill.name} `)
                      onChoose?.(skill)
                    }
                    setOpened(false)
                  }}
                >
                  <span className="skill-option-name">{skill.name}</span>
                  {skill.description && <small>{skill.description}</small>}
                </Button>
              </li>
            ))}
          </ul>
          <p role="status" className="skill-status">
            {status === 'loading'
              ? t('composer.skill.loading')
              : status === 'failed'
                ? t('composer.skill.failed')
                : !items.length
                  ? t('composer.skill.empty')
                  : t('composer.skill.keyboard')}
          </p>
        </div>
      )}
    </section>
  )
}
