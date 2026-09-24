import { type HTMLElement as HappyElement, Window } from 'happy-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { createProviderPicker } from '../src/provider-picker.js'

let window: Window
afterEach(() => {
  vi.unstubAllGlobals()
  window?.happyDOM.abort()
})

function setup() {
  window = new Window()
  vi.stubGlobal('window', window)
  const doc = window.document
  doc.body.innerHTML = `<dialog open><label>Provider<select id="config-provider">
    <option value="">选择 Provider</option>
    <optgroup label="API Key"><option value="deepseek">DeepSeek</option>
      <option value="openai">OpenAI</option><option value="unavailable" disabled>Unavailable</option></optgroup>
    <optgroup label="订阅登录"><option value="openai:oauth">OpenAI · 订阅登录</option></optgroup>
    <optgroup label="disabled" disabled><option value="blocked">Blocked</option></optgroup>
    </select></label><input id="next" /></dialog>`
  const select = doc.querySelector('select') as unknown as HTMLSelectElement
  select.value = 'deepseek'
  const picker = createProviderPicker(select)
  const trigger = doc.querySelector('button') as unknown as HTMLButtonElement
  const key = (value: string) => {
    const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
    trigger.dispatchEvent(event as unknown as Event)
    return event
  }
  return { doc, select, picker, trigger, key }
}

it('renders catalogue groups and selection without changing provider/auth values', () => {
  const h = setup()
  const changed = vi.fn()
  h.select.addEventListener('change', changed)
  h.trigger.click()
  expect(h.select.hidden).toBe(true)
  expect(h.doc.querySelector('label')?.htmlFor).toBe(h.trigger.id)
  expect(h.doc.querySelectorAll('[role="group"]')).toHaveLength(2)
  expect(h.doc.querySelectorAll('[role="option"]')).toHaveLength(3)
  expect(h.doc.querySelector('[aria-selected="true"]')?.textContent).toBe('DeepSeek✓')
  h.doc.querySelectorAll<HappyElement>('[role="option"]')[2]?.click()
  expect(h.select.value).toBe('openai:oauth')
  expect(changed).toHaveBeenCalledOnce()
  expect(h.trigger.textContent).toBe('OpenAI · 订阅登录')
  expect(h.doc.querySelector('[role="listbox"]')).toBeNull()
  h.trigger.click()
  h.doc.querySelectorAll<HappyElement>('[role="option"]')[2]?.click()
  expect(changed).toHaveBeenCalledOnce()
})

it('supports arrows, Home/End, typeahead and Enter; Escape cancels without closing the dialog', () => {
  const h = setup()
  h.trigger.focus()
  h.key('ArrowDown')
  h.key('End')
  expect(h.trigger.getAttribute('aria-activedescendant')).toBe('config-provider-listbox-2')
  h.key('Home')
  h.key('o')
  expect(h.trigger.getAttribute('aria-activedescendant')).toBe('config-provider-listbox-1')
  h.key('Enter')
  expect(h.select.value).toBe('openai')
  h.key(' ')
  h.key('ArrowUp')
  h.key('Escape')
  expect(h.select.value).toBe('openai')
  expect(h.doc.querySelector('dialog')?.open).toBe(true)
  expect(h.trigger.getAttribute('aria-expanded')).toBe('false')
  expect(h.doc.activeElement?.id).toBe(h.trigger.id)
})

it('preserves Tab navigation and dismisses on outside interaction and parent close', () => {
  const h = setup()
  h.trigger.click()
  expect(h.key('Tab').defaultPrevented).toBe(false)
  expect(h.trigger.getAttribute('aria-expanded')).toBe('false')
  h.trigger.click()
  h.doc.querySelector('#next')?.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
  expect(h.doc.querySelector('[role="listbox"]')).toBeNull()
  h.trigger.click()
  h.doc.querySelector('dialog')?.dispatchEvent(new window.Event('close'))
  expect(h.doc.querySelector('[role="listbox"]')).toBeNull()
})

it('syncs programmatic changes, loading/locked accounts and an empty catalogue', () => {
  const h = setup()
  h.trigger.click()
  h.select.value = 'openai:oauth'
  h.select.disabled = true
  h.picker.sync()
  expect(h.trigger.disabled).toBe(true)
  expect(h.trigger.textContent).toBe('OpenAI · 订阅登录')
  expect(h.doc.querySelector('[role="listbox"]')).toBeNull()
  h.trigger.click()
  expect(h.doc.querySelector('[role="listbox"]')).toBeNull()
  h.select.disabled = false
  h.select.innerHTML = '<option value="">无可用 Provider</option>'
  h.picker.sync()
  expect(h.trigger.textContent).toBe('无可用 Provider')
  expect(h.trigger.disabled).toBe(true)
})
