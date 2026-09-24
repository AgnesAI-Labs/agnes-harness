import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'
import { COMPUTER_USE_ACTIONS, ComputerUseParams } from '../src/schema.js'

const HERMES_ACTIONS = [
  'capture',
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'drag',
  'scroll',
  'type',
  'key',
  'set_value',
  'wait',
  'list_apps',
  'list_windows',
  'launch_app',
  'focus_app',
] as const

describe('computer_use model schema', () => {
  it('exposes the exact fixed-Hermes action surface through one discriminator', () => {
    expect(COMPUTER_USE_ACTIONS).toEqual(HERMES_ACTIONS)
    expect(new Set(COMPUTER_USE_ACTIONS).size).toBe(HERMES_ACTIONS.length)
  })

  it('accepts the fixed schema fields and rejects unknown/raw-driver fields', () => {
    expect(
      Value.Check(ComputerUseParams, {
        action: 'click',
        element: 4,
        modifiers: ['cmd', 'windows', 'meta'],
        delivery_mode: 'foreground',
        bring_to_front: true,
        capture_after: true,
      }),
    ).toBe(true)
    expect(Value.Check(ComputerUseParams, { action: 'driver_click', x: 1, y: 2 })).toBe(false)
    expect(Value.Check(ComputerUseParams, { action: 'capture', max_elements: 10_000 })).toBe(false)
    expect(Value.Check(ComputerUseParams, { action: 'click', coordinate: [1] })).toBe(false)
    expect(Value.Check(ComputerUseParams, { action: 'click', element: 0 })).toBe(true)
    expect(Value.Check(ComputerUseParams, { action: 'click', element: -1 })).toBe(false)
  })

  it('keeps coordinate pairs exact without draft-07 tuple items, which GLM and Agnes reject', () => {
    const tupleItems: string[] = []
    const walk = (node: unknown, path: string) => {
      if (typeof node !== 'object' || node === null) return
      if (Array.isArray((node as { items?: unknown }).items)) tupleItems.push(path)
      for (const [key, value] of Object.entries(node)) walk(value, `${path}/${key}`)
    }
    walk(JSON.parse(JSON.stringify(ComputerUseParams)), '')
    expect(tupleItems).toEqual([])
    for (const field of ['coordinate', 'from_coordinate', 'to_coordinate']) {
      expect(Value.Check(ComputerUseParams, { action: 'drag', [field]: [1, 2] })).toBe(true)
      expect(Value.Check(ComputerUseParams, { action: 'drag', [field]: [1] })).toBe(false)
      expect(Value.Check(ComputerUseParams, { action: 'drag', [field]: [1, 2, 3] })).toBe(false)
      expect(Value.Check(ComputerUseParams, { action: 'drag', [field]: [1.5, 2] })).toBe(false)
    }
  })

  it('documents every model-visible field at the schema boundary', () => {
    const properties = ComputerUseParams.properties as Record<string, { description?: string }>
    expect(Object.keys(properties)).not.toHaveLength(0)
    for (const [name, schema] of Object.entries(properties))
      expect(schema.description, `${name} description`).toBeTypeOf('string')
  })
})
