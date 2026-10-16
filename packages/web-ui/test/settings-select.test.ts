/** @vitest-environment happy-dom */
import { createElement } from 'react'
import { afterEach, expect, it } from 'vitest'
import {
  materializeSettingsControls,
  mountRegion,
  SettingsOptionSelect,
  setSettingsSelectOptions,
} from '../src/index.js'

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

it('renders grouped settings options through React before the native picker reads them', () => {
  const host = document.createElement('div')
  document.body.append(host)
  dispose = mountRegion(host, createElement(SettingsOptionSelect, { id: 'config-provider' }))
  const select = host.querySelector<HTMLSelectElement>('#config-provider')
  if (!select) throw new Error('provider select missing')

  setSettingsSelectOptions(
    select,
    [{ label: '选择 Provider', value: '' }],
    [
      { label: 'API Key', options: [{ label: 'OpenAI', value: 'openai' }] },
      { label: '订阅登录', options: [{ label: 'OpenAI · 订阅登录', value: 'openai:oauth' }] },
    ],
  )

  expect(select.querySelectorAll('optgroup')).toHaveLength(2)
  expect([...select.options].map(({ value }) => value)).toEqual(['', 'openai', 'openai:oauth'])
  select.value = 'openai:oauth'
  setSettingsSelectOptions(
    select,
    [{ label: '选择 Provider', value: '' }],
    [{ label: '订阅登录', options: [{ label: 'OpenAI · 订阅登录', value: 'openai:oauth' }] }],
  )
  expect(select.value).toBe('openai:oauth')
  expect(select.querySelector('optgroup')?.label).toBe('订阅登录')
})

it('materializes static fields without changing form values, constraints or bound control identity', () => {
  const host = document.createElement('div')
  document.body.append(host)
  host.innerHTML = `<form>
    <label class="form-field"><span>Endpoint</span><template data-agnes-control="input" id="endpoint" name="endpoint" type="url" required autocomplete="url" maxlength="128" aria-describedby="endpoint-help" data-testid="endpoint-field" value="https://example.invalid"></template></label>
    <template data-agnes-control="select" id="transport" name="transport"><optgroup label="Local"><option value="stdio">stdio</option></optgroup><option value="http" selected>HTTP</option></template>
    <template data-agnes-control="textarea" id="draft" name="draft" rows="3" spellcheck="false">first\nsecond</template>
    <template data-agnes-control="input" name="locale" type="radio" value="en" checked></template>
    <template data-agnes-control="input" name="locale" type="radio" value="zh-CN"></template>
  </form>`
  materializeSettingsControls(host)
  const form = host.querySelector('form')!
  const endpoint = host.querySelector<HTMLInputElement>('#endpoint')!
  const select = host.querySelector<HTMLSelectElement>('#transport')!
  const draft = host.querySelector<HTMLTextAreaElement>('#draft')!
  expect(endpoint.type).toBe('url')
  expect(endpoint.required).toBe(true)
  expect(endpoint.maxLength).toBe(128)
  expect(endpoint.autocomplete).toBe('url')
  expect(endpoint.getAttribute('aria-describedby')).toBe('endpoint-help')
  expect(endpoint.getAttribute('data-testid')).toBe('endpoint-field')
  expect(select.value).toBe('http')
  expect([...select.options].map((option) => option.value)).toEqual(['stdio', 'http'])
  expect(select.querySelector('optgroup')?.label).toBe('Local')
  expect(draft.value).toBe('first\nsecond')
  // happy-dom exposes rows as a string; the materializer must preserve the exact HTML constraint.
  expect(draft.getAttribute('rows')).toBe('3')
  expect(new FormData(form).get('locale')).toBe('en')
  endpoint.value = 'https://changed.invalid'
  select.value = 'stdio'
  materializeSettingsControls(host)
  expect(host.querySelector('#endpoint')).toBe(endpoint)
  expect(new FormData(form).get('endpoint')).toBe('https://changed.invalid')
  expect(new FormData(form).get('transport')).toBe('stdio')
  endpoint.value = ''
  expect(endpoint.checkValidity()).toBe(false)
  expect(host.querySelector('template[data-agnes-control]')).toBeNull()
})

it('preserves an unavailable saved value in native and rich selects and exposes field states', async () => {
  const { Field, Select, SettingsInput, SettingsSelect, SettingsTextArea } = await import('../src/index.js')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = mountRegion(
    host,
    createElement(
      'div',
      {},
      createElement(
        Field,
        { label: 'Invalid', error: 'Enter a value.' },
        createElement(SettingsInput, { id: 'invalid', value: '', onChange() {} }),
      ),
      createElement(SettingsInput, { id: 'readonly', readOnly: true, value: 'kept' }),
      createElement(SettingsTextArea, { id: 'disabled', disabled: true }),
      createElement(
        SettingsSelect,
        { id: 'native', value: 'removed', onChange() {} },
        createElement('option', { value: 'available' }, 'Available'),
      ),
      createElement(Select, { value: 'removed', options: [{ value: 'available', label: 'Available' }] }),
      createElement(SettingsSelect, { id: 'native-empty', value: 'removed', onChange() {} }),
      createElement(Select, { id: 'rich-empty', value: 'removed', options: [] }),
      createElement(
        SettingsSelect,
        { id: 'native-readonly', value: 'kept', readOnly: true },
        createElement('option', { value: 'kept' }, 'Kept'),
      ),
      createElement(
        SettingsSelect,
        { id: 'disabled-group', value: 'kept', onChange() {} },
        createElement(
          'optgroup',
          { label: 'Unavailable', disabled: true },
          createElement('option', { value: 'kept' }, 'Kept'),
        ),
      ),
    ),
  )
  expect(host.querySelector('#invalid')?.getAttribute('aria-invalid')).toBe('true')
  expect(host.querySelector<HTMLInputElement>('#readonly')?.readOnly).toBe(true)
  expect(host.querySelector<HTMLTextAreaElement>('#disabled')?.disabled).toBe(true)
  const native = host.querySelector<HTMLSelectElement>('#native')!
  expect(host.querySelector('#native-readonly')?.getAttribute('aria-readonly')).toBe('true')
  expect(host.querySelector('#disabled-group')?.getAttribute('aria-invalid')).toBe('true')
  expect(host.querySelector<HTMLSelectElement>('#native-empty')?.value).toBe('removed')
  expect(host.querySelector('#native-empty')?.getAttribute('aria-invalid')).toBe('true')
  expect(host.querySelector('#rich-empty')?.getAttribute('aria-invalid')).toBe('true')
  expect(native.value).toBe('removed')
  expect(native.getAttribute('aria-invalid')).toBe('true')
  expect(native.selectedOptions[0]?.disabled).toBe(true)
  expect(host.querySelector('.agnes-ui-select [aria-invalid]')?.getAttribute('aria-invalid')).toBe('true')
  expect(host.querySelector('.agnes-ui-select')?.textContent).toContain('removed')
})
