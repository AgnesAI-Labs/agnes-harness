import type {
  HookContext,
  HookPayloadMap,
  PluginContextFacets,
  ProjectionDef,
  ProjectionEvent,
  ServiceContext,
  ServiceDef,
} from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { main } from '../index.mjs'
import { catalog } from '../src/locales.mjs'
import { compactMetadata, contextMetadata, metadataProjection } from '../src/metadata.mjs'

function fixture() {
  type Handler = (payload: unknown, ctx: HookContext) => unknown
  const hooks = new Map<string, Handler>()
  let service: ServiceDef
  let projection: ProjectionDef
  const events: { type: string; data: ProjectionEvent['data'] }[] = []
  let fail = false
  const stop = main.apply({
    self: { extId: 'agnes/context-doctor' },
    hooks: {
      register(name: string, handler: Handler) {
        hooks.set(name, handler)
        return () => {
          hooks.delete(name)
        }
      },
    },
    projections: {
      register(def: ProjectionDef) {
        projection = def
        return () => {}
      },
    },
    services: {
      register(def: ServiceDef) {
        service = def
        return () => {}
      },
    },
    eventLog: {
      async append(_name: string, value: ProjectionEvent['data']) {
        if (fail) throw new Error('storage failure with private diagnostic')
        events.push({ type: 'x/agnes/context-doctor/snapshot', data: structuredClone(value) })
        return events.length
      },
    },
  } as unknown as PluginContextFacets)
  const context = (id = 'selected', lane = 'main', signal = new AbortController().signal) =>
    ({
      session: { key: id, lane, workspaceRoot: '/private/workspace' },
      signal,
      replayed: false,
    }) as HookContext
  return {
    hooks,
    events,
    context,
    stop,
    emit: (name: string, payload: unknown, ctx = context()) => {
      const handler = hooks.get(name)
      if (!handler) throw new Error('Missing hook')
      return handler(payload, ctx)
    },
    read: (id?: string, lane?: string, input = {}) =>
      service.handler(input, context(id, lane) as unknown as ServiceContext),
    projection: () => projection,
    fail: () => {
      fail = true
    },
  }
}
const surface = () => [
  { seq: 1, type: 'user/message' as const, pinned: true, tokensEstimate: 8 },
  { seq: 2, type: 'assistant/message' as const, tokensEstimate: 7 },
  { seq: 3, type: 'tool/result' as const },
]
const contextPayload = (text: string): HookPayloadMap['context'] => ({
  sections: [
    { id: 'agents-md', order: 120, content: text, source: '/private/AGENTS.md' },
    { id: 'memory:index', order: 131, content: 'private memory', source: '/private/memory' },
    { id: '/private/unknown-section', order: 150, content: 'private body' },
  ],
  surfaceDigest: { nodes: 3, tokensEstimate: 15 },
  getSurface: surface,
})
const request = (slot = 'main'): HookPayloadMap['before_request'] =>
  ({
    slot,
    model: '/private/model',
    attempt: 1,
    request: {
      model: '/private/model',
      slot,
      messageCount: 3,
      toolNames: ['private_tool'],
      samplingParams: { private: 'secret' },
    },
  }) as HookPayloadMap['before_request']

