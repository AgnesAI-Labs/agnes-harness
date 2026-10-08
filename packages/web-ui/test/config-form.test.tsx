/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  type ConfigSchema,
  configIssues,
  configSchemaSupported,
  providerConfigSchemas,
  SchemaConfigForm,
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
  ])
    expect(configSchemaSupported(bad as ConfigSchema)).toBe(false)
  const cycle: { type: 'object'; additionalProperties: false; properties: Record<string, ConfigSchema> } = {
    type: 'object',
    additionalProperties: false,
    properties: {},
  }
  cycle.properties.self = cycle
  expect(configSchemaSupported(cycle)).toBe(false)
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
    await act(async () => root.render(createElement(Harness)))
    await act(async () =>
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    expect(save).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('credential reference')
    const credential = host.querySelector<HTMLInputElement>('#credential')!
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setInput.call(credential, valid.credential)
      credential.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const names = host.querySelector<HTMLTextAreaElement>('#names')!
    const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
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
  const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
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
  expect(host.querySelector<HTMLInputElement>('#credential')?.disabled).toBe(true)
  expect(save).not.toHaveBeenCalled()
  await act(async () => root.unmount())
})

it.each(['sandbox', 'compaction', 'persistence'] as const)(
  'renders generated %s options with shared localized controls',
  async (kind) => {
    const { ProviderConfigForm } = await import('../src/index.js')
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () =>
      root.render(createElement(ProviderConfigForm, { kind, value: {}, onChange: vi.fn() })),
    )
    expect(host.querySelectorAll('label').length).toBe(
      Object.keys(providerConfigSchemas[kind].properties ?? {}).length,
    )
    expect(host.textContent).not.toContain('option.')
    expect(host.textContent).not.toContain('not supported')
    for (const control of host.querySelectorAll<HTMLInputElement>('input, select, textarea'))
      expect(control.disabled).toBe(true)
    await act(async () => root.unmount())
  },
)
