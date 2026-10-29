import { installFeedbackSink, type OperationFeedback } from '../src/feedback.js'

/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  type ConfigSchema,
  configIssues,
  configSchemaSupported,
  createDocumentLocaleSource,
  providerConfigSchemas,
  SchemaConfigForm,
  UiLocaleProvider,
} from '../src/index.js'

const schema: ConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'credential', 'count', 'names'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 20, 'x-ui': { labelKey: 'name', id: 'name' } },
    credential: {
      type: 'string',
      format: 'credential-reference',
      'x-ui': { labelKey: 'credential', id: 'credential' },
    },
    count: { type: 'integer', minimum: 1, maximum: 5, 'x-ui': { labelKey: 'count', id: 'count' } },
    names: {
      type: 'array',
      maxItems: 2,
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
      'x-ui': { labelKey: 'names', id: 'names' },
    },
  },
}
function valueSetter(prototype: object) {
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new Error('Native value setter missing')
  return setter
}
const valid = { name: 'demo', credential: 'secret://demo/api-key', count: 2, names: ['one'] }

it('refuses unsupported schemas and invalid configuration without leaking credential values', () => {
  expect(configIssues(schema, valid)).toEqual([])
  for (const value of [
    { ...valid, count: 1.5 },
    { ...valid, count: 6 },
    { ...valid, names: ['one', 'one'] },
    { ...valid, credential: 'raw-secret-value' },
    { ...valid, credential: 'secret://demo/a/../../b' },
    { ...valid, unexpected: true },
    { ...valid, name: '' },
  ]) {
    const errors = configIssues(schema, value)
    expect(errors.length).toBeGreaterThan(0)
    expect(JSON.stringify(errors)).not.toContain('raw-secret-value')
  }
  for (const bad of [
    { ...schema, oneOf: [] },
    { ...schema, additionalProperties: true },
    { type: 'string', pattern: '[' },
    { type: 'object', properties: [], additionalProperties: false },
    { type: 'object', properties: {} },
    { anyOf: [{ const: 'option', type: 'boolean' }] },
    { type: 'invalid', enum: ['option'] },
    { type: 'array', uniqueItems: 'true', items: { type: 'string' } },
    { ...schema, not: { type: 'string', pattern: '[' } },
    { ...schema, not: { type: 'object', properties: {}, unevaluatedProperties: false } },
  ])
    expect(configSchemaSupported(bad as ConfigSchema)).toBe(false)
  const cycle: { type: 'object'; additionalProperties: false; properties: Record<string, ConfigSchema> } = {
    type: 'object',
    additionalProperties: false,
    properties: {},
  }
  cycle.properties.self = cycle
  expect(configSchemaSupported(cycle)).toBe(false)
  const negativeCycle: { not?: ConfigSchema } = { ...schema }
  negativeCycle.not = negativeCycle
  expect(configSchemaSupported(negativeCycle)).toBe(false)
  const excludedText: ConfigSchema = {
    ...schema,
    properties: {
      ...schema.properties,
      name: { type: 'string', maxLength: 100000, not: { type: 'string' } },
    },
  }
  expect(configIssues(excludedText, { ...valid, name: 'x'.repeat(70000) })).toContainEqual({
    path: '/name',
    code: 'choice',
  })
  const nested: ConfigSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['settings'],
    properties: { settings: schema },
  }
  expect(configIssues(nested, { settings: { ...valid, count: 0 } })).toContainEqual({
    path: '/settings/count',
    code: 'range',
  })
  expect(configIssues(providerConfigSchemas.compaction, { reserve_tokens: -1 })).toContainEqual({
    path: '/reserve_tokens',
    code: 'range',
  })
  expect(configIssues(providerConfigSchemas.sandbox, { level: 'unexpected' })).toContainEqual({
    path: '/level',
    code: 'choice',
  })
  for (const value of [
    { level: 'L1', on_unavailable: 'allow-if-unimplemented' },
    { level: 'L0', on_unavailable: 'allow' },
    { on_unavailable: 'allow-if-unimplemented' },
  ])
    expect(configIssues(providerConfigSchemas.sandbox, value)).toEqual([])
  expect(
    configIssues(providerConfigSchemas.sandbox, {
      level: 'L0',
      on_unavailable: 'allow-if-unimplemented',
      required: false,
    }),
  ).toContainEqual({ path: '', code: 'choice' })
  expect(configIssues(providerConfigSchemas.persistence, { provider: 'bad provider' })).toContainEqual({
    path: '/provider',
    code: 'pattern',
  })
})

