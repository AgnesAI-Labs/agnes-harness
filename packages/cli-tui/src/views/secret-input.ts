import { type Component, CURSOR_MARKER, escapeControl } from '../component.js'
import { fitLine } from '../components/line.js'
import { parseKey } from '../keys.js'

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// Provider keys are opaque printable ASCII. Rejecting an entire invalid paste avoids silently
// changing credential material and then probing a value the user did not submit.
const PRINTABLE_SECRET = /^[\x21-\x7e]+$/
const PRINTABLE_TEXT = /^[\x20-\x7e]+$/

export type SecretInputViewOptions = {
  label?: string
  hint?: string
  /** Text prompts may be shown and may accept a blank response; secrets remain masked by default. */
  masked?: boolean
  allowEmpty?: boolean
  allowSpaces?: boolean
  onSubmit(secret: string): void
  onBack(): void
  onInvalid?(reason: 'empty' | 'invalid-characters'): void
}

function stripEdgeNewlines(value: string): string {
  return value.replace(/^(?:\r\n|[\r\n])+|(?:\r\n|[\r\n])+$/g, '')
}

function removeLastGrapheme(value: string): string {
  const segments = Array.from(GRAPHEMES.segment(value))
  const last = segments.at(-1)
  return last ? value.slice(0, last.index) : value
}

function placeCursor(line: string): string {
  const end = line.search(/\s*$/)
  return `${line.slice(0, end)}${CURSOR_MARKER}${line.slice(end)}`
}

export class SecretInputView implements Component {
  #secret = ''

  constructor(private readonly options: SecretInputViewOptions) {}

  invalidate(): void {}

  handleInput(data: string): boolean {
    const key = parseKey(data, false)
    switch (key.name) {
      case 'enter': {
        if (!this.#secret && !this.options.allowEmpty) {
          this.options.onInvalid?.('empty')
          return true
        }
        const submitted = this.#secret
        this.#secret = ''
        this.options.onSubmit(submitted)
        return true
      }
      case 'backspace':
        this.#secret = removeLastGrapheme(this.#secret)
        return true
      case 'esc':
        this.#secret = ''
        this.options.onBack()
        return true
      case 'ctrl-c':
        this.#secret = ''
        return false
      case 'char': {
        const value = stripEdgeNewlines(key.ch ?? '')
        const printable = this.options.allowSpaces ? PRINTABLE_TEXT : PRINTABLE_SECRET
        if (!value || !printable.test(value)) {
          this.options.onInvalid?.(value ? 'invalid-characters' : 'empty')
          return true
        }
        this.#secret += value
        return true
      }
      case 'unknown':
        this.options.onInvalid?.('invalid-characters')
        return true
      default:
        return false
    }
  }

  render(width: number): string[] {
    const label = escapeControl(this.options.label ?? 'API key:')
    const hint = escapeControl(this.options.hint ?? 'enter submit  escape back')
    const value = this.options.masked === false ? escapeControl(this.#secret) : '[input hidden]'
    return [placeCursor(fitLine(`${label} ${value}`, width)), fitLine(hint, width)]
  }
}