describe('context metadata MVP', () => {
  it.each(['English rules', '中文规则'])(
    'separates observed rule/memory estimates without storing text: %s',
    async (text) => {
      const f = fixture()
      const payload = contextPayload(text)
      const original = structuredClone({ sections: payload.sections, surface: payload.getSurface() })
      expect(await f.emit('context', payload)).toEqual({ refreshOnRequest: true })
      expect(await f.emit('before_request', request())).toEqual({})
      const value = await f.read()
      expect(value).toMatchObject({
        status: 'live',
        snapshot: {
          context: {
            groups: {
              rules: { characters: text.length, heuristicTokens: Math.ceil(text.length / 4) },
              memory: { characters: 14, heuristicTokens: 4 },
            },
            surface: { missingEstimates: 1, pinned: 1, results: 1 },
          },
          request: { slot: 'main', toolNamesCount: 1, model: null, contextWindow: null },
        },
      })
      expect(JSON.stringify(f.events)).not.toMatch(
        /private|中文规则|English rules|secret|memory:index|agents-md/,
      )
      expect({ sections: payload.sections, surface: payload.getSurface() }).toEqual(original)
      expect(await f.read('other')).toMatchObject({ status: 'unknown', snapshot: null })
      expect(await f.read('selected', 'other-lane')).toMatchObject({ status: 'unknown' })
      await expect(f.read('selected', 'main', { sessionId: 'other' })).rejects.toThrow('unavailable')
      f.stop()
      expect(f.hooks.size).toBe(0)
      await expect(f.read()).rejects.toThrow('unavailable')
    },
  )

  it('records observed compaction ranges, window changes and unknown retention/offload facts without transforming input', async () => {
    const f = fixture()
    for (const contextWindow of [8192, 32768]) {
      const before = {
        contextTokens: 9000,
        contextWindow,
        reserveTokens: 1024,
        reason: 'overflow',
        getSurface: surface,
        customInstructions: 'private compaction instruction',
      }
      expect(await f.emit('before_compact', before)).toBeNull()
      expect(before.getSurface()).toEqual(surface())
      expect(await f.read()).toMatchObject({
        snapshot: {
          beforeCompact: {
            contextWindow,
            previousContextWindow: contextWindow === 8192 ? null : 8192,
            surface: { pinned: 1, results: 1 },
          },
        },
      })
    }
    const compact = Object.freeze({
      replaceSeq: 8,
      range: [1, 3] as [number, number],
      tokensBefore: 9000,
      tokensAfter: 20,
    })
    expect(await f.emit('compact', compact)).toBeUndefined()
    expect(await f.read()).toMatchObject({
      snapshot: {
        compact: {
          range: [1, 3],
          tokensAfterEstimate: 20,
          retainedPairs: null,
          retainedPins: null,
          omissions: null,
          offloadedBytes: null,
        },
      },
    })
    expect(JSON.stringify(f.events)).not.toContain('private')
    await f.emit('before_request', request('private_slot'))
    expect(await f.read()).toMatchObject({ snapshot: { request: { slot: null, contextWindow: null } } })
    f.stop()
  })

  it('keeps huge output estimates bounded and unavailable fields unknown, including old history', async () => {
    const f = fixture()
    expect(await f.read()).toMatchObject({ status: 'unknown' })
    const payload = contextPayload('x'.repeat(2_000_000))
    payload.getSurface = () => [{ seq: 8, type: 'tool/result', tokensEstimate: 300_000 }]
    await f.emit('context', payload)
    expect(JSON.stringify(f.events).length).toBeLessThan(4096)
    expect(
      contextMetadata({ sections: [], surfaceDigest: { nodes: 0, tokensEstimate: 0 }, getSurface: () => [] }),
    ).toMatchObject({
      groups: { rules: null, memory: null, other: null },
      digestNodes: 0,
    })
    expect(compactMetadata({ range: [1, 2] } as unknown as HookPayloadMap['compact'])).toMatchObject({
      tokensBeforeEstimate: null,
      tokensAfterEstimate: null,
    })
    let state: ProjectionEvent['data'] = metadataProjection.init()
    for (const event of f.events) state = f.projection().apply(state, event as ProjectionEvent)
    expect(await f.read()).toMatchObject({ snapshot: state })
    await f.emit('session_start', {}) // A new runtime cannot re-read historical own projection today.
    expect(await f.read()).toMatchObject({ status: 'unknown' })
    f.stop()
  })

  it('fails diagnostics closed while leaving request/compaction and permissions unchanged; cleanup prevents late reads', async () => {
    const f = fixture()
    f.fail()
    expect(await f.emit('context', contextPayload('rules'))).toEqual({ refreshOnRequest: true })
    expect(await f.emit('before_request', request())).toEqual({})
    expect(await f.emit('before_compact', { getSurface: surface })).toBeNull()
    expect(await f.read()).toMatchObject({ status: 'unknown' })
    const aborted = new AbortController()
    aborted.abort()
    await f.emit('context', contextPayload('cancelled'), f.context('selected', 'main', aborted.signal))
    expect(f.events).toHaveLength(0)
    f.stop()
  })

  it('bounds live session cache and releases one session independently', async () => {
    const f = fixture()
    for (let i = 0; i < 65; i++) await f.emit('context', contextPayload('x'), f.context(String(i)))
    expect(await f.read('0')).toMatchObject({ status: 'unknown' })
    expect(await f.read('64')).toMatchObject({ status: 'live' })
    await f.emit('shutdown', {}, f.context('64'))
    expect(await f.read('64')).toMatchObject({ status: 'unknown' })
    expect(await f.read('63')).toMatchObject({ status: 'live' })
    f.stop()
  })
  it('has complete zh/en copy and labels estimates/unknowns in both languages', () => {
    expect(Object.keys(catalog.en).sort()).toEqual(Object.keys(catalog['zh-CN']).sort())
    expect(catalog.en.estimates).toContain('not provider tokenizer')
    expect(catalog['zh-CN'].estimates).toContain('不是供应商 tokenizer')
  })
})
