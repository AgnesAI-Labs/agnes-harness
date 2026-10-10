import type { RuntimeDescriptor } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { DecisionSelection } from '../src/decision-selection.js'

const jevloop: RuntimeDescriptor = {
  id: 'jevloop',
  version: '1',
  label: 'JevLoop',
  apiVersion: 1,
  available: true,
  capabilities: { prompt: true, cancel: true, resume: true, compact: false, fork: false },
  defaultDecisionBackend: 'jev',
  decisionBackends: [
    { backend: 'jev', label: 'Jev', available: true },
    { backend: 'laya', label: 'Laya', available: false, unavailableReason: '未配置或未启用' },
  ],
}

it('follows the trusted default, keeps drafts per scope, and refuses unavailable choices', () => {
  const selection = new DecisionSelection()
  selection.update('draft', jevloop)
  expect(selection.options).toHaveLength(2)
  expect(selection.selected).toBe('jev')
  expect(selection.submission()).toEqual({ decisionBackend: 'jev' })
  expect(() => selection.select('laya')).toThrow('不可用')
  selection.select('jev')
  expect(selection.selected).toBe('jev')

  // Each session or comparison target owns its own draft choice.
  selection.update('session-a', jevloop)
  expect(selection.selected).toBe('jev')
  selection.update('draft', undefined)
  expect(selection.options).toEqual([])
  expect(selection.submission()).toEqual({})
  selection.update('session-a', jevloop)
  expect(selection.selected).toBe('jev')
})

it('blocks sending when the selected backend is unavailable and honors an explicit restore', () => {
  const selection = new DecisionSelection()
  selection.update('draft', jevloop, undefined, 'laya')
  expect(selection.selected).toBe('laya')
  expect(selection.available).toBe(false)
  expect(() => selection.submission()).toThrow('不可用')
  selection.restore('jev')
  expect(selection.submission()).toEqual({ decisionBackend: 'jev' })
})
