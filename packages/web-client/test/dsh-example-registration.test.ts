import { Context } from '@agnes/cordis'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientContext } from '../src/index.js'
import {
  AgnesClientService,
  CommandService,
  clientModule,
  DSH_SLOT_CATALOG_VERSION,
  dshSlotSpec,
  LocaleService,
  SessionService,
  SlotRegistry,
  ThemeService,
} from '../src/index.js'

const contexts: Context[] = []

async function makeRegistry() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const client = { sessions: { get: () => undefined } } as never
  new AgnesClientService(ctx, client)
  new CommandService(ctx, async () => true)
  new SessionService(ctx, undefined, client)
  new ThemeService(ctx, 'light')
  new LocaleService(ctx, 'zh-CN')
  const registry = (ctx as unknown as ClientContext).slots as SlotRegistry
  const spec = dshSlotSpec('conversation.input.model')
  if (!spec) throw new Error('model slot spec missing')
  registry.declare('conversation.input.model', spec, 'dsh-example-test')
  contexts.push(ctx)
  return { ctx, registry }
}

function modelModule(marker: 'a' | 'b', priority: number, broken = false) {
  const Component = () => {
    if (broken) throw new Error(`model ${marker} render failure`)
    return createElement('button', { type: 'button', 'data-demo-model': marker }, `model-${marker}`)
  }
  return {
    apply(ctx: ClientContext) {
      ctx.slots.register(
        { name: 'conversation.input.model', id: `dsh-model-picker-${marker}`, priority },
        Component,
      )
    },
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
})

describe('DSH model picker registrations', () => {
  it('lets model A shadow B at priority 10, then exposes B and finally the host fallback', async () => {
    const { ctx, registry } = await makeRegistry()
    const modelA = modelModule('a', 10)
    const modelB = modelModule('b', 20)
    const fiberA = ctx.plugin(clientModule(modelA), {
      packageId: '@agnes-examples/dsh-model-picker-a',
      rowId: 'web:@agnes-examples/dsh-model-picker-a',
      revision: 'v1',
      allowedSlots: ['conversation.input.model'],
      slotCatalogVersion: DSH_SLOT_CATALOG_VERSION,
    })
    const fiberB = ctx.plugin(clientModule(modelB), {
      packageId: '@agnes-examples/dsh-model-picker-b',
      rowId: 'web:@agnes-examples/dsh-model-picker-b',
      revision: 'v1',
      allowedSlots: ['conversation.input.model'],
      slotCatalogVersion: DSH_SLOT_CATALOG_VERSION,
    })
    await Promise.all([fiberA, fiberB])

    expect(registry.entries('conversation.input.model')).toHaveLength(2)
    expect(registry.entriesOfSlot('conversation.input.model')).toHaveLength(1)
    expect(registry.entriesOfSlot('conversation.input.model')[0]).toMatchObject({
      owner: 'web:@agnes-examples/dsh-model-picker-a',
      priority: 10,
    })
    const winner = registry.entriesOfSlot('conversation.input.model')[0]
    if (!winner) throw new Error('model winner missing')
    expect(
      (winner.component as (props: unknown) => { props: Record<string, unknown> })({}).props[
        'data-demo-model'
      ],
    ).toBe('a')

    await fiberA.dispose()
    expect(registry.entriesOfSlot('conversation.input.model')[0]).toMatchObject({
      owner: 'web:@agnes-examples/dsh-model-picker-b',
      priority: 20,
    })
    await fiberB.dispose()
    expect(registry.entriesOfSlot('conversation.input.model')).toEqual([])
  })

  it('abdicates broken A after render failure without removing B', async () => {
    const { ctx, registry } = await makeRegistry()
    const modelA = modelModule('a', 10, true)
    const modelB = modelModule('b', 20)
    const errors: { owner?: string; abdicated: boolean }[] = []
    const offError = registry.onEntryError((_name, entry, _error, info) => {
      errors.push({
        abdicated: info.abdicated,
        ...(entry.owner === undefined ? {} : { owner: entry.owner }),
      })
    })
    const fiberA = ctx.plugin(clientModule(modelA), {
      packageId: '@agnes-examples/dsh-model-picker-a',
      rowId: 'web:@agnes-examples/dsh-model-picker-a',
      revision: 'broken',
      allowedSlots: ['conversation.input.model'],
      slotCatalogVersion: DSH_SLOT_CATALOG_VERSION,
    })
    const fiberB = ctx.plugin(clientModule(modelB), {
      packageId: '@agnes-examples/dsh-model-picker-b',
      rowId: 'web:@agnes-examples/dsh-model-picker-b',
      revision: 'v1',
      allowedSlots: ['conversation.input.model'],
      slotCatalogVersion: DSH_SLOT_CATALOG_VERSION,
    })
    await Promise.all([fiberA, fiberB])

    const broken = registry.entriesOfSlot('conversation.input.model')[0]
    expect(broken?.owner).toBe('web:@agnes-examples/dsh-model-picker-a')
    if (!broken) throw new Error('broken model entry missing')
    expect(() => (broken.component as () => unknown)()).toThrow('render failure')
    registry.reportEntryError('conversation.input.model', broken, new Error('render failure'), {
      abdicate: true,
    })
    expect(errors).toEqual([{ owner: 'web:@agnes-examples/dsh-model-picker-a', abdicated: true }])
    expect(registry.entriesOfSlot('conversation.input.model')[0]?.owner).toBe(
      'web:@agnes-examples/dsh-model-picker-b',
    )
    offError()
    await fiberA.dispose()
    await fiberB.dispose()
  })

  it('rejects equal-priority model registrations as a kernel conflict', async () => {
    const { registry } = await makeRegistry()
    registry.register({ name: 'conversation.input.model', priority: 10, owner: 'a' }, () => null)
    expect(() =>
      registry.register({ name: 'conversation.input.model', priority: 10, owner: 'b' }, () => null),
    ).toThrow(/priority 10/)
  })
})
