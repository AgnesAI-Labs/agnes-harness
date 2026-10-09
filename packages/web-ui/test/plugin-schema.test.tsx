/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
import { act, createElement, useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { PluginSchemaFields } from '../src/plugin-schema-fields.js'
import {
  pluginFormKind,
  pluginSchemaDefault,
  resolvePluginSchema,
  type PluginSchema,
} from '../src/plugin-schema-model.js'

describe('plugin schema form projection', () => {
  it.each([
    [{ type: 'object', properties: { child: { type: 'string' } } }, 'object'],
    [{ type: 'array', items: { type: 'object' } }, 'array'],
    [{ enum: ['a', 'b'] }, 'enum'],
    [{ oneOf: [{ type: 'string' }, { type: 'number' }] }, 'variant'],
    [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, 'variant'],
    [{ type: 'object', additionalProperties: { type: 'integer' } }, 'object'],
    [
      { type: 'string', format: 'date-time', default: '2026-10-09T00:00:00Z', description: 'Timestamp' },
      'string',
    ],
    [{ allOf: [{ type: 'object' }] }, 'json'],
    [{ type: 'array', prefixItems: [{ type: 'string' }], items: false }, 'json'],
    [{ type: 'string', 'x-vendor-control': true }, 'json'],
    [true, 'json'],
    [{ type: ['object', 'null'], properties: { x: { type: 'string' } } }, 'json'],
    [{ oneOf: [{ type: 'object' }], required: ['x'] }, 'json'],
  ])('chooses a control or lossless fallback for %j', (schema, kind) => {
    expect(pluginFormKind(schema, 0)).toBe(kind)
    expect(pluginFormKind(schema, 6)).toBe('json')
  })

  it('resolves nested and recursive refs with bounded defaults, without overwriting assertion siblings', () => {
    const root = {
      $defs: {
        node: {
          type: 'object',
          properties: { child: { $ref: '#/$defs/node' }, count: { type: 'integer', default: 2 } },
        },
      },
      $ref: '#/$defs/node',
    }
    expect(resolvePluginSchema(root, { $ref: '#/$defs/node' })).toEqual(root.$defs.node)
    expect(pluginSchemaDefault(root, root)).toEqual({ count: 2 })
    expect(pluginFormKind(resolvePluginSchema(root, { $ref: '#/$defs/node', required: ['child'] }), 0)).toBe(
      'json',
    )
    expect(pluginFormKind(resolvePluginSchema(root, { $ref: '#/missing' }), 0)).toBe('json')
  })

  it('renders recursive references to the depth bound, keeping the remaining subtree editable', async () => {
    const schema: PluginSchema = {
      $defs: {
        node: {
          type: 'object',
          properties: { label: { type: 'string' }, child: { $ref: '#/$defs/node' } },
          additionalProperties: false,
        },
      },
      $ref: '#/$defs/node',
    }
    const nested = (depth: number): unknown =>
      depth === 0 ? { label: 'leaf' } : { label: `level-${depth}`, child: nested(depth - 1) }
    const value = nested(8)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          createElement(PluginSchemaFields, {
            root: schema,
            schema,
            value,
            path: '',
            issues: [],
            onChange() {},
            onInvalid() {},
          }),
        ),
      )
      expect(host.querySelector('[data-testid="plugin-config-field/label"]')).not.toBeNull()
      const fallback = host.querySelector<HTMLTextAreaElement>(
        '[data-testid="plugin-config-json/child/child/child/child/child/child"]',
      )!
      expect(JSON.parse(fallback.value)).toEqual(nested(2))
      const ids = [...host.querySelectorAll('[id]')].map((node) => node.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(pluginFormKind({ $id: 'urn:child', type: 'object' }, 1)).toBe('json')
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('edits constructs, preserves unknown values across branch views and malformed JSON, and blocks plaintext secret typing', async () => {
    const schema: PluginSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Business agent name' },
        status: { enum: ['ready', 'paused'] },
        secret: { type: 'string', format: 'credential-reference' },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { count: { type: 'integer', default: 2 } },
            additionalProperties: false,
          },
        },
        choice: {
          oneOf: [
            { title: 'String', type: 'string' },
            { title: 'Object', type: 'object', properties: { enabled: { type: 'boolean', default: true } } },
          ],
        },
        raw: { allOf: [{ type: 'object' }] },
      },
      additionalProperties: { type: 'integer' },
    }
    let value: unknown = {
      status: 'ready',
      name: 'old',
      secret: 'secret://demo/key',
      rows: [],
      choice: { enabled: true, retained: 4 },
      raw: { original: true },
      custom: 3,
    }
    let invalid = false
    function Harness() {
      const [draft, setDraft] = useState(value)
      const onInvalid = useCallback((_path: string, next: boolean) => {
        invalid = next
      }, [])
      return createElement(PluginSchemaFields, {
        root: schema,
        schema,
        value: draft,
        path: '',
        issues: [],
        onInvalid,
        onChange(next) {
          value = next
          setDraft(next)
        },
      })
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(Harness)))
    const input = host.querySelector<HTMLInputElement>('[data-testid="plugin-config-field/name"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'agent')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect((value as Record<string, unknown>).name).toBe('agent')
    expect((value as Record<string, unknown>).custom).toBe(3)
    expect(host.textContent).toContain('Business agent name')
    const status = host.querySelector<HTMLSelectElement>('[data-testid="plugin-config-field/status"]')!
    await act(async () => {
      status.value = '1'
      status.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect((value as Record<string, unknown>).status).toBe('paused')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="plugin-config-add-item/rows"]')!.click(),
    )
    expect((value as Record<string, unknown>).rows).toEqual([{ count: 2 }])
    const key = host.querySelector<HTMLInputElement>('[data-testid="plugin-config-new-key/"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(key, 'extra')
      key.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="plugin-config-add-key/"]')!.click(),
    )
    expect((value as Record<string, unknown>).extra).toBe(0)
    const picker = host.querySelector<HTMLSelectElement>('[data-testid="plugin-config-variant/choice"]')!
    await act(async () => {
      picker.value = '0'
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect((value as Record<string, unknown>).choice).toEqual({ enabled: true, retained: 4 })
    const json = host.querySelector<HTMLTextAreaElement>('[data-testid="plugin-config-json/raw"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        json,
        '{\n  "typing":',
      )
      json.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(invalid).toBe(true)
    expect(json.value).toBe('{\n  "typing":')
    expect((value as Record<string, unknown>).raw).toEqual({ original: true })
    const secret = host.querySelector<HTMLInputElement>('[data-testid="plugin-config-field/secret"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        secret,
        'synthetic-plaintext',
      )
      secret.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect((value as Record<string, unknown>).secret).toBe('secret://demo/key')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        secret,
        'secret://demo/new',
      )
      secret.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect((value as Record<string, unknown>).secret).toBe('secret://demo/new')
    await act(async () => root.unmount())
    host.remove()
  })
})
