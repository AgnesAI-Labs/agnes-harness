import {
  defineStore,
  isWebRowId,
  packageIdFromWebRowId,
  SlotCore,
  type StoredEntry,
  webRowId,
} from '@agnes/web-slots'
import { describe, expect, it, vi } from 'vitest'

const component = () => null

describe('web slot kernel', () => {
  it('supports four kinds and priority shadowing', () => {
    const slots = new SlotCore()
    slots.declare('single', { kind: 'single', scope: 'root' })
    slots.declare('keyed', { kind: 'keyed', scope: 'root' })
    slots.declare('list', { kind: 'list', scope: 'root' })
    slots.declare('chain', { kind: 'chain', scope: 'root' })

    const singleHigh = slots.register({ name: 'single', priority: 10 }, component)
    const singleLow = slots.register({ name: 'single', priority: 1 }, component)
    expect(slots.entriesOfSlot('single')).toHaveLength(1)
    expect(slots.entriesOfSlot('single')[0]).toBe(slots.entries('single')[0])
    expect(() => slots.register({ name: 'single', priority: 1 }, component)).toThrow(/priority 1/)

    slots.register({ name: 'keyed', key: 'a', priority: 3 }, component)
    slots.register({ name: 'keyed', key: 'a', priority: 1 }, component)
    slots.register({ name: 'keyed', key: 'b', priority: 0 }, component)
    expect(slots.entriesOfSlot('keyed')).toHaveLength(2)

    slots.register({ name: 'list', id: 'one', priority: 2 }, component)
    slots.register({ name: 'list', id: 'one', priority: 0 }, component)
    slots.register({ name: 'list', id: 'two', priority: 0 }, component)
    expect(slots.entriesOfSlot('list')).toHaveLength(2)

    slots.register({ name: 'chain', priority: 0, select: () => 'first' }, component)
    slots.register({ name: 'chain', priority: 1, select: () => 'second' }, component)
    expect(slots.entriesOfSlot('chain')).toHaveLength(2)

    singleLow()
    singleHigh()
  })

  it('elects the first non-null chain selector and uses fallback after decline', () => {
    const slots = new SlotCore()
    slots.declare('chain', { kind: 'chain', scope: 'root' })
    const declined = slots.register({ name: 'chain', priority: 0, select: () => null }, component)
    const throwing = slots.register(
      {
        name: 'chain',
        priority: 1,
        select: () => {
          throw new Error('decline')
        },
      },
      component,
    )
    const winner = slots.register({ name: 'chain', priority: 2, select: () => ({ id: 'winner' }) }, component)
    expect(slots.selectChain('chain', { owner: true })?.entry).toBe(slots.entries('chain')[2])
    expect(slots.selectChain('chain', { owner: true })?.value).toEqual({ id: 'winner' })
    winner()
    expect(slots.selectChain('chain', null)).toBeUndefined()
    expect(slots.entriesOfSlot('chain')).toHaveLength(2)
    declined()
    throwing()
  })

  it('recursively collapses child declarations and advances declaration epochs', () => {
    const slots = new SlotCore()
    slots.declare('root', { kind: 'single', scope: 'root' })
    const childOff = slots.register(
      {
        name: 'root',
        children: {
          child: { kind: 'single', scope: 'session' },
        },
      },
      component,
    )
    const grandchildOff = slots.register(
      {
        name: 'child',
        children: { grandchild: { kind: 'list', scope: 'session' } },
      },
      component,
    )
    slots.register({ name: 'grandchild', id: 'x' }, component)
    expect(slots.declarationEpoch('child')).toBe(1)
    expect(slots.declarationEpoch('grandchild')).toBe(1)
    childOff()
    expect(slots.spec('child')).toBeUndefined()
    expect(slots.spec('grandchild')).toBeUndefined()
    expect(slots.entries('grandchild')).toHaveLength(0)
    expect(slots.declarationEpoch('child')).toBe(2)
    expect(slots.declarationEpoch('grandchild')).toBe(2)
    grandchildOff()
  })

  it('does not resurrect an unloaded child when its parent is declared again', () => {
    const slots = new SlotCore()
    slots.declare('root', { kind: 'single', scope: 'root' })
    const first = slots.register(
      { name: 'root', children: { child: { kind: 'list', scope: 'root' } } },
      component,
    )
    const staleChild = slots.register({ name: 'child', id: 'old' }, component)
    first()
    expect(slots.entries('child')).toHaveLength(0)
    slots.declare('root-2', { kind: 'single', scope: 'root' })
    slots.register({ name: 'root-2', children: { child: { kind: 'list', scope: 'root' } } }, component)
    expect(slots.entries('child')).toHaveLength(0)
    expect(() => staleChild()).not.toThrow()
  })

  it('keeps declaration notifications synchronous and batches render notifications', async () => {
    const slots = new SlotCore()
    const declarations: string[] = []
    const renders: string[] = []
    slots.subscribeDeclaration('late', () => declarations.push('declared'))
    slots.subscribe('late', () => renders.push('render'))
    slots.declare('late', { kind: 'list', scope: 'root' })
    expect(declarations).toEqual(['declared'])
    expect(renders).toEqual([])
    slots.register({ name: 'late', id: 'a' }, component)
    slots.register({ name: 'late', id: 'b' }, component)
    expect(renders).toEqual([])
    await Promise.resolve()
    expect(renders).toEqual(['render'])
  })

  it('does not advance declaration epoch for entry churn and does not resurrect abdicated entries', async () => {
    const slots = new SlotCore()
    slots.declare('single', { kind: 'single', scope: 'root' })
    const epoch = slots.declarationEpoch('single')
    const off = slots.register({ name: 'single', priority: 0 }, component)
    expect(slots.declarationEpoch('single')).toBe(epoch)
    const entry = slots.entries('single')[0]
    if (!entry) throw new Error('entry missing')
    slots.reportEntryError('single', entry, new Error('render'), { abdicate: true })
    expect(slots.entriesOfSlot('single')).toEqual([])
    off()
    expect(slots.declarationEpoch('single')).toBe(epoch)
    await Promise.resolve()
  })

  it('injects ahead of declaration and cleans up on collapse', () => {
    const slots = new SlotCore()
    const register = vi.fn(() => () => undefined)
    const dispose = slots.inject('future', register)
    slots.declare('future', { kind: 'single', scope: 'root' })
    expect(register).toHaveBeenCalledTimes(1)
    dispose()
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('abdicates a failed shadowing entry once and exposes the fallback', () => {
    const slots = new SlotCore()
    slots.declare('safe', { kind: 'single', scope: 'root' })
    const high = slots.register({ name: 'safe', priority: 0 }, component)
    const fallback = slots.register({ name: 'safe', priority: 1 }, component)
    const entry = slots.entries('safe')[0] as StoredEntry
    slots.reportEntryError('safe', entry, new Error('boom'), { abdicate: true })
    expect(slots.entriesOfSlot('safe')[0]).toBe(slots.entries('safe')[1])
    slots.reportEntryError('safe', entry, new Error('again'), { abdicate: true })
    expect(slots.entries('safe')).toHaveLength(2)
    high()
    fallback()
  })

  it('pins a store handle to one scope and releases it after removal', () => {
    const slots = new SlotCore()
    slots.declare('root', { kind: 'single', scope: 'root' })
    slots.declare('session', { kind: 'single', scope: 'session' })
    const handle = defineStore({ initial: 0 })
    const off = slots.register({ name: 'root', store: handle }, component)
    expect(() => slots.register({ name: 'session', store: handle }, component)).toThrow(/one scope/)
    off()
    expect(() => slots.register({ name: 'session', store: handle }, component)).not.toThrow()
  })

  it('uses daemon-owned web row ids and removes withdrawn package contributions', () => {
    expect(webRowId('@acme/panel')).toBe('web:@acme/panel')
    expect(isWebRowId('web:@acme/panel')).toBe(true)
    expect(packageIdFromWebRowId('web:@acme/panel')).toBe('@acme/panel')
    expect(isWebRowId('panel')).toBe(false)
    expect(() => webRowId('web:forged')).toThrow(/invalid package id/)

    const slots = new SlotCore()
    slots.declare('root', { kind: 'list', scope: 'root' })
    const off = slots.register({ name: 'root', id: 'panel', owner: '@acme/panel' }, component)
    slots.removeOwner('@acme/panel')
    expect(slots.entries('root')).toHaveLength(0)
    expect(() => off()).not.toThrow()
  })

  it('retains idempotent key removal for legacy registry callers', () => {
    const slots = new SlotCore()
    slots.declare('root', { kind: 'single', scope: 'root' })
    const off = slots.register({ name: 'root' }, component)
    const entry = slots.entries('root')[0]
    expect(entry).toBeDefined()
    if (!entry) return
    slots.remove(entry.key)
    slots.remove(entry.key)
    expect(slots.entries('root')).toHaveLength(0)
    expect(() => off()).not.toThrow()
  })
})
