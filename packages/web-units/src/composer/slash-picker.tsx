import { Button } from '@agnes/web-ui'
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { Translate } from '../locales/index.js'
import type { ComposerView } from './contracts.js'
import { bindComposerListbox } from './listbox-aria.js'

type Commands = NonNullable<ComposerView['input']['commands']>
type Command = Commands[number]

function commandWord(input: HTMLTextAreaElement): string | undefined {
  const { value, selectionStart, selectionEnd } = input
  if (selectionStart < 1 || selectionStart !== selectionEnd) return undefined
  const match = /^\/([^\s/]*)$/u.exec(value)
  // JavaScript's dollar anchor can also match before a trailing newline.
  return match?.[0] === value ? match[1] : undefined
}

/** Completes a whole slash word. The host routes the resulting draft through normal submission. */
export function SlashPicker({
  textarea,
  edit,
  commands,
  t,
}: {
  textarea: RefObject<HTMLTextAreaElement | null>
  edit(start: number, end: number, text: string): void
  commands: Commands
  t: Translate
}) {
  const listId = useId()
  const [word, setWord] = useState<string>()
  const [active, setActive] = useState(0)
  const dismissed = useRef<string>()
  const items = word === undefined ? [] : commands.filter((command) => command.startsWith(word))
  const selected = items[active] ?? items[0]
  const keyboard = useRef({ word, items, selected, choose })
  keyboard.current = { word, items, selected, choose }

  function choose(command: Command): void {
    const input = textarea.current
    if (!input || commandWord(input) !== word || !items.includes(command)) return
    edit(0, input.value.length, `/${command} `)
    setWord(undefined)
  }

  useEffect(() => {
    const input = textarea.current
    if (!input) return
    const update = () => {
      if (document.activeElement !== input) return
      const next = dismissed.current === input.value ? undefined : commandWord(input)
      if (next === keyboard.current.word) return
      setWord(next)
      setActive(0)
    }
    const typed = () => {
      dismissed.current = undefined
      update()
    }
    const close = () => {
      setWord(undefined)
      setActive(0)
    }
    const caret = (event: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) update()
    }
    const keydown = (event: KeyboardEvent) => {
      const { word, items, selected, choose } = keyboard.current
      if (
        !selected ||
        word !== commandWord(input) ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.shiftKey ||
        event.altKey ||
        ((event.ctrlKey || event.metaKey) && event.key !== 'Enter')
      )
        return
      switch (event.key) {
        case 'Escape':
          dismissed.current = input.value
          close()
          break
        case 'ArrowDown':
        case 'ArrowUp':
          setActive(
            (items.indexOf(selected) + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length,
          )
          break
        case 'Enter':
        case 'Tab':
          choose(selected)
          break
        default:
          return
      }
      event.preventDefault()
      event.stopPropagation()
    }
    input.addEventListener('input', typed)
    input.addEventListener('focus', update)
    input.addEventListener('click', update)
    input.addEventListener('select', update)
    input.addEventListener('keyup', caret)
    input.addEventListener('blur', close)
    input.addEventListener('keydown', keydown, true)
    if (document.activeElement === input) update()
    return () => {
      input.removeEventListener('input', typed)
      input.removeEventListener('focus', update)
      input.removeEventListener('click', update)
      input.removeEventListener('select', update)
      input.removeEventListener('keyup', caret)
      input.removeEventListener('blur', close)
      input.removeEventListener('keydown', keydown, true)
    }
  }, [textarea])

  useLayoutEffect(() => {
    const input = textarea.current
    if (!input || !selected) return
    return bindComposerListbox(input, listId, `${listId}-${selected}`)
  }, [listId, selected, textarea])

  if (!selected) return null
  return (
    <div className="composer-slash">
      <div id={listId} className="slash-popup" role="listbox" aria-label={t('composer.slash.label')}>
        {items.map((command) => (
          <Button
            key={command}
            id={`${listId}-${command}`}
            appearance="ghost"
            className="slash-option"
            role="option"
            aria-selected={selected === command}
            tabIndex={-1}
            htmlType="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(command)}
          >
            <span translate="no">/{command}</span>
            <small>{t(`composer.slash.${command}`)}</small>
          </Button>
        ))}
      </div>
    </div>
  )
}
