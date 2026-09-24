import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { Renderer } from '../src/tui/renderer.js'
import { displayWidth, FakeTerminal } from '../src/tui/terminal.js'
import { AuthMethodView } from '../src/tui/views/auth-method.js'
import { SecretInputView } from '../src/tui/views/secret-input.js'
import { emulate } from './tui/harness.js'

describe('AuthMethodView', () => {
  it.each([40, 80, 120])('renders the two product choices and hint within %i columns', (width) => {
    const view = new AuthMethodView({ onChoose: () => {}, onCancel: () => {} })
    const lines = view.render(width)
    expect(lines.map((line) => line.trimEnd())).toMatchSnapshot()
    expect(lines.every((line) => displayWidth(line) === width)).toBe(true)
    expect(lines.join('\n')).toContain('Sign in with an Agnes account')
    expect(lines.join('\n')).toContain('Sign in with an API key')
    expect(lines.map((line) => line.trimEnd()).join(' ')).toContain(
      '↑↓ navigate  enter select  escape/ctrl+c cancel',
    )
  })

  it('reuses Select navigation, root Escape cancels, and Ctrl-C stays with the outer ladder', () => {
    const choose = vi.fn()
    const cancel = vi.fn()
    const view = new AuthMethodView({ onChoose: choose, onCancel: cancel })
    expect(view.handleInput('\x1b[B')).toBe(true)
    expect(view.handleInput('\r')).toBe(true)
    expect(choose).toHaveBeenCalledWith('api-key')
    expect(view.handleInput('\x1b')).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(view.handleInput('\x03')).toBe(false)
  })

  it('can honor an API-key preflight suggestion without changing Select behavior', () => {
    const choose = vi.fn()
    const view = new AuthMethodView({ suggested: 'api-key', onChoose: choose, onCancel: () => {} })
    view.handleInput('\r')
    expect(choose).toHaveBeenCalledWith('api-key')
  })
})

describe('SecretInputView', () => {
  it.each([40, 80, 120])('never renders the secret at %i columns', async (width) => {
    const secret = 'sk-render-sentinel-879023'
    const view = new SecretInputView({ onSubmit: () => {}, onBack: () => {} })
    const emptyFrame = view.render(width)
    view.handleInput(secret)
    const secretFrame = view.render(width)
    const direct = secretFrame.join('\n')
    expect(direct).not.toContain(secret)
    expect(JSON.stringify(view)).not.toContain(secret)
    expect(secretFrame).toEqual(emptyFrame)
    expect(secretFrame.every((line) => displayWidth(line) === width)).toBe(true)
    expect(secretFrame.map((line) => line.replaceAll('\x00CUR\x00', '').trimEnd())).toMatchSnapshot()

    const term = new FakeTerminal({ columns: width, rows: 5 })
    const renderer = new Renderer(term, view)
    renderer.start()
    try {
      const rendered = term.writes.join('')
      expect(rendered).not.toContain(secret)
      expect((await emulate(term, width, 5)).lines.join('\n')).not.toContain(secret)
    } finally {
      renderer.stop()
    }
  })

  it('strips pasted edge newlines, submits once, clears, backspaces, and child Escape goes back', () => {
    const submitted = vi.fn()
    const back = vi.fn()
    const invalid = vi.fn()
    const view = new SecretInputView({ onSubmit: submitted, onBack: back, onInvalid: invalid })
    expect(view.handleInput('\r\nsk-test-key\r\n')).toBe(true)
    expect(view.handleInput('\x7f')).toBe(true)
    expect(view.handleInput('y')).toBe(true)
    expect(view.handleInput('\r')).toBe(true)
    expect(submitted).toHaveBeenCalledExactlyOnceWith('sk-test-key')
    expect(view.render(80).join('\n')).not.toContain('sk-test-key')
    expect(view.handleInput('\x1b')).toBe(true)
    expect(back).toHaveBeenCalledOnce()
    expect(view.handleInput('\x03')).toBe(false)
  })

  it('rejects empty, whitespace and non-printable input without echoing it', () => {
    const submit = vi.fn()
    const invalid = vi.fn()
    const view = new SecretInputView({
      label: 'Key\u001b[2J:',
      hint: 'Enter\u0007 submit',
      onSubmit: submit,
      onBack: () => {},
      onInvalid: invalid,
    })
    view.handleInput('\r')
    view.handleInput('   ')
    view.handleInput('abc\u0007def')
    view.handleInput('\r')
    expect(submit).not.toHaveBeenCalled()
    expect(invalid).toHaveBeenCalled()
    const rendered = view.render(80).join('\n')
    expect(rendered).not.toContain('\u001b')
    expect(rendered).not.toContain('\u0007')
  })

  it('shows an explicit text prompt and can submit the blank Copilot enterprise default', () => {
    const submit = vi.fn()
    const view = new SecretInputView({
      label: 'Enterprise domain',
      masked: false,
      allowEmpty: true,
      allowSpaces: true,
      onSubmit: submit,
      onBack: () => {},
    })
    view.handleInput('github.example.com')
    expect(view.render(80).join('\n')).toContain('github.example.com')
    view.handleInput('\r')
    expect(submit).toHaveBeenCalledWith('github.example.com')
    view.handleInput('\r')
    expect(submit).toHaveBeenCalledWith('')
  })
})

it('keeps onboarding and TUI view imports behind their dependency boundaries', async () => {
  const urls = [
    new URL('../src/tui/views/auth-method.ts', import.meta.url),
    new URL('../src/tui/views/secret-input.ts', import.meta.url),
    new URL('../src/onboarding/state.ts', import.meta.url),
    new URL('../src/onboarding/controller.ts', import.meta.url),
  ]
  const sources = await Promise.all(urls.map((url) => readFile(url, 'utf8')))
  for (const source of sources) {
    expect(source).not.toMatch(/@agnes\/(?:host|ai)/)
    expect(source).not.toMatch(/node:(?:fs|http|https|net)/)
    expect(source).not.toMatch(/\bfetch\s*\(/)
  }
  for (const source of sources.slice(0, 2)) expect(source).not.toMatch(/onboarding\//)
})