describe('schema form actions and control semantics', () => {
  it('validates before actions, keeps multiline typing, and preserves changes after failure', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    document.documentElement.lang = 'en'
    const locale = createDocumentLocaleSource({})
    const save = vi.fn().mockRejectedValue(new Error('raw backend secret'))
    const probe = vi.fn().mockResolvedValue(undefined)
    function Harness() {
      const [value, change] = useState<Record<string, unknown>>({ ...valid, credential: 'raw-secret-value' })
      return createElement(SchemaConfigForm, {
        schema,
        value,
        onChange: change,
        onSave: save,
        onTest: probe,
        t: (key) =>
          ({ name: 'Name', credential: 'Credential reference', count: 'Count', names: 'Names' })[
            key as 'name'
          ] ?? key,
      })
    }

    await act(async () =>
      root.render(createElement(UiLocaleProvider, { source: locale.source }, createElement(Harness))),
    )
    await act(async () =>
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    expect(save).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('credential reference')
    const credential = host.querySelector<HTMLInputElement>('#credential')!
    expect(credential.getAttribute('aria-invalid')).toBe('true')
    expect(credential.getAttribute('aria-describedby')).toBe('credential-error')
    expect(host.querySelector('#credential-error')).not.toBeNull()
    const setInput = valueSetter(HTMLInputElement.prototype)
    await act(async () => {
      setInput.call(credential, valid.credential)
      credential.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const names = host.querySelector<HTMLTextAreaElement>('#names')!
    const setText = valueSetter(HTMLTextAreaElement.prototype)
    await act(async () => {
      setText.call(names, 'one\n')
      names.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(names.value).toBe('one\n')
    await act(async () => {
      setText.call(names, 'one\ntwo')
      names.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="button"]')?.click())
    expect(probe).toHaveBeenCalledWith(
      { ...valid, names: ['one', 'two'] },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    await act(async () =>
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    expect(save).toHaveBeenCalledTimes(1)
    expect(credential.value).toBe(valid.credential)
    expect(host.textContent).not.toContain('raw backend secret')
    expect(host.textContent).toContain('Your changes have been kept')
    save.mockRejectedValue({ message: 'private conflict', data: { messageKey: 'appServer.errors.conflict' } })
    await act(async () =>
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    expect(host.textContent).toContain('The resource changed. Reload the latest state before retrying.')
    await act(async () => {
      document.documentElement.lang = 'zh-CN'
      window.dispatchEvent(new Event('agnes:locale-changed'))
    })
    expect(host.textContent).toContain('资源已变更。 请重新载入最新状态后重试。')
    expect(host.textContent).not.toContain('private conflict')
    expect(credential.value).toBe(valid.credential)
    probe.mockRejectedValue({ data: { messageKey: 'appServer.errors.forbidden' } })
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="button"]')?.click())
    expect(host.textContent).toContain('此操作的权限被拒绝。 请管理员复核适用策略后再重试。')
    locale.dispose()
    document.documentElement.lang = 'en'
    await act(async () => root.unmount())
    host.remove()
  })
  it('disables read-only actions and aborts an outstanding test on disposal', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    let signal: AbortSignal | undefined
    const probe = vi.fn(async (_value, context) => {
      signal = context.signal
      await new Promise(() => {})
    })
    const props = {
      schema,
      value: valid,
      onChange: vi.fn(),
      onTest: probe,
      t: (key: string) => key.toUpperCase(),
    }
    await act(async () => root.render(createElement(SchemaConfigForm, { ...props, readOnly: true })))
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
    await act(async () => root.render(createElement(SchemaConfigForm, props)))
    await act(async () => host.querySelector<HTMLButtonElement>('button')?.click())
    expect(signal?.aborted).toBe(false)
    await act(async () => root.unmount())
    expect(signal?.aborted).toBe(true)
  })
})

it('loads a declared settings component, preserves revisions and drafts across locale changes, and isolates scopes', async () => {
  const { createSchemaSettingsComponent } = await import('../src/index.js')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const load = vi.fn(async (context) => ({ values: { ...valid, name: context.data }, revision: 7 }))
  const save = vi.fn(async (document) => ({ ...document, revision: 8 }))
  const Component = createSchemaSettingsComponent({
    schema,
    testId: 'extension-config',
    scope: (context) => String(context.data),
    canConfigure: () => true,
    load,
    save,
  })
  const english = (key: string) =>
    ({ name: 'Name', credential: 'Credential reference', count: 'Count', names: 'Names' })[key as 'name'] ??
    key
  const chinese = (key: string) =>
    ({ name: '名称', credential: '凭据引用', count: '数量', names: '名称列表' })[key as 'name'] ?? key
  await act(async () => root.render(createElement(Component, { context: { data: 'one', t: english } })))
  const name = host.querySelector<HTMLInputElement>('#name')!
  const setInput = valueSetter(HTMLInputElement.prototype)
  await act(async () => {
    setInput.call(name, 'draft')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => root.render(createElement(Component, { context: { data: 'one', t: chinese } })))
  expect(load).toHaveBeenCalledTimes(1)
  expect(name.value).toBe('draft')
  expect(host.textContent).toContain('凭据引用')
  await act(async () =>
    host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(save).toHaveBeenCalledWith(
    { values: { ...valid, name: 'draft' }, revision: 7 },
    expect.objectContaining({ data: 'one' }),
    expect.any(AbortSignal),
  )
  await act(async () =>
    host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(save.mock.calls[1]?.[0].revision).toBe(8)
  await act(async () => root.render(createElement(Component, { context: { data: 'two', t: english } })))
  expect(host.querySelector<HTMLInputElement>('#name')?.value).toBe('two')
  expect(load).toHaveBeenCalledTimes(2)
  await act(async () => root.unmount())
  host.remove()
})

it('blocks missing field translations and safely retries unavailable configuration reads', async () => {
  const { createSchemaSettingsComponent } = await import('../src/index.js')
  const host = document.createElement('div')
  const root = createRoot(host)
  const save = vi.fn()
  await act(async () =>
    root.render(
      createElement(SchemaConfigForm, {
        schema,
        value: valid,
        onChange: vi.fn(),
        onSave: save,
        t: (key) => key,
      }),
    ),
  )
  expect(host.textContent).toContain('not supported')
  expect(host.querySelector('label')).toBeNull()
  expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('private backend detail'))
    .mockRejectedValueOnce({ data: { messageKey: 'appServer.errors.unavailable' } })
    .mockResolvedValue({ values: valid })
  const Component = createSchemaSettingsComponent({
    schema,
    testId: 'retry-config',
    canConfigure: () => false,
    load,
    save,
  })
  await act(async () => root.render(createElement(Component, { context: { t: (key) => key.toUpperCase() } })))
  expect(host.textContent).not.toContain('private backend detail')
  expect(host.textContent).toContain('unavailable')
  await act(async () => host.querySelector<HTMLButtonElement>('button')?.click())
  expect(host.textContent).toContain(
    'The required backend is unavailable. Check its configuration and compatibility.',
  )
  await act(async () => host.querySelector<HTMLButtonElement>('button')?.click())
  expect(host.querySelector<HTMLInputElement>('#credential')?.disabled).toBe(true)
  expect(save).not.toHaveBeenCalled()
  await act(async () => root.unmount())
})

it.each(
  (['sandbox', 'compaction', 'persistence'] as const).flatMap((kind) =>
    (['en', 'zh-CN'] as const).map((language) => ({ kind, language })),
  ),
)(
  'renders generated $kind options with shared localized controls ($language)',
  async ({ kind, language }) => {
    const { ProviderConfigForm } = await import('../src/index.js')
    const host = document.createElement('div')
    const root = createRoot(host)
    document.documentElement.lang = language
    const locale = createDocumentLocaleSource({})
    const save = vi.fn().mockResolvedValue(undefined)
    const render = (value: Record<string, unknown>, editable = false) =>
      act(async () =>
        root.render(
          createElement(
            UiLocaleProvider,
            { source: locale.source },
            createElement(ProviderConfigForm, {
              kind,
              value,
              onChange: vi.fn(),
              ...(editable ? { onSave: save } : {}),
            }),
          ),
        ),
      )
    await render({})
    expect(host.querySelectorAll('label').length).toBe(
      Object.keys(providerConfigSchemas[kind].properties ?? {}).length,
    )
    expect(host.textContent).not.toContain('option.')
    expect(host.textContent).not.toContain('not supported')
    expect(host.querySelector('input[type="checkbox"]')).toBeNull()
    if (kind !== 'persistence') expect(host.querySelector('[role="switch"]')).not.toBeNull()
    for (const control of host.querySelectorAll<HTMLInputElement>('input, select, textarea'))
      expect(control.disabled).toBe(true)
    if (kind === 'sandbox') {
      expect(host.querySelector('option[value="allow-if-unimplemented"]')?.textContent).toBe(
        language === 'en'
          ? 'Allow only where operating system isolation is not implemented'
          : '仅在未实现操作系统隔离的平台上允许执行',
      )
      await render({ level: 'L0', on_unavailable: 'allow-if-unimplemented', required: false }, true)
      await act(async () =>
        host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      )
      expect(save).not.toHaveBeenCalled()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        language === 'en' ? 'Choose an available option.' : '请选择可用选项。',
      )
      const value = { level: 'L1', on_unavailable: 'allow-if-unimplemented', required: false }
      await render(value, true)
      await act(async () =>
        host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      )
      expect(save).toHaveBeenCalledWith(value, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    }
    await act(async () => root.unmount())
    locale.dispose()
  },
)

it('shows provider saving only for changed values and keeps the draft when saving fails', async () => {
  const { ProviderConfigForm } = await import('../src/index.js')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const outcomes: OperationFeedback[] = []
  const releaseFeedback = installFeedbackSink({ publish: (result) => outcomes.push(result), resolve() {} })
  const save = vi.fn().mockRejectedValueOnce(new Error('private failure')).mockResolvedValue(undefined)
  function Harness() {
    const [value, onChange] = useState<Record<string, unknown>>({ provider: 'disk' })
    return createElement(ProviderConfigForm, { kind: 'persistence', value, onChange, onSave: save })
  }
  await act(async () => root.render(createElement(Harness)))
  expect(host.querySelector('.agh-settings-save-bar')).toBeNull()
  const input = host.querySelector<HTMLInputElement>('input')!
  const setter = valueSetter(HTMLInputElement.prototype)
  await act(async () => {
    setter.call(input, 'memory')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(host.querySelector('.agh-settings-save-bar')).not.toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('.agh-btn--primary')?.click())
  expect(input.value).toBe('memory')
  expect(host.textContent).not.toContain('private failure')
  expect(outcomes).toHaveLength(0)
  await act(async () => host.querySelector<HTMLButtonElement>('.agh-btn--primary')?.click())
  expect(save).toHaveBeenCalledWith(
    { provider: 'memory' },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
  expect(host.querySelector('.agh-settings-save-bar')).toBeNull()
  expect(host.querySelector('.agh-settings-saved')).toBeNull()
  expect(host.querySelector('[data-tone="success"]')).toBeNull()
  expect(outcomes).toHaveLength(1)
  expect(outcomes[0]).toMatchObject({ outcome: 'success', message: 'Configuration saved.' })
  releaseFeedback()
  await act(async () => {
    setter.call(input, 'disk')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () =>
    host.querySelector<HTMLButtonElement>('.agh-settings-save-bar .agh-btn--secondary')?.click(),
  )
  expect(input.value).toBe('memory')
  await act(async () => root.unmount())
  host.remove()
})
